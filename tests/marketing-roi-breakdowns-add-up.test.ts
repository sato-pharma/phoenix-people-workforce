import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { reconcileMarketingRoiBreakdowns } from "../src/lib/marketing-requests/roi-breakdown-reconcile.ts";
import { pickMarketingRequestAreaId } from "../src/lib/marketing-requests/request-area.ts";
import type {
  SalesMarketingCustomerImpactRow,
  SalesMarketingDashboardSnapshot,
  SalesMarketingRoiComparisonRow,
} from "../src/lib/sales-marketing-intelligence/types.ts";

/**
 * The Marketing ROI Dashboard's breakdowns add up to its cards (owner report, 2026-10-26).
 *
 * The cards read 7 paid requests and EGP 51,800; the Region and Distributor reports read 6 and
 * EGP 48,200, and the Customer report had 6 rows. MKT-REQ-20261004-6D1003DC (EGP 3,600) targets a
 * pharmacy with no distributor account, and `phx_marketing_roi_fast` INNER-joined through that
 * account, so the request fell out of every breakdown. The same function wrote a literal 0 for
 * every row's pharmacy count and every product row's customer count, while the PHARMACIES card
 * read 7.
 *
 * Pinned three ways: the SQL keeps the request (left join) and counts real pharmacies; the service's
 * last step folds any remaining gap into an Unassigned row; and a new request is never filed under
 * a retired region-level area (the reason this one sat under "Delta (1)").
 */

const MIGRATION_DIRS = [
  new URL("../supabase/_migrations_archive/pre-baseline-2026-07-11/", import.meta.url),
  new URL("../supabase/migrations/", import.meta.url),
];

