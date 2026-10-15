// Does the Production Planner fit the screen — in BOTH shells, at every width?
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//   node scripts/measure-production-planning-fit.mjs --capture xlsx/../planner-fixture.json
//   node --experimental-strip-types --experimental-specifier-resolution=node \
//     --experimental-loader ./scripts/needs-you-fit-loader.mjs \
//     scripts/measure-production-planning-fit.mjs --fixture <that file>
//
// (`pnpm run ui:measure-production-planning-fit -- --fixture <file>` from the PRIMARY checkout;
// never `pnpm` inside a worktree — AGENTS.md §5. `--capture` needs `--env-file=.env.local`.)
//
// WHY THIS SCRIPT HAD TO EXIST. `tests/production-planning-fits-the-screen.test.ts` is the cheap
// half that runs in the required `validate` job: it pins the constructs that let an overflow happen
// at all — no `overflow-x-*`, no `min-w-[…]`, a `table-fixed` with a colgroup summing to 100%, a
// `flex-wrap` tab strip. Its own header says what it cannot do: "that measurement is a browser's
// job (`scrollWidth > clientWidth` over `main` at 1024px, 1280px and 375px, in both surfaces) and
// this file cannot do it". This is that job. A required CI check must never depend on a browser
// being in the runner image, which is why it is a script and not a test — the same reason
// `scripts/measure-rankings-fit.mjs` and `scripts/measure-needs-you-fit.mjs` are scripts.
//
// 🔴 AND WHY IT CANNOT BE DONE IN A BROWSER ON PRODUCTION. This module is dual-surface, and each
// twin REDIRECTS the other shell's viewer to its sibling: `app/(admin)/admin/production-planning`
// sends a portal-mode viewer to `/employee-portals/production-planning` and that page sends an
// admin-mode viewer back. So an account reaches exactly ONE of the two shells, ever. The owner is
// Super Admin — admin mode — so his own signed-in session can never render the PORTAL surface,
// which is the one its main user (Dr. Sahar Khalil, `Manager`) actually opens, and the one with the
// tighter content box. Production does not accept dev-auth headers either. Measuring the portal
// shell therefore means rendering the real components inside the portal's own container chain,
// which is exactly what this does.
//
// It renders the REAL tab components — the house rule is to verify the emitted artifact, never the
// source — wraps each in its shell's own container chain, and styles them with the repository's own
// `app/globals.css` compiled by the repository's own Tailwind. The loader, the shell chain and the
// Tailwind compile are `measure-needs-you-fit.mjs`'s, which documents why each is built that way.
//
// EVERY ZERO IS EARNED. Three positive controls run at each width in each shell, each failing in
// the direction being tested, because a harness that is silently not measuring — Tailwind never
// loaded, the viewport never took, the selector matched nothing — looks exactly like a page that
// fits.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "measure-production-planning-fit",
  entry: import.meta.url,
  known: ["--capture", "--fixture", "--phx-display-scale"],
  hints: [
    "--capture <file> writes the fixture; --fixture <file> measures it",
  ],
});

const require = createRequire(import.meta.url);
const ROOT = process.cwd();

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? null : args[at + 1] ?? "";
};
const capturePath = flag("--capture");
const fixturePath = flag("--fixture");

// ── --capture: write the real workspace payload, so the measurement runs on real data ───────────
//
// Deliberately a separate mode and never the default: the payload is written where the caller asks.
// A measurement on invented data would prove nothing anyway — the names are Arabic and six-figure
// piece counts are what a column has to hold.
//
// 🔴 THIS USED TO SAY THE PAYLOAD IS NEVER COMMITTED, BECAUSE IT CARRIES RAW-MATERIAL PRICES.
// Measured 2026-10-09, it carries none: 0 of 12 materials priced, 0 of 12 plan rows with a unit
// price, `plan.totals.costEgp` "0.00", `unpricedMaterials` 10. The ban was therefore keeping the
// whole measurement locked to a machine with production credentials AND enough free memory for
// chromium plus a Tailwind compile — which is why it had gone unrun. So one capture now lives at
// `tests/fixtures/production-planning-fit.json`, and the ban became a required check:
// `tests/production-planning-fit-fixture.test.ts` goes red the moment a committed fixture holds a
// real price. A capture made AFTER the owner prices these materials is still yours to keep out of
// git — write it anywhere and pass it with `--fixture`.
if (capturePath) {
  const { getProductionPlanningWorkspace } = await import("../src/lib/production-planning/service.ts");
  const workspace = await getProductionPlanningWorkspace(
    { hrId: "B-10", loginId: "B-10", role: "Super Admin", scope: { kind: "all" }, source: "system" },
    { mode: "total_boxes", productId: null, requestedQty: "100000", sampleUnits: "10000" },
  );
  fs.writeFileSync(capturePath, JSON.stringify(workspace, null, 2), "utf8");
  console.log(
    `captured ${fs.statSync(capturePath).size} bytes to ${capturePath} — ${workspace.materials.length} materials, ` +
      `${workspace.plan?.rows?.length ?? 0} plan rows, level ${workspace.level}`,
  );
  process.exit(0);
}

