import assert from "node:assert/strict";

import { buildReconciliation, resolveUploadPeriod } from "../src/lib/sales/sales-upload.ts";
import type { NormalizeResult } from "../src/lib/sales/normalizer/types.ts";

function makeResult(over: { totalRows: number; fullyCoded: number; ignored: number; blank: number; exceptions: number; coded?: { qty: number; value: number }[] }): NormalizeResult {
  return {
    coded: (over.coded ?? []).map((c) => ({ qty: c.qty, value: c.value })),
    distributorCode: "PS",
    exceptions: Array.from({ length: over.exceptions }, () => ({})),
    ignoredRows: [],
    blankCustomerRows: [],
    summary: {
      brickResolved: over.fullyCoded,
      blankCustomerSkipped: over.blank,
      fullyCoded: over.fullyCoded,
      ignored: over.ignored,
      productResolved: over.fullyCoded,
      totalRows: over.totalRows,
    },
  } as unknown as NormalizeResult;
}

function reconciliationBalances() {
  const r = buildReconciliation(makeResult({
    totalRows: 5, fullyCoded: 3, ignored: 1, blank: 1, exceptions: 0,
    coded: [{ qty: 10, value: 100 }, { qty: 5, value: 50 }, { qty: 2, value: 20 }],
  }));
  assert.equal(r.rowsRead, 5);
  assert.equal(r.rowsCoded, 3);
  assert.equal(r.rowsIgnored, 1);
  assert.equal(r.rowsBlankCustomer, 1);
  assert.equal(r.rowsBlocked, 0);
  assert.equal(r.totalQty, 17);
  assert.equal(r.totalValue, 170);
}

function reconciliationCountsBlockedRows() {
  const r = buildReconciliation(makeResult({ totalRows: 4, fullyCoded: 2, ignored: 0, blank: 0, exceptions: 2 }));
  assert.equal(r.rowsBlocked, 2);
  assert.equal(r.rowsRead, 4);
}

// The whole point: a row can never silently vanish. If the buckets don't sum to rows read, abort.
function reconciliationMismatchThrows() {
  assert.throws(
    () => buildReconciliation(makeResult({ totalRows: 10, fullyCoded: 2, ignored: 0, blank: 0, exceptions: 0 })),
    /reconciliation mismatch/i,
  );
}

// The period decision must never silently drop a month (the HIGH bug the review caught).
function periodDecisionNeverSilentlyDrops() {
  // override → consolidate everything under it
  assert.deepEqual(resolveUploadPeriod(["2026-05", "2026-04"], "2026-06"), { kind: "ok", period: "2026-06", consolidate: true });
  // date-less pivot (CP) + override
  assert.deepEqual(resolveUploadPeriod([null, "", undefined], "2026-05"), { kind: "ok", period: "2026-05", consolidate: true });
  // single period, no override → use it, no consolidation
  assert.deepEqual(resolveUploadPeriod(["2026-05", "2026-05"], ""), { kind: "ok", period: "2026-05", consolidate: false });
  // no dates, no override → missing (ask for a period)
  assert.deepEqual(resolveUploadPeriod([null, ""], ""), { kind: "missing" });
  // multiple months, no override → refuse (no silent drop)
  assert.deepEqual(resolveUploadPeriod(["2026-05", "2026-04"], ""), { kind: "multi", periods: ["2026-04", "2026-05"] });
  // invalid override is ignored (treated as no override)
  assert.deepEqual(resolveUploadPeriod(["2026-05"], "nonsense"), { kind: "ok", period: "2026-05", consolidate: false });
}

export function runSalesUploadReconcileTests() {
  reconciliationBalances();
  reconciliationCountsBlockedRows();
  reconciliationMismatchThrows();
  periodDecisionNeverSilentlyDrops();
}
