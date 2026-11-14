/**
 * The capture engine shared by explore.mjs (the CLI), self-check.mjs (the browser checks) and
 * mcp-server.mjs (the tool interface). One path, so what is checked is what runs.
 *
 * For every (persona, state, viewport) it: opens a FRESH fenced browser context with the persona's
 * session, reaches the state (address, the page's own first link, a vetted click, Tab presses, or a
 * labelled mock), waits for the page to settle, masks the document, measures it, takes the
 * accessibility snapshot and the full-page screenshot plus each internal scroller expanded, then runs
 * the independent leak check and DELETES every file of a shot that fails it.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { classifyRequest, collectPageStoppedWrites, installFence, sanitizeUrlForLog } from "./fence.mjs";
import { measurePage, summarizeMeasurements } from "./measure.mjs";
import { SAFE_WORDS, findAriaLeaks, maskDocument, maskString, pageCall, sanitizeAriaSnapshot, verifyDocument } from "./redact.mjs";
import { RUN_BOUNDS, VIEWPORTS, classifyControl } from "./safety.mjs";

/**
 * A full-page screenshot cut at the viewport's width. A page that overflows sideways would otherwise
 * come out as wide as its widest element (2000 px at a 390 px viewport, self-check 14 Nov 2026) and no
 * two baselines would compare; the overflow itself is measured (horizontalOverflowPx), not pictured.
 */
async function shootFullPage(page, file, width, options) {
  const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0, 1));
  await page.screenshot({ path: file, fullPage: true, clip: { x: 0, y: 0, width, height }, ...options });
}

export async function launchBrowser() {
  const { chromium } = await import("playwright");
  const tried = [];
  for (const channel of [undefined, "msedge", "chrome"]) {
    try {
      return await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
    } catch (error) {
      tried.push(`${channel ?? "bundled chromium"}: ${String(error.message).split("\n")[0]}`);
    }
  }
  throw new Error(`no browser could start: ${tried.join(" | ")}`);
}

/**
 * The one write a run makes: the sign-in POST, from a throwaway context's API client (which no route
 * fence sees, and which never renders a page). The session comes back as an in-memory storage state;
 * nothing is written to disk. Returns { ok, status, code, state }.
 */
export async function signIn(browser, origin, loginId, password) {
  const context = await browser.newContext();
  try {
    // A network failure (no answer at all: the spare's DNS lookup failed once on 14 Nov 2026) is tried
    // once more after a pause; an ANSWER, even a refusal, is never retried, so a wrong password is
    // never sent twice toward the lockout.
    let response = null;
    for (let attempt = 1; attempt <= 2 && !response; attempt += 1) {
      try {
        response = await context.request.post(`${origin}/api/auth/login`, {
          data: { loginId, password, remember: false },
          headers: { origin, referer: `${origin}/login` },
          timeout: 60_000,
          maxRedirects: 0,
        });
      } catch (error) {
        if (attempt === 2) return { ok: false, status: null, code: `network-error: ${String(error.message).split("\n")[0].slice(0, 120)}`, state: null };
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
    let code = null;
    try {
      const body = await response.json();
      code = typeof body?.error === "string" ? body.error : null;
    } catch {
      code = null;
    }
    if (!response.ok()) return { ok: false, status: response.status(), code: code ?? "http-error", state: null };
    const state = await context.storageState();
    if (!state.cookies.some((cookie) => cookie.httpOnly)) return { ok: false, status: response.status(), code: "no-session-cookie", state: null };
    return { ok: true, status: response.status(), code: null, state };
  } finally {
    await context.close();
  }
}

/** A fresh context: one viewport, the persona's session, both fence layers, workers blocked. */
export async function openFencedContext(browser, { origin, viewport, storageState, stoppedLog, thirdPartyGetHosts }) {
  const size = VIEWPORTS[viewport];
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    isMobile: size.mobile,
    hasTouch: size.mobile,
    deviceScaleFactor: 1,
    serviceWorkers: "block",
    acceptDownloads: false,
    reducedMotion: "reduce",
    ...(storageState ? { storageState } : {}),
  });
  context.setDefaultNavigationTimeout(RUN_BOUNDS.navigationTimeoutMs);
  context.setDefaultTimeout(30_000);
  await installFence(context, { origin, thirdPartyGetHosts }, stoppedLog);
  return context;
}

