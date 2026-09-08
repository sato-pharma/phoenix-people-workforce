import assert from "node:assert/strict";
import JSZip from "jszip";

import { HOUSE_XLSX_COLORS } from "../src/lib/export/house-xlsx-palette.ts";
import { buildClosingEngineFill } from "../src/lib/sales/closing-engine-data.ts";
import { fillClosingEngine } from "../src/lib/sales/closing-engine-fill.ts";
import { EXECUTIVE_GEOMETRY } from "../src/lib/sales/closing-executive-look.ts";
import { buildClosingPerformanceReview } from "../src/lib/sales/closing-performance-review.ts";
import type { MonthlyClosingCell, MonthlyClosingMatrix } from "../src/lib/sales/monthly-closing.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE PREMIUM MONTHLY CLOSING WORKBOOK IS EXEMPT FROM THE HOUSE DOCUMENT IDENTITY.
//
// Owner instruction, 2026-09-08. He was shown a redesign of this workbook, approved it, and asked
// for it to become the standing visual identity of the file: "Treat this workbook as the OFFICIAL
// visual reference and design standard for all future Monthly Closing files." He was told, in the
// same conversation and before the work began, that the look deliberately departs from three of his
// own locked rules -- the square-edge rule (its buttons are rounded), the ink rule (it carries
// filled navy bands and filled table headers), and the house palette (its navy is not one of the
// four blues measured from the logo) -- and he answered: "yes, keep the design, pin it with a test."
//
// THIS TEST EXISTS BECAUSE THE EXEMPTION IS INVISIBLE IN THE CODE. `house-identity.ts` says every
// company document wears SATO-DIS-2026-01 v1.0, and its ink rule forbids filled areas outright. A
// session sweeping for documents not yet on the standard finds this workbook, finds a hundred and
// thirty filled shapes and a rounded button bar, and "finishes the job" -- reversing an owner
// decision while believing it is enforcing one. That has already happened twice in this repository,
// to the automated payroll exports and to the weekly NSM/DSM book, and both needed a red test to
// argue back. See `payroll-phoenix-look.test.ts` and `weekly-nsm-dsm-beige-look.test.ts`; this is
// the same shape and the third instance.
//
// THE SPLIT IS PER-EXPORT, NOT PER-MODULE. The offer letters, the hiring pack and the published
// payslip renderer all stay on the house identity. Only this workbook is exempt, and only because
// he looked at it and said so.
// ─────────────────────────────────────────────────────────────────────────────

/** The four brand blues. None may appear in this workbook, as fill or as type. */
const HOUSE_ONLY = [
  HOUSE_XLSX_COLORS.deep,
  HOUSE_XLSX_COLORS.blue,
  HOUSE_XLSX_COLORS.light,
  HOUSE_XLSX_COLORS.tint,
] as const;

// The executive look's own marks, re-typed here on purpose rather than imported. A test that
// imported the workbook's own constants could not fail when they changed -- it would assert only
// that the file equals itself. These literals are the owner's decision written down independently
// of the code that implements it, which is the whole point of a pinning test.
const BAND_NAVY = "FF042C46";
const BRAND_BLUE = "FF085080";
const ACCENT_BLUE = "FF0868A8";

/** The three heights that carry the layout: title, navigation, warning strip. */
const OVERVIEW_BAND = { nav: 37, title: 44, warning: 30 } as const;

const PRODUCTS = [
  { family: "Royafloxacin", productCode: "RY001", productName: "Royafloxacin 500mg" },
  { family: "Saginko", productCode: "SG001", productName: "Saginko 80mg" },
];

function cell(salesUnits: number, salesValue: number, targetUnits: number | null, targetValue: number | null): MonthlyClosingCell {
  return {
    achievement: targetValue == null || targetValue <= 0 ? null : salesValue / targetValue,
    salesUnits,
    salesValue,
    targetUnits,
    targetValue,
  };
}

function sum(cells: MonthlyClosingCell[]): MonthlyClosingCell {
  const salesValue = cells.reduce((total, one) => total + one.salesValue, 0);
  const targeted = cells.filter((one) => one.targetValue != null);
  const targetValue = targeted.length === 0 ? null : targeted.reduce((total, one) => total + (one.targetValue ?? 0), 0);
  return {
    achievement: targetValue == null || targetValue <= 0 ? null : salesValue / targetValue,
    salesUnits: cells.reduce((total, one) => total + one.salesUnits, 0),
    salesValue,
    targetUnits: targeted.length === 0 ? null : targeted.reduce((total, one) => total + (one.targetUnits ?? 0), 0),
    targetValue,
  };
}

function fixture(period: string, scale = 1): MonthlyClosingMatrix {
  const regions = ["Cairo", "Giza", "Alex-BHR"].map((regionName, index) => {
    const areas = [0, 1].map((slot) => {
      const cells = [cell(180 * scale, 12_047 * scale, 429, 26_040), cell(0, 0, 306, 34_012)];
      return {
        areaCode: `A${index}${slot}`,
        areaName: `${regionName} area ${slot + 1}`,
        cells,
        kind: "area" as const,
        regionCode: `R${index}`,
        regionName,
        rowTotal: sum(cells),
      };
    });
    return {
      areas,
      regionCode: `R${index}`,
      regionName,
      subtotal: {
        cells: PRODUCTS.map((_, column) => sum(areas.map((area) => area.cells[column]!))),
        kind: "regionSubtotal" as const,
        regionCode: `R${index}`,
        regionName,
        rowTotal: sum(areas.map((area) => area.rowTotal)),
      },
    };
  });
  const allAreas = regions.flatMap((region) => region.areas);
  return {
    availableLines: ["Anti Infective"],
    availablePeriods: ["2026-08", "2026-09"],
    columns: PRODUCTS,
    grandTotal: {
      cells: PRODUCTS.map((_, column) => sum(allAreas.map((area) => area.cells[column]!))),
      kind: "grandTotal",
      rowTotal: sum(allAreas.map((area) => area.rowTotal)),
    },
    line: "Anti Infective",
    period,
    regions,
  };
}

