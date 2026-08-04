import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildKpiBand,
  resolveRoiStatusScope,
  roiValueBucket,
  sharedAttributionOverlap,
  type RoiAttributionLine,
} from "../src/lib/marketing-requests/roi-report-service.ts";
import type { MarketingRoiReportRow } from "../src/lib/marketing-requests/roi-report-types.ts";
import type { MarketingRequestStatus } from "../src/lib/marketing-requests/types.ts";

/**
 * Marketing ROI — a company-wide total counts each invoice line once, and the default page scope
 * is live campaigns only.
 *
 * Two campaigns targeting the same pharmacy and product over overlapping ROI windows both
 * legitimately claim the same sale, so adding up the per-request figures inflated the executive
 * band: production carried 392 claims over 309 real sales, 729,884.77 EGP added up against
 * 480,155.92 EGP of actual sales (+52.0%). Separately, the report loaded every status with a pay
 * date, so its headline cost read 1,336,971 EGP where the Sales-Marketing Intelligence dashboard
 * read 762,010, and 277,353 EGP of rejected and archived sales was labelled "held in pending
 * requests" to an executive.
 */

const row = (overrides: Partial<MarketingRoiReportRow> & Pick<MarketingRoiReportRow, "requestId">): MarketingRoiReportRow => ({
  actualCoverageRatio: 0,
  actualSalesUnits: 0,
  actualSalesValue: 0,
  approverRoleKeys: [],
  attributionGapReason: null,
  attributionQuality: "exact_customer",
  customerName: "El Ezaby",
  dataCoverage: "complete",
  distributorCodes: ["IBN"],
  estimatedCost: 1_000,
  expectedRoiValue: 10_000,
  forecastCoverageRatio: 1,
  hasSalesData: true,
  line: "Anti Inf",
  payDate: "2026-03-01",
  productCodes: ["MKT_PRD001"],
  region: "Cairo",
  requestCode: `MR-${overrides.requestId}`,
  requesterHrId: "HR-1",
  requesterName: "Ahmed Samir",
  requestTypeName: "Shelf share",
  requiredRoiValue: 10_000,
  resultStatus: "on_track",
  roiDurationMonths: 3,
  roiWindow: "2026-03 → 2026-05",
  salesDataComplete: true,
  status: "approved",
  ...overrides,
});

const line = (requestId: string, overrides: Partial<RoiAttributionLine> = {}): RoiAttributionLine => ({
  customerCode: "ph-100",
  distributorCode: "IBN",
  invoicePeriod: "2026-03",
  productCode: "MKT_PRD001",
  qty: 10,
  requestId,
  value: 4_000,
  ...overrides,
});