async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page
    .waitForFunction(
      () => ![...document.querySelectorAll("h1,h2")].some((h) => /^Loading\b/.test(h.textContent?.trim() ?? "")),
      null,
      { timeout: 60_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(400);
}

/** Read a control's facts in the page (real name, never returned to the log) and classify it. */
async function vetControl(locator, origin) {
  const facts = await locator.evaluate((element) => ({
    tag: element.tagName,
    type: element.getAttribute("type"),
    role: element.getAttribute("role"),
    name: (element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 200),
    href: element.getAttribute("href"),
    download: element.hasAttribute("download"),
    inForm: Boolean(element.closest("form")),
    formMethod: element.closest("form")?.getAttribute("method") ?? null,
  }));
  return { verdict: classifyControl(facts, origin), name: facts.name };
}

async function neverTouchHit(locator, neverTouch) {
  for (const rule of neverTouch) {
    if (await locator.evaluate((element, selector) => element.matches(selector), rule.selector).catch(() => false)) return rule.reason;
  }
  return null;
}

/**
 * Capture one state at one viewport. Returns a manifest entry; never throws for a page problem
 * (navigation failure, refusal, leak) — those are recorded outcomes.
 */
export async function captureOne(browser, job) {
  const { origin, persona, state, viewport, address, outDir, shotId, keepList, sourceIndexLookup, neverTouch } = job;
  const started = Date.now();
  const stopped = [];
  const network = [];
  const consoleErrors = [];
  const steps = [];
  const entry = {
    id: shotId,
    persona: persona.id,
    role: persona.role,
    state: state.id,
    stateLabel: state.label,
    viewport,
    mock: state.mock ?? null,
    requested: sanitizeUrlForLog(new URL(address, origin).href, origin),
    outcome: "pending",
    steps,
  };
  const keep = new Set(keepList);
  const safe = new Set(SAFE_WORDS);
  const context = await openFencedContext(browser, { origin, viewport, storageState: job.storageState, stoppedLog: stopped });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    if (consoleErrors.length >= 30) return;
    const location = message.location();
    consoleErrors.push({
      type: message.type(),
      text: maskString(message.text().slice(0, 240), keep, safe),
      at: location?.url ? `${sanitizeUrlForLog(location.url, origin)}:${location.lineNumber ?? 0}` : null,
    });
  });
  page.on("pageerror", (error) => {
    if (consoleErrors.length < 30) consoleErrors.push({ type: "pageerror", text: maskString(String(error.message).slice(0, 240), keep, safe), at: null });
  });
  page.on("requestfinished", async (request) => {
    if (network.length >= 400) return;
    const response = await request.response().catch(() => null);
    const timing = request.timing();
    network.push({
      method: request.method(),
      url: sanitizeUrlForLog(request.url(), origin),
      type: request.resourceType(),
      status: response?.status() ?? null,
      ms: timing.responseEnd > 0 ? Math.round(timing.responseEnd) : null,
    });
  });
  page.on("requestfailed", (request) => {
    if (network.length >= 400) return;
    network.push({ method: request.method(), url: sanitizeUrlForLog(request.url(), origin), type: request.resourceType(), status: null, failure: request.failure()?.errorText ?? "failed" });
  });

  const files = [];
  try {
    // 1. Reach the state.
    const target = new URL(address, origin).href;
    const verdict = classifyRequest({ method: "GET", url: target }, { origin });
    if (!verdict.allow) throw Object.assign(new Error(`address refused by the fence: ${verdict.reason}`), { outcome: "refused" });
    let response = await page.goto(target, { waitUntil: "domcontentloaded" }).catch((error) => {
      throw Object.assign(new Error(`navigation failed: ${String(error.message).split("\n")[0].slice(0, 160)}`), { outcome: "navigation-failed" });
    });
    steps.push(`goto ${entry.requested} -> ${response?.status() ?? "no response"}`);
    await settle(page);

    if (state.followFirst) {
      const link = page.locator(state.followFirst).first();
      if ((await link.count()) === 0) throw Object.assign(new Error(`no element matches ${state.followFirst}`), { outcome: "not-present" });
      const { verdict: control } = await vetControl(link, origin);
      if (!control.allowed) throw Object.assign(new Error(`link refused: ${control.reason}`), { outcome: "refused" });
      await Promise.all([page.waitForURL((url) => url.href !== page.url(), { timeout: 60_000 }).catch(() => {}), link.click()]);
      steps.push(`follow the page's first ${state.followFirst} -> ${sanitizeUrlForLog(page.url(), origin)}`);
      await settle(page);
    }
    if (state.click) {
      const candidates = page.locator(state.click.selector);
      const count = await candidates.count();
      let clicked = false;
      for (let i = 0; i < Math.min(count, 25) && !clicked; i += 1) {
        const candidate = candidates.nth(i);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        const blocked = await neverTouchHit(candidate, neverTouch);
        if (blocked) {
          steps.push(`skipped a never-touch control (${blocked})`);
          continue;
        }
        const { verdict: control, name } = await vetControl(candidate, origin);
        if (state.click.nameIncludes && !name.includes(state.click.nameIncludes)) continue;
        if (!control.allowed) {
          steps.push(`refused a control: ${control.reason}`);
          continue;
        }
        await candidate.click();
        clicked = true;
        steps.push(`click ${state.click.selector}${state.click.nameIncludes ? ` named "${state.click.nameIncludes}"` : ""}`);
      }
      if (!clicked) throw Object.assign(new Error(`no clickable, allowed element for ${state.click.selector}`), { outcome: "not-present" });
      await settle(page);
    }
    if (state.keyboard) {
      for (let i = 0; i < state.keyboard.presses; i += 1) await page.keyboard.press("Tab");
      const focus = await page.evaluate(() => {
        const element = document.activeElement;
        if (!element || element === document.body) return { focused: false };
        const style = getComputedStyle(element);
        const ring = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
        const shadow = style.boxShadow && style.boxShadow !== "none";
        const box = element.getBoundingClientRect();
        return { focused: true, tag: element.tagName.toLowerCase(), visibleIndicator: Boolean(ring || shadow), inViewport: box.top >= 0 && box.bottom <= innerHeight };
      });
      entry.focus = focus;
      steps.push(`press Tab x${state.keyboard.presses} -> ${focus.focused ? `${focus.tag}, indicator ${focus.visibleIndicator ? "visible" : "NOT visible"}` : "nothing focused"}`);
    }
    if (state.mock === "loading") {
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      // A page route outranks the context fence, so it re-asks the fence itself before letting go.
      await page.route(/[?&]_rsc=/, async (route) => {
        const request = route.request();
        if (!classifyRequest({ method: request.method(), url: request.url(), headers: request.headers() }, { origin }).allow) {
          await route.abort("blockedbyclient").catch(() => {});
          return;
        }
        await held;
        await route.continue().catch(() => {});
      });
      const link = page.locator('a[href*="/kpis/frequency"]').first();
      if ((await link.count()) === 0) throw Object.assign(new Error("no link to a sibling KPIs page to navigate through"), { outcome: "not-present" });
      const { verdict: control } = await vetControl(link, origin);
      if (!control.allowed) throw Object.assign(new Error(`link refused: ${control.reason}`), { outcome: "refused" });
      await link.click({ noWaitAfter: true });
      await page.waitForTimeout(1_500);
      steps.push("mock: the next page's server response held; captured while the app shows its loading state");
      entry._release = release;
    }
    if (state.mock === "error") {
      await page.route(/[?&]_rsc=/, (route) => route.fulfill({ status: 500, body: "mock failure" }));
      const tab = page.locator('a[href*="tab=am-pm"], a[href*="/kpis/coverage"]').first();
      if ((await tab.count()) === 0) throw Object.assign(new Error("no tab link to navigate through"), { outcome: "not-present" });
      const { verdict: control } = await vetControl(tab, origin);
      if (!control.allowed) throw Object.assign(new Error(`link refused: ${control.reason}`), { outcome: "refused" });
      await tab.click();
      await page.waitForTimeout(4_000);
      steps.push("mock: the next page's server response replaced with HTTP 500; captured what the reader sees");
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    }

    entry.landedOn = sanitizeUrlForLog(page.url(), origin);
    entry.httpStatus = response?.status() ?? null;

    // 2. Mask, then measure, then snapshot and shoot.
    const maskStats = await page.evaluate(pageCall(maskDocument, keepList, SAFE_WORDS));
    const measurements = await page.evaluate(measurePage, { mobile: VIEWPORTS[viewport].mobile });
    const shotsDir = path.join(outDir, "shots");
    const ariaDir = path.join(outDir, "aria");
    mkdirSync(shotsDir, { recursive: true });
    mkdirSync(ariaDir, { recursive: true });
    const rawAria = await page.locator("body").ariaSnapshot({ timeout: 20_000 }).catch(() => null);
    const aria = rawAria ? sanitizeAriaSnapshot(rawAria, origin, sanitizeUrlForLog) : null;
    // The snapshot is text a model reads: it gets the pattern check too, on top of the masked DOM.
    const ariaLeaks = aria ? findAriaLeaks(aria) : [];
    if (aria) {
      const ariaFile = path.join(ariaDir, `${shotId}.yml`);
      writeFileSync(ariaFile, aria);
      files.push(ariaFile);
    }
    const shotFile = path.join(shotsDir, `${shotId}.png`);
    await shootFullPage(page, shotFile, VIEWPORTS[viewport].width, { animations: "disabled", caret: "hide", timeout: 60_000 });
    files.push(shotFile);
    const scrollerShots = [];
    const marked = await page.evaluate(() => {
      const out = [];
      for (const element of document.body.querySelectorAll("*")) {
        if (out.length >= 4) break;
        const style = getComputedStyle(element);
        const y = /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
        const x = /(auto|scroll)/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1;
        if (!(x || y) || element.clientHeight < 40) continue;
        element.setAttribute("data-phx-scroller", String(out.length));
        out.push({ index: out.length, x, y });
      }
      return out;
    });
    for (const scroller of marked) {
      const locator = page.locator(`[data-phx-scroller="${scroller.index}"]`);
      await locator.evaluate((element) => {
        element.style.setProperty("max-height", "none", "important");
        element.style.setProperty("height", "auto", "important");
        element.style.setProperty("overflow", "visible", "important");
        element.style.setProperty("max-width", "none", "important");
        element.style.setProperty("width", "max-content", "important");
      });
      const file = path.join(shotsDir, `${shotId}--scroller-${scroller.index}.png`);
      await locator.screenshot({ path: file, timeout: 30_000 }).catch(() => null);
      files.push(file);
      scrollerShots.push({ file: path.relative(outDir, file).split(path.sep).join("/"), axis: scroller.x && scroller.y ? "both" : scroller.x ? "x" : "y" });
    }
    if (entry._release) {
      entry._release();
      delete entry._release;
    }

    // 3. The independent leak check. Any leak deletes every file of this shot.
    const verification = await page.evaluate(pageCall(verifyDocument, keepList, SAFE_WORDS));
    const keptTexts = maskStats.keptTexts;
    delete maskStats.keptTexts;
    const leakKinds = [...verification.leaks.map((leak) => leak.kind), ...ariaLeaks.map((kind) => `aria-${kind}`)];
    const leakCount = verification.leakCount + ariaLeaks.length;
    entry.redaction = { ...maskStats, leakCount, leakKinds: [...new Set(leakKinds)] };
    if (leakCount > 0) {
      for (const file of files) rmSync(file, { force: true });
      entry.outcome = "deleted-privacy-check-failed";
      entry.image = null;
      entry.scrollers = [];
    } else {
      entry.outcome = "captured";
      entry.image = path.relative(outDir, shotFile).split(path.sep).join("/");
      entry.aria = aria ? `aria/${shotId}.yml` : null;
      entry.scrollers = scrollerShots;
    }
    entry.measurements = summarizeMeasurements(measurements);
    entry.measurementDetail = measurements;
    entry.sourceCandidates = sourceIndexLookup(keptTexts);
  } catch (error) {
    entry.outcome = error.outcome ?? "error";
    entry.error = String(error.message).slice(0, 300);
    for (const file of files) rmSync(file, { force: true });
    entry.image = null;
  } finally {
    if (entry._release) entry._release();
    delete entry._release;
    await collectPageStoppedWrites(page, { origin }, stopped).catch(() => {});
    await context.close().catch(() => {});
  }
  entry.writesStopped = stopped;
  entry.console = consoleErrors;
  entry.network = {
    requests: network.length,
    failed: network.filter((item) => item.status === null || item.status >= 400).slice(0, 20),
    slowest: [...network].filter((item) => item.ms !== null).sort((a, b) => b.ms - a.ms).slice(0, 5),
  };
  entry.ms = Date.now() - started;
  return { entry, network };
}

