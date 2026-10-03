// Does /sales/rankings actually fit the screen, and are its corners actually square?
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//   node --experimental-strip-types --experimental-specifier-resolution=node \
//     --experimental-loader ./scripts/needs-you-fit-loader.mjs scripts/measure-rankings-fit.mjs
//
// (`pnpm run ui:measure-rankings-fit` from the PRIMARY checkout; never `pnpm` inside a worktree —
// AGENTS.md §5.)
//
// WHY A SCRIPT AND NOT A TEST: it launches real Chromium, and a required CI check must never depend
// on a browser being in the runner image — the same reason `scripts/measure-needs-you-fit.mjs` and
// `scripts/check-payslip-page-fit.mjs` are scripts. `tests/sales-rankings.test.ts` is the cheap half
// that runs in `validate` and stops the classes and the colgroup arithmetic coming back; this is the
// half that answers whether the pixels are right.
//
// It renders the REAL component — the house rule is to verify the emitted artifact, never the source
// — wraps it in `app-shell.tsx`'s own container chain, and styles it with the repository's own
// `app/globals.css` compiled by the repository's own Tailwind. The loader, the shell chain, the
// Tailwind compile and all four controls are `measure-needs-you-fit.mjs`'s, which documents why each
// one is built the way it is; only the fixture and the component differ.
//
// EVERY ZERO IS EARNED. Three positive controls run at each width, each failing in the direction
// being tested — a harness reporting "no overflow" looks identical to one that is silently not
// measuring (Tailwind never loaded, the viewport never took, the selector matched nothing).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

const React = require("react");
// The <Link> stub inside needs-you-fit-loader.mjs reads React from here — a data: URL module cannot
// resolve a bare specifier.
globalThis.__needsYouFitReact = React;

// react 19.3.0 against react-dom 19.2.8: `react-dom/server` refuses to load when the two disagree,
// and only a standalone SSR script ever meets this (Next serves its own bundled pair). See the long
// note in measure-needs-you-fit.mjs — it is a lie about a version string and nothing else.
Object.defineProperty(React, "version", {
  configurable: true,
  value: require("react-dom/package.json").version,
  writable: true,
});
const { renderToStaticMarkup } = require("react-dom/server");
const { chromium } = require("playwright");

const { RankingsExplorer } = await import("../src/components/sales/rankings/rankings-explorer.tsx");

const ROOT = process.cwd();
const REPO_NODE_MODULES_OWNER = path.resolve(ROOT, "app");

// ── The fixture ─────────────────────────────────────────────────────────────────────────────────

/**
 * REAL names from production, longest first — the same six `measure-needs-you-fit.mjs` uses, for the
 * same reason: invented names prove nothing, and the longest name on the system is 55 characters.
 * A board of "Ahmed Samir" would fit anything.
 */
const LONGEST_REAL_NAMES = [
  "Muhammad Muhammad AlMinshawy AbualMaati Muhammad Ismail",
  "Mustafa Abdelhamid Mohamed Mohamed El Kabbani",
  "Ahmed Nabil Basim Abdelaziz Youssef Mohamed",
  "Hossam Mohamed Reda AboElftouh Abdelghafar",
  "Ahmed BahaElDin Suliman Ibrahim Al Maraghi",
  "Nada Mohamed Abdelmoaty Mohamed Elsharkawy",
];

const LINES = [
  { code: "cns", label: "CNS" },
  { code: "anti_infective", label: "Anti Infective" },
  { code: "pedia", label: "Pedia" },
];

function entry(index) {
  const line = LINES[index % LINES.length];
  return {
    key: `B${100 + index}`,
    hrId: `B-${100 + index}`,
    name: LONGEST_REAL_NAMES[index % LONGEST_REAL_NAMES.length],
    // The longest real job title on the system, and the widest the subtitle can legitimately be.
    title: index % 3 === 0 ? "Senior Medical Representative" : "Medical Representative",
    lineCode: line.code,
    lineLabel: line.label,
    regionName: index % 2 === 0 ? "Upper Egypt" : "Delta and Canal",
    hasPhoto: false,
    rank: index + 1,
    // A real spread, and 1569.9% is the widest achievement this module has ever printed.
    achievementPercent: index === 0 ? 1569.9 : 180 - index * 7,
    salesValue: 9_876_543 - index * 311_111,
    coveredValue: 8_765_432,
    targetValue: 1_234_567,
    priorRank: index === 2 ? null : index + 3,
    trend: index === 2 ? null : 2,
  };
}

