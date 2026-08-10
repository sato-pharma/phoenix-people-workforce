import { chromium } from "playwright";

const URL = "http://127.0.0.1:3020/admin/automated-payroll/finance";
const VIEWS = [
  { label: "desktop 1920", width: 1920, height: 1080, out: "rebuild-desktop.png" },
  { label: "laptop 1440", width: 1440, height: 900, out: "rebuild-laptop.png" },
  { label: "mobile 390", width: 390, height: 844, out: "rebuild-mobile.png" },
];

const browser = await chromium.launch();
for (const view of VIEWS) {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    extraHTTPHeaders: { "x-phoenix-role": "Finance Manager", "x-phoenix-hr-id": "B-185" },
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.waitForSelector("text=Automated Payroll", { timeout: 180000 });
  await page.waitForTimeout(2000);

  const info = await page.evaluate(() => {
    const heads = [...document.querySelectorAll("h2")].map((h) => h.textContent?.trim());
    const grid = [...document.querySelectorAll("div")].find((d) => /grid gap-5 lg:grid-cols-3/.test(d.className));
    const cards = grid ? [...grid.children].map((c) => Math.round(c.getBoundingClientRect().width)) : [];
    const top = grid ? [...grid.children].map((c) => Math.round(c.getBoundingClientRect().top)) : [];
    const hero = [...document.querySelectorAll("h1")].find((h) => h.textContent?.includes("Automated Payroll"));
    let shell = hero?.closest("div");
    while (shell && !/mx-auto/.test(shell.className)) shell = shell.parentElement?.closest("div") ?? null;
    const r = shell?.getBoundingClientRect();
    return {
      sectionTitles: heads,
      cardWidths: cards,
      sameRow: top.length > 1 ? new Set(top).size === 1 : null,
      shellWidth: r ? Math.round(r.width) : null,
      rightGutter: r ? Math.round(window.innerWidth - r.right) : null,
      docScrollX: document.documentElement.scrollWidth > window.innerWidth,
      periodInHero: Boolean(document.querySelector("h1")?.closest("section")?.textContent?.includes("Check")),
    };
  });

  await page.screenshot({ path: view.out, fullPage: false });
  console.log(`\n=== ${view.label} ===`);
  console.log(`  shell width      : ${info.shellWidth}px (right gutter ${info.rightGutter}px)`);
  console.log(`  section cards    : ${info.sectionTitles.join(" | ")}`);
  console.log(`  card widths      : ${info.cardWidths.join(", ")}`);
  console.log(`  cards on one row : ${info.sameRow}`);
  console.log(`  period in hero   : ${info.periodInHero}`);
  console.log(`  horizontal scroll: ${info.docScrollX ? "YES (BAD)" : "no"}`);
  console.log(`  console errors   : ${consoleErrors.length ? consoleErrors.slice(0, 3).join(" / ") : "none"}`);
  await context.close();
}
await browser.close();
