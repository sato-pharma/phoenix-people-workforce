// Does /admin/needs-you actually fit the screen, and are its corners actually square?
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//   node --experimental-strip-types --experimental-specifier-resolution=node \
//     --experimental-loader ./scripts/needs-you-fit-loader.mjs scripts/measure-needs-you-fit.mjs
//
// (`pnpm run ui:measure-needs-you-fit` from the PRIMARY checkout; never `pnpm` inside a worktree —
// AGENTS.md §5, and `bash-guard.mjs` C6 denies it.)
//
// WHY THIS IS A SCRIPT AND NOT A TEST. It launches real Chromium, and a required CI check must never
// depend on a browser being in the runner image — the same reason `scripts/measure-kpis-table-heads.mjs`
// and `scripts/check-payslip-page-fit.mjs` are scripts. `tests/needs-you-fits-the-screen.test.ts` is
// the cheap half that runs in `checks` and stops the CLASSES coming back; this is the half that
// answers whether the pixels are right.
//
// WHY IT RENDERS THE REAL COMPONENT. The house rule is to verify the EMITTED ARTIFACT, never the
// source. So this imports `NeedsYouBoardView` itself, renders it with `react-dom/server`, wraps the
// output in `app-shell.tsx`'s own container chain, and styles it with the repository's own
// `app/globals.css` compiled by the repository's own Tailwind. Nothing is copied by hand — a
// hand-copied harness is a copy of the source wearing the artifact's clothes, and it cannot catch a
// class the component actually applies but the copy forgot.
//
// 🔴 THE FOUR TRAPS THIS HARNESS IS BUILT AROUND, each of which has produced a false clean reading
// on this codebase before:
//
//  1. `.admin-shell { overflow-x: clip }` (app/globals.css) CUTS overflow rather than scrolling it.
//     So the golden rule's own prescribed check — `scrollWidth > clientWidth` — reads a perfect
//     375/375 on a page with hundreds of pixels hanging off the side. It is reported here because the
//     rule names it, and it is NOT the instrument that decides: the CHILD-RECT sweep is.
//  2. `.admin-shell :has(> table)` gives any element directly holding a table `overflow-x: auto`, so
//     a wide table scrolls inside its own wrapper and the page reads clean. Hence the PER-CELL check.
//  3. Under `table-fixed` a cell that cannot wrap does not widen the table at all — it is clipped —
//     so the per-cell check needs its OWN positive control; a wrapper-level control cannot validate it.
//  4. The SIDEBAR must be in the chain, or the worst width reads clean: content width does not grow
//     monotonically with the viewport, because the 272px rail appears at `lg:`. Widths are measured at
//     375 / 768 / 1024 / 1280 / 1920 for that reason, never at two.
//
// AND EVERY ZERO IS EARNED. Three positive controls run at each width, each failing in the direction
// being tested. A harness that reports "no overflow" is worthless on its own — it looks identical to
// one that is silently not measuring (Tailwind never loaded, the viewport never took, the selector
// matched nothing). If a control does not fire, the run FAILS and reports nothing as proven.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

const React = require("react");
// The `<Link>` stub in needs-you-fit-loader.mjs reads React from here — a data: URL module cannot
// resolve a bare specifier.
globalThis.__needsYouFitReact = React;

/**
 * 🔴 A REAL DEPENDENCY SKEW, WORKED AROUND HERE AND WORTH KNOWING. `react` resolves to 19.3.0 and
 * `react-dom` to 19.2.8 in this repo's lockfile, and `react-dom/server` refuses to load at all when
 * the two disagree (`ensureCorrectIsomorphicReactVersion`, in BOTH its development and production
 * builds). The app itself never meets this, because Next serves its own bundled pair — only a
 * standalone SSR script like this one does.
 *
 * The patch is a lie about a version string and nothing else: `createElement` and the renderer are
 * unchanged, and nothing in a measurement run reads `React.version`. It is confined to this file so
 * the skew stays visible rather than becoming a thing the repo quietly depends on.
 */
Object.defineProperty(React, "version", {
  configurable: true,
  value: require("react-dom/package.json").version,
  writable: true,
});
const { renderToStaticMarkup } = require("react-dom/server");
const { chromium } = require("playwright");

const { NeedsYouBoardView } = await import("../src/components/admin/needs-you-board.tsx");

const ROOT = process.cwd();
const REPO_NODE_MODULES_OWNER = path.resolve(ROOT, "app");

// ── The fixture ─────────────────────────────────────────────────────────────────────────────────

