import assert from "node:assert/strict";

import {
  applyLineRegionScope,
  computeSalesAccessScope,
  resolveSalesGeographyBound,
} from "../src/lib/sales/access-scope.ts";
import { applyDetailScope, type ClosingDetailRow } from "../src/lib/sales/monthly-closing-details.ts";
import { applyRegionScope, scopeMatrixToAreaCodes } from "../src/lib/sales/monthly-closing-portal.ts";
import type {
  MonthlyClosingCell,
  MonthlyClosingMatrix,
} from "../src/lib/sales/monthly-distributor-import.ts";
import { computePortalSosVisibility } from "../src/lib/sales/portal-sos-dashboard.ts";
import { computeSeatAreaScope } from "../src/lib/sales/seat-area-scope.ts";

// Guards the seat-derived AREA scope for District / Regional Managers.
//
// THE BUG THIS LOCKS DOWN: a district's areas are not always inside its geographic region. CNS
// "Kafr El-Sheikh 1" (D16) is operationally owned by the CNS Alex-BHR DM, but its sales rows carry
// region D1 / Delta (1). Scoping that DM by his employee row's region name ("ALEX-BHR" → AB) hid an
// entire rep's sales from his own manager. The fix bounds him by his SEAT's areas instead — and the
// symmetric risk is that reaching D16 also drags in Delta (1)'s OTHER areas, which belong to a
// different DM. Both halves are asserted below for every consumer.
//
// The fixtures mirror real production shapes (seat ids, area codes, the AB/D1 split).

const SEATS = [
  { seatId: "SEAT-CNS-NSM", seatTier: "NSM", lineCode: "cns", path: ["SEAT-ROOT-CEO", "SEAT-CNS-NSM"], occupantHrId: "B-122" },
  {
    seatId: "SEAT-CNS-DM-AB",
    seatTier: "DM",
    lineCode: "cns",
    path: ["SEAT-ROOT-CEO", "SEAT-CNS-NSM", "SEAT-CNS-DM-AB"],
    occupantHrId: "B-119",
  },
  {
    seatId: "SEAT-CNS-DM-D1",
    seatTier: "DM",
    lineCode: "cns",
    path: ["SEAT-ROOT-CEO", "SEAT-CNS-NSM", "SEAT-CNS-DM-D1"],
    occupantHrId: "B-120",
  },
  { seatId: "SEAT-PED-RSM", seatTier: "RSM", lineCode: "pedia", path: ["SEAT-ROOT-CEO", "SEAT-PED-NSM", "SEAT-PED-RSM"], occupantHrId: "PD-0001" },
  {
    seatId: "SEAT-PED-DM-AB",
    seatTier: "DM",
    lineCode: "pedia",
    path: ["SEAT-ROOT-CEO", "SEAT-PED-NSM", "SEAT-PED-RSM", "SEAT-PED-DM-AB"],
    occupantHrId: "B-74",
  },
  {
    seatId: "SEAT-PED-DM-D2",
    seatTier: "DM",
    lineCode: "pedia",
    path: ["SEAT-ROOT-CEO", "SEAT-PED-NSM", "SEAT-PED-RSM", "SEAT-PED-DM-D2"],
    occupantHrId: "B-184",
  },
  // A seated DM with no rows in the line→area map at all (master-data gap).
  { seatId: "SEAT-AIF-DM-XX", seatTier: "DM", lineCode: "anti_infective", path: ["SEAT-ROOT-CEO", "SEAT-AIF-DM-XX"], occupantHrId: "B-999" },
  // An ACTING_DM district seat — the line-area map's dm_seat_id points at the ACTING_DM
  // seat itself (production shape: anti_infective UE1/UE2 → SEAT-AIF-ADM-UE-1).
  {
    seatId: "SEAT-AIF-ADM-UE-1",
    seatTier: "ACTING_DM",
    lineCode: "anti_infective",
    path: ["SEAT-ROOT-CEO", "SEAT-AIF-NSM", "SEAT-AIF-ADM-UE-1"],
    occupantHrId: "B-1",
  },
];

