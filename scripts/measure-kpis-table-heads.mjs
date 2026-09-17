// How many pixels does one KPIs-board table cell actually NEED?
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS SCRIPT EXISTS. `tests/kpis-board-tables-fit.test.ts` pins a measured `needPx` per column
// and tells the next person to "measure the new head at 619px and record that here, rather than
// editing a number until this goes green". The 2026-09-16 measuring pass left no tool behind, so
// the only way to obey that instruction was to build the harness again from scratch — which is what
// 2026-09-17 had to do when the Summary table gained its Overall column. It is a script and not a
// test for the same reason as scripts/check-payslip-page-fit.mjs: it launches real Chromium, and a
// required CI check must never depend on a browser being present in the runner image.
//
//   node scripts/measure-kpis-table-heads.mjs
//
// WHAT IT MEASURES. The MINIMUM width at which a cell does not overflow — `width: min-content` on
// the cell itself, which resolves to its longest unwrappable token plus its own padding and border.
// That is the number the test compares a column's percentage against, because a multi-word head
// wraps (so its scrollWidth would just equal whatever width you gave it) while a single word cannot.
//
// WHAT IT STANDS ON. The cells' own class strings from src/components/crm/kpis-chrome.tsx, resolved
// to the CSS those utilities emit, plus the two shells' real `thead th` overrides from
// app/globals.css (0.78rem and a 1px orange border, both `!important`) and the font stack from
// src/styles/tokens.css. Every value below is copied, never invented — the constants carry the file
// and line they came from.
//
// THE CONTROLS ARE THE POINT. It re-measures columns whose needs were recorded on 2026-09-16 and
// refuses to call a run good unless they reproduce within 2px.
//
// IT GATES ON HEAD-DRIVEN COLUMNS ONLY, and that limit is deliberate rather than convenient. A
// head is one uppercase word that cannot wrap, so its minimum width is exactly reproducible:
// Coverage comes back 105 against a recorded 104 and Frequency 113 against 113. A BODY cell is a
// value, a meter and a wrapping caption, and the 2026-09-16 pass measured those some other way —
// Summary's AM body reads 60px here against a recorded 67, a 7px gap this harness does not claim to
// explain. So a body reading is printed for information and gates nothing.
//
// That is enough to answer the question it was built for, because the Overall column is HEAD-driven
// by 26px: its head needs 93–101px against a body needing 67–75px, and the run prints the two apart
// so that is checkable rather than asserted. Even if the body methodology is 7px generous the way
// AM's is, the head still sets the floor. A column where the BODY governs cannot be settled with
// this script — measure that one in the real page.
//
// WHICH FAMILY THE RECORDED NUMBERS ARE IN — measured 2026-09-17, and worth knowing before you
// record anything. The four families below disagree by up to 12px on one head, and the recorded
// needs reproduce under SEGOE UI: Frequency reads 113 against a recorded 113, Coverage 105 against
// 104. Under Arial — which is where the stack lands on a machine with none of the three, and which
// the test's own header notes is "wider still" — the same two read 126 and 115. So the run prints
// every family, calibrates on Segoe UI, and RECOMMENDS the widest reading for a new column: a need
// recorded too large only ever makes the pin stricter, and can never hide an overflow.

import { chromium } from "playwright";

/** The portal's table at a 1024px viewport with the sidebar open, display scale 100%. */
const NARROWEST_TABLE_PX = 619;

/**
 * src/styles/tokens.css:305 — `--phx-font-ui`'s first three families, measured one at a time, plus
 * Arial: the stack's last real entry and where a machine with none of the three lands.
 *
 * `calibration: true` marks the family the recorded needs reproduce under. Do not add `, sans-serif`
 * to any of these — an absent family would then fall back silently and be reported under the wrong
 * name, which is exactly how this harness first read Arial's numbers and called them Aptos's.
 */
const FONTS = [
  { css: '"Aptos"', label: "Aptos (Office)" },
  { css: '"Segoe UI Variable Text"', label: "Segoe UI Variable Text" },
  { css: '"Segoe UI"', label: "Segoe UI", calibration: true },
  { css: "Arial", label: "Arial (no-stack fallback)" },
];