const overall = Array.from({ length: 12 }, (_, index) => entry(index));

const DATA = {
  mode: "quarter",
  window: {
    mode: "quarter",
    anchor: "2026-08",
    periods: ["2026-07", "2026-08"],
    from: "2026-07",
    to: "2026-08",
    label: "Q3 2026",
    rangeLabel: "Jul – Aug 2026",
    prior: { periods: ["2026-04"], from: "2026-04", to: "2026-06", label: "Q2 2026" },
  },
  filters: { lines: [], titles: [], regions: [], query: "" },
  boards: {
    overall,
    byLine: LINES.map((line, index) => ({
      lineCode: line.code,
      lineLabel: line.label,
      entries: overall.filter((row) => row.lineCode === line.code).map((row, place) => ({ ...row, rank: place + 1 })),
      seats: [40, 30, 41][index],
      vacant: [9, 12, 14][index],
    })),
    ranked: overall.length,
    seats: 111,
    vacant: 35,
  },
  focus: null,
  publishedMonths: ["2026-07", "2026-08"],
  anchorOptions: [
    { value: "2026-08", label: "Q3 2026" },
    { value: "2026-06", label: "Q2 2026" },
  ],
  lineOptions: LINES.map((line) => ({ value: line.code, label: line.label })),
  // Every title and region the filter bar can offer at once — the widest the chip rows ever get.
  titleOptions: ["Medical Representative", "Senior Medical Representative", "District Manager"].map((title) => ({
    label: title,
    value: title,
  })),
  regionOptions: ["Delta and Canal", "Upper Egypt", "Cairo and Giza", "Alexandria and West Delta"].map((region) => ({
    label: region,
    value: region,
  })),
  nothingPublished: false,
};

// ── The emitted artifact ────────────────────────────────────────────────────────────────────────

const boardHtml = renderToStaticMarkup(React.createElement(RankingsExplorer, { data: DATA }));

/** `app-shell.tsx`'s own container chain plus the 272px rail — geometry only. */
function harness(css) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Rankings fit harness</title><style>${css}</style></head>
<body>
<div class="min-h-screen text-phx-ink admin-shell bg-[#F3F6FA]">
  <div class="flex min-h-screen">
    <aside id="fit-sidebar" class="sticky top-0 z-40 hidden h-screen shrink-0 flex-col lg:flex border-r w-[272px]"></aside>
    <div class="flex min-w-0 flex-1 flex-col">
      <div class="phx-navrow-scope flex min-w-0 flex-1 flex-col">
        <main class="phx-zoom-surface min-w-0 flex-1 px-3 py-4 sm:px-4 sm:py-5 lg:px-4 lg:py-6 xl:px-5">
          <div class="w-full mx-auto phx-shell-cap-admin">
            <div class="p-4 sm:p-6">
${boardHtml}
            </div>
          </div>
        </main>
      </div>
    </div>
  </div>
