import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  allocateDirectToOperationalRegions,
  applyOperationalRegions,
  buildOperationalRegionMap,
  closingRegionsAsOfDate,
  splitProRata,
  submitterKey,
  type LineOperationalRegionMap,
} from "../src/lib/sales/closing-organogram-regions.ts";
import { scopeMatrixToRegionNames } from "../src/lib/sales/monthly-closing-portal.ts";
import type {
  MonthlyClosingCell,
  MonthlyClosingMatrix,
  SalesAreaReference,
} from "../src/lib/sales/monthly-distributor-import.ts";

// The Closing Matrix grouped areas by where they sit geographically. The organogram says who owns
// them, per line, and the two disagree on purpose. Shapes below are the real production ones:
//
//   Anti Infective  UE-1 = UE1, UE2 (+ GZ6)   UE-2 = UE3..UE8   — that line has no plain "UE"
//   CNS             D16 (Kafr El-Sheikh 1) sits under AB, not D1
//
// Two things must survive the regrouping: no sales may move or vanish, and a viewer scoped to
// "Upper Egypt" must still be narrowed — every Upper Egypt employee carries that exact label, so a
// region-name bound that matches nothing would fail OPEN to the whole company.

const region = (regionCode: string, regionName: string) => ({ regionCode, regionName });

function areas(): SalesAreaReference[] {
  return [
    { areaCode: "UE1", areaName: "Minia 1", ...region("UE", "Upper Egypt") },
    { areaCode: "UE2", areaName: "Minia 2", ...region("UE", "Upper Egypt") },
    { areaCode: "UE3", areaName: "Assuit 1", ...region("UE", "Upper Egypt") },
    { areaCode: "GZ6", areaName: "Giza 6", ...region("GZ", "Giza") },
    { areaCode: "D16", areaName: "Kafr El-Sheikh 1", ...region("D1", "Delta (1)") },
  ];
}

const antiInfective: LineOperationalRegionMap = {
  regionByArea: new Map([
    ["UE1", { regionCode: "UE-1", regionName: "Upper Egypt 1" }],
    ["UE2", { regionCode: "UE-1", regionName: "Upper Egypt 1" }],
    ["UE3", { regionCode: "UE-2", regionName: "Upper Egypt 2" }],
    ["GZ6", { regionCode: "UE-1", regionName: "Upper Egypt 1" }],
    ["D16", { regionCode: "D1", regionName: "Delta (1)" }],
  ]),
  regionCodes: new Set(["UE-1", "UE-2", "D1"]),
};

const cns: LineOperationalRegionMap = {
  regionByArea: new Map([["D16", { regionCode: "AB", regionName: "Alex-BHR" }]]),
  regionCodes: new Set(["AB", "UE", "GZ", "D1"]),
};

const cell = (salesValue: number, salesUnits = 0): MonthlyClosingCell => ({
  salesUnits,
  salesValue,
  targetUnits: null,
  targetValue: null,
  achievement: null,
});

