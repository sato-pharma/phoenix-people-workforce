// Does the CV Lookup results table actually fit the screen, and are its corners actually square?
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//   node --experimental-strip-types --experimental-specifier-resolution=node \
//     --experimental-loader ./scripts/needs-you-fit-loader.mjs scripts/measure-cv-lookup-fit.mjs
//
// (`pnpm run ui:measure-cv-lookup-fit` from the PRIMARY checkout; never `pnpm` inside a worktree —
// AGENTS.md §5, and `bash-guard.mjs` C6 denies it.)
//
// WHY THIS EXISTS. CV Lookup (owner, 2026-09-30) is a new five-column table on a screen an HR seat
// opens every day, and the fits-the-screen golden rule is MEASURED, never argued. It reuses
// `needs-you-fit-loader.mjs` and the harness shape of `measure-needs-you-fit.mjs` verbatim, including
// all four of the traps recorded there — read that file's header before changing anything here:
//
//   1. `.admin-shell { overflow-x: clip }` CUTS overflow rather than scrolling it, so the rule's own
//      `scrollWidth > clientWidth` check reads a perfect 375/375 on a page hanging off the side. It
//      is printed because the rule names it; the CHILD-RECT sweep is what decides.
//   2. `.admin-shell :has(> table)` gives a table's wrapper `overflow-x: auto`, so a wide table
//      scrolls inside itself and the page reads clean. Hence the PER-CELL check.
//   3. Under `table-fixed` a cell that cannot wrap is CLIPPED rather than widening the table, so the
//      per-cell check needs its own control.
//   4. The 272px SIDEBAR must be in the chain or the worst width reads clean, because content width
//      does not grow monotonically with the viewport — the rail appears at `lg:`.
//
// WHY IT RENDERS `CvLookupResultsView` AND NOT `CvLookupSearch`. A search result is client state, so
// server-rendering the screen itself would draw the empty box and report it clean — the false-clean
// reading this whole harness exists to avoid. The results view was split out for exactly this.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

const React = require("react");
// The `<Link>` stub in needs-you-fit-loader.mjs reads React from here — a data: URL module cannot
// resolve a bare specifier. Same global name, because it is the same loader.
globalThis.__needsYouFitReact = React;

// The react / react-dom version skew, and why lying about the string is safe: see the same note in
// scripts/measure-needs-you-fit.mjs. `react` is 19.3.0 and `react-dom` 19.2.8 in this lockfile, and
// `react-dom/server` refuses to load when they disagree. Next never meets this; a standalone SSR
// script does.
Object.defineProperty(React, "version", {
  configurable: true,
  value: require("react-dom/package.json").version,
  writable: true,
});
const { renderToStaticMarkup } = require("react-dom/server");
const { chromium } = require("playwright");

const { CvLookupResultsView } = await import("../src/components/recruitment/cv-lookup-search.tsx");

const ROOT = process.cwd();
const REPO_NODE_MODULES_OWNER = path.resolve(ROOT, "app");

// ── The fixture: the WIDEST values this table can legitimately print ────────────────────────────

/**
 * 🔴 THE ONE READING THAT DECIDES THIS TABLE IS THE LONGEST UNBREAKABLE TOKEN, NOT THE LONGEST VALUE.
 *
 * Under `table-fixed` a value with spaces in it always wraps; what clips is a run with no break
 * opportunity. Measured on production 2026-09-30 across every field this table prints
 * (`email`, `current_employer`, `university`, `applied_for_job_title`, `current_job_title`):
 *
 *   longest unbroken token   43 chars  — an e-mail run together with a LinkedIn URL
 *   longest whole value     364 chars  — a free-text `current_job_title`
 *   longest full_name        44 chars  ·  longest university  89 chars
 *
 * The token below is 43 characters of `m`, which is WIDER than the real 43-character token at the
 * same length, so a clean reading here is stricter than production. No real candidate's name, e-mail
 * or phone number is committed to this repository: for geometry the LENGTH and the glyph width are
 * the whole of the signal, and a job applicant's identity is not this harness's business.
 *
 * The university string IS real — an institution name is not personal data, and it is the widest
 * space-separated value the table has to lay out.
 */
