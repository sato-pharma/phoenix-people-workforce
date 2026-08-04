import assert from "node:assert/strict";

import {
  buildMonthlyClosingMatrix,
  filterMonthlyClosingMatrix,
  injectDirectIntoMatrix,
  isClosingRegionRefinement,
  type MonthlyClosingDistrict,
  type SalesAreaReference,
  type SalesProductReference,
} from "../src/lib/sales/monthly-distributor-import.ts";
import { scopeMatrixToRegionNames } from "../src/lib/sales/monthly-closing-portal.ts";

// The Closing Matrix groups areas by the region code their SALES rows carry — one flat "UE".
// Anti Infective, though, really runs Upper Egypt as TWO districts with two managers:
//   UE-1 = Minia 1 / Minia 2      (SEAT-AIF-ADM-UE-1, Nosiba Salah)
//   UE-2 = Assuit / Sohag / Qena  (SEAT-AIF-DM-UE-2,  Ahmed Nashaat)
// Reported as one merged block, neither manager could read their own number — and the Direct
// channel already imports region UE-1 / UE-2, so the sheet was showing Upper Egypt THREE times
// (one distributor block plus two direct-only orphans).
//
// The fix reads the organogram (au.line_area_map.operational_region_code) but honours it ONLY
// where it SUB-DIVIDES the area's own geography. The same column also parks line-specific
// "Others" areas (Anti Infective CA5 -> OT) and hands single areas to a neighbouring district
// (GZ6 -> UE-1, CNS D16 -> AB); adopting those would restate district subtotals nobody asked to
// change. That predicate is the whole safety story, so most of what follows tests what must NOT
// move.

const AREAS: SalesAreaReference[] = [
  { areaCode: "CA5", areaName: "Down town", regionCode: "CA", regionName: "Cairo" },
  { areaCode: "GZ1", areaName: "Giza - Giza Centers", regionCode: "GZ", regionName: "Giza" },
  { areaCode: "GZ6", areaName: "Fayoum-Beni Suef", regionCode: "GZ", regionName: "Giza" },
  { areaCode: "UE1", areaName: "Minia 1", regionCode: "UE", regionName: "Upper Egypt" },
  { areaCode: "UE2", areaName: "Minia 2", regionCode: "UE", regionName: "Upper Egypt" },
  { areaCode: "UE3", areaName: "Assuit 1", regionCode: "UE", regionName: "Upper Egypt" },
  { areaCode: "UE7", areaName: "Qena 1", regionCode: "UE", regionName: "Upper Egypt" },
];

// Exactly what production's au_v_line_area_map returns for anti_infective (2026-08-02).
const AIF_DISTRICTS: MonthlyClosingDistrict[] = [
  { areaCode: "CA5", regionCode: "OT", regionName: "Others" },
  { areaCode: "GZ1", regionCode: "GZ", regionName: "Giza" },
  { areaCode: "GZ6", regionCode: "UE-1", regionName: "Upper Egypt 1" },
  { areaCode: "UE1", regionCode: "UE-1", regionName: "Upper Egypt 1" },
  { areaCode: "UE2", regionCode: "UE-1", regionName: "Upper Egypt 1" },
  { areaCode: "UE3", regionCode: "UE-2", regionName: "Upper Egypt 2" },
  { areaCode: "UE7", regionCode: "UE-2", regionName: "Upper Egypt 2" },
];

const PRODUCTS: SalesProductReference[] = [
  { factoryPrice: 10, family: "F", familyCode: "F", line: "L", productCode: "P1", productName: "Product One", source: "" },
];

// One unit of sales per area, priced 10 — so any regrouping error shows up as a wrong count.
const CELLS = AREAS.map((area, index) => ({
  areaCode: area.areaCode,
  productCode: "P1",
  salesUnits: index + 1,
  salesValue: (index + 1) * 10,
}));

function build(districts?: MonthlyClosingDistrict[]) {
  return buildMonthlyClosingMatrix({
    areas: AREAS,
    availableLines: ["L"],
    availablePeriods: ["2026-06"],
    cells: CELLS,
    districts,
    line: "L",
    period: "2026-06",
    products: PRODUCTS,
  });
}

const regionOf = (m: ReturnType<typeof build>, code: string) => m.regions.find((r) => r.regionCode === code);
const areaCodesIn = (m: ReturnType<typeof build>, code: string) =>
  (regionOf(m, code)?.areas ?? []).map((a) => a.areaCode).sort();