/**
 * REAL names from production, longest first — measured 2026-09-28 with
 * `select full_name, length(full_name) from employees order by 2 desc`.
 *
 * Invented names prove nothing: the 2026-08-21 mobile-card defect was found by a 52-character rep
 * name and would have been missed by "Ahmed Samir". The longest name on the system today is 55
 * characters, and six of them are listed because six is exactly what a roster cell prints before it
 * says how many more there are — so this is the widest that cell can ever legitimately be.
 */
const LONGEST_REAL_NAMES = [
  "Muhammad Muhammad AlMinshawy AbualMaati Muhammad Ismail",
  "Mustafa Abdelhamid Mohamed Mohamed El Kabbani",
  "Ahmed Nabil Basim Abdelaziz Youssef Mohamed",
  "Hossam Mohamed Reda AboElftouh Abdelghafar",
  "Ahmed BahaElDin Suliman Ibrahim Al Maraghi",
  "Nada Mohamed Abdelmoaty Mohamed Elsharkawy",
];

function boardFixture() {
  const item = (overrides) => ({
    count: 12,
    externalUrl: null,
    href: "/admin/approvals/vacation",
    kind: "approval",
    lane: "yours",
    note: null,
    oldestAt: "2026-08-04T06:30:00.000Z",
    ageDays: 45,
    overdue: false,
    people: LONGEST_REAL_NAMES,
    sourceId: "leave-approvals",
    ...overrides,
  });

  const yours = [
    item({
      key: "y1",
      label: "12 leave requests awaiting your approval",
      overdue: true,
    }),
    item({
      // The widest realistic label: a closing period naming every unpublished line, with the
      // published half in the note beneath it.
      key: "y2",
      sourceId: "monthly-closings",
      kind: "publish",
      count: null,
      people: [],
      oldestAt: "2026-09-01T00:00:00.000Z",
      ageDays: 27,
      href: "/sales/monthly-closing",
      label: "2026-08 is not published for Anti Infective, CNS, Pedia",
      note: "Already published for Head Office Consumer Health and Head Office Prescription.",
    }),
    item({
      // A count-only badge source: no roster, no timestamp. The cell must read "Not recorded".
      key: "y3",
      sourceId: "direct-order-unbooked",
      people: [],
      oldestAt: null,
      ageDays: null,
      count: 4,
      href: "/admin/direct-orders",
      label: "4 approved direct orders waiting on a sales month",
      note: "Finance books the month; nothing here changes one.",
    }),
    item({
      // Past the six names a cell prints, so the "and N more" wording is on screen.
      key: "y4",
      sourceId: "probation-decisions",
      people: [...LONGEST_REAL_NAMES, ...LONGEST_REAL_NAMES],
      href: "/probation",
      label: "12 probation decisions are due within 30 days",
      note: "3 of them are already past the probation end date.",
    }),
  ];

  return {
    allClearProvable: false,
    generatedAt: "2026-09-28T09:00:00.000Z",
    notProven: [
      {
        because:
          "Resignations: fetch failed; Contract renewals: it did not answer within 8 seconds; The employee directory: TypeError: Cannot read properties of undefined",
        id: "action-inbox",
        label: "Other approvals inbox",
      },
      { because: "it did not answer within 8 seconds", id: "marketing-approvals", label: "Marketing approval inbox" },
    ],
    someoneElse: [
      item({
        key: "s1",
        lane: "someone-else",
        sourceId: "payroll-publish",
        count: null,
        people: [],
        href: "/admin/automated-payroll",
        label: "September 2026 payroll is still being worked on",
        note: "Reported so an abandoned month is visible, never as work waiting on you.",
      }),
    ],
    sources: [
      { because: null, id: "action-inbox", itemCount: null, label: "Other approvals inbox", status: "unavailable" },
      { because: null, id: "leave-approvals", itemCount: 1, label: "Leave approvals", status: "ok" },
      {
        because: "you hold no rung on this queue",
        id: "market-awareness-approvals",
        itemCount: 0,
        label: "Awareness approvals",
        status: "not-applicable",
      },
      {
        because:
          "it did not answer within 8 seconds — the marketing approval steps query timed out against a table of 41,000 rows",
        id: "marketing-approvals",
        itemCount: null,
        label: "Marketing approval inbox",
        status: "unavailable",
      },
    ],
    worthKnowing: [
      item({
        key: "w1",
        lane: "worth-knowing",
        sourceId: "payroll-publish",
        count: 7,
        href: "/admin/automated-payroll/finance",
        label: "7 people have money withheld at a past publish",
        note: "Across July 2026, August 2026, September 2026. Figures are on the payroll screen, never here.",
      }),
    ],
    yours,
  };
}