if (!fixturePath || !fs.existsSync(fixturePath)) {
  console.error(
    "measure-production-planning-fit: --fixture <file> is required (and must exist).\n" +
      "A committed one is here, captured 2026-10-09 and pinned price-free by\n" +
      "tests/production-planning-fit-fixture.test.ts:\n" +
      "    --fixture tests/fixtures/production-planning-fit.json\n" +
      "To refresh it against live data:  node --env-file=.env.local --experimental-strip-types " +
      "--experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \\\n" +
      "    scripts/measure-production-planning-fit.mjs --capture <file>\n" +
      "There is still no built-in default on purpose: a synthetic fixture measures a table nobody " +
      "will ever see, and a refreshed capture must stay out of git once these materials are priced.",
  );
  process.exit(2);
}

const React = require("react");
// The <Link> stub inside needs-you-fit-loader.mjs reads React from here — a data: URL module cannot
// resolve a bare specifier.
globalThis.__needsYouFitReact = React;
// react 19.3.0 against react-dom 19.2.8: `react-dom/server` refuses to load when the two disagree,
// and only a standalone SSR script ever meets this. See measure-needs-you-fit.mjs — it is a lie
// about a version string and nothing else.
Object.defineProperty(React, "version", {
  configurable: true,
  value: require("react-dom/package.json").version,
  writable: true,
});
const { renderToStaticMarkup } = require("react-dom/server");
const { chromium } = require("playwright");

const workspace = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

const {
  CostTab,
  PlannerTab,
  ProductionPlanningHeader,
  ProductionPlanningLanguageProvider,
  RunTab,
  SettingsTab,
  StockTab,
} = await import("../src/components/production-planning/production-planning-workspace.tsx");
const { productionPlanningStrings } = await import("../src/lib/production-planning/strings.ts");

// ── The emitted artifact ────────────────────────────────────────────────────────────────────────

const noop = () => {};
const noopAsync = async () => {};
const materialsById = new Map((workspace.materials ?? []).map((material) => [material.id, material]));
const productId = workspace.products?.[0]?.id ?? "";

/**
 * Every tab, rendered at once, under one tab strip.
 *
 * All five at once rather than one run per tab: the widest thing on this screen may not be on the
 * tab that was opened, and a per-tab sweep is five chances to measure the four that fit. The strip
 * itself is the module's own markup (`flex flex-wrap`, never a scroller — on a right-to-left page a
 * horizontal scroller opens at the LEFT, which is the END of the line, so the FIRST tab is the one
 * off screen).
 */
function AllTabs({ lang }) {
  const S = productionPlanningStrings(lang);
  return React.createElement(
    "div",
    { className: "min-w-0", dir: S.dir, lang: S.lang },
    React.createElement(
      "div",
      { className: "mt-4 flex flex-wrap gap-2", role: "tablist" },
      S.tabs.map((entry) =>
        React.createElement(
          "button",
          {
            className: "border border-slate-300 bg-white px-3 py-1.5 text-[12px] font-bold text-slate-700",
            key: entry.key,
            role: "tab",
            type: "button",
          },
          entry.label,
        ),
      ),
    ),
    React.createElement(
      "div",
      { className: "mt-4 space-y-4" },
      React.createElement(PlannerTab, {
        busy: false,
        canWrite: true,
        data: workspace,
        key: "planner",
        mode: "total_boxes",
        onCalculate: noop,
        onCommit: noop,
        onModeChange: noop,
        onOverrideChange: noop,
        onProductChange: noop,
        onRequestedChange: noop,
        onSamplesChange: noop,
        onWillSendChange: noop,
        overridePct: "",
        plan: workspace.plan ?? null,
        productId,
        requestedQty: "100000",
        sampleUnits: "10000",
        willSend: {},
      }),
      React.createElement(StockTab, { busy: false, canWrite: true, data: workspace, key: "stock", onSave: noopAsync }),
      React.createElement(CostTab, {
        busy: false,
        canWrite: true,
        data: workspace,
        key: "cost",
        onSave: noopAsync,
        plan: workspace.plan ?? null,
      }),
      React.createElement(RunTab, {
        busy: false,
        canWrite: true,
        data: workspace,
        key: "run",
        materialsById,
        onSave: noopAsync,
      }),
      React.createElement(SettingsTab, {
        busy: false,
        canWrite: true,
        data: workspace,
        key: "settings",
        onSave: noopAsync,
      }),
    ),
  );
}

