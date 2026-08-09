import assert from "node:assert/strict";

import {
  buildMonthlyClosingMatrix,
  injectDirectIntoMatrix,
  filterMonthlyClosingMatrix,
  rebuildMatrixFromRows,
  type MonthlyClosingTargetCell,
  type SalesAreaReference,
  type SalesProductReference,
} from "../src/lib/sales/monthly-distributor-import.ts";

// The Closing Matrix's Tgt Units / Tgt Value / Ach % columns.
//
// They shipped as HEADERS OVER HARDCODED NULLS: monthly-closing-export.ts wrote
// `num(row.getCell(start + 2), null, ...)` for all three, on every product, on every row — three
// of every five columns structurally blank — while the loader's own comment said the slots "stay
// null until the Phase 2 targets upload exists". That upload had been live since 2026-07-18.
//
// The owner's report was "many columns are empty ... all comparison on sales only no comparison
// between sales vs target and achievement". These are pure functions, so the roll-up rules are
// tested directly, with no Supabase in the way.
//
// The rule that matters most: a MISSING target is not a zero. A zero target would both assert
// "this area was told to sell nothing" and turn every achievement % into a division by nothing.

const AREAS: SalesAreaReference[] = [
  { areaCode: "CA1", areaName: "Heliopolis", regionCode: "CA", regionName: "Cairo" },
  { areaCode: "CA2", areaName: "Nasr City", regionCode: "CA", regionName: "Cairo" },
  { areaCode: "D11", areaName: "Qalubeya", regionCode: "D1", regionName: "Delta (1)" },
];

const PRODUCTS: SalesProductReference[] = [
  { factoryPrice: 10, family: "F", familyCode: "F", line: "L", productCode: "P1", productName: "Product One", source: "" },
];

function build(targets?: MonthlyClosingTargetCell[]) {
  return buildMonthlyClosingMatrix({
    areas: AREAS,
    availableLines: ["L"],
    availablePeriods: ["2026-07"],
    cells: [
      { areaCode: "CA1", productCode: "P1", salesUnits: 60, salesValue: 600 },
      { areaCode: "CA2", productCode: "P1", salesUnits: 40, salesValue: 400 },
      { areaCode: "D11", productCode: "P1", salesUnits: 10, salesValue: 100 },
    ],
    line: "L",
    period: "2026-07",
    products: PRODUCTS,
    targets,
  });
}

const cairoOf = (m: ReturnType<typeof build>) => m.regions.find((r) => r.regionCode === "CA")!;
const areaOf = (m: ReturnType<typeof build>, code: string) =>
  m.regions.flatMap((r) => r.areas).find((a) => a.areaCode === code)!;