/**
 * The utilities each cell wears, resolved to CSS.
 *
 * TH  — kpis-chrome.tsx: "px-3 py-2.5 text-left text-phx-2xs font-black uppercase tracking-[0.12em]"
 * NUM — kpis-chrome.tsx: "px-3 py-3 align-top text-sm font-semibold tabular-nums"
 * The shell rules that beat them: app/globals.css:944 and :1058 force `font-size: 0.78rem` on every
 * `thead th`, and :951 / :1065 put a 1px border on every th and td. `box-sizing: border-box` comes
 * from Tailwind's preflight, so the border eats into the cell rather than adding to it.
 */
const CSS = `
  * { box-sizing: border-box; margin: 0; }
  body { font-feature-settings: "kern" 1, "liga" 1, "calt" 1; font-kerning: normal; }
  .cell { display: block; width: min-content; border: 1px solid rgba(249, 115, 22, 0.22); }
  /* A head cell: px-3 py-2.5, and the shell's 0.78rem !important over text-phx-2xs. */
  .head { padding: 0.625rem 0.75rem; font-size: 0.78rem; font-weight: 900; text-transform: uppercase; letter-spacing: 0.12em; }
  /* A body cell: px-3 py-3 text-sm. */
  .body { padding: 0.75rem; font-size: 0.875rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  /* The head's sub-label: "mt-0.5 block text-phx-3xs font-bold normal-case tracking-normal". */
  .sub { display: block; margin-top: 0.125rem; font-size: 9px; font-weight: 700; text-transform: none; letter-spacing: normal; }
  /* MeasureCell's value: "block text-base font-black". */
  .value { display: block; font-size: 1rem; font-weight: 900; }
  /* MeasureCell's caption: "mt-1 block text-phx-3xs font-semibold". */
  .caption { display: block; margin-top: 0.25rem; font-size: 9px; font-weight: 600; line-height: 1rem; }
  /* The sortable head's link: "inline-flex flex-wrap items-baseline gap-1" — so the arrow may wrap
     away from the label, and the label's own longest word is what cannot. */
  .link { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem; }
`;

/**
 * Every cell measured, newest last.
 *
 * `control` carries the need recorded in tests/kpis-board-tables-fit.test.ts on 2026-09-16. A cell
 * with one is a check on the harness; a cell without one is what this run is for.
 *
 * `gates` says whether that control decides the run. Only a HEAD-driven column gates, for the reason
 * in the header: a one-word head's minimum is reproducible to the pixel, a body cell's is not.
 */
const CELLS = [
  {
    column: "Coverage",
    control: 104,
    gates: true,
    head: { label: "Coverage", sub: "Reached at all", sortable: true },
    body: { value: "100%", caption: "94 of 100 planned doctors" },
  },
  {
    column: "Frequency",
    control: 113,
    gates: true,
    head: { label: "Frequency", sub: "Exact only", sortable: true },
    body: { value: "100%", caption: "61 exact · 30 below · 9 above" },
  },
  {
    // BODY-driven: "AM" is the narrowest head on the board, so the recorded 67px came from the cell
    // under it, and this harness reads that cell 7px narrower. Informational, gates nothing.
    column: "AM",
    control: 67,
    gates: false,
    head: { label: "AM", sub: "Of 2", sortable: true },
    body: { value: "No calls", caption: "1.42 of 2 a day" },
  },
  {
    // NEW on 2026-09-17 — the consolidated figure the owner asked for. Not sortable (a blended
    // rank is the one thing this board does not produce), so its head carries no arrow.
    column: "Overall",
    control: null,
    gates: false,
    head: { label: "Overall", sub: "Average of 4", sortable: false },
    body: {
      // The longest value and the longest caption the cell can print: `overallValue` falls back to
      // "No score" when nothing could be scored, and `overallCaption`'s worst case names two capped
      // measures. See overallValue / overallCaption in kpis-board-view.tsx.
      value: "No score",
      caption: "4 of 4 measures averaged · Frequency and PM capped at 100",
    },
  },
];

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
${CELLS.map(
  (cell, index) => `
  <div class="cell head" id="head-${index}">
    ${cell.head.sortable ? `<span class="link"><span>${cell.head.label}</span><span>↓</span></span>` : `<span>${cell.head.label}</span>`}
    <span class="sub">${cell.head.sub}</span>
  </div>
  <div class="cell body" id="body-${index}">
    <span class="value">${cell.body.value}</span>
    <span class="caption">${cell.body.caption}</span>
  </div>`,
).join("\n")}
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
await page.setContent(html);

