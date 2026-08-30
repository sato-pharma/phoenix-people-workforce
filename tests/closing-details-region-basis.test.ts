import assert from "node:assert/strict";

import {
  applyDetailFilters,
  applyDetailScope,
  buildFilterOptions,
  type ClosingDetailRow,
} from "../src/lib/sales/monthly-closing-details.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The Closing DETAILS tab must split a month the same way the Closing MATRIX beside it does — by
// the ORGANOGRAM — while its ACCESS gate stays on geography.
//
// Until this was fixed the tab offered and filtered the GEOGRAPHIC region. On Anti Infective that
// is not a cosmetic disagreement: the sheet carries one "UE" for all of Upper Egypt, the Matrix
// carries UE-1 and UE-2, and this tab's own Export button posts the picked region straight into the
// closing export — where a region the matrix has never heard of narrows to `__NO_MATCHING_AREA__`
// and returns an EMPTY workbook. Measured on production 2026-08-31: 28 (line, area) pairs across
// the three lines resolve to a different region under the organogram than under geography.
//
// The access half is the other way round and must stay that way. A region-scoped viewer's bound is
// resolved from the geographic master, so testing it against a relabelled code would drop every row
// he owns — an empty tab, which reads as "there were no sales" rather than as a bug.
// ─────────────────────────────────────────────────────────────────────────────

function row(overrides: Partial<ClosingDetailRow> = {}): ClosingDetailRow {
  const base: ClosingDetailRow = {
    id: 1,
    rowNumber: 1,
    distributorCode: "POS",
    invoicePeriod: "2026-07",
    invoiceDate: "2026-07-15",
    officialLine: "Anti Infective",

    sheetAreaCode: "UE3",
    sheetAreaName: "Qena",
    sheetRegionCode: "UE",
    sheetRegionName: "Upper Egypt",
    blockCode: "",
    brickId: "B1",

    brickName: "Qena Central",
    areaCode: "UE3",
    areaName: "Qena",
    // GEOGRAPHIC — the access dimension.
    regionCode: "UE",
    regionName: "Upper Egypt",
    // ORGANOGRAM — what the Matrix shows and the picker offers.
    operationalRegionCode: "UE-2",
    operationalRegionName: "Upper Egypt 2",
    areaMismatch: false,
    brickUnmapped: false,

    clientCode: "C1",
    clientName: "Pharmacy One",
    clientAddress: "",

    productCode: "LA001",
    productName: "Lacto Advanced 1",
    family: "Lacto",
    factoryPrice: 100,

    qty: 10,
    bonusQty: 0,
    discount: 0,
    effectiveUnits: 10,
    salesValue: 1_000,
    sheetValue: 1_000,

    isDirect: false,
    isConfidential: false,
    missingClientCode: false,
    validationState: "valid",
    includedInClosing: true,
    exclusions: [],
  };
  return { ...base, ...overrides };
}

export function runClosingDetailsRegionBasisTests() {
  // UE1 and UE3 are geographically both "UE". The organogram splits them across two DM districts —
  // exactly the production shape for Anti Infective.
  const ue1 = row({ id: 1, areaCode: "UE1", sheetAreaCode: "UE1", areaName: "Assiut",
    operationalRegionCode: "UE-1", operationalRegionName: "Upper Egypt 1" });
  const ue3 = row({ id: 2, areaCode: "UE3", sheetAreaCode: "UE3", areaName: "Qena",
    operationalRegionCode: "UE-2", operationalRegionName: "Upper Egypt 2" });
  // A line the organogram does not re-own: both codes are the same, and nothing about it changes.
  const cairo = row({ id: 3, areaCode: "CA1", sheetAreaCode: "CA1", areaName: "Cairo 1",
    regionCode: "CA", regionName: "Cairo",
    operationalRegionCode: "CA", operationalRegionName: "Cairo" });
  const rows = [ue1, ue3, cairo];

  // ── 1. The picker offers the ORGANOGRAM regions — the same vocabulary as the Matrix ──────────
  const options = buildFilterOptions(rows);
  const offered = options.regions.map((region) => region.code).sort();
  assert.deepEqual(
    offered,
    ["CA", "UE-1", "UE-2"],
    "the region picker must offer the organogram regions the Matrix is grouped by",
  );
  assert.ok(
    !offered.includes("UE"),
    "offering the geographic 'UE' is what made this tab's Export return an empty workbook — the " +
      "closing matrix has no such region, so it narrowed to __NO_MATCHING_AREA__",
  );

  // ── 2. Picking one selects the rows the Matrix books there ───────────────────────────────────
  const inUe2 = applyDetailFilters(rows, { regionCodes: ["UE-2"] });
  assert.deepEqual(inUe2.map((r) => r.id), [2], "UE-2 must select exactly the row the Matrix books under UE-2");

  const inUe1 = applyDetailFilters(rows, { regionCodes: ["UE-1"] });
  assert.deepEqual(inUe1.map((r) => r.id), [1], "UE-1 must select exactly the row the Matrix books under UE-1");

  // The geographic code is no longer a valid choice, and must not quietly select both districts.
  assert.equal(
    applyDetailFilters(rows, { regionCodes: ["UE"] }).length,
    0,
    "the geographic code is not offered and must not match — it would merge two DM districts",
  );

  // ── 3. The area list cascades off the SAME basis, or picking UE-1 empties it ──────────────────
  const areasUnderUe1 = options.areas.filter((area) => area.regionCode === "UE-1").map((a) => a.code);
  assert.deepEqual(
    areasUnderUe1,
    ["UE1"],
    "areas must be tagged with the organogram region: the panel filters the area list by the " +
      "selected region, so a geographic tag leaves that list empty the moment UE-1 is picked",
  );

  // ── 4. ACCESS stays geographic — the guard against an empty tab ───────────────────────────────
  // A viewer scoped to Upper Egypt holds the GEOGRAPHIC code "UE". Every row above displays as
  // UE-1 or UE-2, so a scope test on the organogram code would match none of them.
  const scopedToUpperEgypt = applyDetailScope(rows, {
    allowedRegionCodes: new Set(["UE"]),
    allowedProductCodes: null,
    dropConfidential: false,
  });
  assert.deepEqual(
    scopedToUpperEgypt.map((r) => r.id),
    [1, 2],
    "a viewer scoped to geographic UE must keep both Upper Egypt rows even though they now DISPLAY " +
      "as UE-1 and UE-2 — testing access on the relabelled code empties his tab",
  );

  // And it still excludes what it should: Cairo is not in his bound.
  assert.ok(
    !scopedToUpperEgypt.some((r) => r.regionCode === "CA"),
    "the geographic access bound must still exclude regions the viewer does not hold",
  );

  // ── 5. A line the organogram does not re-own is untouched ────────────────────────────────────
  assert.deepEqual(
    applyDetailFilters(rows, { regionCodes: ["CA"] }).map((r) => r.id),
    [3],
    "where the two bases agree, nothing about the tab's behaviour changes",
  );
}
