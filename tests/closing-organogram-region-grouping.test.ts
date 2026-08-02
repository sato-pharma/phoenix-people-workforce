import assert from "node:assert/strict";

import {
  applyOperationalRegions,
  buildMonthlyClosingMatrix,
  CLOSING_ORGANOGRAM_REGION_LINES,
  type SalesAreaReference,
  type SalesProductReference,
} from "../src/lib/sales/monthly-distributor-import.ts";

// Monthly Closing grouping for Anti Infective.
//
// The owner's rule (2026-08-02) is per-LINE: "only in Anti Infective, Fayoum belongs to GZ and
// Beni Suef belongs to UE-1; in other lines these areas belong to GZ". An area carries exactly one
// static region_code and buildMonthlyClosingMatrix grouped on it directly, so the rule could not
// be said at all -- which is why GZ6 "Fayoum-Beni Suef" was split into GZ8 Fayoum + GZ9 Beni Suef
// and why the Anti Infective sheet now groups by the organogram's district territory instead.
//
// The scope is deliberately narrow. Applying the same override to CNS and Pedia would ALSO move
// Down town CA->GZ, Kafr El-Sheikh 1 D1->AB and Helwan-Maadi GZ->CA, silently restating two sheets
// nobody asked to change.

const REGION_NAMES = new Map<string, string>([
  ["GZ", "Giza"],
  ["UE", "Upper Egypt"],
  ["UE-1", "Upper Egypt 1"],
  ["UE-2", "Upper Egypt 2"],
  ["CA", "Cairo"],
]);

/** Both halves of the old GZ6, plus a plain Upper Egypt area for the ordering check. */
const AREAS: SalesAreaReference[] = [
  { areaCode: "GZ8", areaName: "Fayoum", regionCode: "GZ", regionName: "Giza" },
  { areaCode: "GZ9", areaName: "Beni Suef", regionCode: "GZ", regionName: "Giza" },
  { areaCode: "UE3", areaName: "Assuit 1", regionCode: "UE", regionName: "Upper Egypt" },
];

/** What au_v_line_area_map says for anti_infective, carries_target rows only. */
const AIF_OPERATIONAL = new Map<string, string>([
  ["GZ8", "GZ"],
  ["GZ9", "UE-1"],
  ["UE3", "UE-2"],
]);

const PRODUCTS: SalesProductReference[] = [
  { factoryPrice: 10, family: "F", familyCode: "F", line: "L", productCode: "P1", productName: "Product One", source: "" },
];

function matrixFor(areas: SalesAreaReference[]) {
  return buildMonthlyClosingMatrix({
    areas,
    availableLines: ["Anti Infective"],
    availablePeriods: ["2026-07"],
    cells: [
      { areaCode: "GZ8", productCode: "P1", salesUnits: 6, salesValue: 60 },
      { areaCode: "GZ9", productCode: "P1", salesUnits: 75, salesValue: 750 },
      { areaCode: "UE3", productCode: "P1", salesUnits: 10, salesValue: 100 },
    ],
    line: "Anti Infective",
    period: "2026-07",
    products: PRODUCTS,
  });
}

const regionOf = (m: ReturnType<typeof matrixFor>, code: string) =>
  m.regions.find((region) => region.regionCode === code);

