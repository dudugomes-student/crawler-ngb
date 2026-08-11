const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

// COLOQUE A URL DO SITE AQUI
const START_URL = "https://dudugomes-student.github.io/TccNewGenBank/";

// Limite de páginas para o primeiro teste.
// Depois você pode aumentar.
const MAX_PAGES = 50;

const visited = new Set();
const pagesData = [];

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);

    // Remove #ancoras
    parsed.hash = "";

    return parsed.href;
  } catch {
    return null;
  }
}

function safeFileName(url) {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/[^\w.-]+/g, "_")
    .slice(0, 150);
}

async function crawlPage(page, url, baseDomain) {
  console.log(`\nVisitando: ${url}`);

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    await page.waitForTimeout(1500);

    const title = await page.title();

    // Pega todos os links da página
    const links = await page.locator("a").evaluateAll((elements) =>
      elements.map((el) => ({
        text: (el.innerText || el.textContent || "").trim(),
        href: el.href,
      }))
    );

    // Pega os botões
    const buttons = await page.locator("button").evaluateAll((elements) =>
      elements.map((el) => ({
        text: (el.innerText || el.textContent || "").trim(),
        ariaLabel: el.getAttribute("aria-label"),
        type: el.getAttribute("type"),
      }))
    );

    // Pega inputs
    const inputs = await page.locator("input").evaluateAll((elements) =>
      elements.map((el) => ({
        type: el.type,
        name: el.name,
        placeholder: el.placeholder,
        ariaLabel: el.getAttribute("aria-label"),
      }))
    );

    // Screenshot da página inteira
    const screenshotName = `${safeFileName(url)}.png`;

    await page.screenshot({
      path: path.join("screenshots", screenshotName),
      fullPage: true,
    });

    const cleanLinks = links
      .map((link) => ({
        ...link,
        href: normalizeUrl(link.href),
      }))
      .filter((link) => link.href);

    pagesData.push({
      url,
      title,
      screenshot: screenshotName,
      links: cleanLinks,
      buttons,
      inputs,
    });

    // Descobre links internos
    const internalLinks = cleanLinks
      .map((link) => link.href)
      .filter((href) => {
        try {
          return new URL(href).hostname === baseDomain;
        } catch {
          return false;
        }
      });

    return [...new Set(internalLinks)];
  } catch (error) {
    console.error(`Erro em ${url}: ${error.message}`);

    pagesData.push({
      url,
      error: error.message,
    });

    return [];
  }
}

async function main() {
  if (!fs.existsSync("screenshots")) {
    fs.mkdirSync("screenshots");
  }

  const browser = await chromium.launch({
    headless: false,
  });

  const context = await browser.newContext({
    viewport: {
      width: 1440,
      height: 1000,
    },
  });

  const page = await context.newPage();

  const baseDomain = new URL(START_URL).hostname;

  const queue = [START_URL];

  while (
    queue.length > 0 &&
    visited.size < MAX_PAGES
  ) {
    const currentUrl = queue.shift();
    const normalized = normalizeUrl(currentUrl);

    if (!normalized) continue;

    if (visited.has(normalized)) continue;

    visited.add(normalized);

    const discoveredLinks = await crawlPage(
      page,
      normalized,
      baseDomain
    );

    for (const link of discoveredLinks) {
      if (
        !visited.has(link) &&
        !queue.includes(link)
      ) {
        queue.push(link);
      }
    }

    console.log(
      `Páginas encontradas: ${visited.size} | Fila: ${queue.length}`
    );
  }

  fs.writeFileSync(
    "pages.json",
    JSON.stringify(pagesData, null, 2)
  );

  console.log("\n==========================");
  console.log("CRAWLER FINALIZADO");
  console.log("==========================");
  console.log(`Páginas visitadas: ${visited.size}`);
  console.log("Arquivo: pages.json");
  console.log("Screenshots: /screenshots");

  await browser.close();
}

main();