/**
 * The module in one language, header included, under the real provider.
 *
 * The provider rather than a prop because that is how the module resolves its own language, and
 * `initialLang` is the only door into it from outside a browser. BOTH languages are measured and
 * neither is derived from the other: English is a LEFT-TO-RIGHT layout of different strings, so its
 * columns, its header rail and its wrap points are a second layout, not a translation of a measured
 * one. The owner chose the language with a toggle, which means both are a reader's real screen.
 */
function moduleFor(lang) {
  return renderToStaticMarkup(
    React.createElement(
      ProductionPlanningLanguageProvider,
      { initialLang: lang },
      React.createElement(ProductionPlanningHeader, null),
      React.createElement(AllTabs, { lang }),
    ),
  );
}

const LANGS = ["ar", "en"];
const MODULE_HTML = new Map(LANGS.map((lang) => [lang, moduleFor(lang)]));

// ── The two shells, geometry only ───────────────────────────────────────────────────────────────

/**
 * `src/components/layout/app-shell.tsx`'s own chain plus its 272px rail. No nav content: a rail's
 * WIDTH is the only thing of it that reaches the content box, and the admin planner page wraps the
 * module in `space-y-6 p-6 sm:p-8`.
 */
const ADMIN_CHAIN = (inner) => `
<div class="min-h-screen text-phx-ink admin-shell bg-[#F3F6FA]">
  <div class="flex min-h-screen">
    <aside class="sticky top-0 z-40 hidden h-screen shrink-0 flex-col lg:flex border-r w-[272px]"></aside>
    <div class="flex min-w-0 flex-1 flex-col">
      <div class="phx-navrow-scope flex min-w-0 flex-1 flex-col">
        <main class="phx-zoom-surface min-w-0 flex-1 px-3 py-4 sm:px-4 sm:py-5 lg:px-4 lg:py-6 xl:px-5">
          <div class="w-full mx-auto phx-shell-cap-admin">
            <div class="space-y-6 p-6 sm:p-8">${inner}</div>
          </div>
        </main>
      </div>
    </div>
  </div>
</div>`;

/**
 * `src/components/employee-portal/employee-portal-layout.tsx`'s row above `<main>`, its 324px
 * `lg:block` rail and `<main>` itself, plus the `employee-portal-page-frame` wrapper
 * `EmployeePortalPageShell` (enterprise-shell.tsx) puts around its children.
 *
 * THIS is the box that matters. It pads more than the admin one — `lg:pl-8` against `lg:px-4`, and
 * a 324px rail against 272px — so the planner is TIGHTER in the shell its main user opens than in
 * the one the owner's own account sees.
 */
const PORTAL_CHAIN = (inner) => `
<div class="min-h-screen bg-[#F3F6FA] text-phx-ink">
  <div class="relative mx-auto flex w-full max-w-[1580px] items-start gap-4 px-3 py-4 sm:px-4 sm:py-5 lg:gap-4 lg:py-7 lg:pl-8 lg:pr-4">
    <aside class="hidden shrink-0 self-stretch transition-[width] duration-200 lg:block w-[324px]"></aside>
    <div class="flex min-w-0 flex-1 flex-col">
      <main class="phx-zoom-surface employee-portal-mobile-safe min-w-0 flex-1 space-y-5 lg:space-y-7 lg:pb-0 pb-[8.5rem]">
        <div class="employee-portal-page-frame mx-auto w-full space-y-5" dir="auto">${inner}</div>
      </main>
    </div>
  </div>
</div>`;