export function runClosingOrganogramRegionGroupingTests() {
  // ── The rule the split exists to make expressible ──────────────────────────
  {
    const moved = applyOperationalRegions(AREAS, AIF_OPERATIONAL, REGION_NAMES);
    const beniSuef = moved.find((area) => area.areaCode === "GZ9");
    const fayoum = moved.find((area) => area.areaCode === "GZ8");

    assert.equal(
      beniSuef?.regionCode,
      "UE-1",
      "Beni Suef must sit under UE-1 on the Anti Infective sheet, not GZ",
    );
    assert.equal(beniSuef?.regionName, "Upper Egypt 1", "the moved region carries its real name");
    assert.equal(fayoum?.regionCode, "GZ", "Fayoum stays in Giza on every line");
    assert.equal(fayoum?.regionName, "Giza");
  }

  // ── An area with no organogram row for this line is left exactly as it was ──
  // The loader passes only carries_target rows, so an area the line treats as "Other" never
  // appears in the map. Its sales must stay in its geographic home, not fall into Others.
  {
    const moved = applyOperationalRegions(AREAS, new Map([["GZ9", "UE-1"]]), REGION_NAMES);
    const assuit = moved.find((area) => area.areaCode === "UE3");
    assert.equal(assuit?.regionCode, "UE", "no organogram row ⇒ keep the static region");
    assert.equal(assuit?.regionName, "Upper Egypt");
    assert.equal(moved.find((a) => a.areaCode === "GZ8")?.regionCode, "GZ");
  }

  // ── A region rename that is a no-op returns the SAME object (no churn) ─────
  {
    const input: SalesAreaReference[] = [
      { areaCode: "GZ8", areaName: "Fayoum", regionCode: "GZ", regionName: "Giza" },
    ];
    const moved = applyOperationalRegions(input, new Map([["GZ8", "GZ"]]), REGION_NAMES);
    assert.equal(moved[0], input[0], "an unchanged area is passed through untouched");
  }

  // ── An unnamed region code still groups, falling back to the code itself ───
  {
    const moved = applyOperationalRegions(AREAS, new Map([["GZ9", "UE-9"]]), new Map());
    assert.equal(moved.find((a) => a.areaCode === "GZ9")?.regionName, "UE-9");
  }

  // ── End to end: the two halves of the old GZ6 land in DIFFERENT blocks ─────
  {
    const before = matrixFor(AREAS);
    assert.equal(
      regionOf(before, "GZ")?.areas.length,
      2,
      "precondition: without the override Fayoum and Beni Suef share the Giza block",
    );
    assert.equal(regionOf(before, "UE-1"), undefined);

    const after = matrixFor(applyOperationalRegions(AREAS, AIF_OPERATIONAL, REGION_NAMES));
    const giza = regionOf(after, "GZ");
    const ue1 = regionOf(after, "UE-1");
    const ue2 = regionOf(after, "UE-2");

    assert.deepEqual(giza?.areas.map((a) => a.areaCode), ["GZ8"], "Giza keeps Fayoum only");
    assert.deepEqual(ue1?.areas.map((a) => a.areaCode), ["GZ9"], "UE-1 owns Beni Suef");
    assert.deepEqual(ue2?.areas.map((a) => a.areaCode), ["UE3"]);

    // Subtotals must follow the areas, not stay behind with the old region.
    assert.equal(giza?.subtotal.cells[0].salesUnits, 6);
    assert.equal(ue1?.subtotal.cells[0].salesUnits, 75);
    assert.equal(
      after.grandTotal.cells[0].salesUnits,
      91,
      "regrouping must never create or destroy sales",
    );
  }

  // ── UE-1/UE-2 sort next to Upper Egypt, not at the bottom as unranked codes ─
  {
    const after = matrixFor(applyOperationalRegions(AREAS, AIF_OPERATIONAL, REGION_NAMES));
    const order = after.regions.map((region) => region.regionCode);
    assert.deepEqual(order, ["GZ", "UE-1", "UE-2"], "Giza then the Upper Egypt territories");
  }

  // ── The scope decision is itself load-bearing, so guard it ─────────────────
  {
    assert.ok(
      CLOSING_ORGANOGRAM_REGION_LINES.has("anti_infective"),
      "Anti Infective groups by district territory",
    );
    assert.ok(
      !CLOSING_ORGANOGRAM_REGION_LINES.has("cns") && !CLOSING_ORGANOGRAM_REGION_LINES.has("pedia"),
      "CNS and Pedia must keep static geography — adding them silently restates their sheets",
    );
  }
}