// ── The emitted artifact ────────────────────────────────────────────────────────────────────────

const boardHtml = renderToStaticMarkup(React.createElement(NeedsYouBoardView, { board: boardFixture() }));

/**
 * `app-shell.tsx`'s own container chain, copied class-for-class (lines 146-227) plus the `<aside>`
 * from `sidebar.tsx` at `SIDEBAR_WIDTH_EXPANDED` (272px, expanded by default).
 *
 * This is the one part of the harness that is hand-copied, and it is copied because the shell itself
 * cannot be rendered without a session, a router and a permission lookup. Only its GEOMETRY matters
 * here, which is the widths, the paddings and the three `.admin-shell` rules — the rail's colours are
 * left out on purpose.
 */
function harness(css) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Needs You fit harness</title><style>${css}</style></head>
<body>
<div class="min-h-screen text-phx-ink admin-shell bg-[#F3F6FA]">
  <div class="flex min-h-screen">
    <aside id="fit-sidebar" class="sticky top-0 z-40 hidden h-screen shrink-0 flex-col lg:flex border-r w-[272px]"></aside>
    <div class="flex min-w-0 flex-1 flex-col">
      <div class="phx-navrow-scope flex min-w-0 flex-1 flex-col">
        <main class="phx-zoom-surface min-w-0 flex-1 px-3 py-4 sm:px-4 sm:py-5 lg:px-4 lg:py-6 xl:px-5">
          <div class="w-full mx-auto phx-shell-cap-admin">
${boardHtml}
          </div>
        </main>
      </div>
    </div>
  </div>
</div>
</body></html>`;
}

// ── The repository's own CSS, compiled by the repository's own Tailwind ──────────────────────────

/**
 * `@tailwindcss/node`'s `compile`, reached through the pnpm store because neither it nor
 * `@tailwindcss/postcss` is hoisted (Next loads them through its own resolution).
 *
 * `source(none)` is substituted for Tailwind's automatic source detection and the candidates are
 * supplied by hand FROM THE RENDERED HTML. Two reasons, both load-bearing: automatic detection would
 * walk the repository (~346k path entries here — tens of seconds), and feeding it the emitted markup
 * means a class the component applies but Tailwind never compiled shows up as a missing style rather
 * than being quietly absent from both sides.
 */
async function compileCss(html) {
  const storeRoot = findStoreRoot();
  const nodeApi = path.join(
    storeRoot,
    ".pnpm/@tailwindcss+node@4.3.3/node_modules/@tailwindcss/node/dist/index.mjs",
  );
  if (!fs.existsSync(nodeApi)) {
    throw new Error(
      `@tailwindcss/node 4.3.3 is not in the pnpm store at ${nodeApi}. The harness compiles the ` +
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
  // The control's own class, so it cannot fail merely because its utility was not compiled.
  candidates.add("rounded-lg");
  return { candidateCount: candidates.size, css: compiler.build([...candidates]) };
}

/** The pnpm store lives in the PRIMARY checkout; a worktree has only a junction, or nothing at all. */
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

/**
 * Everything read in ONE evaluate, at a viewport asserted inside the same call.
 *
 * `expectedWidth` is the positive control on the INSTRUMENT: a viewport that silently did not take is
 * the documented way every subsequent reading becomes fiction while still looking like a clean page.
 */
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
  const table = document.querySelector("main table");
  const head = document.querySelector("main thead th");
  const cards = document.querySelectorAll("main ul.md\\\\:hidden > li");
  return {
    innerWidth: vw,
    widthTook: vw === ${expectedWidth},
    mainClientWidth: main ? main.clientWidth : -1,
    pageScrollOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    mainScrollOverflow: main ? main.scrollWidth > main.clientWidth : null,
    overflowing,
    clippedCells,
    radii,
    tableVisible: table ? table.getBoundingClientRect().width > 0 : false,
    cardsVisible: cards.length > 0 ? cards[0].getBoundingClientRect().width > 0 : false,
    cardCount: cards.length,
    tableRadius: table ? getComputedStyle(table).borderRadius : null,
    cardRadius: cards.length > 0 ? getComputedStyle(cards[0]).borderRadius : null,
    headFontSize: head ? getComputedStyle(head).fontSize : null,
    headFontFamily: head ? getComputedStyle(head).fontFamily.split(",")[0] : null,
    tailwindApplied: table ? getComputedStyle(table).tableLayout : null,
  };
})()`;