function page(chain, css, inner, lang) {
  const S = productionPlanningStrings(lang);
  return `<!doctype html>
<html lang="${S.lang}" dir="${S.dir}"><head><meta charset="utf-8"><title>Production Planner fit harness</title>
<style>${css}</style></head><body>${chain(inner)}</body></html>`;
}

/** The repo's own globals.css, compiled by the repo's own Tailwind against the emitted markup. */
async function compileCss(html) {
  const storeRoot = findStoreRoot();
  const nodeApi = path.join(storeRoot, ".pnpm/@tailwindcss+node@4.3.3/node_modules/@tailwindcss/node/dist/index.mjs");
  if (!fs.existsSync(nodeApi)) {
    throw new Error(
      `@tailwindcss/node 4.3.3 is not in the pnpm store at ${nodeApi}. This harness compiles the ` +
        `repo's real globals.css, so it cannot fall back to a CDN build without measuring different CSS.`,
    );
  }
  const { compile } = await import(pathToFileURL(nodeApi).href);
  const globals = fs.readFileSync(path.join(ROOT, "app/globals.css"), "utf8");
  if (!globals.includes('@import "tailwindcss";')) {
    throw new Error('app/globals.css no longer contains `@import "tailwindcss";` — update the source(none) patch.');
  }
  const compiler = await compile(globals.replace('@import "tailwindcss";', '@import "tailwindcss" source(none);'), {
    base: path.resolve(ROOT, "app"),
    onDependency: () => {},
  });
  const candidates = new Set();
  for (const match of html.matchAll(/class="([^"]*)"/g)) {
    for (const token of (match[1] ?? "").split(/\s+/)) if (token) candidates.add(token);
  }
  // Not emitted by this module — it is the radius control's own class, and the control has to be
  // able to come back non-zero for its zero to mean anything.
  candidates.add("rounded-lg");
  return { candidateCount: candidates.size, css: compiler.build([...candidates]) };
}