</div>
</body></html>`;
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
    base: REPO_NODE_MODULES_OWNER,
    onDependency: () => {},
  });
  const candidates = new Set();
  for (const match of html.matchAll(/class="([^"]*)"/g)) {
    for (const token of (match[1] ?? "").split(/\s+/)) if (token) candidates.add(token);
  }
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

const READ = (expectedWidth) => `(() => {
  const main = document.querySelector("main");
  const vw = window.innerWidth;
  const overflowing = [];
  for (const el of document.querySelectorAll("main *")) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.right > vw + 0.5) {
      overflowing.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || "").slice(0, 70), right: Math.round(rect.right) });
    }
  }
  const clippedCells = [];
  for (const cell of document.querySelectorAll("main td, main th")) {
    const over = cell.scrollWidth - cell.clientWidth;
    if (over > 1) clippedCells.push({ over, text: (cell.textContent || "").slice(0, 40) });
  }
  const radii = [];
  for (const el of document.querySelectorAll("main *")) {
    const radius = getComputedStyle(el).borderRadius;
    if (radius && radius !== "0px" && !radius.startsWith("0px 0px 0px 0px")) {
      radii.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || "").slice(0, 70), radius });
    }
  }
  // Every board is its own query container, so EACH ONE is asked separately: at a 1280px viewport
  // the full-width board shows its table while the 452px two-up panels show cards, and a harness
  // keyed to the viewport would never see that.
  const boards = [];
  for (const el of document.querySelectorAll("main div")) {
    if (getComputedStyle(el).containerType !== "inline-size") continue;
    const table = el.querySelector("table");
    const card = el.querySelector("ul > li");
    boards.push({
      width: Math.round(el.getBoundingClientRect().width),
      table: table ? Math.round(table.getBoundingClientRect().width) : 0,
      cards: card ? Math.round(card.getBoundingClientRect().width) : 0,
    });
  }
  return {
    innerWidth: vw,
    widthTook: vw === ${expectedWidth},
    mainClientWidth: main ? main.clientWidth : -1,
    // Zero containers means the compiled CSS never applied container-type: inline-size, and every
    // reading below would be a bare-HTML measurement wearing the shape of a styled one.
    boards,
    pageScrollOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    mainScrollOverflow: main ? main.scrollWidth > main.clientWidth : null,
    overflowing,
    clippedCells,
    radii,
    laidOutTables: boards.filter((board) => board.table > 0).length,
    tableLayout: (() => {
      const table = [...document.querySelectorAll("main table")].find((el) => el.getBoundingClientRect().width > 0);
      return table ? getComputedStyle(table).tableLayout : null;
    })(),
  };
})()`;

const CONTROL_LEFT_PROBE = `(() => {
  const main = document.querySelector("main");
  const probe = document.createElement("div");
  probe.id = "fit-control-probe";
  probe.style.cssText = "width:" + (main.clientWidth + 400) + "px;height:4px;background:red";
  main.prepend(probe);
  const vw = window.innerWidth;
  let count = 0;
  for (const el of document.querySelectorAll("main *")) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.right > vw + 0.5) count += 1;
  }
  return count;
})()`;

const CONTROL_LEFT_PROBE_REMOVE = `(() => { document.getElementById("fit-control-probe")?.remove(); return true; })()`;

// A LATIN unbreakable token: Arabic offers break opportunities between letters and wraps even with
// overflow-wrap forced to normal, so it is not a control at all.
// It must be a cell in a LAID-OUT table: at a 1280px viewport the first three boards are cards and
// their tables are display:none, where every width reads 0 and the control silently cannot fire.
const CONTROL_CELL_CLIP = `(() => {
  const cell = [...document.querySelectorAll("main tbody td")].find((el) => el.getBoundingClientRect().width > 0);
  if (!cell) return { ran: false };
  const original = cell.innerHTML;
  const wrap = cell.style.overflowWrap;
  cell.style.overflowWrap = "normal";
  cell.style.wordBreak = "normal";
  cell.innerHTML = "<span>" + "Mohammed".repeat(8) + "</span>";
  const withBreak = cell.scrollWidth - cell.clientWidth;
  cell.innerHTML = original;
  cell.style.overflowWrap = wrap;
  cell.style.wordBreak = "";
  return { ran: true, fired: withBreak > 1, over: withBreak, restoredOver: cell.scrollWidth - cell.clientWidth };
})()`;

// An INLINE radius, because `rounded-lg` computes to 0px here — globals.css sweeps it, so a class
// probe reads the same 0px as a correct page and would certify a deleted sweep.
const CONTROL_RADIUS = `(() => {
  const probe = document.createElement("div");
  probe.style.cssText = "width:10px;height:10px;border-radius:8px";
  document.querySelector("main").appendChild(probe);
  const radius = getComputedStyle(probe).borderRadius;
  probe.remove();
  return radius;
})()`;

const WIDTHS = [375, 768, 1024, 1280, 1920];

// ── Run ─────────────────────────────────────────────────────────────────────────────────────────

const { candidateCount, css } = await compileCss(harness(""));
const html = harness(css);

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

console.log(`\nRankings — fit and square-edge measurement`);
console.log(`  rendered page: ${boardHtml.length} bytes · compiled CSS: ${css.length} bytes from ${candidateCount} candidates`);
console.log(`  harness: ${url} (served over HTTP — a file:// tab loads as a static snapshot and Tailwind never applies)\n`);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(url, { waitUntil: "load" });

let failures = 0;
const fail = (line) => {
  failures += 1;
  console.log(`  FAIL  ${line}`);
};

for (const width of WIDTHS) {
  await page.setViewportSize({ height: 1200, width });
  const reading = await page.evaluate(READ(width));

  console.log(
    `  ${String(width).padStart(4)}px  main ${String(reading.mainClientWidth).padStart(5)}px content   ` +
      reading.boards
        .map((board) => `${board.width}px→${board.table > 0 ? `table ${board.table}px` : "cards"}`)
        .join("  "),
  );

  if (!reading.widthTook) {
    fail(`${width}px: the viewport did not take (innerWidth ${reading.innerWidth}). Every reading below it is fiction.`);
    continue;
  }
  // The styling gate, and it holds at EVERY width because it does not depend on a table existing:
  // `container-type: inline-size` can only come from the compiled `@container` utility.
  if (reading.boards.length === 0) {
    fail(
      `${width}px: not one board is a query container, so the compiled CSS never applied ` +
        `\`container-type: inline-size\` and nothing below was really measured.`,
    );
    continue;
  }
  // Each board must resolve to exactly ONE of the two layouts. Both at once double-reports a rep;
  // neither means the board rendered nothing at all and the zeros below are vacuous.
  const ambiguous = reading.boards.filter((board) => (board.table > 0) === (board.cards > 0));
  if (ambiguous.length > 0) {
    fail(
      `${width}px: ${ambiguous.length} board(s) show both layouts or neither — ${JSON.stringify(ambiguous.slice(0, 3))}. ` +
        `The @min-[620px] container query did not resolve.`,
    );
    continue;
  }
  const anyTable = reading.laidOutTables > 0;
  if (anyTable && reading.tableLayout !== "fixed") {
    fail(`${width}px: table-layout reads "${reading.tableLayout}", not "fixed" — the colgroup is not governing the columns.`);
    continue;
  }

  const beforeProbe = reading.overflowing.length;
  const withProbe = await page.evaluate(CONTROL_LEFT_PROBE);
  await page.evaluate(CONTROL_LEFT_PROBE_REMOVE);
  const afterProbe = (await page.evaluate(READ(width))).overflowing.length;
  if (!(withProbe > beforeProbe && afterProbe === beforeProbe)) {
    fail(
      `${width}px: the child-rect control did not fire (${beforeProbe} → ${withProbe} → ${afterProbe}). ` +
        `A left-anchored over-wide probe MUST be detected; without that, the zeros mean nothing.`,
    );
  }
  if (anyTable) {
    const cellControl = await page.evaluate(CONTROL_CELL_CLIP);
    if (!cellControl.ran || !cellControl.fired || cellControl.restoredOver > 1) {
      fail(`${width}px: the per-cell clip control did not fire (${JSON.stringify(cellControl)}).`);
    }
  }
  if ((await page.evaluate(CONTROL_RADIUS)) === "0px") {
    fail(`${width}px: an inline border-radius: 8px probe measured 0px, so the radius sweep proves nothing.`);
  }

  console.log(
    `          page scrollWidth > clientWidth: ${reading.pageScrollOverflow}` +
      `   main scrollWidth > clientWidth: ${reading.mainScrollOverflow}` +
      `   (both INERT under .admin-shell overflow-x: clip — reported, never trusted)`,
  );
  console.log(
    `          children past the viewport: ${reading.overflowing.length}` +
      `   clipped cells: ${reading.clippedCells.length}` +
      `   non-zero radii: ${reading.radii.length}` +
      `   boards: ${reading.boards.length} (${reading.laidOutTables} as a table)`,
  );

  if (reading.pageScrollOverflow || reading.mainScrollOverflow) {
    fail(`${width}px: scrollWidth exceeds clientWidth. That is the golden rule broken outright.`);
  }
  if (reading.overflowing.length > 0) {
    fail(`${width}px: ${reading.overflowing.length} element(s) extend past the viewport — ${JSON.stringify(reading.overflowing.slice(0, 3))}`);
  }
  if (reading.clippedCells.length > 0) {
    fail(`${width}px: ${reading.clippedCells.length} cell(s) clip their own content — ${JSON.stringify(reading.clippedCells.slice(0, 3))}`);
  }
  if (reading.radii.length > 0) {
    fail(
      `${width}px: ${reading.radii.length} element(s) carry a corner radius — ${JSON.stringify(reading.radii.slice(0, 4))}. ` +
        `The square-edge golden rule is no round or semi-round corners, anywhere.`,
    );
  }
}

await browser.close();
server.close();

console.log(
  failures === 0
    ? `\nEvery width read clean with its controls firing. The Rankings tab fits at 375px and at desktop,\n` +
        `and nothing under <main> carries a corner radius.\n`
    : `\n${failures} failure(s) above. Nothing here is proven — fix the page, or fix the harness, and re-run.\n`,
);
process.exit(failures === 0 ? 0 : 1);