const LINE_AREAS = [
  // Saad's CNS Alex-BHR district: five AB areas + D16, which is geographically Delta (1).
  { lineCode: "cns", areaCode: "AB1", dmSeatId: "SEAT-CNS-DM-AB" },
  { lineCode: "cns", areaCode: "AB2", dmSeatId: "SEAT-CNS-DM-AB" },
  { lineCode: "cns", areaCode: "AB3", dmSeatId: "SEAT-CNS-DM-AB" },
  { lineCode: "cns", areaCode: "AB4", dmSeatId: "SEAT-CNS-DM-AB" },
  { lineCode: "cns", areaCode: "AB5", dmSeatId: "SEAT-CNS-DM-AB" },
  { lineCode: "cns", areaCode: "D16", dmSeatId: "SEAT-CNS-DM-AB" },
  // The OTHER Delta (1) CNS areas are NOT his — the leak this must never open. Production shape:
  // D11 belongs to the Delta (1) DM, D17 to the line's "Others" pseudo-DM seat (nobody's district).
  { lineCode: "cns", areaCode: "D11", dmSeatId: "SEAT-CNS-DM-D1" },
  { lineCode: "cns", areaCode: "D17", dmSeatId: "SEAT-CNS-OTHERS" },
  { lineCode: "pedia", areaCode: "AB1", dmSeatId: "SEAT-PED-DM-AB" },
  { lineCode: "pedia", areaCode: "D24", dmSeatId: "SEAT-PED-DM-D2" },
  { lineCode: "anti_infective", areaCode: "UE1", dmSeatId: "SEAT-AIF-ADM-UE-1" },
  { lineCode: "anti_infective", areaCode: "UE2", dmSeatId: "SEAT-AIF-ADM-UE-1" },
];

const FACT_REGION_BY_AREA = new Map([
  ["AB1", "AB"],
  ["AB2", "AB"],
  ["AB3", "AB"],
  ["AB4", "AB"],
  ["AB5", "AB"],
  ["D11", "D1"],
  ["D16", "D1"],
  ["D17", "D1"],
  ["D24", "D2"],
  ["UE1", "UE"],
  ["UE2", "UE"],
]);

function seatScopeFor(hrId: string) {
  return computeSeatAreaScope({
    viewerHrId: hrId,
    seats: SEATS,
    lineAreas: LINE_AREAS,
    factRegionByAreaCode: FACT_REGION_BY_AREA,
  });
}

function cell(salesValue: number): MonthlyClosingCell {
  return { salesUnits: salesValue, salesValue, targetUnits: null, targetValue: null, achievement: null };
}

function areaRow(areaCode: string, regionCode: string, regionName: string, value: number, isDirect = false) {
  return {
    areaCode,
    areaName: `${areaCode} name`,
    cells: [cell(value)],
    isDirect: isDirect || undefined,
    kind: "area" as const,
    regionCode,
    regionName,
    rowTotal: cell(value),
  };
}

function matrixFixture(): MonthlyClosingMatrix {
  const abAreas = [areaRow("AB1", "AB", "Alex-BHR", 100)];
  const d1Areas = [
    areaRow("D16", "D1", "Delta (1)", 50), // Saad's
    areaRow("D11", "D1", "Delta (1)", 900), // another DM's
    areaRow("DIRECT", "D1", "Delta (1)", 7, true), // synthetic per-region Direct row
  ];
  return {
    columns: [{ productCode: "P1", productName: "Prod 1" }],
    regions: [
      { areas: abAreas, regionCode: "AB", regionName: "Alex-BHR", subtotal: { kind: "subtotal", cells: [cell(100)], regionCode: "AB", regionName: "Alex-BHR", rowTotal: cell(100) } },
      { areas: d1Areas, regionCode: "D1", regionName: "Delta (1)", subtotal: { kind: "subtotal", cells: [cell(957)], regionCode: "D1", regionName: "Delta (1)", rowTotal: cell(957) } },
    ],
    grandTotal: { kind: "grandTotal", cells: [cell(1057)], rowTotal: cell(1057) },
    directNational: { kind: "subtotal", cells: [cell(11)], regionCode: "", regionName: "Direct", rowTotal: cell(11) },
    companyTotal: { kind: "grandTotal", cells: [cell(1068)], rowTotal: cell(1068) },
  } as unknown as MonthlyClosingMatrix;
}

function detailRow(areaCode: string, regionCode: string): ClosingDetailRow {
  return { areaCode, regionCode, isConfidential: false } as unknown as ClosingDetailRow;
}

