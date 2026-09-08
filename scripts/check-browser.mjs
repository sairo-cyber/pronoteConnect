import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent("<!doctype html><title>pronoteconnect</title>");
  if (await page.title() !== "pronoteconnect") throw new Error("chromium ne répond pas correctement");
} finally {
  await browser.close();
}

process.stdout.write("Chromium est installé et fonctionnel.\n");
