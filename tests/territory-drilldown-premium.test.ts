import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MONTH_CHIP_LEGEND,
  SYNC_DESCRIPTION,
  areaLoadFailedText,
  countOf,
  lineSummaryDetail,
  monthChips,
  pharmacyCount,
  pharmacySheetsLine,
  shortMonthName,
  structureLine,
  syncRunLine,
  syncVerdict,
  trendChartLabel,
} from "@/lib/sales/territory/drilldown-words";

/**
 * The Sales Drilldown premium pass (`/employee-portals/territory-drilldown`, the region → area →
 * block → brick → pharmacy tree and its data sync panel). Every sentence the page says comes from
 * `src/lib/sales/territory/drilldown-words.ts`, worked here by hand; the components are then read
 * for the look the house rules forbid — round corners, gradients, shadows, type under 11px, month
 * names cut to three letters — so none of it can drift back. Account: docs/territory-drilldown.md.
 */

const COMPONENTS = [
  "src/components/sales/territory/territory-tree-desktop.tsx",
  "src/components/sales/territory/territory-tree-mobile.tsx",
  "src/components/sales/territory/territory-month-chips.tsx",
  "src/components/sales/territory/territory-sync-panel.tsx",
  "src/components/sales/territory/territory-line-picker.tsx",
  "src/components/sales/territory/pharmacy-trend-sparkline.tsx",
];

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Every string the page can show, so a gendered word is caught wherever it sits. */
function quotedText(source: string): string[] {
  return [
    ...[...source.matchAll(/"([^"\n]*)"/g)].map((m) => m[1]),
    ...[...source.matchAll(/`([^`]*)`/g)].map((m) => m[1]),
    // JSX text, including a sentence on its own line between two tags.
    ...[...source.matchAll(/>([^<>{}]+)</g)].map((m) => m[1].trim()).filter(Boolean),
  ];
}

export function runTerritoryDrilldownPremiumTests() {
  // ── Counts: spelled out with their noun, thousands separated, never "row(s)" ───────────────────
  assert.equal(countOf(1, "row"), "1 row");
  assert.equal(countOf(0, "row"), "0 rows");
  assert.equal(countOf(1204, "row"), "1,204 rows");
  assert.equal(pharmacyCount(1), "1 pharmacy");
  assert.equal(pharmacyCount(12), "12 pharmacies");
  assert.equal(structureLine({ blocks: 3, pharmacies: 41 }), "3 blocks · 41 pharmacies");
  assert.equal(structureLine({ blocks: 1, pharmacies: null }), "1 block", "pharmacies not loaded yet are left out, never a zero");
  assert.equal(structureLine({ bricks: 1, pharmacies: 1 }), "1 brick · 1 pharmacy");
  assert.equal(structureLine({ areas: 14 }), "14 areas");
  assert.equal(structureLine({}), "");

  // ── Month chips: the year on the first chip and on each January ─────────────────────────────────
  const crossing = monthChips([
    { period: "2025-11", hasSales: true },
    { period: "2025-12", hasSales: false },
    { period: "2026-01", hasSales: true },
    { period: "2026-02", hasSales: false },
  ]);
  assert.deepEqual(
    crossing.map((chip) => chip.label),
    ["Nov 2025", "Dec", "Jan 2026", "Feb"],
    "a window that crosses a year names the year where it starts and where it turns",
  );
  assert.deepEqual(
    crossing.map((chip) => chip.spoken),
    ["Nov 2025: bought", "Dec 2025: no purchase", "Jan 2026: bought", "Feb 2026: no purchase"],
    "each chip is spoken with its year and its meaning, so the colour is never the only signal",
  );
  const sameYear = monthChips([
    { period: "2026-07", hasSales: true },
    { period: "2026-08", hasSales: true },
  ]);
  assert.deepEqual(sameYear.map((chip) => chip.label), ["Jul 2026", "Aug"]);
  assert.deepEqual(monthChips([]), []);
  const odd = monthChips([{ period: "2026-13", hasSales: false }]);
  assert.equal(odd[0].label, "2026-13", "a period that is not a month is shown as it is, never guessed");
  assert.match(MONTH_CHIP_LEGEND, /bought/);
  assert.match(MONTH_CHIP_LEGEND, /no purchase/);

  assert.equal(shortMonthName("2026-07"), "Jul");
  assert.equal(shortMonthName("2026-01"), "Jan");
  assert.equal(shortMonthName("bad"), "bad");
  assert.equal(trendChartLabel(["2026-02", "2026-03", "2026-07"]), "Sales value by month, Feb 2026 to Jul 2026");
  assert.equal(trendChartLabel(["2026-07"]), "Sales value by month, Jul 2026");
  assert.equal(trendChartLabel([]), "Sales value by month, no months to show");

  // ── The area header's pharmacy figure is labelled, and the old check mark is words ──────────────
  assert.equal(pharmacySheetsLine("EGP 1,250", null), "Pharmacies on the uploaded sheets: EGP 1,250");
  assert.equal(pharmacySheetsLine("EGP 1,250", true), "Pharmacies on the uploaded sheets: EGP 1,250, adds up to the area's sheets");
  assert.equal(
    pharmacySheetsLine("EGP 1,250", false),
    "Pharmacies on the uploaded sheets: EGP 1,250, differs from the area's sheets total",
    "a pharmacy sum that does not add up is said, not left as a missing tick",
  );

  // ── Errors in the viewer's words, never an HTTP code ───────────────────────────────────────────
  assert.match(areaLoadFailedText(401), /session has ended/);
  assert.match(areaLoadFailedText(403), /session has ended/);
  for (const status of [500, 502, 404, null]) {
    const text = areaLoadFailedText(status);
    assert.match(text, /could not be loaded/);
    assert.doesNotMatch(text, /HTTP|\d{3}/, "no status code reaches the screen");
  }

  // ── The sync panel: what it does, in plain words, for a Medical Rep too ─────────────────────────
  assert.doesNotMatch(SYNC_DESCRIPTION, /re-?stamp|batch|rollup|reconcile/i, "no engine words in the description");
  assert.match(SYNC_DESCRIPTION, /published is never changed/);
  assert.equal(
    syncRunLine({ restampedRows: 1204, refreshedBatches: 3, durationMs: 4210 }),
    "Moved 1,204 rows · rebuilt 3 files · 4.2 seconds",
  );
  assert.equal(syncRunLine({ restampedRows: 1, refreshedBatches: 1, durationMs: 0 }), "Moved 1 row · rebuilt 1 file · 0.0 seconds");
  assert.equal(syncRunLine({ restampedRows: 0, refreshedBatches: 0, durationMs: -5 }), "Moved 0 rows · rebuilt 0 files · 0.0 seconds");
  assert.equal(syncVerdict(true), "Every line adds up to its uploaded sheets.");
  assert.equal(syncVerdict(false), "Some months do not add up to their uploaded sheets.");

  const base = { mismatched: 0, geoMismatchRows: 0, unrollupRows: 0, geographyChecked: true };
  assert.equal(lineSummaryDetail(base), "", "a clean line says nothing after its name");
  assert.equal(lineSummaryDetail({ ...base, geographyChecked: false, geoMismatchRows: 9 }), " · areas not checked");
  assert.equal(lineSummaryDetail({ ...base, geoMismatchRows: 1 }), " · 1 row on the wrong area");
  assert.equal(lineSummaryDetail({ ...base, unrollupRows: 2400 }), " · 2,400 rows missing from the totals");
  assert.equal(
    lineSummaryDetail({ ...base, mismatched: 2, geoMismatchRows: 3, unrollupRows: 1 }),
    " · 3 rows on the wrong area · 1 row missing from the totals",
    "row-level causes outrank the bare month count",
  );
  assert.equal(lineSummaryDetail({ ...base, mismatched: 1 }), " · 1 month not adding up");

  // ── The look: flat, square, 11px floor, month names never cut ───────────────────────────────────
  for (const path of COMPONENTS) {
    const source = read(path);
    for (const [pattern, why] of [
      [/\brounded(-[a-z0-9]+)?\b/, "no round corners (the square-edge golden rule)"],
      [/bg-gradient-/, "flat colour, never a gradient"],
      [/shadow-(\[|sm\b|md\b|lg\b|xl\b|2xl\b)/, "no drop shadows"],
      [/text-phx-(2xs|3xs)\b/, "nothing below 11px"],
      [/fontSize=\{(?:[0-9]|10)\}/, "chart type at 11px or more"],
      [/\.slice\(0,\s*3\)/, "a month's name is read from its period, never cut from a sentence"],
      [/Reconciled ✓/, "the check mark is said in words"],
      [/\(s\)|\(es\)/, "counts are spelled out, never row(s) or batch(es)"],
      [/toLocaleString\(\)/, "numbers are formatted with a named locale"],
      [/\btext-white\/\d+/, "no see-through text on a dark head; a solid tint reads at 11px"],
    ] as const) {
      assert.doesNotMatch(source, pattern, `${path}: ${why}`);
    }
    for (const text of quotedText(source)) {
      assert.doesNotMatch(text, /\b(he|him|his|she|her|hers)\b/i, `${path}: no gendered words on screen — "${text}"`);
    }
  }

  // Both trees draw their month chips from the one shared row, so desktop and phone never drift.
  for (const tree of ["src/components/sales/territory/territory-tree-desktop.tsx", "src/components/sales/territory/territory-tree-mobile.tsx"]) {
    const source = read(tree);
    assert.match(source, /<MonthChipRow\b/, `${tree}: month chips come from MonthChipRow`);
    assert.match(source, /<MonthChipLegend\b/, `${tree}: the chips' two colours are explained once per brick`);
    assert.match(source, /pharmacySheetsLine\(/, `${tree}: the area's pharmacy figure is labelled`);
    assert.match(source, /structureLine\(/, `${tree}: structural counts are spelled through structureLine`);
    assert.doesNotMatch(source, /block\{|area\{|brick\{/, `${tree}: no hand-built plurals`);
  }
  const chips = read("src/components/sales/territory/territory-month-chips.tsx");
  assert.match(chips, /aria-label=\{chip\.spoken\}/, "each chip is spoken with its year and meaning");

  const sparkline = read("src/components/sales/territory/pharmacy-trend-sparkline.tsx");
  assert.match(sparkline, /fontSize=\{11\}/);
  assert.match(sparkline, /trendChartLabel\(/, "the chart names its window for a screen reader");

  const hook = read("src/components/sales/territory/use-territory-tree.ts");
  assert.doesNotMatch(hook, /HTTP \$\{/, "the area load error never shows a status code");
  assert.match(hook, /areaLoadFailedText\(/);

  const panel = read("src/components/sales/territory/territory-sync-panel.tsx");
  for (const call of ["SYNC_DESCRIPTION", "syncRunLine(report)", "syncVerdict(", "lineSummaryDetail(line)"]) {
    assert.ok(panel.includes(call), `the sync panel says its words through ${call}`);
  }

  // The Regional Sales Manager's home tile carries the page's own name, as the menu and the page do.
  const rmHome = read("src/components/employee-portal/dashboards/rm-command-center.tsx");
  assert.match(rmHome, /href: "\/employee-portals\/territory-drilldown", icon: MapIcon, label: "Sales Drilldown"/);
}