export function runMarketingRoiSharedAttributionTests() {
  // ── the shared-claim ledger ─────────────────────────────────────────────────
  // Nothing claimed twice → nothing to deduct.
  assert.equal(sharedAttributionOverlap([]), 0, "an empty ledger cannot prove any double count");
  assert.equal(
    sharedAttributionOverlap([line("a"), line("a", { invoicePeriod: "2026-04" })]),
    0,
    "two different months inside ONE request are two different sales, not a double count",
  );

  // The same sale claimed by two campaigns: real value 4,000, added up 8,000, overlap 4,000.
  assert.equal(
    sharedAttributionOverlap([line("a"), line("b")]),
    4_000,
    "a sale both campaigns legitimately claim must be counted once company-wide",
  );
  assert.equal(
    sharedAttributionOverlap([line("a"), line("b"), line("c")]),
    8_000,
    "four claimants on one sale deduct every claim beyond the first — production saw up to 4",
  );

  // Identical lines are a MULTISET, never a set: the RPC does not expose the source sale's row id,
  // so three identical lines inside one request are three distinct sales. Collapsing them by
  // signature would under-report the company's own sales (197 signatures cover 309 sales in prod).
  assert.equal(
    sharedAttributionOverlap([line("a"), line("a"), line("a"), line("b"), line("b")]),
    2 * 4_000,
    "the union keeps the three copies request a claimed; only b's two duplicate claims are deducted",
  );

  // ── the KPI band ────────────────────────────────────────────────────────────
  // Two approved campaigns, each correctly reporting the same 4,000 sale as its own actuals.
  const shared = buildKpiBand(
    [
      row({ actualSalesValue: 4_000, requestId: "a" }),
      row({ actualSalesValue: 4_000, requestId: "b" }),
    ],
    "2026-05",
    0,
    [line("a"), line("b")],
  );
  assert.equal(shared.totalActualValue, 4_000, "the company sold 4,000 once, however many campaigns claim it");
  assert.equal(shared.approvedValue, 4_000, "the approved chip is a company total too — it double counted identically");
  assert.equal(
    shared.coverageRatio,
    4_000 / 20_000,
    "coverage must divide the DEDUPED sales by the required return, or a shared sale inflates the percentage",
  );

  // Per-request figures are correct as they stand and must not be touched.
  assert.equal(
    buildKpiBand([row({ actualSalesValue: 4_000, requestId: "a" })], "2026-05", 0, [line("a")]).totalActualValue,
    4_000,
    "one campaign claiming its own sale has nothing to deduct",
  );

  // Value with no claimed line behind it is never deducted: direct-order sales are attributed per
  // request and never appear in the ledger, so rebuilding the total from the ledger would drop
  // them the moment a campaign tracks direct orders.
  assert.equal(
    buildKpiBand([row({ actualSalesValue: 4_000, requestId: "a" })], "2026-05", 0, []).totalActualValue,
    4_000,
    "sales the ledger cannot see stay counted in full",
  );

  // A caller that narrowed the rows (ROI Tracking's facets) must get the overlap of ITS subset.
  const narrowed = buildKpiBand([row({ actualSalesValue: 4_000, requestId: "a" })], "2026-05", 0, [line("a"), line("b")]);
  assert.equal(
    narrowed.totalActualValue,
    4_000,
    "b is not in this band, so its claim must not deduct value from the only row that is",
  );

  // ── which money is approved, which is pending, which is neither ─────────────
  assert.equal(roiValueBucket("approved"), "approved");
  assert.equal(roiValueBucket("finance_hold"), "approved", "a paid campaign held by finance is committed money");
  assert.equal(roiValueBucket("pending_approval"), "pending");
  assert.equal(roiValueBucket("rejected"), null, "refused spend is not awaiting anyone's decision");
  assert.equal(roiValueBucket("archived"), null, "an archived campaign is history, not a pending request");

  const mixed = buildKpiBand(
    [
      row({ actualSalesValue: 4_000, requestId: "a", status: "approved" }),
      row({ actualSalesValue: 3_000, requestId: "b", status: "rejected" }),
      row({ actualSalesValue: 2_000, requestId: "c", status: "archived" }),
      row({ actualSalesValue: 1_000, requestId: "d", status: "pending_approval" }),
    ],
    "2026-05",
    0,
    [],
  );
  assert.equal(mixed.approvedValue, 4_000);
  assert.equal(
    mixed.pendingValue,
    1_000,
    "the band's chip reads 'held in pending requests' — rejected and archived money must not appear in it",
  );

  // ── the default scope an executive means by "our marketing spend" ───────────
  const defaultScope = resolveRoiStatusScope([]);
  const live: MarketingRequestStatus[] = ["approved", "active", "roi_tracking", "closed", "finance_hold"];
  assert.deepEqual([...defaultScope].sort(), [...live].sort(), "an unfiltered page scopes to live campaigns");
  for (const status of ["archived", "rejected", "pending_approval", "draft"] as MarketingRequestStatus[]) {
    assert.equal(
      defaultScope.includes(status),
      false,
      `${status} spend must not silently join the headline cost — that is the 574,961 EGP the dashboards disagreed by`,
    );
  }
  assert.deepEqual(
    resolveRoiStatusScope(["archived"]),
    ["archived"],
    "an explicit status selection always wins, so opting back into archived still works",
  );

  // ── wiring (Supabase-backed, so pinned by source) ───────────────────────────
  const service = readFileSync("src/lib/marketing-requests/roi-report-service.ts", "utf8");
  assert.match(
    service,
    /matchesNonRoiFilters\(entry, scopedFilters\)/,
    "the report must select candidates through the status-scoped filters, not the raw request body",
  );
  assert.match(
    service,
    /buildKpiBand\(finalRows, ctx\.salesDataAsOf, restrictedExcludedCount, attributionLines\)/,
    "the band must be built WITH the claim ledger; without it the total silently returns to the summed figure",
  );
}