/**
 * Two readings per family per cell — the head's own offsetWidth and the body's, kept APART, because
 * which of the two governs a column is the thing this run has to show rather than assume.
 */
const readings = new Map();
for (const font of FONTS) {
  readings.set(
    font.label,
    await page.evaluate(
      ({ css, count }) => {
        document.body.style.fontFamily = css;
        return Array.from({ length: count }, (_, index) => ({
          head: Math.ceil(document.getElementById(`head-${index}`).offsetWidth),
          body: Math.ceil(document.getElementById(`body-${index}`).offsetWidth),
        }));
      },
      { css: font.css, count: CELLS.length },
    ),
  );
}
await browser.close();

const calibration = FONTS.find((font) => font.calibration).label;
const need = (label, index) => {
  const cell = readings.get(label)[index];
  return Math.max(cell.head, cell.body);
};

console.log(`\nKPIs board cells — minimum width before overflow, at the ${NARROWEST_TABLE_PX}px table.`);
console.log("Each reading is head/body: the cell's own width at `width: min-content`, the wider one governs.\n");
console.log(`  ${"family".padEnd(26)}${CELLS.map((cell) => cell.column.padStart(12)).join("")}`);
for (const font of FONTS) {
  const row = readings.get(font.label);
  console.log(
    `  ${font.label.padEnd(26)}${row.map((cell) => `${cell.head}/${cell.body}`.padStart(12)).join("")}` +
      (font.calibration ? "   <- calibration" : ""),
  );
}

let controlsOk = true;
console.log("");
CELLS.forEach((cell, index) => {
  const onCalibration = readings.get(calibration)[index];
  const widest = Math.max(...FONTS.map((font) => need(font.label, index)));
  const driver = onCalibration.head >= onCalibration.body ? "head" : "body";
  if (cell.control == null) {
    console.log(
      `  ${cell.column.padEnd(10)} NEW — record needPx ${widest} (widest family; ` +
        `${Math.max(onCalibration.head, onCalibration.body)} on ${calibration}), which pins the column at ` +
        `${Math.ceil((widest / NARROWEST_TABLE_PX) * 100)}% or more. Driven by its ${driver} ` +
        `(head ${onCalibration.head}, body ${onCalibration.body}).`,
    );
    return;
  }
  const drift = Math.abs(Math.max(onCalibration.head, onCalibration.body) - cell.control);
  if (!cell.gates) {
    console.log(
      `  ${cell.column.padEnd(10)} control ${drift}px off and NOT GATING — recorded ${cell.control}px, ` +
        `${Math.max(onCalibration.head, onCalibration.body)}px here (head ${onCalibration.head}, body ` +
        `${onCalibration.body}). Its ${driver} governs, and this harness only claims to reproduce a head.`,
    );
    return;
  }
  if (drift > 2) controlsOk = false;
  console.log(
    `  ${cell.column.padEnd(10)} control ${drift <= 2 ? "PASS" : "FAIL"} — recorded ${cell.control}px, ` +
      `${Math.max(onCalibration.head, onCalibration.body)}px on ${calibration} (${drift}px drift), ${driver}-driven.`,
  );
});

console.log(
  controlsOk
    ? `\nEvery HEAD control reproduces the 2026-09-16 pass on ${calibration}, so a head-driven reading stands on\n` +
        `the same footing. A body-driven column is not settled by this script — measure that one in the page.\n`
    : `\nA HEAD CONTROL DRIFTED — do not record anything. The harness no longer reproduces the pass it is\n` +
        `calibrated against.\n`,
);
process.exit(controlsOk ? 0 : 1);
