#!/usr/bin/env node
/*
 * Phoenix Workforce run driver — signs in as a role through dev-auth and drives the running dev
 * server in headless Chromium (the Playwright install the e2e suite already uses).
 *
 *   node .claude/skills/run-phoenix-workforce/driver.mjs [options] <step> [<step> ...]
 *
 * Options (before the steps):
 *   --base <url>     dev server (default http://localhost:3000)
 *   --role <role>    dev-auth role, e.g. "Super Admin", "HR Operations", "Medical Rep"
 *                    (omit for no sign-in at all)
 *   --hrId <id>      sign in as THAT person; dev-auth refuses (409) a role they do not hold
 *   --width <px>     viewport width (default 1440; 375 for the mobile check)
 *   --out <dir>      where screenshots land (default output/run-skill)
 *
 * Steps run in order in ONE browser context, so the sign-in cookie carries through:
 *   go <path>        navigate, wait for the network to settle, print status + title + url
 *   shot <name>      full-page screenshot -> <out>/<name>.png
 *   click <text>     click the first VISIBLE element whose text is exactly <text> (never coordinates)
 *   fill <label> <value>  fill the field labelled <label>
 *   text             print the visible text of <main> (first 3,000 characters)
 *   overflow         the fits-the-screen rule: scrollWidth vs clientWidth of <main> and <body>
 *   eval <js>        evaluate an expression in the page, print the JSON result
 *   waitfor <text>   wait (up to 120 s) until <text> is visible
 *   wait <ms>        sleep
 *
 * Exit code 1 if any step fails; console errors, failed requests and every write the driver stopped
 * are printed at the end.
 *
 * The dev server reads .env.local, which is PRODUCTION Supabase, so a page opened as a real person
 * (--hrId) can write under that person's name without a single click: a page's mount effects, its
 * autosaves and the beacons of a closing page. So the browser sends GET and nothing else, on every
 * step and with no way to turn it off. A stopped fetch or beacon is answered as a success, so the page
 * carries on: "Saved" on a driven page means nothing was saved. This cannot stop what a page's own
 * server render writes during a GET; see "What it cannot stop" in SKILL.md.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const opts = { base: "http://localhost:3000", role: null, hrId: null, width: 1440, out: "output/run-skill" };
while (argv[0]?.startsWith("--")) {
  const key = argv.shift().slice(2);
  if (!(key in opts)) {
    console.error(`unknown option --${key}`);
    process.exit(2);
  }
  opts[key] = argv.shift();
}
opts.width = Number(opts.width);
if (argv.length === 0) {
  console.error("no steps. e.g.: --role \"Super Admin\" go /admin shot admin");
  process.exit(2);
}
mkdirSync(opts.out, { recursive: true });

// Playwright pins one browser build per version, and the weekly dependency refresh moves the
// version — 1.64.1 wants chromium_headless_shell-1248 while this laptop held 1243, so every run
// died "Executable doesn't exist" (2026-10-31). Fall back to the browsers Windows already has
// (Edge, then Chrome) instead of a ~150 MB download after every bump.
const launchBrowser = async () => {
  const tried = [];
  for (const channel of [undefined, "msedge", "chrome"]) {
    try {
      const launched = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
      if (channel) console.log(`browser: Playwright's own Chromium is missing, using installed ${channel}`);
      return launched;
    } catch (error) {
      tried.push(`${channel ?? "bundled chromium"}: ${String(error.message).split("\n")[0]}`);
    }
  }
  console.error(`no browser could start:\n  ${tried.join("\n  ")}\nfix: npx playwright install chromium`);
  process.exit(1);
};
const browser = await launchBrowser();
const context = await browser.newContext({
  viewport: { width: opts.width, height: opts.width < 768 ? 812 : 900 },
  isMobile: opts.width < 768,
  hasTouch: opts.width < 768,
  // Playwright's routing cannot see a request a service worker makes, and OneSignal registers one.
  serviceWorkers: "block",
});

// Two layers, because each misses what the other catches. context.route sees every request the
// network stack is asked for (XHR, a form post, a worker), but a sendBeacon or keepalive fetch from a
// closing page still reached the server past it (1 Nov 2026). The page-side stubs stop those before
// they become requests at all, and cannot see an XHR or a form post.
const writesStopped = [];
const recordStoppedWrite = (how, method, url) => {
  const target = new URL(url, opts.base);
  const where = target.origin === new URL(opts.base).origin ? `${target.pathname}${target.search}` : target.href;
  writesStopped.push(`${method} ${where} (${how})`);
};
// The page keeps its own list in the tab's sessionStorage: a Playwright binding called from a closing
// page never came back (the pagehide writes were stopped but went unlisted), and storage is written
// at once and outlives the navigation. Collected at the end of the run.
const STOPPED_KEY = "__phxDriverWritesStopped";
const collectStoppedWrites = async () => {
  for (const frame of page.frames()) {
    const read = frame.evaluate((key) => {
      const held = sessionStorage.getItem(key);
      sessionStorage.removeItem(key);
      return held;
    }, STOPPED_KEY);
    const held = await Promise.race([read, new Promise((done) => setTimeout(done, 5_000, null))]).catch(() => null);
    for (const [how, method, url] of JSON.parse(held ?? "[]")) recordStoppedWrite(how, method, url);
  }
};
await context.addInitScript((key) => {
  const report = (how, method, url) => {
    try {
      const held = JSON.parse(sessionStorage.getItem(key) ?? "[]");
      held.push([how, method, new URL(String(url), location.href).href]);
      sessionStorage.setItem(key, JSON.stringify(held));
    } catch {
      // No storage in this frame (a sandboxed one): the write is still stopped, it just goes unlisted.
    }
  };
  const realFetch = window.fetch;
  window.fetch = function fetch(input, init) {
    const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
    if (method === "GET") return realFetch.call(this, input, init);
    report("fetch", method, input?.url ?? input);
    return Promise.resolve(new Response(null, { status: 204 }));
  };
  Navigator.prototype.sendBeacon = function sendBeacon(url) {
    report("beacon", "POST", url);
    return true;
  };
}, STOPPED_KEY);
await context.route("**/*", (route) => {
  const request = route.request();
  if (request.method() === "GET") return route.continue();
  recordStoppedWrite(request.resourceType(), request.method(), request.url());
  // Aborting a form post navigates the tab to Chrome's error page, which has no sessionStorage, so the
  // page's own list was lost and later steps read the error page. A 204 never reaches the server either,
  // and a browser stays on the page it is on.
  if (request.isNavigationRequest()) return route.fulfill({ status: 204 });
  return route.abort("blockedbyclient");
});