const WIDEST_UNBREAKABLE_TOKEN = "m".repeat(43);
const WIDEST_REAL_UNIVERSITY =
  "New Cairo Higher Institute for Administrative Sciences and Computer Accounting Department";
const WIDEST_NAME = "W".repeat(44);
const LONGEST_JOB_TITLE =
  "Clinical Pharmacist and Medical Representative for the Anti Infective and Central Nervous System " +
  "portfolios covering Greater Cairo, Giza and the Delta, reporting to the district sales manager, " +
  "responsible for pharmacy coverage, doctor coverage, key account development and monthly target " +
  "attainment across the whole assigned brick list and its neighbouring territories";

/** A `ts_headline` snippet at its own configured ceiling: MaxWords 26 across MaxFragments 2. */
const LONGEST_MATCHED_ON =
  "clinical pharmacist with eight years of hospital and community experience across cardiology, " +
  "endocrinology and paediatric wards, holding a diploma in clinical pharmacy · registered " +
  "pharmacist, syndicate member, fluent in Arabic and English with advanced spreadsheet skills";

function hitsFixture() {
  const base = {
    addedAt: "2026-09-01T08:15:00.000Z",
    appliedFor: "Medical Representative",
    candidateId: "00000000-0000-4000-8000-000000000001",
    currentEmployer: "Sato Pharmaceuticals",
    currentJobTitle: "Pharmacist",
    email: "a.candidate@example.com",
    governorate: "Kafr El-Sheikh",
    matchedOn: "clinical pharmacist · cardiology",
    name: "Ahmed Samir Mohamed",
    phone: "01000000000",
    status: "new",
    statusLabel: "New",
    university: "Cairo University",
  };

  return [
    // 1 · Every cell at its widest, all at once. This is the row that decides.
    {
      ...base,
      candidateId: "00000000-0000-4000-8000-000000000002",
      name: WIDEST_NAME,
      appliedFor: LONGEST_JOB_TITLE.slice(0, 77), // the real `applied_for_job_title` ceiling
      currentEmployer: WIDEST_UNBREAKABLE_TOKEN,
      currentJobTitle: LONGEST_JOB_TITLE,
      email: WIDEST_UNBREAKABLE_TOKEN,
      matchedOn: LONGEST_MATCHED_ON,
      phone: WIDEST_UNBREAKABLE_TOKEN,
      university: WIDEST_REAL_UNIVERSITY,
    },
    // 2 · The application-only hit: no CV snippet, so the cell falls back to job title + employer.
    {
      ...base,
      candidateId: "00000000-0000-4000-8000-000000000003",
      matchedOn: "",
      currentJobTitle: LONGEST_JOB_TITLE.slice(0, 120),
      currentEmployer: WIDEST_REAL_UNIVERSITY,
    },
    // 3 · The empty record: every optional field blank, so the em-dash path is measured too.
    {
      addedAt: null,
      appliedFor: "",
      candidateId: "00000000-0000-4000-8000-000000000004",
      currentEmployer: "",
      currentJobTitle: "",
      email: "",
      governorate: "",
      matchedOn: "",
      name: "Unnamed candidate",
      phone: "",
      status: "",
      statusLabel: "New",
      university: "",
    },
    base,
  ];
}

// ── The emitted artifact ────────────────────────────────────────────────────────────────────────