/**
 * The overflow control.
 *
 * ANCHORED AT THE LEFT, not the right, and sized RELATIVE to the content box. Both details were
 * learned the hard way. Widening an element inside a `justify-end` row pushes it LEFT, off-screen,
 * where neither `scrollWidth` nor a `rect.right > viewport` check can see it in LTR — so the control
 * reads exactly like a working page and the natural next thought is the wrong one. And a FIXED 900px
 * probe fits inside the content box at 1024px and above, so it silently stopped being a control at
 * the three widest readings, which is the same false clean one layer up.
 */
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

/**
 * The per-cell control, and it uses a LATIN token deliberately.
 *
 * An Arabic token is NOT a control for an unbreakable word: the script offers break opportunities
 * between letters, so 60 repeated Arabic letters wrap even with `overflow-wrap: normal` forced on and
 * the control reports a clean zero that looks exactly like a passing screen (measured 2026-09-28 on
 * the Phoenix CRM Today table). `"Mohammed".repeat(8)` cannot break.
 */
const CONTROL_CELL_CLIP = `(() => {
  const cell = document.querySelector("main tbody td");
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
  const restored = cell.scrollWidth - cell.clientWidth;
  return { ran: true, fired: withBreak > 1, over: withBreak, restoredOver: restored };
})()`;

/**
 * The radius control, and it uses an INLINE radius rather than `rounded-lg`.
 *
 * 🔴 BECAUSE `rounded-lg` MEASURES 0px IN THIS APP — measured here, 2026-09-28. `app/globals.css`
 * sweeps the rounded utilities to zero, so a `rounded-lg` probe is not a control at all: it reads the
 * same 0px as a correct page and would certify a sweep that had been deleted. An inline
 * `border-radius: 8px` cannot be swept, so it proves the instrument can see a radius when one exists.
 *
 * That reading is also why `tests/needs-you-fits-the-screen.test.ts` still bans the CLASSES rather
 * than leaning on this measurement. AGENTS.md is explicit that the `globals.css` sweep "is not
 * coverage" — it catches the spellings it enumerates — so a `rounded-` class in this component is a
 * defect waiting on the day its spelling is not one of them, even while it computes to 0px today.
 */
const CONTROL_RADIUS = `(() => {
  const probe = document.createElement("div");
  probe.style.cssText = "width:10px;height:10px;border-radius:8px";
  document.querySelector("main").appendChild(probe);
  const radius = getComputedStyle(probe).borderRadius;
  probe.remove();
  return radius;
})()`;

/** What a swept utility class actually computes to here — reported, because it is not obvious. */
const SWEPT_CLASS_RADIUS = `(() => {
  const probe = document.createElement("div");
  probe.className = "rounded-lg";
  probe.style.cssText = "width:10px;height:10px";
  document.querySelector("main").appendChild(probe);
  const radius = getComputedStyle(probe).borderRadius;
  probe.remove();
  return radius;
})()`;

const WIDTHS = [375, 768, 1024, 1280, 1920];

// ── Run ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * 🔴 CANDIDATES COME FROM THE WHOLE HARNESS, NOT JUST THE BOARD — and the first version of this
 * script got that wrong, which is worth recording because the failure looked like a pass.
 *
 * Feeding Tailwind only the board's own classes left the SHELL CHAIN uncompiled: `main` got no
 * `px-3`/`sm:px-4`/`lg:px-4` padding and the `<aside>` no `w-[272px]`, so every width reported
 * `main.clientWidth === innerWidth` and the sidebar simply was not there. The board then read clean
 * against a content box up to 272px wider than the real one — the "give the harness the REAL content
 * width, or its margins are fiction" trap, and the tell was `main` measuring 1024px at a viewport
 * where the rail is visible. `.admin-shell` and `.phx-shell-cap-admin` masked it further, because
 * those are plain classes in globals.css and are emitted whether or not anything asks for them.
 */
const { candidateCount, css } = await compileCss(harness(""));
const html = harness(css);

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

console.log(`\nNeeds You — fit and square-edge measurement`);
console.log(`  rendered board: ${boardHtml.length} bytes · compiled CSS: ${css.length} bytes from ${candidateCount} candidates`);
console.log(`  harness: ${url} (served over HTTP — a file:// tab loads as a static snapshot and Tailwind never applies)\n`);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(url, { waitUntil: "load" });
console.log(`  a "rounded-lg" class computes to ${await page.evaluate(SWEPT_CLASS_RADIUS)} here — app/globals.css sweeps it.`);
console.log(`  so the radius control below is an INLINE border-radius, which no sweep can reach.\n`);

let failures = 0;
const fail = (line) => {
  failures += 1;
  console.log(`  FAIL  ${line}`);
};

