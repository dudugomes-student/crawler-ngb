const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const pages = JSON.parse(
  fs.readFileSync("./pages.json", "utf8")
);

const OUTPUT_FILE = "./interactions.json";
const SCREENSHOTS_DIR = "./interaction-screenshots";

if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

const interactions = [];

function cleanText(text = "") {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
}

function safeName(text = "") {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

async function getState(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);

      const rect = el.getBoundingClientRect();

      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) !== 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const dialogs = Array.from(
      document.querySelectorAll(
        'dialog, [role="dialog"], [aria-modal="true"], [class*="modal"], [class*="Modal"]'
      )
    )
      .filter(visible)
      .map((el) => clean(el.innerText));

    function clean(value = "") {
      return value.replace(/\s+/g, " ").trim().slice(0, 1000);
    }

    return {
      url: location.href,

      title: document.title,

      bodyText: clean(
        document.body?.innerText || ""
      ).slice(0, 10000),

      dialogs,

      expanded: Array.from(
        document.querySelectorAll('[aria-expanded="true"]')
      ).length,

      selectedTabs: Array.from(
        document.querySelectorAll(
          '[role="tab"][aria-selected="true"]'
        )
      ).map((el) =>
        clean(el.innerText || el.getAttribute("aria-label") || "")
      )
    };
  });
}

function detectType(before, after) {
  if (before.url !== after.url) {
    return {
      type: "navigation",
      destination: after.url
    };
  }

  if (after.dialogs.length > before.dialogs.length) {
    return {
      type: "modal",
      destination: null
    };
  }

  if (after.selectedTabs.join("|") !== before.selectedTabs.join("|")) {
    return {
      type: "tab",
      destination: null
    };
  }

  if (after.expanded > before.expanded) {
    return {
      type: "expanded",
      destination: null
    };
  }

  if (before.bodyText !== after.bodyText) {
    return {
      type: "state-change",
      destination: null
    };
  }

  return {
    type: "no-visible-change",
    destination: null
  };
}

async function getCandidates(page) {
  return page.evaluate(() => {
    const elements = Array.from(
      document.querySelectorAll(`
        a[href],
        button,
        [role="button"],
        [role="tab"],
        summary,
        [aria-expanded]
      `)
    );

    const visible = elements.filter((el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();

      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    });

    return visible.map((el, index) => ({
      index,

      tag: el.tagName.toLowerCase(),

      text: (
        el.innerText ||
        el.textContent ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 150),

      ariaLabel: el.getAttribute("aria-label"),

      role: el.getAttribute("role"),

      href: el.getAttribute("href"),

      type: el.getAttribute("type"),

      id: el.id || null,

      testId: el.getAttribute("data-testid"),

      ariaExpanded: el.getAttribute("aria-expanded"),

      ariaSelected: el.getAttribute("aria-selected")
    }));
  });
}

async function findElement(page, candidate) {
  if (candidate.testId) {
    const locator = page.locator(
      `[data-testid="${candidate.testId}"]`
    );

    if (await locator.count()) {
      return locator.first();
    }
  }

  if (candidate.id) {
    const locator = page.locator(
      `#${CSS.escape(candidate.id)}`
    );

    if (await locator.count()) {
      return locator.first();
    }
  }

  if (candidate.ariaLabel) {
    const locator = page.getByLabel(
      candidate.ariaLabel,
      { exact: true }
    );

    if (await locator.count()) {
      return locator.first();
    }
  }

  if (candidate.text) {
    if (candidate.tag === "button") {
      const locator = page
        .getByRole("button", {
          name: candidate.text,
          exact: true
        });

      if (await locator.count()) {
        return locator.first();
      }
    }

    if (candidate.tag === "a") {
      const locator = page
        .getByRole("link", {
          name: candidate.text,
          exact: true
        });

      if (await locator.count()) {
        return locator.first();
      }
    }
  }

  return null;
}

