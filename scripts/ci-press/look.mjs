// One-off, never merged: the browser look for the first-read work and the home, on a GitHub runner against STAGING. EVERY non-GET request is stopped.
// usage (from the worktree): node look.mjs <flow> <outDir>     flow: rep-nav | manager-team | manager-phone
import { createRequire } from "node:module";
import { freemem } from "node:os";
import { mkdirSync } from "node:fs";

const require = createRequire(`${process.cwd()}/package.json`);
const { chromium } = require("playwright");

const [flow, outDir] = process.argv.slice(2);
const BASE = process.env.LOOK_BASE ?? "http://localhost:3011";
const REP = "B-59";
const MANAGER = "B-116";
const FLOWS = {
  "manager-phone": { hrId: MANAGER, role: "District Manager", width: 375 },
  "rep-nav": { hrId: REP, role: "Medical Rep", width: 1440 },
  "manager-team": { hrId: MANAGER, role: "District Manager", width: 1440 },
};
const who = FLOWS[flow];
if (!who) throw new Error(`unknown flow ${flow}`);
mkdirSync(outDir, { recursive: true });

const guard = () => {
  const mb = Math.round(freemem() / 1048576);
  return mb;
};

const launch = async () => {
  for (const channel of [undefined, "msedge", "chrome"]) {
    try {
      return await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
    } catch {
      // the next browser Windows already has
    }
  }
  throw new Error("no browser could start");
};

const browser = await launch();
const context = await browser.newContext({
  viewport: { width: who.width, height: who.width < 768 ? 812 : 900 },
  isMobile: who.width < 768,
  hasTouch: who.width < 768,
});
await context.addInitScript(() => {
  navigator.sendBeacon = () => true;
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const method = String(init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    if (["GET", "HEAD", "OPTIONS"].includes(method)) return realFetch(input, init);
    return Promise.resolve(new Response(null, { status: 204 }));
  };
});
const page = await context.newPage();

const blocked = [];
await context.route("**/*", (route) => {
  const request = route.request();
  if (["GET", "HEAD", "OPTIONS"].includes(request.method())) return route.continue();
  blocked.push(`${request.method()} ${new URL(request.url()).pathname}`);
  return route.abort();
});

const errors = [];
const failures = [];
const calls = [];
const warnings = [];
// The router asking the server for a page again: the page's own read starts anew inside it, so a Back with one of these is fresh without the browser reading Visits.
const pageRequests = [];
page.on("console", (m) => {
  if (m.type() === "warning") warnings.push(m.text().slice(0, 400));
  if (m.type() === "error" && !/net::ERR_FAILED|Failed to fetch/.test(m.text())) errors.push(m.text().slice(0, 1800));
});
page.on("pageerror", (e) => errors.push(`pageerror: ${String(e.message).slice(0, 400)}`));
page.on("response", (r) => r.status() >= 500 && failures.push(`${r.status()} ${new URL(r.url()).pathname}`));
page.on("request", (r) => {
  const url = new URL(r.url());
  if (url.pathname.startsWith("/api/phoenix-crm/") && r.method() === "GET") calls.push(url.pathname + url.search);
  if (url.searchParams.has("_rsc") || r.headers().rsc === "1") pageRequests.push(`${url.pathname}${r.headers()["next-router-prefetch"] ? " (prefetch)" : ""}`);
  else if (r.isNavigationRequest() && r.frame() === page.mainFrame()) pageRequests.push(url.pathname);
});

const settle = async (extra = 3000) => {
  await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => {});
  await page
    .waitForFunction(() => ![...document.querySelectorAll("h1,h2")].some((h) => /^Loading\b/.test(h.textContent?.trim() ?? "")), null, { timeout: 120_000 })
    .catch(() => console.log("  still showing a Loading heading after 120 s"));
  await page.waitForTimeout(extra);
};

const go = async (path) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await page.goto(`${BASE}${path}`, { timeout: 180_000 });
      await settle();
      return response;
    } catch (error) {
      if (attempt >= 4 || !/ERR_CONNECTION_(RESET|REFUSED)|ERR_EMPTY_RESPONSE/.test(error.message)) throw error;
      console.log("  dev server restarting, retrying");
      await page.waitForTimeout(15_000);
    }
  }
};