const resultsHtml = renderToStaticMarkup(
  React.createElement(CvLookupResultsView, {
    hits: hitsFixture(),
    query: "clinical pharmacist cardiology",
    // Plain buttons, so nothing measured depends on a fetch or on the interview calendar's `/me`
    // gate — but BOTH of them, stacked exactly as the live screen stacks them. Measuring one button
    // where the screen draws two is the false-clean this harness exists to avoid: the CV column is
    // 16% of a `table-fixed` table, and the wider label ("Schedule interview") is the one that
    // decides whether the cell clips.
    renderAction: (hit) =>
      React.createElement(
        "div",
        { className: "flex flex-col items-start gap-1.5", key: hit.candidateId },
        ["CV + application", "Schedule interview"].map((label) =>
          React.createElement(
            "button",
            {
              className:
                "gap-2 inline-flex h-7 items-center justify-center rounded-[min(var(--radius-md),12px)] " +
                "border border-border bg-background px-2.5 text-[0.8rem] font-medium",
              key: label,
              type: "button",
            },
            label,
          ),
        ),
      ),
    truncated: true,
  }),
);

/**
 * `app-shell.tsx`'s own container chain plus the `<aside>` from `sidebar.tsx` at
 * `SIDEBAR_WIDTH_EXPANDED` (272px, expanded by default) — copied from
 * `scripts/measure-needs-you-fit.mjs`, which copied it class-for-class from the shell.
 *
 * It is hand-copied because the shell cannot render without a session, a router and a permission
 * lookup. Only its GEOMETRY matters here: the widths, the paddings and the three `.admin-shell`
 * rules. If the shell's chain changes, both harnesses change together.
 */
function harness(css) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>CV Lookup fit harness</title><style>${css}</style></head>
<body>
<div class="min-h-screen text-phx-ink admin-shell bg-[#F3F6FA]">
  <div class="flex min-h-screen">
    <aside id="fit-sidebar" class="sticky top-0 z-40 hidden h-screen shrink-0 flex-col lg:flex border-r w-[272px]"></aside>
    <div class="flex min-w-0 flex-1 flex-col">
      <div class="phx-navrow-scope flex min-w-0 flex-1 flex-col">
        <main class="phx-zoom-surface min-w-0 flex-1 px-3 py-4 sm:px-4 sm:py-5 lg:px-4 lg:py-6 xl:px-5">
          <div class="w-full mx-auto phx-shell-cap-admin">
${resultsHtml}
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
 * Identical to the Needs You harness, for the reason recorded there: `source(none)` replaces
 * Tailwind's automatic detection (which would walk ~346k path entries) and the candidates are fed in
 * FROM THE RENDERED HTML — so a class the component applies but Tailwind never compiled shows up as a
 * missing style rather than being absent from both sides.
 *
 * 🔴 Candidates come from the WHOLE harness, never just the results markup. Feeding it only the
 * component's classes leaves the SHELL CHAIN uncompiled: `main` loses its padding and the `<aside>`
 * its `w-[272px]`, so every width reports `main.clientWidth === innerWidth` and the table is measured
 * against a content box up to 272px wider than the real one.
 */
