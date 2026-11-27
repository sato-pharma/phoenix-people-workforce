// Runs ON THE SPARE (copied to ~/phoenix/shots.mjs and run from the live checkout, whose node_modules has Playwright).
// Called by ~/.claude/scripts/spare-shots.ps1 on the main laptop (owner, 2026-11-23: "Do 18, 19 and 20" - #18).
// For each page: the LIVE version (localhost:3000) and the pull request (localhost:3001), each at desktop 1440 px and
// phone 375 px, full page. It also measures a sideways scroll (the fits-the-screen golden rule) on every shot.
// Input (env): SHOTS = JSON [{path, role, hr}], OUT = folder. Output: PNGs + results.json in OUT.
import { createRequire } from "node:module";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";

// Playwright is resolved from the live checkout (the working folder), not from this file's own folder.
const { chromium } = createRequire(process.cwd() + "/")("playwright");
const pages = JSON.parse(process.env.SHOTS || "[]");
const out = process.env.OUT;
mkdirSync(out, { recursive: true });
const sides = [["before", 3000], ["after", 3001]];
const views = [["desktop", { width: 1440, height: 900 }, false], ["phone", { width: 375, height: 812 }, true]];
const freeMb = () => Number(/MemAvailable:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"))[1]) / 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (p) => (p === "/" ? "home" : p.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-"));

const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
const results = [];
for (const pg of pages) {
  for (const [side, port] of sides) {
    for (const [view, viewport, isMobile] of views) {
      for (let i = 0; i < 12 && freeMb() < 500; i++) await sleep(10_000); // the two dev servers come first
      const file = `${slug(pg.path)}-${view}-${side}.png`;
      const r = { page: pg.path, side, view, file, role: pg.role };
      const ctx = await browser.newContext({ viewport, isMobile, hasTouch: isMobile, deviceScaleFactor: 1 });
      const tab = await ctx.newPage();
      try {
        const q = new URLSearchParams({ role: pg.role, next: pg.path });
        if (pg.hr) q.set("hrId", pg.hr);
        const res = await tab.goto(`http://127.0.0.1:${port}/api/dev-auth?${q}`, { waitUntil: "load", timeout: 240_000 });
        r.status = res?.status() ?? null;
        r.landed = new URL(tab.url()).pathname;
        await sleep(4000); // client data and fonts settle (dev mode keeps a socket open, so no "network idle")
        r.sidewaysScroll = await tab.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth));
        await tab.screenshot({ path: `${out}/${file}`, fullPage: true, timeout: 120_000 });
      } catch (e) {
        r.error = String(e?.message || e).split("\n")[0];
      }
      await ctx.close();
      results.push(r);
      console.log(`${r.error ? "FAIL" : "ok  "} ${pg.path} ${view} ${side}${r.status ? ` ${r.status}` : ""}${r.sidewaysScroll ? ` SIDEWAYS ${r.sidewaysScroll}px` : ""}${r.error ? ` ${r.error}` : ""}`);
    }
  }
}
await browser.close();
writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