export function runDmSeatAreaScopeTests() {
  // ── computeSeatAreaScope ────────────────────────────────────────────────────
  const saad = seatScopeFor("B-119");
  assert.ok(saad, "a seated DM resolves a scope");
  assert.deepEqual(
    [...saad!.areaCodes].sort(),
    ["AB1", "AB2", "AB3", "AB4", "AB5", "D16"],
    "DM gets exactly his own six areas — including the out-of-region D16",
  );
  assert.deepEqual(
    [...saad!.factRegionCodes].sort(),
    ["AB", "D1"],
    "fact regions span both regions his areas' rows actually carry",
  );
  assert.equal(saad!.areaCodes.has("D11"), false, "the sibling DM's Delta (1) area is NOT included");
  assert.equal(saad!.areaCodes.has("D17"), false, "nor the Others-seat area in that same region");

  // The other direction: the Delta (1) DM keeps his own areas and does NOT inherit Saad's D16. Under
  // the old region-name bound he saw every D1x area, Saad's included — this tightens that too.
  const deltaDm = seatScopeFor("B-120");
  assert.deepEqual([...(deltaDm?.areaCodes ?? [])].sort(), ["D11"], "Delta (1) DM gets only his own seat's areas");
  assert.equal(deltaDm?.areaCodes.has("D16"), false, "Delta (1) DM does NOT inherit Saad's out-of-region area");

  // Case-insensitive HR_ID match (the org tree stores upper-case, sessions may not).
  assert.deepEqual([...(seatScopeFor("b-119")?.areaCodes ?? [])].sort(), [...saad!.areaCodes].sort(), "HR_ID match is case-insensitive");

  // RSM: the union of every DM seat in the subtree, resolved from `path`.
  const rsm = seatScopeFor("PD-0001");
  assert.deepEqual([...(rsm?.areaCodes ?? [])].sort(), ["AB1", "D24"], "RSM gets every DM seat in his subtree");
  assert.deepEqual([...(rsm?.factRegionCodes ?? [])].sort(), ["AB", "D2"], "RSM fact regions follow his areas");

  // An ACTING_DM seat is a first-class district seat: its occupant gets their own areas
  // instead of silently falling back to the line-blind region label.
  const acting = seatScopeFor("B-1");
  assert.deepEqual(
    [...(acting?.areaCodes ?? [])].sort(),
    ["UE1", "UE2"],
    "an ACTING_DM resolves their seat's own areas (previously dropped to the region-label fallback)",
  );

  // An NSM occupies no DM/RSM seat here → null (line scope keeps applying upstream).
  assert.equal(seatScopeFor("B-122"), null, "an NSM gets no seat area bound");
  assert.equal(seatScopeFor("B-000"), null, "an unseated HR_ID gets no seat area bound");
  assert.equal(seatScopeFor(""), null, "a blank HR_ID gets no seat area bound");
  // Seated but the seat map has no areas for them → null, NOT an empty set. An empty set would
  // black the manager's dashboards out on a master-data gap; null keeps the legacy region bound.
  assert.equal(seatScopeFor("B-999"), null, "a seated DM with zero mapped areas falls back (null), never empty");

  // ── computeSalesAccessScope ─────────────────────────────────────────────────
  const dmScope = computeSalesAccessScope({
    role: "District Manager",
    businessScope: "TEAM",
    viewerLineName: "CNS",
    viewerRegionName: "ALEX-BHR",
    includeRestricted: false,
    seatAreaScope: saad!,
  });
  assert.deepEqual([...(dmScope.allowedAreaCodes ?? [])].sort(), ["AB1", "AB2", "AB3", "AB4", "AB5", "D16"], "seat areas reach the sales scope");
  assert.deepEqual([...(dmScope.allowedAreaFactRegionCodes ?? [])].sort(), ["AB", "D1"], "paired fact regions reach the sales scope");
  assert.deepEqual([...(dmScope.allowedRegionNames ?? [])], ["alex-bhr"], "the legacy region name is still carried (labels/fallbacks)");

  const dmNoSeat = computeSalesAccessScope({
    role: "District Manager",
    businessScope: "TEAM",
    viewerLineName: "CNS",
    viewerRegionName: "ALEX-BHR",
    includeRestricted: false,
    seatAreaScope: null,
  });
  assert.equal(dmNoSeat.allowedAreaCodes, null, "no seat → no area bound (behaviour unchanged)");
  assert.equal(dmNoSeat.allowedAreaFactRegionCodes, null, "no seat → no fact-region widener");

  const companyScope = computeSalesAccessScope({
    role: "CEO",
    businessScope: "COMPANY",
    viewerLineName: null,
    viewerRegionName: null,
    includeRestricted: false,
    seatAreaScope: saad!,
  });
  assert.equal(companyScope.allowedAreaCodes, null, "COMPANY scope is never area-bounded");

  const noneScope = computeSalesAccessScope({
    role: "Employee",
    businessScope: "NONE",
    viewerLineName: null,
    viewerRegionName: null,
    includeRestricted: false,
  });
  assert.equal(noneScope.allowedAreaCodes?.size, 0, "NONE scope fails closed with an empty area set");

  // A LINE-scoped role (NSM) must not pick up an area bound even if one were passed in.
  const lineScope = computeSalesAccessScope({
    role: "National Sales Manager",
    businessScope: "LINE",
    viewerLineName: "CNS",
    viewerRegionName: "Egypt",
    includeRestricted: false,
    seatAreaScope: saad!,
  });
  assert.equal(lineScope.allowedAreaCodes, null, "LINE scope stays nationwide within the line");

  // ── resolveSalesGeographyBound ──────────────────────────────────────────────
  const neverCalled = () => {
    throw new Error("region-name resolution must not run when an area bound exists");
  };
  const seatBound = resolveSalesGeographyBound(dmScope, neverCalled);
  assert.deepEqual([...(seatBound.areaCodes ?? [])].sort(), ["AB1", "AB2", "AB3", "AB4", "AB5", "D16"]);
  assert.deepEqual([...(seatBound.regionCodes ?? [])].sort(), ["AB", "D1"], "region set is the areas' fact regions");

  const legacyBound = resolveSalesGeographyBound(dmNoSeat, () => new Set(["AB"]));
  assert.equal(legacyBound.areaCodes, null, "legacy path has no area bound");
  assert.deepEqual([...(legacyBound.regionCodes ?? [])], ["AB"], "legacy path resolves region names to codes");

  const companyBound = resolveSalesGeographyBound(companyScope, neverCalled);
  assert.equal(companyBound.areaCodes, null);
  assert.equal(companyBound.regionCodes, null, "company scope is unbounded");

  // ── applyLineRegionScope (row guard) ───────────────────────────────────────
  const rows = [
    { officialLine: "CNS", regionCode: "AB", areaCode: "AB1", label: "own AB area" },
    { officialLine: "CNS", regionCode: "D1", areaCode: "D16", label: "own out-of-region area" },
    { officialLine: "CNS", regionCode: "D1", areaCode: "D11", label: "sibling DM's area in the same region" },
    { officialLine: "CNS", regionCode: "D1", areaCode: "D17", label: "sibling DM's other area" },
  ];
  const guarded = applyLineRegionScope(rows, {
    allowedLineNames: new Set(["CNS"]),
    allowedRegionCodes: new Set(["AB", "D1"]),
    allowedAreaCodes: dmScope.allowedAreaCodes,
  });
  assert.deepEqual(
    guarded.map((row) => row.areaCode).sort(),
    ["AB1", "D16"],
    "the widened region set alone would leak D11/D17 — the area filter keeps only the owned areas",
  );

  // Rows with no area dimension (e.g. Weekly Sales facts) are unaffected by the area bound.
  const noAreaRows = [
    { officialLine: "CNS", regionCode: "AB" },
    { officialLine: "CNS", regionCode: "D1" },
  ];
  assert.equal(
    applyLineRegionScope(noAreaRows, {
      allowedLineNames: new Set(["CNS"]),
      allowedRegionCodes: new Set(["AB"]),
      allowedAreaCodes: dmScope.allowedAreaCodes,
    }).length,
    1,
    "an area-less fact grain still falls back to the region bound only",
  );

  // ── Monthly Closing matrix ─────────────────────────────────────────────────
  const scopedMatrix = scopeMatrixToAreaCodes(matrixFixture(), dmScope.allowedAreaCodes!);
  assert.deepEqual(
    scopedMatrix.regions.flatMap((region) => region.areas.map((area) => area.areaCode)).sort(),
    ["AB1", "D16"],
    "matrix keeps the owned out-of-region area and drops the sibling's",
  );
  assert.equal(
    scopedMatrix.regions.find((region) => region.regionCode === "D1")?.subtotal.cells[0]?.salesValue,
    50,
    "the Delta (1) subtotal is recomputed from the surviving area only (was 957)",
  );
  assert.equal(scopedMatrix.grandTotal.cells[0]?.salesValue, 150, "grand total = 100 + 50, recomputed");
  assert.equal(scopedMatrix.directNational, null, "national direct stays hidden from a scoped viewer");
  assert.equal(scopedMatrix.companyTotal, null, "company total stays hidden from a scoped viewer");
  assert.equal(
    scopedMatrix.regions.every((region) => region.areas.every((area) => !area.isDirect)),
    true,
    "the synthetic per-region Direct row is dropped too",
  );

  // applyRegionScope: area bound wins; region name only with no area bound; a seat-scoped miss is EMPTY.
  const viaAreaBound = applyRegionScope(matrixFixture(), new Set(["alex-bhr"]), dmScope.allowedAreaCodes);
  assert.deepEqual(
    viaAreaBound.regions.flatMap((region) => region.areas.map((area) => area.areaCode)).sort(),
    ["AB1", "D16"],
    "applyRegionScope prefers the area bound over the region name",
  );
  const viaRegionName = applyRegionScope(matrixFixture(), new Set(["alex-bhr"]), null);
  assert.deepEqual(
    viaRegionName.regions.map((region) => region.regionCode),
    ["AB"],
    "with no area bound the legacy region-name narrowing still applies",
  );
  // 🔴 Flipped 2026-10-26: this used to fail OPEN to the whole matrix — a District Manager whose seat
  // areas had no row this month saw every sibling district. A seat-scoped miss is now an honest empty
  // closing, and the page says "No rows for your areas".
  const unmatchedAreas = applyRegionScope(matrixFixture(), null, new Set(["ZZ9"]));
  assert.equal(unmatchedAreas.regions.length, 0, "🔴 an area bound matching nothing is EMPTY, never the full matrix");
  const unmatchedWithRegion = applyRegionScope(matrixFixture(), new Set(["alex-bhr"]), new Set(["ZZ9"]));
  assert.equal(unmatchedWithRegion.regions.length, 0, "🔴 nor the region: the seat's areas are the whole reach");

  // ── Monthly Closing details row guard ──────────────────────────────────────
  const detailRows = [detailRow("AB1", "AB"), detailRow("D16", "D1"), detailRow("D11", "D1")];
  assert.deepEqual(
    applyDetailScope(detailRows, {
      allowedRegionCodes: new Set(["AB", "D1"]),
      allowedAreaCodes: dmScope.allowedAreaCodes,
      allowedProductCodes: null,
      dropConfidential: false,
    }).map((row) => row.areaCode),
    ["AB1", "D16"],
    "detail rows: the area bound replaces the region check",
  );
  assert.deepEqual(
    applyDetailScope(detailRows, {
      allowedRegionCodes: new Set(["AB"]),
      allowedProductCodes: null,
      dropConfidential: false,
    }).map((row) => row.areaCode),
    ["AB1"],
    "detail rows: without an area bound the region check is unchanged",
  );
  assert.equal(
    applyDetailScope(detailRows, {
      allowedRegionCodes: null,
      allowedAreaCodes: new Set<string>(),
      allowedProductCodes: null,
      dropConfidential: false,
    }).length,
    0,
    "detail rows: an empty area set fails closed",
  );

  // (The Analytics block pinned the same area bound in the Sales Analytics module's scope, retired
  // with that module on 2026-09-17.)

  // ── Portal SoS filter visibility ───────────────────────────────────────────
  const line = new Set(["cns"]);
  assert.equal(
    computePortalSosVisibility(line, new Set(["AB", "D1"]), true).region,
    false,
    "a one-district viewer keeps the region picker hidden even with two region codes",
  );
  assert.equal(
    computePortalSosVisibility(line, new Set(["AB", "D1"]), false).region,
    true,
    "a genuinely multi-region viewer (RM) still gets the region picker",
  );
  assert.equal(computePortalSosVisibility(line, new Set(["AB"])).region, false, "the pre-existing single-region rule is unchanged");
}