export function runClosingOrganogramRegionsTests() {
  // ── Areas take the region the organogram gives them for this line ──
  const mapped = applyOperationalRegions(areas(), antiInfective);
  const byCode = new Map(mapped.map((area) => [area.areaCode, area]));
  assert.equal(byCode.get("UE1")?.regionCode, "UE-1", "Anti Infective: Minia 1 is Upper Egypt 1");
  assert.equal(byCode.get("UE1")?.regionName, "Upper Egypt 1", "the region NAME follows too");
  assert.equal(byCode.get("UE3")?.regionCode, "UE-2", "Anti Infective: Assuit 1 is Upper Egypt 2");
  assert.equal(byCode.get("GZ6")?.regionCode, "UE-1", "a Giza area really does sit under Upper Egypt 1");
  assert.equal(mapped.length, areas().length, "regrouping never drops an area");

  // The geographic home is remembered — access scoping still resolves viewers by it.
  assert.equal(byCode.get("UE1")?.sourceRegionName, "Upper Egypt", "UE1 remembers it is in Upper Egypt");
  assert.equal(byCode.get("GZ6")?.sourceRegionName, "Giza", "GZ6 remembers it is in Giza");
  assert.equal(byCode.get("D16")?.sourceRegionCode, undefined, "an area that did not move carries no source");

  // ── CNS: Kafr El-Sheikh belongs to Alex-BHR, not Delta (1) ──
  const cnsMapped = applyOperationalRegions(areas(), cns);
  const kafr = cnsMapped.find((area) => area.areaCode === "D16");
  assert.equal(kafr?.regionCode, "AB", "CNS: Kafr El-Sheikh 1 sits under Alex-BHR");
  assert.equal(kafr?.sourceRegionCode, "D1", "and remembers Delta (1) is its geography");

  // ── No organogram for this line (Head Office) ⇒ untouched ──
  assert.deepEqual(applyOperationalRegions(areas(), null), areas(), "no map leaves every area alone");

  // ── Splitting money is exact, in both directions ──
  assert.deepEqual(splitProRata(100, [1, 1]), [50, 50], "an even split is even");
  const thirds = splitProRata(100, [1, 1, 1]);
  assert.equal(thirds.reduce((sum, part) => sum + part, 0), 100, "thirds still add back to the total");
  const credit = splitProRata(-241392.5, [3, 1]);
  assert.equal(
    Number(credit.reduce((sum, part) => sum + part, 0).toFixed(6)),
    -241392.5,
    "a credit note splits without losing a piaster",
  );
  assert.deepEqual(splitProRata(500, [0, 0]), [0, 0], "no weight anywhere yields nothing, not NaN");

  // ── Direct on a region the line does not have gets split across the DM territories ──
  // Weighted by sales from the UPPER EGYPT areas only: UE-1 earns 300 (UE1 200 + UE2 100),
  // UE-2 earns 100 (UE3). GZ6's 900 must not pull Upper Egypt money toward UE-1.
  const allocated = allocateDirectToOperationalRegions(
    [{ productCode: "P1", regionCode: "UE", salesUnits: 40, salesValue: 4000 }],
    {
      areas: areas(),
      cells: [
        { areaCode: "UE1", productCode: "P1", salesUnits: 2, salesValue: 200 },
        { areaCode: "UE2", productCode: "P1", salesUnits: 1, salesValue: 100 },
        { areaCode: "UE3", productCode: "P1", salesUnits: 1, salesValue: 100 },
        { areaCode: "GZ6", productCode: "P1", salesUnits: 9, salesValue: 900 },
      ],
      map: antiInfective,
    },
  );
  assert.deepEqual(
    allocated.map((row) => row.regionCode).sort(),
    ["UE-1", "UE-2"],
    "the UE Direct row lands on the two territories that line actually has",
  );
  const antiByRegion = new Map(allocated.map((row) => [row.regionCode, row]));
  assert.equal(antiByRegion.get("UE-1")?.salesValue, 3000, "UE-1 takes 300/400 of the Direct value");
  assert.equal(antiByRegion.get("UE-2")?.salesValue, 1000, "UE-2 takes 100/400");
  assert.equal(
    allocated.reduce((sum, row) => sum + row.salesValue, 0),
    4000,
    "the split adds back to the original Direct value exactly",
  );
  assert.equal(
    allocated.reduce((sum, row) => sum + row.salesUnits, 0),
    40,
    "units add back too",
  );

  // ── The sheet names who booked each Direct sale; that beats any estimate ──
  // Production, Anti Infective 2026-07: نسيبة صلاح books 27,354 and احمد نشأت 5,980 of the 33,334
  // tagged "UE". Pro-rata guessed 8,566 / 24,768 — nearly the reverse.
  const SALAH = "نسيبة صلاح";
  const NASHAAT = "احمد نشأت";
  const regionBySubmitter = new Map([
    [submitterKey("نسيبة صلاح حسانين موسى"), "UE-1"],
    [submitterKey("احمد نشأت على أحمد"), "UE-2"],
  ]);

  // The sheet writes a short name, the employee master a full one — the key must bridge that.
  assert.equal(submitterKey(SALAH), submitterKey("نسيبة صلاح حسانين موسى"), "short and full Arabic names match");
  assert.equal(submitterKey(NASHAAT), submitterKey("احمد نشأت على أحمد"), "hamza spelling does not break the match");
  assert.notEqual(submitterKey(SALAH), submitterKey(NASHAAT), "two different managers never collide");

  const bySubmitter = allocateDirectToOperationalRegions(
    [{ productCode: "P1", regionCode: "UE", salesUnits: 100, salesValue: 33334 }],
    {
      areas: areas(),
      cells: [
        { areaCode: "UE1", productCode: "P1", salesUnits: 2, salesValue: 200 },
        { areaCode: "UE3", productCode: "P1", salesUnits: 1, salesValue: 100 },
      ],
      map: antiInfective,
      submitters: [
        { productCode: "P1", regionCode: "UE", submitter: SALAH, value: 27354 },
        { productCode: "P1", regionCode: "UE", submitter: NASHAAT, value: 5980 },
      ],
      regionBySubmitter,
    },
  );
  const submitted = new Map(bySubmitter.map((row) => [row.regionCode, row.salesValue]));
  assert.equal(submitted.get("UE-1"), 27354, "Salah's Direct is credited to UE-1, not estimated");
  assert.equal(submitted.get("UE-2"), 5980, "Nashaat's Direct is credited to UE-2");
  assert.equal(
    bySubmitter.reduce((sum, row) => sum + row.salesValue, 0),
    33334,
    "attribution by submitter still adds back to the RPC total",
  );

  // A name nobody recognises must not be credited to a guess — that part alone falls back.
  const partly = allocateDirectToOperationalRegions(
    [{ productCode: "P1", regionCode: "UE", salesUnits: 0, salesValue: 1000 }],
    {
      areas: areas(),
      cells: [
        { areaCode: "UE1", productCode: "P1", salesUnits: 0, salesValue: 300 },
        { areaCode: "UE3", productCode: "P1", salesUnits: 0, salesValue: 100 },
      ],
      map: antiInfective,
      submitters: [
        { productCode: "P1", regionCode: "UE", submitter: SALAH, value: 600 },
        { productCode: "P1", regionCode: "UE", submitter: "شخص مجهول", value: 400 },
      ],
      regionBySubmitter,
    },
  );
  assert.equal(
    partly.reduce((sum, row) => sum + row.salesValue, 0),
    1000,
    "an unknown submitter's share is still spread, never dropped",
  );
  const partlyByRegion = new Map<string, number>();
  partly.forEach((row) => partlyByRegion.set(row.regionCode, (partlyByRegion.get(row.regionCode) ?? 0) + row.salesValue));
  // 600 identified for UE-1, then the unresolved 400 pro-rata 300:100 => UE-1 600+300, UE-2 100.
  assert.equal(partlyByRegion.get("UE-1"), 900, "identified share plus its pro-rata slice of the rest");
  assert.equal(partlyByRegion.get("UE-2"), 100, "UE-2 gets only its pro-rata slice of the unresolved part");

  // With no submitter information at all the old pro-rata behaviour still applies.
  const noSubmitters = allocateDirectToOperationalRegions(
    [{ productCode: "P1", regionCode: "UE", salesUnits: 0, salesValue: 400 }],
    {
      areas: areas(),
      cells: [
        { areaCode: "UE1", productCode: "P1", salesUnits: 0, salesValue: 300 },
        { areaCode: "UE3", productCode: "P1", salesUnits: 0, salesValue: 100 },
      ],
      map: antiInfective,
      submitters: [],
      regionBySubmitter,
    },
  );
  assert.equal(noSubmitters.find((row) => row.regionCode === "UE-1")?.salesValue, 300, "pro-rata still works");

  // au.direct_region_allocation's declared weights beat anything derived from sales.
  // Its real production row for anti_infective/UE is UE-1 weight 3, UE-2 weight 6.
  const declaredWeights = allocateDirectToOperationalRegions(
    [{ productCode: "P1", regionCode: "UE", salesUnits: 0, salesValue: 900 }],
    {
      areas: areas(),
      cells: [
        { areaCode: "UE1", productCode: "P1", salesUnits: 0, salesValue: 999 }, // sales say UE-1
        { areaCode: "UE3", productCode: "P1", salesUnits: 0, salesValue: 1 },
      ],
      map: antiInfective,
      allocationWeights: new Map([["UE", new Map([["UE-1", 3], ["UE-2", 6]])]]),
    },
  );
  const declaredByRegion = new Map(declaredWeights.map((row) => [row.regionCode, row.salesValue]));
  assert.equal(declaredByRegion.get("UE-1"), 300, "the declared 3:6 weight wins over the sales split");
  assert.equal(declaredByRegion.get("UE-2"), 600, "…and UE-2 takes its declared two thirds");

  // A region the line DOES have passes straight through.
  const untouched = allocateDirectToOperationalRegions(
    [{ productCode: "P1", regionCode: "UE-1", salesUnits: 5, salesValue: 500 }],
    { areas: areas(), cells: [], map: antiInfective },
  );
  assert.deepEqual(untouched, [{ productCode: "P1", regionCode: "UE-1", salesUnits: 5, salesValue: 500 }],
    "a Direct row already on an operational region is left alone");

  // Nothing sold that month ⇒ even split rather than a lost row.
  const noSales = allocateDirectToOperationalRegions(
    [{ productCode: "P1", regionCode: "UE", salesUnits: 0, salesValue: 1000 }],
    { areas: areas(), cells: [], map: antiInfective },
  );
  assert.equal(
    noSales.reduce((sum, row) => sum + row.salesValue, 0),
    1000,
    "a Direct row survives a month with no distributor sales to weight it",
  );

  // An unplaceable region is kept as-is — money is never dropped on the floor.
  const unplaceable = allocateDirectToOperationalRegions(
    [{ productCode: "P1", regionCode: "ZZ", salesUnits: 1, salesValue: 77 }],
    { areas: areas(), cells: [], map: antiInfective },
  );
  assert.deepEqual(unplaceable, [{ productCode: "P1", regionCode: "ZZ", salesUnits: 1, salesValue: 77 }],
    "a Direct row that maps nowhere still appears");

  // ── A viewer scoped to "Upper Egypt" must still be narrowed, not handed everything ──
  const matrix: MonthlyClosingMatrix = {
    availableLines: ["Anti Infective"],
    availablePeriods: ["2026-07"],
    columns: [{ family: "F", productCode: "P1", productName: "Royafloxacin" }],
    line: "Anti Infective",
    period: "2026-07",
    grandTotal: { kind: "grandTotal", cells: [cell(1500)], rowTotal: cell(1500) },
    directNational: null,
    companyTotal: null,
    regions: [
      {
        regionCode: "UE-1",
        regionName: "Upper Egypt 1",
        areas: [
          { kind: "area", areaCode: "UE1", areaName: "Minia 1", regionCode: "UE-1", regionName: "Upper Egypt 1", sourceRegionCode: "UE", sourceRegionName: "Upper Egypt", cells: [cell(200)], rowTotal: cell(200) },
          { kind: "area", areaCode: "GZ6", areaName: "Giza 6", regionCode: "UE-1", regionName: "Upper Egypt 1", sourceRegionCode: "GZ", sourceRegionName: "Giza", cells: [cell(900)], rowTotal: cell(900) },
        ],
        subtotal: { kind: "regionSubtotal", regionCode: "UE-1", regionName: "Upper Egypt 1", cells: [cell(1100)], rowTotal: cell(1100) },
      },
      {
        regionCode: "D1",
        regionName: "Delta (1)",
        areas: [
          { kind: "area", areaCode: "D12", areaName: "Tanta", regionCode: "D1", regionName: "Delta (1)", cells: [cell(400)], rowTotal: cell(400) },
        ],
        subtotal: { kind: "regionSubtotal", regionCode: "D1", regionName: "Delta (1)", cells: [cell(400)], rowTotal: cell(400) },
      },
    ],
  };

  const scoped = scopeMatrixToRegionNames(matrix, new Set(["upper egypt"]));
  assert.deepEqual(scoped.regions.map((r) => r.regionCode), ["UE-1"], "Delta (1) is dropped for an Upper Egypt viewer");
  assert.deepEqual(
    scoped.regions[0].areas.map((area) => area.areaCode),
    ["UE1"],
    "the Giza area under the same district manager is NOT handed over",
  );
  assert.equal(scoped.regions[0].subtotal.cells[0].salesValue, 200, "the subtotal is recomputed from what survived");
  assert.equal(scoped.grandTotal.rowTotal.salesValue, 200, "and so is the grand total");

  // The un-split case must behave exactly as it always did: whole regions in, whole regions out.
  // canonicalizeRegionName only lower-cases and trims, so the punctuation stays.
  const plain = scopeMatrixToRegionNames(matrix, new Set(["delta (1)"]));
  assert.deepEqual(plain.regions.map((r) => r.regionCode), ["D1"], "a plain region match still works");
  assert.equal(plain.regions[0].areas.length, 1, "and keeps its areas untouched");

  // A viewer with a region nobody has must come back empty, never widened here.
  assert.equal(scopeMatrixToRegionNames(matrix, new Set(["nowhere"])).regions.length, 0, "no match means no regions");
}


// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHEN a closing resolves the org chart, which is a different question from WHICH map it uses.
//
// The loader used to resolve at `new Date()` — the day the closing was RUN. The closing golden rule
// says a month cannot publish before the 1st of the month after it, so a structure change dated to
// that 1st was in force on every legal run date for the month before. The Anti Infective Delta (3)
// split was exactly that shape: five areas dated to 2026-09-01, which would have pulled August's
// sales onto Delta (3) the moment August was closed. The fix is to resolve at the PERIOD END.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const regionNames = () => new Map([
  ["OT", "Others"],
  ["D2", "Delta (2)"],
  ["D3", "Delta (3)"],
]);

export function runClosingPeriodDatingTests() {
  // ── The as-of date is the last day of the month being closed ───────────────────────────────────
  assert.equal(closingRegionsAsOfDate("2026-08"), "2026-08-31", "August resolves on the last day of August");
  assert.equal(closingRegionsAsOfDate("2026-02"), "2026-02-28", "a short month is not padded out to 30");
  assert.equal(closingRegionsAsOfDate("2028-02"), "2028-02-29", "a leap February keeps its 29th");
  assert.equal(closingRegionsAsOfDate("2026-12"), "2026-12-31", "December does not roll into the next year");

  // No month picked yet (the empty skeleton) still yields a real date, never "" or "Invalid Date" —
  // a blank would compare as less than every effective_from and silently empty the whole map.
  for (const blank of [null, undefined, "", "   ", "2026", "2026-13", "2026-00", "not-a-period"]) {
    assert.match(
      closingRegionsAsOfDate(blank as string | null | undefined),
      /^\d{4}-\d{2}-\d{2}$/,
      `${JSON.stringify(blank)} must fall back to a real calendar date`,
    );
  }

  // ── THE REGRESSION, in the exact production shape ──────────────────────────────────────────────
  const delta3 = [
    { area_code: "D11", operational_region_code: "OT", effective_from: "2026-07-13", effective_to: null },
    { area_code: "D11", operational_region_code: "D3", effective_from: "2026-09-01", effective_to: null },
  ];

  const august = buildOperationalRegionMap(delta3, closingRegionsAsOfDate("2026-08"), regionNames());
  assert.equal(august?.regionByArea.get("D11")?.regionCode, "OT", "closing August leaves D11 in Others");
  assert.ok(!august?.regionCodes.has("D3"), "and Delta (3) is not even a column on the August sheet");

  const september = buildOperationalRegionMap(delta3, closingRegionsAsOfDate("2026-09"), regionNames());
  assert.equal(september?.regionByArea.get("D11")?.regionCode, "D3", "closing September does move D11 to Delta (3)");
  assert.equal(september?.regionByArea.get("D11")?.regionName, "Delta (3)", "carrying the region's real name");

  // Proof this test discriminates rather than passing for free: resolve at the day the closing is
  // RUN — the old behaviour — and every legal August run date gives the wrong answer.
  for (const runDate of ["2026-09-01", "2026-09-15", "2026-10-03"]) {
    const asRun = buildOperationalRegionMap(delta3, runDate, regionNames());
    assert.equal(
      asRun?.regionByArea.get("D11")?.regionCode,
      "D3",
      `resolving at the run date ${runDate} would have credited August's sales to Delta (3)`,
    );
  }

  // ── effective_to is EXCLUSIVE, matching au.f_line_area_map_asof ────────────────────────────────
  // A row that closes on the day its successor opens must not still be live on that day, or the
  // area maps twice and the answer depends on which row happens to be read last.
  const handover = [
    { area_code: "D24", operational_region_code: "D2", effective_from: "2026-07-13", effective_to: "2026-09-01" },
    { area_code: "D24", operational_region_code: "D3", effective_from: "2026-09-01", effective_to: null },
  ];
  assert.equal(
    buildOperationalRegionMap(handover, "2026-08-31", regionNames())?.regionByArea.get("D24")?.regionCode,
    "D2",
    "the day before the handover belongs to the outgoing territory",
  );
  assert.equal(
    buildOperationalRegionMap(handover, "2026-09-01", regionNames())?.regionByArea.get("D24")?.regionCode,
    "D3",
    "and the handover day itself belongs outright to the incoming one",
  );
  assert.equal(
    buildOperationalRegionMap([...handover].reverse(), "2026-08-31", regionNames())?.regionByArea.get("D24")?.regionCode,
    "D2",
    "row order cannot change the answer — exactly one row is ever live on a given date",
  );

  // ── An area no row covers stays absent, so the caller keeps its geography ──────────────────────
  // Production's real case: OT3's rows on all three lines closed on 2026-07-27 with no successor.
  const retired = [
    { area_code: "OT3", operational_region_code: "OT", effective_from: "2026-07-13", effective_to: "2026-07-27" },
  ];
  assert.equal(
    buildOperationalRegionMap(retired, "2026-08-31", regionNames()),
    null,
    "no covering row means no map at all — applyOperationalRegions then leaves the area where geography put it",
  );

  // ── SOURCE PIN: neither call site may quietly drop the period again ────────────────────────────
  // The argument is required, so TypeScript catches an omission; what it cannot catch is someone
  // passing a literal null to make the compiler happy. That is what these pin.
  const importer = readFileSync(
    new URL("../src/lib/sales/monthly-distributor-import.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    importer.includes("loadLineOperationalRegions(skeletonLineCode, selectedPeriod)"),
    "the empty-skeleton path must pass the selected period",
  );
  assert.ok(
    importer.includes("loadLineOperationalRegions(targetLineCode, selectedPeriod)"),
    "the loaded-month path must pass the selected period",
  );
  assert.equal(
    (importer.match(/loadLineOperationalRegions\(/g) ?? []).length,
    2,
    "two call sites, both pinned above — a third one needs its own review before it is added here",
  );
}