export function runClosingMatrixTargetsTests() {
  // ── No targets at all: every target column stays NULL, never 0 ──────────────
  {
    const m = build();
    assert.equal(areaOf(m, "CA1").cells[0].targetValue, null, "no target row ⇒ null, never 0");
    assert.equal(areaOf(m, "CA1").cells[0].targetUnits, null);
    assert.equal(
      areaOf(m, "CA1").cells[0].achievement,
      null,
      "achievement against no target must be null — a 0 target would divide by nothing",
    );
    assert.equal(cairoOf(m).subtotal.cells[0].targetValue, null, "a region whose areas have no targets stays null");
    assert.equal(m.grandTotal.cells[0].targetValue, null);
    // Sales must be entirely unaffected by the target columns existing.
    assert.equal(cairoOf(m).subtotal.cells[0].salesValue, 1000, "Cairo sales = 600 + 400");
  }

  // ── Targets present: value, units and achievement all populate ──────────────
  {
    const m = build([
      { areaCode: "CA1", productCode: "P1", targetUnits: 50, targetValue: 500 },
      { areaCode: "CA2", productCode: "P1", targetUnits: 100, targetValue: 1000 },
    ]);
    const ca1 = areaOf(m, "CA1").cells[0];
    assert.equal(ca1.targetValue, 500);
    assert.equal(ca1.targetUnits, 50);
    assert.equal(ca1.achievement, 600 / 500, "achievement = sales value ÷ target value");

    // ── The subtotal sums first, THEN divides ────────────────────────────────
    // Averaging the two area percentages would give (1.2 + 0.4) / 2 = 0.8. The correct answer
    // weights by size: (600 + 400) / (500 + 1000) = 0.666…. A region is not the mean of its
    // areas, and this is the assertion that stops someone "simplifying" it into one.
    const cairo = cairoOf(m).subtotal.cells[0];
    assert.equal(cairo.targetValue, 1500, "region target = 500 + 1000");
    assert.equal(cairo.targetUnits, 150);
    assert.equal(cairo.achievement, 1000 / 1500);
    assert.notEqual(cairo.achievement, (600 / 500 + 400 / 1000) / 2, "must NOT be the mean of the area percentages");
  }

  // ── A region where only SOME areas carry a target ───────────────────────────
  // The untargeted area's sales still count toward the numerator (it really did sell), but it
  // must not silently contribute a 0 target and flatter the percentage.
  {
    const m = build([{ areaCode: "CA1", productCode: "P1", targetUnits: 50, targetValue: 500 }]);
    const cairo = cairoOf(m).subtotal.cells[0];
    assert.equal(cairo.targetValue, 500, "only the targeted area contributes to the region target");
    assert.equal(cairo.salesValue, 1000, "both areas' sales still count");
    assert.equal(cairo.achievement, 1000 / 500);
    assert.equal(areaOf(m, "CA2").cells[0].targetValue, null, "the untargeted area keeps a null target");
  }

  // ── Direct rows carry no target and must not zero out the region's ─────────
  // Direct has no area, so it can have no area-level target. Injecting it must leave the region
  // target untouched while its sales DO join the region total.
  {
    const m = injectDirectIntoMatrix(
      build([{ areaCode: "CA1", productCode: "P1", targetUnits: 50, targetValue: 500 }]),
      [{ productCode: "P1", regionCode: "CA", salesUnits: 200, salesValue: 2000 }],
    );
    const direct = cairoOf(m).areas.find((a) => a.isDirect)!;
    assert.equal(direct.cells[0].targetValue, null, "a Direct row has no area, so it can carry no target");
    assert.equal(direct.cells[0].achievement, null);

    const cairo = cairoOf(m).subtotal.cells[0];
    assert.equal(cairo.targetValue, 500, "Direct must not add a 0 target to the region");
    assert.equal(cairo.salesValue, 3000, "Direct sales DO join the region total: 600 + 400 + 2000");
    assert.equal(cairo.achievement, 3000 / 500, "achievement reflects the Direct sales it now includes");
  }

  // ── Filtering re-derives targets, not just sales ────────────────────────────
  // filterMonthlyClosingMatrix rebuilds subtotals from the surviving areas. If it summed sales
  // but carried a stale target through, a filtered view would show the wrong achievement.
  {
    const m = filterMonthlyClosingMatrix(
      build([
        { areaCode: "CA1", productCode: "P1", targetUnits: 50, targetValue: 500 },
        { areaCode: "CA2", productCode: "P1", targetUnits: 100, targetValue: 1000 },
      ]),
      { areaCodes: ["CA1"] },
    );
    const cairo = cairoOf(m).subtotal.cells[0];
    assert.equal(cairo.targetValue, 500, "filtering to CA1 must drop CA2's target too");
    assert.equal(cairo.salesValue, 600);
    assert.equal(cairo.achievement, 600 / 500, "the filtered achievement is re-derived from the survivors");
    assert.equal(m.grandTotal.cells[0].targetValue, 500, "the grand total re-derives as well");
  }

  // ── A zero target is treated as no target, not as infinite achievement ──────
  {
    const m = build([{ areaCode: "CA1", productCode: "P1", targetUnits: 0, targetValue: 0 }]);
    const ca1 = areaOf(m, "CA1").cells[0];
    assert.equal(ca1.targetValue, 0, "a real 0 target is still reported as entered");
    assert.equal(ca1.achievement, null, "but achievement against 0 must be null, never Infinity");
    assert.ok(Number.isFinite(ca1.salesValue));
  }

  // ── rebuildMatrixFromRows — row-level filtered exports re-sum every cell from the invoice
  // rows the Data sheet shows, because a distributor / Included-Excluded / search filter slices
  // INSIDE a cell, which the aggregate matrix cannot express. ──
  {
    const skeleton = build([{ areaCode: "CA1", productCode: "P1", targetUnits: 50, targetValue: 500 }]);
    const row = (areaCode: string, qty: number, salesValue: number, includedInClosing = true) =>
      ({ areaCode, includedInClosing, productCode: "P1", qty, salesValue });

    // One distributor's rows only: CA1 keeps 25/250, CA2 drops to zero but KEEPS ITS ROW.
    const rebuilt = rebuildMatrixFromRows(skeleton, [
      row("CA1", 25, 250),
      row("CA1", 5, 50, false), // excluded row — must not count
    ]);
    const ca1 = rebuilt.regions.flatMap((r) => r.areas).find((a) => a.areaCode === "CA1")!;
    const ca2 = rebuilt.regions.flatMap((r) => r.areas).find((a) => a.areaCode === "CA2")!;
    assert.equal(ca1.cells[0].salesValue, 250, "the cell is re-summed from the filtered rows");
    assert.equal(ca1.cells[0].salesUnits, 25);
    assert.equal(ca2.cells[0].salesValue, 0, "an area the filter left empty shows zero");
    assert.ok(rebuilt.regions.flatMap((r) => r.areas).some((a) => a.areaCode === "CA2"),
      "…but keeps its row — 'sold nothing here' must stay visible");
    assert.equal(rebuilt.grandTotal.rowTotal.salesValue, 250, "grand total = exactly the filtered rows");

    // Targets/achievement go null: they are company-set per area & product and cannot be sliced.
    assert.equal(ca1.cells[0].targetValue, null, "a row-level slice must not claim a target");
    assert.equal(ca1.cells[0].achievement, null, "…nor a fake achievement %");

    // Direct rows and the company total are dropped — Direct orders are not distributor invoice
    // rows, so no row-level filter can apply to them.
    const withDirect = injectDirectIntoMatrix(skeleton, [
      { productCode: "P1", regionCode: "CA", salesUnits: 7, salesValue: 70 },
    ]);
    const rebuiltFromDirect = rebuildMatrixFromRows(withDirect, [row("CA1", 25, 250)]);
    assert.ok(
      rebuiltFromDirect.regions.flatMap((r) => r.areas).every((a) => !a.isDirect),
      "Direct area rows are dropped from a row-level filtered matrix",
    );
    assert.equal(rebuiltFromDirect.companyTotal, null);
    assert.equal(rebuiltFromDirect.directNational, null);
    assert.equal(rebuiltFromDirect.grandTotal.rowTotal.salesValue, 250,
      "the grand total covers the filtered distributor rows only");

    // Excluded-only filter: every row is excluded from the closing, so the closing matrix is
    // honestly zero — never a whole-month number next to an excluded-only Data sheet.
    const excludedOnly = rebuildMatrixFromRows(skeleton, [row("CA1", 9, 90, false)]);
    assert.equal(excludedOnly.grandTotal.rowTotal.salesValue, 0);
  }

  // ── preserveTargets — the PORTAL export path ────────────────────────────────
  // The employee-portal closing export rebuilds the matrix from the viewer's own rows so the
  // Matrix ties to the Data sheet (the store split moves sales between a city's areas). That is
  // NOT a distributor slice — the whole of the viewer's scope is present — so each cell's target
  // really does belong beside its rebuilt sales. Without `preserveTargets` the exported Closing
  // Matrix and Target vs Achievement sheets came out with EVERY target blank (an NSM downloading
  // the Anti Infective closing got a file with no target and no achievement); with it, the target
  // survives and achievement re-derives from the rebuilt sales.
  {
    const skeleton = build([
      { areaCode: "CA1", productCode: "P1", targetUnits: 50, targetValue: 500 },
      { areaCode: "CA2", productCode: "P1", targetUnits: 100, targetValue: 1000 },
    ]);
    const row = (areaCode: string, qty: number, salesValue: number) =>
      ({ areaCode, includedInClosing: true, productCode: "P1", qty, salesValue });

    const rebuilt = rebuildMatrixFromRows(
      skeleton,
      [row("CA1", 30, 300), row("CA2", 40, 400)],
      { preserveTargets: true },
    );
    const ca1 = rebuilt.regions.flatMap((r) => r.areas).find((a) => a.areaCode === "CA1")!;
    const ca2 = rebuilt.regions.flatMap((r) => r.areas).find((a) => a.areaCode === "CA2")!;

    assert.equal(ca1.cells[0].salesValue, 300, "sales are still re-summed from the rows");
    assert.equal(ca1.cells[0].targetValue, 500, "the skeleton's target is KEPT, not nulled");
    assert.equal(ca1.cells[0].targetUnits, 50);
    assert.equal(ca1.cells[0].achievement, 300 / 500, "achievement re-derives from the rebuilt sales over the kept target");

    // Roll-ups carry the kept targets, so the whole-line total is measurable again.
    assert.equal(rebuilt.grandTotal.rowTotal.targetValue, 1500, "grand total target = 500 + 1000");
    assert.equal(rebuilt.grandTotal.rowTotal.salesValue, 700, "grand total sales = 300 + 400");
    assert.equal(rebuilt.grandTotal.rowTotal.achievement, 700 / 1500, "grand achievement re-derives from the sums");

    // An area with a target but no rows must read as 0 sales against its real target (0% achieved),
    // never as a blank — a genuine miss must be visible.
    const partial = rebuildMatrixFromRows(skeleton, [row("CA1", 30, 300)], { preserveTargets: true });
    const partialCa2 = partial.regions.flatMap((r) => r.areas).find((a) => a.areaCode === "CA2")!;
    assert.equal(partialCa2.cells[0].salesValue, 0, "no rows for CA2 ⇒ zero sales");
    assert.equal(partialCa2.cells[0].targetValue, 1000, "…but its target is still shown");
    assert.equal(partialCa2.cells[0].achievement, 0, "0 sales against a real target is 0% achieved, not blank");

    // The default (admin filtered) path is UNCHANGED — targets still go null there.
    const adminDefault = rebuildMatrixFromRows(skeleton, [row("CA1", 30, 300)]);
    const adminCa1 = adminDefault.regions.flatMap((r) => r.areas).find((a) => a.areaCode === "CA1")!;
    assert.equal(adminCa1.cells[0].targetValue, null, "without the flag, a rebuilt cell still claims no target");
  }
}