export function runClosingMatrixOrganogramDistrictTests() {
  // ── The headline: Upper Egypt becomes two district blocks ───────────────────
  {
    const m = build(AIF_DISTRICTS);

    assert.deepEqual(
      areaCodesIn(m, "UE-1"),
      ["UE1", "UE2"],
      "UE-1 must hold exactly Minia 1 + Minia 2 — the SEAT-AIF-ADM-UE-1 territory",
    );
    assert.deepEqual(
      areaCodesIn(m, "UE-2"),
      ["UE3", "UE7"],
      "UE-2 must hold exactly the Assuit/Qena areas — the SEAT-AIF-DM-UE-2 territory",
    );
    assert.equal(regionOf(m, "UE"), undefined, "the merged 'UE' block must be gone once it is split");

    assert.equal(regionOf(m, "UE-1")!.regionName, "Upper Egypt 1", "named from au_v_regions, not the bare code");
    assert.equal(regionOf(m, "UE-2")!.regionName, "Upper Egypt 2");

    // Subtotals must be the sum of their own areas, nothing borrowed from the sibling district.
    assert.equal(regionOf(m, "UE-1")!.subtotal.cells[0].salesValue, 40 + 50, "UE-1 = UE1 + UE2 only");
    assert.equal(regionOf(m, "UE-2")!.subtotal.cells[0].salesValue, 60 + 70, "UE-2 = UE3 + UE7 only");
  }

  // ── Splitting a block must never change the national number ─────────────────
  // Regrouping moves rows between subtotals; it must not add, drop or double-count an area.
  {
    const before = build();
    const after = build(AIF_DISTRICTS);
    assert.equal(
      after.grandTotal.rowTotal.salesValue,
      before.grandTotal.rowTotal.salesValue,
      "the grand total is invariant under regrouping — if this moves, an area was counted twice or lost",
    );
    assert.equal(
      after.regions.flatMap((r) => r.areas).length,
      before.regions.flatMap((r) => r.areas).length,
      "same number of area rows before and after",
    );
  }

  // ── What must NOT move: reassignments are not refinements ───────────────────
  // GZ6 (Fayoum-Beni Suef) is mapped to UE-1 by the organogram, but it is a different geography,
  // not a sub-division of Giza. It is also a genuinely mixed area — its bricks straddle Fayoum
  // (Giza's) and Beni Suef (UE-1's) — so moving the whole area either way would be wrong. It
  // stays on sheet geography until that area is split.
  {
    const m = build(AIF_DISTRICTS);
    assert.ok(areaCodesIn(m, "GZ").includes("GZ6"), "GZ6 must stay in Giza — 'GZ' -> 'UE-1' is a move, not a split");
    assert.ok(!areaCodesIn(m, "UE-1").includes("GZ6"), "GZ6 must not be pulled into UE-1");
    assert.equal(regionOf(m, "UE-1")!.subtotal.cells[0].salesValue, 90, "so UE-1's subtotal excludes GZ6");
  }

  // ── What must NOT move: line-specific "Others" parking ──────────────────────
  {
    const m = build(AIF_DISTRICTS);
    assert.ok(areaCodesIn(m, "CA").includes("CA5"), "CA5 must stay in Cairo — 'CA' -> 'OT' is a move, not a split");
    assert.equal(regionOf(m, "OT"), undefined, "no Others block may appear out of nowhere");
  }

  // ── A line with no refinement is untouched, block for block ─────────────────
  // CNS and Pedia have reassignments but no split region, so their sheets must render exactly as
  // they did before this change.
  {
    const cnsDistricts: MonthlyClosingDistrict[] = [
      { areaCode: "CA5", regionCode: "GZ", regionName: "Giza" },
      { areaCode: "GZ6", regionCode: "OT", regionName: "Others" },
      { areaCode: "UE1", regionCode: "UE", regionName: "Upper Egypt" },
    ];
    assert.deepEqual(
      build(cnsDistricts).regions.map((r) => [r.regionCode, r.areas.map((a) => a.areaCode)]),
      build().regions.map((r) => [r.regionCode, r.areas.map((a) => a.areaCode)]),
      "a line whose organogram only REASSIGNS areas must group identically to no organogram at all",
    );
  }

  // ── The two districts sort together, in Upper Egypt's national slot ─────────
  {
    const codes = build(AIF_DISTRICTS).regions.map((r) => r.regionCode);
    assert.deepEqual(codes, ["CA", "GZ", "UE-1", "UE-2"], "UE-1/UE-2 rank where 'UE' used to, and stay adjacent");
  }

  // ── A manager scoped by the COARSE region name still sees their district ────
  // Both Anti Infective Upper Egypt managers' employee rows say "Upper Egypt". Matching only the
  // refined name would have handed them an empty closing the moment the split shipped.
  {
    const scoped = scopeMatrixToRegionNames(build(AIF_DISTRICTS), new Set(["upper egypt"]));
    assert.deepEqual(
      scoped.regions.map((r) => r.regionCode).sort(),
      ["UE-1", "UE-2"],
      "'Upper Egypt' must still resolve to both of its districts",
    );
    assert.equal(scoped.grandTotal.rowTotal.salesValue, 40 + 50 + 60 + 70, "and the scoped total covers both");

    const giza = scopeMatrixToRegionNames(build(AIF_DISTRICTS), new Set(["giza"]));
    assert.deepEqual(giza.regions.map((r) => r.regionCode), ["GZ"], "a Giza viewer must NOT gain the UE districts");
  }

  // ── Direct rows land in their own district, and a stale coarse row is visible ─
  // Direct already imports UE-1 / UE-2. A residual "UE" direct row (the ambiguous upload shape)
  // must NOT be silently folded into one district — it gets its own named block so it is seen.
  {
    const m = injectDirectIntoMatrix(build(AIF_DISTRICTS), [
      { productCode: "P1", regionCode: "UE-1", salesUnits: 30, salesValue: 300 },
      { productCode: "P1", regionCode: "UE-2", salesUnits: 20, salesValue: 200 },
      { productCode: "P1", regionCode: "UE", salesUnits: 40, salesValue: 400 },
    ]);

    assert.ok(regionOf(m, "UE-1")!.areas.some((a) => a.isDirect), "the UE-1 direct row joins the UE-1 block");
    assert.equal(regionOf(m, "UE-1")!.subtotal.cells[0].salesValue, 90 + 300, "UE-1 subtotal picks up its direct sales");
    assert.equal(regionOf(m, "UE-2")!.subtotal.cells[0].salesValue, 130 + 200);

    const orphan = regionOf(m, "UE")!;
    assert.ok(orphan, "an ambiguous 'UE' direct row must still appear somewhere — never dropped");
    assert.equal(orphan.regionName, "Upper Egypt", "and it reads as Upper Egypt, not a bare code");
    assert.equal(orphan.areas.length, 1, "it is a direct-only block");
    assert.equal(
      m.grandTotal.rowTotal.salesValue,
      280 + 300 + 200 + 400,
      "every direct row still reaches the grand total",
    );
  }

  // ── Filtering keeps a district scopeable by its coarse name ─────────────────
  {
    const filtered = filterMonthlyClosingMatrix(build(AIF_DISTRICTS), { regionCodes: ["UE-1"] });
    assert.equal(filtered.regions.length, 1);
    assert.equal(
      filtered.regions[0].baseRegionName,
      "Upper Egypt",
      "the base region must survive filtering, or a filtered portal view would scope to nothing",
    );
  }

  // ── The predicate itself ────────────────────────────────────────────────────
  {
    assert.equal(isClosingRegionRefinement("UE", "UE-1"), true);
    assert.equal(isClosingRegionRefinement("UE", "UE-2"), true);
    assert.equal(isClosingRegionRefinement("GZ", "UE-1"), false, "different region entirely");
    assert.equal(isClosingRegionRefinement("CA", "OT"), false, "Others parking");
    assert.equal(isClosingRegionRefinement("D1", "AB"), false, "CNS Kafr El-Sheikh 1");
    assert.equal(isClosingRegionRefinement("UE", "UE"), false, "no change is not a refinement");
    assert.equal(isClosingRegionRefinement("D1", "D17"), false, "a shared PREFIX is not a sub-division — the dash is required");
    assert.equal(isClosingRegionRefinement("", "UE-1"), false);
    assert.equal(isClosingRegionRefinement("UE", ""), false);
  }
}