for (const width of WIDTHS) {
  await page.setViewportSize({ height: 900, width });
  const reading = await page.evaluate(READ(width));

  console.log(`  ${String(width).padStart(4)}px  main ${String(reading.mainClientWidth).padStart(5)}px content`);

  // ── The instrument is alive, before any absence is believed ─────────────────────────────────────
  if (!reading.widthTook) {
    fail(`${width}px: the viewport did not take (innerWidth ${reading.innerWidth}). Every reading below it is fiction.`);
    continue;
  }
  if (reading.tailwindApplied !== "fixed") {
    fail(`${width}px: table-layout reads "${reading.tailwindApplied}", not "fixed" — the compiled CSS did not apply.`);
    continue;
  }
  const desktop = width >= 768;
  if (desktop && !reading.tableVisible) {
    fail(`${width}px: the desktop table has zero width, so nothing below was measured.`);
    continue;
  }
  if (!desktop && !reading.cardsVisible) {
    fail(`${width}px: the mobile cards have zero width, so nothing below was measured.`);
    continue;
  }

  // ── The three positive controls, at THIS width ──────────────────────────────────────────────────
  const beforeProbe = reading.overflowing.length;
  const withProbe = await page.evaluate(CONTROL_LEFT_PROBE);
  await page.evaluate(CONTROL_LEFT_PROBE_REMOVE);
  const afterProbe = (await page.evaluate(READ(width))).overflowing.length;
  if (!(withProbe > beforeProbe && afterProbe === beforeProbe)) {
    fail(
      `${width}px: the child-rect control did not fire (${beforeProbe} → ${withProbe} → ${afterProbe}). ` +
        `A 900px left-anchored probe MUST be detected; without that, the zeros mean nothing.`,
    );
  }
  if (desktop) {
    const cellControl = await page.evaluate(CONTROL_CELL_CLIP);
    if (!cellControl.ran || !cellControl.fired || cellControl.restoredOver > 1) {
      fail(
        `${width}px: the per-cell clip control did not fire (${JSON.stringify(cellControl)}). Under ` +
          `table-fixed a cell that cannot wrap is CUT rather than widening the table, so this check ` +
          `needs its own control — a wrapper-level one cannot validate it.`,
      );
    }
  }
  const radiusControl = await page.evaluate(CONTROL_RADIUS);
  if (radiusControl === "0px") {
    fail(`${width}px: an inline border-radius: 8px probe measured 0px, so the radius sweep proves nothing.`);
  }

  // ── The real readings ──────────────────────────────────────────────────────────────────────────
  //
  // The page-level check is printed because the golden rule names it, and it is NOT what decides:
  // `.admin-shell { overflow-x: clip }` makes it inert here.
  console.log(
    `          page scrollWidth > clientWidth: ${reading.pageScrollOverflow}` +
      `   main scrollWidth > clientWidth: ${reading.mainScrollOverflow}` +
      `   (both INERT under .admin-shell overflow-x: clip — reported, never trusted)`,
  );
  console.log(
    `          children past the viewport: ${reading.overflowing.length}` +
      (desktop ? `   clipped cells: ${reading.clippedCells.length}` : `   cards: ${reading.cardCount}`) +
      `   non-zero radii: ${reading.radii.length}`,
  );

  if (reading.pageScrollOverflow || reading.mainScrollOverflow) {
    fail(`${width}px: scrollWidth exceeds clientWidth. That is the golden rule broken outright.`);
  }
  if (reading.overflowing.length > 0) {
    fail(
      `${width}px: ${reading.overflowing.length} element(s) extend past the viewport — ` +
        `${JSON.stringify(reading.overflowing.slice(0, 3))}`,
    );
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
  if (desktop && reading.tableRadius !== "0px") {
    fail(`${width}px: the table's computed border-radius is "${reading.tableRadius}", not 0px.`);
  }
  if (!desktop && reading.cardRadius !== "0px") {
    fail(`${width}px: a mobile card's computed border-radius is "${reading.cardRadius}", not 0px.`);
  }
  if (desktop) {
    console.log(`          thead th: ${reading.headFontSize} / ${reading.headFontFamily}   table radius ${reading.tableRadius}`);
  } else {
    console.log(`          card radius ${reading.cardRadius}`);
  }
}

await browser.close();
server.close();

console.log(
  failures === 0
    ? `\nEvery width read clean with all three controls firing at each one. The board fits at 375px and\n` +
        `at desktop, and nothing under <main> carries a corner radius.\n`
    : `\n${failures} failure(s) above. Nothing here is proven — fix the board, or fix the harness, and re-run.\n`,
);
process.exit(failures === 0 ? 0 : 1);