/** The pnpm store lives in the PRIMARY checkout; a worktree has only a junction. */
function findStoreRoot() {
  let dir = ROOT;
  for (let hop = 0; hop < 8; hop += 1) {
    if (fs.existsSync(path.join(dir, "node_modules/.pnpm"))) return path.join(dir, "node_modules");
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not find node_modules/.pnpm walking up from the working directory.");
}

// ── The measurements ────────────────────────────────────────────────────────────────────────────

const READ = (expected, expectedDir) => `(() => {
  const main = document.querySelector("main");
  const vw = window.innerWidth;
  const past = [];
  for (const el of document.querySelectorAll("main *")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && (r.right > vw + 0.5 || r.left < -0.5)) {
      past.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || "").slice(0, 60), left: Math.round(r.left), right: Math.round(r.right) });
    }
  }
  const clipped = [];
  for (const cell of document.querySelectorAll("main td, main th")) {
    const over = cell.scrollWidth - cell.clientWidth;
    if (over > 1) clipped.push({ over: over, text: (cell.textContent || "").trim().slice(0, 36) });
  }
  const radii = [];
  for (const el of document.querySelectorAll("main *")) {
    const rad = getComputedStyle(el).borderRadius;
    if (rad && rad !== "0px" && rad.indexOf("0px 0px 0px 0px") !== 0) {
      radii.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || "").slice(0, 60), radius: rad });
    }
  }
  const scrollers = [];
  for (const el of document.querySelectorAll("main *")) {
    const ox = getComputedStyle(el).overflowX;
    if ((ox === "auto" || ox === "scroll") && el.scrollWidth > el.clientWidth + 1) {
      scrollers.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || "").slice(0, 60), over: el.scrollWidth - el.clientWidth });
    }
  }
  const strip = document.querySelector('main [role="tablist"]');
  // The REAL header's own root, reached from its h1, and not a wrapper this harness wrote: a
  // direction read off the harness's own markup would be the harness agreeing with itself. The
  // header sets its direction from the bundle, so this is where a hard-coded one surviving the
  // toggle shows up - the strings flip and the layout stays facing the other way.
  // (No backticks in here: this comment is inside a template literal, and one ends it.)
  const titled = document.querySelector("main h1");
  const moduleRoot = titled ? titled.closest("[dir]") : null;
  const tables = [...document.querySelectorAll("main table")].filter((t) => t.getBoundingClientRect().width > 0);
  const first = tables[0] || null;
  // The Latin-digits ruling: Intl's "ar-EG" emits Arabic-Indic numerals, and this is where that
  // would show up as a rendered figure rather than as a string in the source.
  const arabicIndic = ((main ? main.textContent : "") || "").match(/[٠-٩۰-۹]/g) || [];
  return {
    innerWidth: vw,
    widthTook: vw === ${expected},
    moduleDir: moduleRoot ? getComputedStyle(moduleRoot).direction : null,
    dirTook: moduleRoot ? getComputedStyle(moduleRoot).direction === "${expectedDir}" : false,
    mainClientWidth: main ? main.clientWidth : -1,
    // clientWidth, NOT getBoundingClientRect: under CSS zoom a rect is VISUAL px and clientWidth is
    // LAYOUT px, so mixing them reports a box 20% narrower than the one the columns were laid out in.
    contentBox: (function () { const b = main ? main.firstElementChild : null; return b ? b.clientWidth : -1; })(),
    pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    mainOverflow: main ? main.scrollWidth > main.clientWidth : null,
    arabicIndic: arabicIndic,
    past: past, clipped: clipped, radii: radii, scrollers: scrollers,
    stripRows: strip ? new Set([...strip.children].map((c) => Math.round(c.getBoundingClientRect().top))).size : -1,
    stripOverflow: strip ? strip.scrollWidth - strip.clientWidth : -1,
    tableCount: tables.length,
    tableWidth: first ? first.clientWidth : 0,
    tableLayout: first ? getComputedStyle(first).tableLayout : null,
    headCells: first ? [...first.querySelectorAll("thead th")].map((th) => th.clientWidth) : [],
    cardLists: document.querySelectorAll("main ul.lg\\\\:hidden, main div.lg\\\\:hidden").length,
    // Zero means the compiled CSS never applied, and every reading above would be a bare-HTML
    // measurement wearing the shape of a styled one.
    cssApplied: main ? getComputedStyle(main).flexGrow === "1" : false,
    zoom: main ? getComputedStyle(main).zoom : null,
  };
})()`;

const CTRL_PROBE = `(() => {
  const main = document.querySelector("main");
  const p = document.createElement("div");
  p.id = "ctrl-probe";
  p.style.cssText = "width:" + (main.clientWidth + 500) + "px;height:4px;background:red";
  main.prepend(p);
  const vw = innerWidth;
  let n = 0;
  for (const el of document.querySelectorAll("main *")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && (r.right > vw + 0.5 || r.left < -0.5)) n += 1;
  }
  document.getElementById("ctrl-probe").remove();
  return n;
})()`;

// A LATIN unbreakable token: Arabic offers break opportunities between letters and wraps even with
// overflow-wrap forced to normal, so an Arabic one is not a control at all.
const CTRL_CELL = `(() => {
  const cell = [...document.querySelectorAll("main tbody td")].find((el) => el.getBoundingClientRect().width > 0);
  if (!cell) return { ran: false };
  const html = cell.innerHTML;
  const wrap = cell.style.overflowWrap;
  cell.style.overflowWrap = "normal";
  cell.style.wordBreak = "normal";
  // Sized to the CELL, not a fixed count: at 1920px a column is 485px wide and nine repeats of an
  // 8-character token no longer overflow it, so a fixed count stops being a control exactly where
  // the page is widest — and reads as a pass.
  const repeats = Math.max(9, Math.ceil(cell.clientWidth / 60) + 4);
  cell.innerHTML = "<span>" + "Mohammed".repeat(repeats) + "</span>";
  const over = cell.scrollWidth - cell.clientWidth;
  cell.innerHTML = html;
  cell.style.overflowWrap = wrap;
  cell.style.wordBreak = "";
  return { ran: true, fired: over > 1, over: over, repeats: repeats, restored: cell.scrollWidth - cell.clientWidth };
})()`;

// The Latin-digits reading has to be able to come back non-zero, or a zero means only that the
// scan never looked. An injected Arabic-Indic token is the one control for it.
const CTRL_DIGITS = `(() => {
  const main = document.querySelector("main");
  const probe = document.createElement("span");
  probe.textContent = "١٢٣";
  main.prepend(probe);
  const hits = ((main.textContent) || "").match(/[٠-٩۰-۹]/g) || [];
  probe.remove();
  return hits.length;
})()`;

// An INLINE radius, because `rounded-lg` computes to 0px here — globals.css sweeps it, so a class
// probe reads the same 0px as a correct page and would certify a deleted sweep.
const CTRL_RADIUS = `(() => {
  const p = document.createElement("div");
  p.style.cssText = "width:10px;height:10px;border-radius:9px";
  document.querySelector("main").appendChild(p);
  const rad = getComputedStyle(p).borderRadius;
  p.remove();
  return rad;
})()`;

const WIDTHS = [375, 768, 1024, 1280, 1920];
const SHELLS = [
  ["admin  (Super Admin, CEO, Finance Manager)", ADMIN_CHAIN],
  ["portal (Dr. Sahar Khalil, Reham Elwiy)", PORTAL_CHAIN],
];

/**
 * Both display scales, because `.phx-zoom-surface { zoom: var(--phx-display-scale, 1) }` makes the
 * LAYOUT box a different width from the visual one — and the two cases are not equivalent.
 *
 * At 1 (the default every user starts on) the layout box is the SMALLEST it gets, so that is the
 * tight case for a table. At 0.8 — which is what the owner's own session is set to — the layout box
 * is a quarter wider, which is why a figure measured in his browser does not match a figure measured
 * at the default and neither is wrong. A sweep that read only one of them would certify half the
 * users.
 */
const SCALES = [1, 0.8];

// ── Run ─────────────────────────────────────────────────────────────────────────────────────────

const { candidateCount, css } = await compileCss(
  LANGS.map((lang) => ADMIN_CHAIN(MODULE_HTML.get(lang)) + PORTAL_CHAIN(MODULE_HTML.get(lang))).join(""),
);

console.log(`\nProduction Planner — fit and square-edge measurement, in BOTH shells`);
console.log(`  fixture: ${fixturePath} — ${workspace.materials?.length ?? 0} materials, ${workspace.plan?.rows?.length ?? 0} plan rows`);
console.log(
  `  rendered module: ${LANGS.map((lang) => `${lang} ${MODULE_HTML.get(lang).length}B`).join(" · ")}` +
    ` · compiled CSS: ${css.length} bytes from ${candidateCount} candidates`,
);
console.log(`  served over HTTP — a file:// tab loads as a static snapshot and Tailwind never applies\n`);

let failures = 0;
const fail = (line) => {
  failures += 1;
  console.log(`  FAIL  ${line}`);
};

const browser = await chromium.launch();

for (const [shellName, chain] of SHELLS) {
  for (const lang of LANGS) {
  const name = `${shellName} · ${lang}`;
  const html = page(chain, css, MODULE_HTML.get(lang), lang);
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const tab = await browser.newPage();
  await tab.goto(url, { waitUntil: "load" });

  console.log(`  ── ${name} ────────────────────────────────────`);
  for (const scale of SCALES) {
  await tab.evaluate(`document.documentElement.style.setProperty("--phx-display-scale", "${scale}")`);
  console.log(`    display scale ${scale}${scale === 1 ? " (the default)" : " (the owner's own session)"}`);
  for (const width of WIDTHS) {
    await tab.setViewportSize({ height: 1200, width });
    const reading = await tab.evaluate(READ(width, productionPlanningStrings(lang).dir));
    // The display scale is gated to `@media screen and (min-width: 1024px)` in globals.css —
    // "below 1024px no zoom is applied" — so BELOW that width zoom 1 is the correct reading and
    // asserting the chosen scale there would be asserting the opposite of the rule.
    const expectedZoom = width >= 1024 ? String(scale) : "1";
    const zoomRead = reading.zoom === "normal" ? "1" : reading.zoom;
    if (zoomRead !== expectedZoom) {
      fail(`${name} ${width}px: <main> computes zoom "${reading.zoom}", not ${expectedZoom} — the scale did not take, so this row is not the case it claims.`);
      continue;
    }

    console.log(
      `  ${String(width).padStart(4)}px  main ${String(reading.mainClientWidth).padStart(5)}px  ` +
        `box ${String(reading.contentBox).padStart(5)}px  tabs ${reading.stripRows} row(s)  ` +
        `tables ${reading.tableCount}` +
        (reading.tableWidth ? ` · first ${reading.tableWidth}px [${reading.headCells.join("/")}]` : " (cards only)"),
    );

    if (!reading.widthTook) {
      fail(`${name} ${width}px: the viewport did not take (innerWidth ${reading.innerWidth}). Every reading below is fiction.`);
      continue;
    }
    if (!reading.dirTook) {
      fail(
        `${name} ${width}px: the module root computes direction "${reading.moduleDir}", not ` +
          `"${productionPlanningStrings(lang).dir}" — the language did not flip the layout, so this row ` +
          `is the other language's measurement wearing this one's name.`,
      );
      continue;
    }
    if (!reading.cssApplied) {
      fail(`${name} ${width}px: <main> does not compute flex-grow:1, so the compiled CSS never applied and nothing was really measured.`);
      continue;
    }

    const probe = await tab.evaluate(CTRL_PROBE);
    if (!(probe > reading.past.length)) {
      fail(
        `${name} ${width}px: the over-wide probe control did not fire (${reading.past.length} → ${probe}). ` +
          `An over-wide child MUST be detected; without that, the zeros mean nothing.`,
      );
    }
    if (reading.tableWidth > 0) {
      const cell = await tab.evaluate(CTRL_CELL);
      if (!cell.ran || !cell.fired || cell.restored > 1) {
        fail(`${name} ${width}px: the per-cell clip control did not fire (${JSON.stringify(cell)}).`);
      }
      if (reading.tableLayout !== "fixed") {
        fail(`${name} ${width}px: table-layout reads "${reading.tableLayout}", not "fixed" — the colgroup is not governing the columns.`);
      }
    }
    if (!((await tab.evaluate(CTRL_DIGITS)) > 0)) {
      fail(`${name} ${width}px: an injected Arabic-Indic token was not detected, so the Latin-digits reading proves nothing.`);
    }
    if ((await tab.evaluate(CTRL_RADIUS)) === "0px") {
      fail(`${name} ${width}px: an inline border-radius: 9px probe measured 0px, so the radius reading proves nothing.`);
    }

    if (reading.pageOverflow || reading.mainOverflow) {
      fail(`${name} ${width}px: scrollWidth exceeds clientWidth. That is the fits-the-screen golden rule broken outright.`);
    }
    if (reading.past.length > 0) {
      fail(`${name} ${width}px: ${reading.past.length} element(s) outside the viewport — ${JSON.stringify(reading.past.slice(0, 3))}`);
    }
    if (reading.clipped.length > 0) {
      fail(`${name} ${width}px: ${reading.clipped.length} cell(s) clip their own content — ${JSON.stringify(reading.clipped.slice(0, 3))}`);
    }
    if (reading.scrollers.length > 0) {
      fail(`${name} ${width}px: ${reading.scrollers.length} sideways scroller(s) — ${JSON.stringify(reading.scrollers.slice(0, 2))}`);
    }
    if (reading.radii.length > 0) {
      fail(
        `${name} ${width}px: ${reading.radii.length} element(s) carry a corner radius — ` +
          `${JSON.stringify(reading.radii.slice(0, 4))}. The square-edge golden rule is no round corners, anywhere.`,
      );
    }
    if (reading.stripOverflow > 1) {
      fail(
        `${name} ${width}px: the tab strip scrolls sideways by ${reading.stripOverflow}px — on a right-to-left ` +
          `page that hides the FIRST tab, not the last.`,
      );
    }
    // The Latin-digits ruling, measured on the RENDERED text rather than on the source: a string
    // test cannot see what `Intl` emitted, and `ar-EG` emits Arabic-Indic numerals.
    if (reading.arabicIndic.length > 0) {
      fail(
        `${name} ${width}px: ${reading.arabicIndic.length} Arabic-Indic numeral(s) rendered — ` +
          `${JSON.stringify(reading.arabicIndic.slice(0, 6))}. Every figure in this module is Latin.`,
      );
    }
  }
  console.log("");
  }
  await tab.close();
  server.close();
  }
}

await browser.close();

console.log(
  failures === 0
    ? `Every width in BOTH shells read clean with its controls firing. The planner fits at 375px and at\n` +
        `desktop in the admin shell and in the tighter portal one, its tab strip wraps instead of\n` +
        `scrolling, and nothing under <main> carries a corner radius.\n`
    : `${failures} failure(s) above. Nothing here is proven — fix the page, or fix the harness, and re-run.\n`,
);
process.exit(failures === 0 ? 0 : 1);