/** The body Postgres holds today: the LAST migration that (re)creates the function. */
function latestFunctionBody(funcName: string): { body: string; file: string } {
  const startRe = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${funcName}\\s*\\(`, "i");
  let latest: { body: string; file: string } | null = null;
  for (const dir of MIGRATION_DIRS) {
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      const sql = readFileSync(new URL(name, dir), "utf8");
      const match = startRe.exec(sql);
      if (!match) continue;
      latest = { body: sql.slice(match.index).replace(/--[^\r\n]*/g, ""), file: name };
    }
  }
  assert.ok(latest, `${funcName}: no migration defines it`);
  return latest!;
}

function comparisonRow(label: string, cost: number, requests: number): SalesMarketingRoiComparisonRow {
  return {
    actualRoiCoverage: 0,
    actualSalesUnits: 0,
    actualSalesValue: 0,
    behindRequests: 0,
    coverageGap: 0,
    customerCount: 1,
    exactSalesRows: 0,
    expectedRoiValue: 0,
    fallbackSalesRows: 0,
    label,
    line: null,
    marketingCost: cost,
    noDataRequests: 0,
    onTrackRequests: 0,
    pharmacyCount: 1,
    requestCount: requests,
    requiredRoiValue: 0,
    value: label,
  };
}

function customerRow(label: string, cost: number): SalesMarketingCustomerImpactRow {
  return {
    actualRoiCoverage: 0,
    actualSalesUnits: 0,
    actualSalesValue: 0,
    coverageGap: 0,
    customerCount: 1,
    distributorCode: null,
    distributorName: null,
    exactSalesRows: 0,
    expectedRoiValue: 0,
    fallbackSalesRows: 0,
    label,
    marketingCost: cost,
    pharmacyCount: 1,
    regionName: "Giza",
    requestCount: 1,
    requiredRoiValue: 0,
    salesRows: 0,
    value: label,
  };
}

/** The owner's numbers: cards 7 / 51,800, every breakdown 6 / 48,200. */
function shortSnapshot(): SalesMarketingDashboardSnapshot {
  return {
    customerImpact: [customerRow("Dr A", 36_000), customerRow("Dr B", 12_200)],
    distributorRoi: [comparisonRow("overseas", 37_000, 5), comparisonRow("Ibn sina", 11_200, 1)],
    limits: { rawRowsReturned: 0, tableLimit: 100 },
    regionRoi: [comparisonRow("Delta (1)", 36_000, 4), comparisonRow("Giza", 12_200, 2)],
    summary: { paidRequestCount: 7, totalMarketingCost: 51_800 },
  } as unknown as SalesMarketingDashboardSnapshot;
}

const totalCost = (rows: Array<{ marketingCost: number }>) => rows.reduce((sum, row) => sum + row.marketingCost, 0);
const totalRequests = (rows: Array<{ requestCount: number }>) => rows.reduce((sum, row) => sum + row.requestCount, 0);

function testReconcileAddsUp() {
  const fixed = reconcileMarketingRoiBreakdowns(shortSnapshot());
  for (const [name, rows] of [
    ["Region", fixed.regionRoi],
    ["Distributor", fixed.distributorRoi],
    ["Customer", fixed.customerImpact],
  ] as const) {
    assert.equal(totalCost(rows), 51_800, `${name} report must add up to the EGP 51,800 card`);
  }
  assert.equal(totalRequests(fixed.regionRoi), 7, "Region report must add up to the 7 paid requests");
  assert.equal(totalRequests(fixed.distributorRoi), 7, "Distributor report must add up to the 7 paid requests");
  assert.equal(fixed.regionRoi.at(-1)?.label, "Unmapped pharmacy", "the missing cost shows as an unmapped pharmacy");
  assert.equal(fixed.distributorRoi.at(-1)?.label, "No distributor account");
  assert.equal(fixed.customerImpact.at(-1)?.label, "Unassigned customer");
  assert.equal(fixed.customerImpact.at(-1)?.regionName, "Unmapped pharmacy", "a gap row never shows a blank region");

  // An Unassigned row already there absorbs the gap instead of a second one appearing.
  const withUnassigned = shortSnapshot();
  withUnassigned.regionRoi = [...withUnassigned.regionRoi, { ...comparisonRow("Unmapped pharmacy", 1_000, 1), value: "Unassigned" }];
  const merged = reconcileMarketingRoiBreakdowns(withUnassigned).regionRoi;
  assert.equal(merged.length, 3, "the gap folds into the existing Unassigned row");
  assert.equal(totalCost(merged), 51_800);

  // Already adding up: untouched. A table cut at the row limit is a top-N list: untouched.
  const exact = reconcileMarketingRoiBreakdowns(fixed);
  assert.equal(exact.regionRoi.length, fixed.regionRoi.length, "a breakdown that adds up gains no row");
  const capped = shortSnapshot();
  capped.limits.tableLimit = 2;
  assert.equal(reconcileMarketingRoiBreakdowns(capped).customerImpact.length, 2, "a capped list is never padded");
}

function testServiceReconcilesLast() {
  const service = readFileSync("src/lib/sales-marketing-intelligence/service.ts", "utf8");
  const calls = service.match(/return reconcileMarketingRoiBreakdowns\(/g) ?? [];
  assert.equal(calls.length, 4, "both dashboard reads reconcile on both return paths (restricted and full view)");
}

function testSqlKeepsEveryRequestAndCountsPharmacies() {
  const { body, file } = latestFunctionBody("phx_marketing_roi_fast");
  assert.match(
    body,
    /left\s+join\s+marketing_pharmacy_distributor_codes\s+mpdc\s+on\s+mpdc\.id\s*=\s*mrph\.distributor_code_id/i,
    `${file}: a target pharmacy with no distributor account must not drop its request from the breakdowns`,
  );
  assert.doesNotMatch(body, /'pharmacyCount',\s*0\s*,/, `${file}: no breakdown row may hard-code 0 pharmacies`);
  assert.doesNotMatch(body, /'customerCount',\s*0\s*,/, `${file}: no breakdown row may hard-code 0 customers`);
}

function testRequestNeverFiledUnderRetiredArea() {
  const selling = new Set([1094, 1100]);
  assert.equal(
    pickMarketingRequestAreaId({ customerAreaId: null, explicitAreaId: null, requesterAreaId: 29, sellingAreaIds: selling }),
    null,
    "a manager's region-level area (Delta (1), id 29) is never stamped on a new request",
  );
  assert.equal(
    pickMarketingRequestAreaId({ customerAreaId: 29, explicitAreaId: null, requesterAreaId: 1100, sellingAreaIds: selling }),
    1100,
    "the first SELLING candidate wins",
  );
  assert.equal(
    pickMarketingRequestAreaId({ customerAreaId: 1094, explicitAreaId: null, requesterAreaId: 29, sellingAreaIds: selling }),
    1094,
  );
  assert.equal(
    pickMarketingRequestAreaId({ customerAreaId: 29, explicitAreaId: null, requesterAreaId: null, sellingAreaIds: null }),
    29,
    "an unreadable bricks table keeps the old behaviour — a failed read is never permission to drop an area",
  );
  const requests = readFileSync("src/lib/marketing-requests/service.ts", "utf8");
  assert.equal(
    (requests.match(/sellingAreaIds: await sellingAreaIdsAmong\(/g) ?? []).length,
    2,
    "both the create and the resubmit path check the area is a selling one",
  );
}

export function runMarketingRoiBreakdownsAddUpTests() {
  testReconcileAddsUp();
  testServiceReconcilesLast();
  testSqlKeepsEveryRequestAndCountsPharmacies();
  testRequestNeverFiledUnderRetiredArea();
}