async function compileCss(html) {
  const storeRoot = findStoreRoot();
  const nodeApi = path.join(
    storeRoot,
    ".pnpm/@tailwindcss+node@4.3.3/node_modules/@tailwindcss/node/dist/index.mjs",
  );
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

/** Everything read in ONE evaluate, at a viewport asserted inside the same call. */
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
  // PortalResponsiveDataList's card list is a DIV of DIVs, each holding PortalRecordCard's
  // <article> — not the <ul>/<li> the Needs You board builds by hand. Reading the wrong shape here
  // is itself a false-clean: a selector matching nothing measures zero cards and zero overflow.
  const cards = document.querySelectorAll("main div.md\\\\:hidden article");
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
    tailwindApplied: table ? getComputedStyle(table).tableLayout : null,
    ellipsised: document.querySelectorAll("main .truncate, main [class*='line-clamp']").length,
  };
})()`;

/** The overflow control: left-anchored and sized RELATIVE to the content box. See the Needs You note. */
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
 * The per-cell control, with a LATIN token deliberately: an Arabic run offers break opportunities
 * between letters, so it wraps even with `overflow-wrap: normal` forced and reports a clean zero.
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
 * The radius control uses an INLINE radius, because `rounded-lg` computes to 0px in this app —
 * `app/globals.css` sweeps the rounded utilities, so a class probe reads the same 0px as a correct
 * page and would certify a sweep that had been deleted.
 */
const CONTROL_RADIUS = `(() => {
  const probe = document.createElement("div");
  probe.style.cssText = "width:8px;height:8px;border-radius:8px";
  document.querySelector("main").prepend(probe);
  const radius = getComputedStyle(probe).borderRadius;
  probe.remove();
  return radius;
})()`;

const SWEPT_CLASS_RADIUS = `(() => {
  const probe = document.createElement("div");
  probe.className = "rounded-lg";
  document.querySelector("main").prepend(probe);
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

console.log(`\nCV Lookup — fit and square-edge measurement`);
console.log(`  rendered results: ${resultsHtml.length} bytes · compiled CSS: ${css.length} bytes from ${candidateCount} candidates`);
console.log(`  widest unbreakable token in the fixture: ${WIDEST_UNBREAKABLE_TOKEN.length} chars (production's own worst case)`);
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

  // ── The positive controls, at THIS width ───────────────────────────────────────────────────────
  const beforeProbe = reading.overflowing.length;
  const withProbe = await page.evaluate(CONTROL_LEFT_PROBE);
  await page.evaluate(CONTROL_LEFT_PROBE_REMOVE);
  const afterProbe = (await page.evaluate(READ(width))).overflowing.length;
  if (!(withProbe > beforeProbe && afterProbe === beforeProbe)) {
    fail(
      `${width}px: the child-rect control did not fire (${beforeProbe} → ${withProbe} → ${afterProbe}). ` +
        `A left-anchored probe wider than the content box MUST be detected; without that, the zeros mean nothing.`,
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
  if (await page.evaluate(CONTROL_RADIUS) === "0px") {
    fail(`${width}px: an inline border-radius: 8px probe measured 0px, so the radius sweep proves nothing.`);
  }

  // ── The real readings ──────────────────────────────────────────────────────────────────────────
  console.log(
    `          page scrollWidth > clientWidth: ${reading.pageScrollOverflow}` +
      `   main scrollWidth > clientWidth: ${reading.mainScrollOverflow}` +
      `   (both INERT under .admin-shell overflow-x: clip — reported, never trusted)`,
  );
  console.log(
    `          children past the viewport: ${reading.overflowing.length}` +
      (desktop ? `   clipped cells: ${reading.clippedCells.length}` : `   cards: ${reading.cardCount}`) +
      `   non-zero radii: ${reading.radii.length}   truncate/line-clamp: ${reading.ellipsised}`,
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
  if (reading.ellipsised > 0) {
    fail(`${width}px: ${reading.ellipsised} element(s) carry truncate or line-clamp. The owner's rule is that text never ellipsises.`);
  }
  if (desktop && reading.tableRadius !== "0px") {
    fail(`${width}px: the table's computed border-radius is "${reading.tableRadius}", not 0px.`);
  }
  if (!desktop && reading.cardRadius !== "0px") {
    fail(`${width}px: a mobile card's computed border-radius is "${reading.cardRadius}", not 0px.`);
  }
}

await browser.close();
server.close();

console.log(
  failures === 0
    ? `\nEvery width read clean with its controls firing. The CV Lookup results fit at 375px and at\n` +
        `desktop with production's widest values, nothing is clipped or ellipsised, and nothing under\n` +
        `<main> carries a corner radius.\n`
    : `\n${failures} failure(s) above. Nothing here is proven — fix the screen, or fix the harness, and re-run.\n`,
);
process.exit(failures === 0 ? 0 : 1);
