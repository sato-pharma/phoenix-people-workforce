import assert from "node:assert/strict";

import {
  buildSourceOfSalesDashboard,
  type SourceOfSalesSummaryRecord,
  type SourceOfSalesUploadBatch,
} from "../src/lib/sales/monthly-distributor-import.ts";

// `buildSourceOfSalesDashboard` summed the batch list UNFILTERED on its unrestricted fast path —
// the path Super Admin and the CEO take — while every other dimension on the same screen came from
// the validated-only summaries query. A rejected upload's batch row is written with fully populated
// total_qty/total_value (persistDistributorSalesUpload), so the page reported a rejected sheet as
// revenue and then contradicted itself one table lower.
//
// The numbers below are the audit's measured July scenario: PS uploads cleanly at
// 45,357,275.31 EGP; IS fails validation and leaves a `blocked` row carrying 1,639,916.38. Before
// the fix the headline read ~47.0M and listed IS as a contributor, while By Line summed to 45.4M.
//
// Production held zero blocked batches on the day this was found — which is exactly why it had
// survived. The state is reached by any failed validation, and by any upload that dies between the
// row insert and finalize (up to ~6h).

const PS_VALUE = 45_357_275.31;
const IS_VALUE = 1_639_916.38;

function uploadBatch(input: Partial<SourceOfSalesUploadBatch> & { batchId: string }): SourceOfSalesUploadBatch {
  return {
    blockingReasons: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    distributorCode: "PS",
    distributorName: "Pharma Source",
    failedRows: 0,
    fileName: "ps.xlsx",
    importableRows: 10,
    period: "2026-07",
    rowCount: 10,
    status: "validated",
    templateKey: "generic",
    totalBonusQty: 0,
    totalQty: 10,
    totalValue: PS_VALUE,
    uploadedBy: "tester",
    warningRows: 0,
    ...input,
  };
}

function summaryRow(
  input: Partial<SourceOfSalesSummaryRecord> & { groupType: string; groupKey: string },
): SourceOfSalesSummaryRecord {
  return {
    batchId: "batch-ps",
    groupCode: null,
    groupLabel: input.groupKey,
    officialLine: null,
    rowCount: 10,
    totalBonusQty: 0,
    totalQty: 10,
    totalValue: PS_VALUE,
    ...input,
  };
}

const validatedBatch = uploadBatch({ batchId: "batch-ps" });

const blockedBatch = uploadBatch({
  batchId: "batch-is",
  blockingReasons: ["unmapped customers"],
  distributorCode: "IS",
  distributorName: "Ibn Sina",
  fileName: "is.xlsx",
  status: "blocked",
  totalValue: IS_VALUE,
});

// The summaries query in the loader is already restricted to validated batch ids, so a blocked
// batch contributes NO summary rows. That asymmetry is the whole bug: the summaries were filtered
// and the batch list was not.
const summaries: SourceOfSalesSummaryRecord[] = [
  summaryRow({ groupKey: "CNS", groupType: "line", officialLine: "CNS" }),
  summaryRow({ groupCode: "P1", groupKey: "P1|Product One|CNS", groupLabel: "Product One", groupType: "product", officialLine: "CNS" }),
  summaryRow({ groupCode: "CA", groupKey: "CA|Cairo", groupLabel: "Cairo", groupType: "region" }),
];

export function runSosDashboardBlockedBatchTotalsTests() {
  // ── The CEO / Super Admin fast path ─────────────────────────────────────────────────────────
  const ceo = buildSourceOfSalesDashboard({
    availablePeriods: ["2026-07"],
    batches: [validatedBatch, blockedBatch],
    period: "2026-07",
    summaries,
  });

  assert.equal(
    ceo.totals.totalValue,
    PS_VALUE,
    `headline Total Value must exclude the blocked batch — got ${ceo.totals.totalValue}, ` +
      `which is the validated ${PS_VALUE} plus the rejected ${IS_VALUE}`,
  );

  assert.deepEqual(
    ceo.byDistributor.map((d) => d.distributorCode),
    ["PS"],
    "a rejected upload must not appear as a contributing distributor",
  );

  assert.equal(ceo.sheetCount, 1, "sheetCount must count the sheets whose value is on screen");

  // The self-contradiction is the symptom the owner would actually see: the headline and the
  // By-Line table are built from two different sources and must agree.
  const byLineTotal = ceo.byLine.reduce((sum, row) => sum + row.totalValue, 0);
  assert.equal(
    ceo.totals.totalValue,
    byLineTotal,
    "headline Total Value must reconcile with By Line — they are built from different sources",
  );

  // ── The scoped path (a viewer who cannot see the Head Office line) ───────────────────────────
  const scoped = buildSourceOfSalesDashboard({
    availablePeriods: ["2026-07"],
    batches: [validatedBatch, blockedBatch],
    excludeHeadOfficeLine: true,
    period: "2026-07",
    summaries,
  });

  assert.equal(scoped.sheetCount, 1, "the scoped path must count validated sheets too");
  assert.deepEqual(
    scoped.byDistributor.map((d) => d.distributorCode),
    ["PS"],
    "the scoped path resolves summary rows through the batch list — a blocked batch must not resolve",
  );
  assert.deepEqual(
    scoped.byDistributor.map((d) => d.sheetCount),
    [1],
    "per-distributor sheetCount must exclude rejected sheets",
  );

  // ── A blocked batch alone must read as zero, never as revenue ────────────────────────────────
  const rejectedOnly = buildSourceOfSalesDashboard({
    availablePeriods: ["2026-07"],
    batches: [blockedBatch],
    period: "2026-07",
    summaries: [],
  });

  assert.equal(rejectedOnly.totals.totalValue, 0, "a period holding only a rejected upload has no sales");
  assert.equal(rejectedOnly.sheetCount, 0, "a rejected upload is not a counted sheet");
  assert.deepEqual(rejectedOnly.byDistributor, [], "a rejected upload contributes no distributor row");
}