function shouldSkip(candidate) {
  const text = (
    candidate.text ||
    candidate.ariaLabel ||
    ""
  ).toLowerCase();

  const dangerousWords = [
    "logout",
    "log out",
    "sair",
    "excluir",
    "delete",
    "remover",
    "remove",
    "comprar",
    "buy",
    "pagar",
    "pay",
    "confirmar pagamento"
  ];

  if (
    dangerousWords.some((word) =>
      text.includes(word)
    )
  ) {
    return true;
  }

  if (
    candidate.tag === "button" &&
    candidate.type === "submit"
  ) {
    return true;
  }

  if (
    candidate.href &&
    candidate.href.startsWith("mailto:")
  ) {
    return true;
  }

  if (
    candidate.href &&
    candidate.href.startsWith("tel:")
  ) {
    return true;
  }

  return false;
}

async function analyzePage(context, pageItem) {
  console.log("\n----------------------------");
  console.log(`Página: ${pageItem.url}`);

  const discoveryPage = await context.newPage();

  try {
    await discoveryPage.goto(pageItem.url, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    await discoveryPage.waitForTimeout(1000);

    const candidates = await getCandidates(
      discoveryPage
    );

    console.log(
      `Encontrados: ${candidates.length} elementos`
    );

    await discoveryPage.close();

    const limitedCandidates =
      candidates.slice(0, 80);

    for (
      let i = 0;
      i < limitedCandidates.length;
      i++
    ) {
      const candidate = limitedCandidates[i];

      if (shouldSkip(candidate)) {
        console.log(
          `IGNORADO: ${
            candidate.text ||
            candidate.ariaLabel ||
            candidate.tag
          }`
        );

        continue;
      }

      const page = await context.newPage();

      try {
        await page.goto(pageItem.url, {
          waitUntil: "domcontentloaded",
          timeout: 30000
        });

        await page.waitForTimeout(700);

        const element = await findElement(
          page,
          candidate
        );

        if (!element) {
          console.log(
            `Não localizado: ${
              candidate.text ||
              candidate.ariaLabel ||
              candidate.tag
            }`
          );

          await page.close();

          continue;
        }

        if (!(await element.isVisible())) {
          await page.close();
          continue;
        }

        const before = await getState(page);

        console.log(
          `[${i + 1}/${limitedCandidates.length}] clicando: ${
            candidate.text ||
            candidate.ariaLabel ||
            candidate.tag
          }`
        );

        await element.scrollIntoViewIfNeeded();

        await element.click({
          timeout: 5000
        });

        await page.waitForTimeout(800);

        const after = await getState(page);

        const result = detectType(
          before,
          after
        );

        let screenshot = null;

        if (
          result.type !== "no-visible-change"
        ) {
          const pageName =
            safeName(
              new URL(pageItem.url).pathname
            ) || "home";

          const elementName =
            safeName(
              candidate.text ||
              candidate.ariaLabel ||
              candidate.tag
            ) || `element-${i}`;

          screenshot =
            `${pageName}__${elementName}.png`;

          await page.screenshot({
            path: path.join(
              SCREENSHOTS_DIR,
              screenshot
            ),
            fullPage: true
          });
        }

        interactions.push({
          page: pageItem.url,

          element: candidate,

          action: "click",

          result,

          screenshot
        });

      } catch (error) {
        console.log(
          `ERRO: ${error.message}`
        );

        interactions.push({
          page: pageItem.url,

          element: candidate,

          action: "click",

          error: error.message
        });
      }

      await page.close();
    }

  } catch (error) {
    console.log(
      `Erro ao abrir ${pageItem.url}:`,
      error.message
    );

    if (!discoveryPage.isClosed()) {
      await discoveryPage.close();
    }
  }
}

async function main() {
  const browser = await chromium.launch({
    headless: false
  });

  const context = await browser.newContext({
    viewport: {
      width: 1440,
      height: 1000
    }
  });

  for (const pageItem of pages) {
    if (
      !pageItem.url ||
      pageItem.error
    ) {
      continue;
    }

    await analyzePage(
      context,
      pageItem
    );

    fs.writeFileSync(
      OUTPUT_FILE,
      JSON.stringify(
        interactions,
        null,
        2
      )
    );
  }

  await browser.close();

  console.log("\n============================");
  console.log("FINALIZADO");
  console.log("============================");

  console.log(
    `Interações: ${interactions.length}`
  );

  console.log(
    `Arquivo: ${OUTPUT_FILE}`
  );

  console.log(
    `Screenshots: ${SCREENSHOTS_DIR}`
  );
}

main().catch(console.error);