/** The permission check for a persona that must NOT reach the board. */
export async function probeDenied(browser, job) {
  const { origin, persona, address, keepList } = job;
  const stopped = [];
  const context = await openFencedContext(browser, { origin, viewport: "desktop", storageState: job.storageState, stoppedLog: stopped });
  const page = await context.newPage();
  const result = { persona: persona.id, role: persona.role, requested: sanitizeUrlForLog(new URL(address, origin).href, origin) };
  try {
    const response = await page.goto(new URL(address, origin).href, { waitUntil: "domcontentloaded" });
    await settle(page);
    result.httpStatus = response?.status() ?? null;
    result.landedOn = sanitizeUrlForLog(page.url(), origin);
    const facts = await page.evaluate(() => ({
      tabStrip: Boolean(document.querySelector('a[href*="tab=call-rate"], a[href*="/kpis/call-rate"]')),
      railOffersKpis: Boolean(document.querySelector('nav a[href="/employee-portals/kpis"], aside a[href="/employee-portals/kpis"]')),
    }));
    result.boardRendered = facts.tabStrip;
    result.railOffersKpis = facts.railOffersKpis;
    result.outcome = facts.tabStrip ? "REACHED-UNEXPECTEDLY" : "denied-as-expected";
    await page.evaluate(pageCall(maskDocument, keepList, SAFE_WORDS));
    const verification = await page.evaluate(pageCall(verifyDocument, keepList, SAFE_WORDS));
    if (verification.leakCount === 0 && job.outDir) {
      const file = path.join(job.outDir, "shots", `${job.shotId}.png`);
      mkdirSync(path.dirname(file), { recursive: true });
      await shootFullPage(page, file, VIEWPORTS.desktop.width, {});
      result.image = path.relative(job.outDir, file).split(path.sep).join("/");
    }
  } catch (error) {
    result.outcome = "navigation-failed";
    result.error = String(error.message).split("\n")[0].slice(0, 200);
  } finally {
    await collectPageStoppedWrites(page, { origin }, stopped).catch(() => {});
    await context.close().catch(() => {});
  }
  result.writesStopped = stopped;
  return result;
}