export async function runClosingExecutiveLookTests() {
  const matrix = fixture("2026-09");
  const fill = buildClosingEngineFill({
    matrix,
    priorMatrix: fixture("2026-08", 3),
    review: buildClosingPerformanceReview({
      availableLines: ["Anti Infective"],
      availablePeriods: ["2026-08", "2026-09"],
      generatedAt: "2026-09-08T20:00:00.000Z",
      matrix,
      seatAssignments: new Map(),
      seriesMatrices: [{ matrix, period: "2026-09" }],
    }),
  });
  const zip = await JSZip.loadAsync(await fillClosingEngine(fill, { macroFree: true }));

  // ── The house identity does not reach this workbook ──────────────────────────────────────────
  const styles = await zip.file("xl/styles.xml")!.async("string");
  let drawingXml = "";
  for (const file of zip.file(/^xl\/drawings\/drawing\d+\.xml$/)) drawingXml += await file.async("string");

  for (const colour of HOUSE_ONLY) {
    const bare = colour.replace(/^FF/, "");
    assert.doesNotMatch(
      styles,
      new RegExp(bare, "i"),
      `the house blue ${colour} appears in this workbook's styles — it is exempt from the house identity by the owner's decision of 2026-09-08, so a sweep that painted it here has reversed him`,
    );
    assert.doesNotMatch(
      drawingXml,
      new RegExp(bare, "i"),
      `the house blue ${colour} appears in this workbook's shapes — same exemption, same reversal`,
    );
  }

  // ── ...and the look it was given instead is still here ───────────────────────────────────────
  for (const colour of [BAND_NAVY, BRAND_BLUE, ACCENT_BLUE]) {
    assert.match(
      styles,
      new RegExp(colour.replace(/^FF/, ""), "i"),
      `${colour} is one of the approved workbook's own colours and it is gone — the look has been restyled away`,
    );
  }

  // ── The buttons stay ROUND ───────────────────────────────────────────────────────────────────
  // The square-edge golden rule says no round corners anywhere, and it is enforced in the admin
  // shell by a sweep that would happily reach this file. The owner looked at these buttons and kept
  // them, so a build whose shapes are all `rect` has had that rule applied where it does not go.
  const rounded = (drawingXml.match(/<a:prstGeom prst="roundRect"/g) ?? []).length;
  assert.ok(
    rounded > 0,
    "every shape in this workbook is square-cornered — the square-edge rule does not reach this export, and the owner kept its rounded buttons",
  );

  // ── The filled bands stay FILLED ─────────────────────────────────────────────────────────────
  // The ink rule ("no filled areas, anywhere") is the other half of the house standard, and the
  // whole visual identity of this workbook is carried by area: a navy title band, a filled table
  // header, filled KPI panels. A build that had the ink rule applied to it loses them.
  const filled = (drawingXml.match(/<a:solidFill>/g) ?? []).length;
  assert.ok(
    filled >= 50,
    `only ${filled} filled shapes — this workbook carries its identity in filled bands, and the ink rule does not reach it`,
  );

  // ── The geometry that makes it read as executive rather than as a spreadsheet ────────────────
  // Height is most of what separates the approved look from what shipped before it: a 44pt title
  // against 34, a 30pt warning strip against 6.95. Reset those and the sheet reverts to the old
  // density even with every colour still in place, which is a regression nothing else would catch.
  const overviewXml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  const heightOf = (row: number): number | null => {
    const tag = new RegExp(`<row\\b[^>]*\\br="${row}"[^>]*>`).exec(overviewXml)?.[0] ?? "";
    const ht = /\bht="([\d.]+)"/.exec(tag)?.[1];
    return ht === undefined ? null : Number(ht);
  };
  assert.equal(heightOf(1), OVERVIEW_BAND.title, "the Overview title band keeps its approved height");
  assert.equal(heightOf(2), OVERVIEW_BAND.nav, "the navigation row keeps its approved height");
  assert.equal(heightOf(3), OVERVIEW_BAND.warning, "the warning strip keeps its approved height");

  // The table is the source of those numbers, so it is asserted too: an edit that changed the
  // geometry table and the workbook together would otherwise pass every line above.
  assert.equal(EXECUTIVE_GEOMETRY.Overview?.head[1], OVERVIEW_BAND.title, "the geometry table itself still carries the approved title height");
  assert.equal(EXECUTIVE_GEOMETRY.Overview?.head[3], OVERVIEW_BAND.warning, "and the approved warning height");

  // ── The positive control ─────────────────────────────────────────────────────────────────────
  // Every assertion above passes on an empty string. These are the counts measured on the build
  // this test was written against, so a sweep that silently found nothing to look at fails here
  // rather than reporting the design intact.
  assert.ok(drawingXml.length > 10_000, "the drawings were actually read — an empty sweep passes every colour check above");
  assert.ok(styles.length > 10_000, "and so were the styles");
}