const report = async (label, since = 0) => {
  const size = await page.evaluate(() => {
    const overflow = [];
    for (const selector of ["html", "body", "main"]) {
      const el = document.querySelector(selector);
      if (el && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "hidden") overflow.push(`${selector} ${el.scrollWidth}>${el.clientWidth}`);
    }
    const text = document.querySelector("main")?.innerText ?? document.body.innerText;
    return {
      overflow,
      refused: (text.match(/could not load|tap to retry|something went wrong|application error/gi) ?? []).length,
      skeletons: document.querySelectorAll('[class*="animate-pulse"]').length,
      textLength: text.length,
    };
  });
  await page.screenshot({ path: `${outDir}/${flow}-${label}.png`, fullPage: false });
  console.log(`[${label}] free ${Math.round(freemem() / 1048576)} MB at ${page.url().replace(BASE, "")} ${JSON.stringify(size)}`);
  console.log(`  phoenix-crm reads: ${calls.slice(since).length ? calls.slice(since).join(" | ") : "none"}`);
  guard();
};

const clientGo = async (path) => {
  await page.evaluate((target) => window.next.router.push(target), path);
  await page.waitForURL(`**${path}`, { timeout: 180_000 });
  await settle();
};

try {
  guard();
  const q = new URLSearchParams({ next: "/api/healthz" });
  if (who.role) q.set("role", who.role);
  if (who.hrId) q.set("hrId", who.hrId);
  const signIn = await go(`/api/dev-auth?${q}`);
  console.log(`signed in ${flow}: ${signIn?.status()} ${((await page.textContent("body")) ?? "").slice(0, 120).replace(/\s+/g, " ")}`);

  if (flow === "manager-team") {
    const mark = calls.length;
    await go("/employee-portals/field-crm/team");
    const started = Date.now();
    const shown = await page.getByText(/^look at$/i).first().waitFor({ timeout: 180_000 }).then(() => true).catch(() => false);
    console.log(`  the lower sections ${shown ? "appeared" : "NEVER appeared"} after a further ${Math.round((Date.now() - started) / 1000)} s`);
    await report("team-settled", mark);
  } else if (flow === "rep-nav") {
    // Cold from the chooser, so the module arrives by client navigation; then away and Back.
    await go("/employee-portals/field-crm");
    await report("chooser");
    let mark = calls.length;
    await page.locator('a[href$="/field-crm/visits"]').first().click();
    await page.waitForURL("**/field-crm/visits", { timeout: 180_000 });
    await settle();
    // Let the screen finish first: a read is spent only once it has drawn.
    await page.waitForFunction(() => document.querySelectorAll('[class*="animate-pulse"]').length === 0, null, { timeout: 60_000 }).catch(() => console.log("  Visits still shows a skeleton after 60 s"));
    await page.waitForTimeout(5000);
    const drawnAt = Date.now();
    await report("visits-from-chooser", mark);
    console.log(`  VERDICT chooser: the browser asked for the Visits read itself ${calls.slice(mark).filter((c) => c.split("?")[0] === "/api/phoenix-crm/visits").length} time(s); 0 means the page handed it over`);
    mark = calls.length;
    await clientGo("/employee-portals/field-crm/plan");
    await report("plan-from-visits", mark);
    await page.waitForTimeout(Math.max(0, 35_000 - (Date.now() - drawnAt)));
    console.log(`  pressing Back ${Math.round((Date.now() - drawnAt) / 1000)} s after Visits drew`);
    mark = calls.length;
    const pageMark = pageRequests.length;
    await page.goBack({ timeout: 180_000 });
    await settle();
    await page.waitForTimeout(5000);
    await report("browser-back-to-visits", mark);
    const ownReads = calls.slice(mark).filter((c) => c.split("?")[0] === "/api/phoenix-crm/visits").length;
    const askedAgain = pageRequests.slice(pageMark).filter((p) => p.endsWith("/field-crm/visits"));
    console.log(`  VERDICT back: the browser read Visits itself ${ownReads} time(s); the router asked the server for the Visits page ${askedAgain.length} time(s). Either one above 0 is fresh; both 0 is the day from before.`);
    console.log(`  page requests on Back: ${pageRequests.slice(pageMark).join(" | ") || "none"}`);
  } else {
    const landing = await go("/employee-portals");
    console.log(`home ${landing?.status()}`);
    await report("home");
    const mark = calls.length;
    await go("/employee-portals/field-crm/team");
    await report("module-hard-load", mark);
  }
} catch (error) {
  console.log(`FAILED: ${String(error.message).split("\n")[0]}`);
  await page.screenshot({ path: `${outDir}/${flow}-failure.png` }).catch(() => {});
  process.exitCode ||= 1;
}

console.log(`blocked writes: ${blocked.length ? [...new Set(blocked)].join(" | ") : "none"}`);
console.log(`5xx: ${failures.length ? failures.join(" | ") : "none"}`);
console.log(`console errors: ${errors.length ? "" : "none"}`);
for (const line of [...new Set(errors)].slice(0, 12)) console.log(`  ${line}`);
console.log(`console warnings: ${warnings.length ? "" : "none"}`);
for (const line of [...new Set(warnings)].slice(0, 12)) console.log(`  ${line}`);
await browser.close();