const page = await context.newPage();
const consoleErrors = [];
const failedRequests = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 300)));
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e.message).slice(0, 300)}`));
page.on("response", (r) => r.status() >= 500 && failedRequests.push(`${r.status()} ${r.url()}`));

const settle = async () => {
  // A cold webpack compile of one page takes 30-90 s on this laptop; networkidle can also never
  // arrive on pages that poll, so fall back to the load event.
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  // Heavy pages (Needs You, the command centres) stream: the shell paints a "Loading <page>"
  // heading over skeleton cards, then the data arrives after the network went quiet. Wait it out.
  await page
    .waitForFunction(
      () => ![...document.querySelectorAll("h1,h2")].some((h) => /^Loading\b/.test(h.textContent?.trim() ?? "")),
      null,
      { timeout: 120_000 },
    )
    .catch(() => console.log("  still showing a Loading heading after 120 s"));
};

// The dev server runs under a 4,096 MB heap cap (scripts/dev-server.mjs), and after a few page
// compiles Next prints "Server is approaching the used memory threshold, restarting..." and
// restarts itself. Any request in flight then dies as ERR_CONNECTION_RESET/REFUSED. Wait for
// /api/healthz to answer again and retry, instead of reporting the page broken.
const gotoRetry = async (url) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await page.goto(url, { timeout: 180_000 });
    } catch (error) {
      if (attempt >= 4 || !/ERR_CONNECTION_(RESET|REFUSED)|ERR_EMPTY_RESPONSE/.test(error.message)) throw error;
      console.log(`  dev server restarting (${error.message.match(/ERR_\w+/)[0]}) — waiting, retry ${attempt}`);
      for (let s = 0; s < 60; s++) {
        const up = await fetch(`${opts.base}/api/healthz`).then((r) => r.ok).catch(() => false);
        if (up) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
};

let failed = false;
try {
  if (opts.role) {
    const q = new URLSearchParams({ role: opts.role, next: "/api/healthz" });
    if (opts.hrId) q.set("hrId", opts.hrId);
    const res = await gotoRetry(`${opts.base}/api/dev-auth?${q}`);
    const body = (await page.textContent("body").catch(() => "")) ?? "";
    if (!res || res.status() >= 400 || /role_mismatch|not_found/.test(body)) {
      throw new Error(`dev-auth refused (${res?.status()}): ${body.slice(0, 300)}`);
    }
    console.log(`signed in: ${opts.role}${opts.hrId ? ` as ${opts.hrId}` : ""}`);
  }

  for (let i = 0; i < argv.length; i++) {
    const step = argv[i];
    if (step === "go") {
      let target = argv[++i];
      // Git Bash (MSYS) rewrites a bare "/admin" argument into "C:/Program Files/Git/admin" before
      // node ever sees it. Undo that here; MSYS_NO_PATHCONV=1 stops it at the source.
      const mangled = /^[A-Za-z]:[\\/].*?[\\/]Git([\\/].*)$/.exec(target);
      if (mangled) target = mangled[1].replace(/\\/g, "/");
      const res = await gotoRetry(new URL(target, opts.base).href);
      await settle();
      console.log(`go ${target} -> ${res?.status()} "${await page.title()}" at ${new URL(page.url()).pathname}`);
    } else if (step === "shot") {
      const file = path.join(opts.out, `${argv[++i]}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(`shot ${file}`);
    } else if (step === "click") {
      const text = argv[++i];
      const target = page.getByText(text, { exact: true }).filter({ visible: true }).first();
      // A sidebar link is a client-side navigation: the click returns at once and the next page
      // compiles for 10-60 s, so wait for the URL the link points at, not for the network.
      const href = await target.evaluate((el) => el.closest("a")?.getAttribute("href") ?? null);
      await target.click({ timeout: 15_000 });
      if (href?.startsWith("/")) {
        const want = href.split(/[?#]/)[0];
        await page.waitForURL((u) => u.pathname === want, { timeout: 180_000 });
      }
      await settle();
      console.log(`click "${text}" -> ${new URL(page.url()).pathname}`);
    } else if (step === "fill") {
      const label = argv[++i];
      const value = argv[++i];
      await page.getByLabel(label).first().fill(value, { timeout: 15_000 });
      console.log(`fill "${label}"`);
    } else if (step === "text") {
      const t = await page.locator("main").first().innerText({ timeout: 10_000 }).catch(() => page.innerText("body"));
      console.log(t.replace(/\n{3,}/g, "\n\n").slice(0, 3000));
    } else if (step === "overflow") {
      const m = await page.evaluate(() =>
        ["main", "body"].map((sel) => {
          const el = document.querySelector(sel);
          return el ? { sel, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth } : { sel, missing: true };
        }),
      );
      const bad = m.filter((x) => x.scrollWidth > x.clientWidth);
      console.log(`overflow @${opts.width}px ${bad.length ? "HORIZONTAL SCROLL" : "ok"} ${JSON.stringify(m)}`);
      if (bad.length) failed = true;
    } else if (step === "eval") {
      console.log(JSON.stringify(await page.evaluate(argv[++i])));
    } else if (step === "waitfor") {
      const text = argv[++i];
      await page.getByText(text).filter({ visible: true }).first().waitFor({ timeout: 120_000 });
      console.log(`waitfor "${text}" ok`);
    } else if (step === "wait") {
      await page.waitForTimeout(Number(argv[++i]));
    } else {
      throw new Error(`unknown step "${step}"`);
    }
  }
} catch (error) {
  failed = true;
  console.error(`FAILED: ${error.message.split("\n")[0]}`);
  await page.screenshot({ path: path.join(opts.out, "failure.png"), fullPage: true }).catch(() => {});
} finally {
  if (consoleErrors.length) console.log(`console errors (${consoleErrors.length}):\n  ${consoleErrors.slice(0, 10).join("\n  ")}`);
  if (failedRequests.length) console.log(`5xx responses (${failedRequests.length}):\n  ${failedRequests.slice(0, 10).join("\n  ")}`);
  // After a `go` the outgoing page runs its pagehide handlers only once the next page has loaded (their
  // beacons reached a recording server after the next page's GET), so give them time to be listed.
  await page.waitForTimeout(2_000).catch(() => {});
  await collectStoppedWrites();
  await browser.close();
  console.log(`writes stopped (${writesStopped.length})${writesStopped.length ? `:\n  ${writesStopped.join("\n  ")}` : ""}`);
}
process.exit(failed ? 1 : 0);
