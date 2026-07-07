import assert from "node:assert/strict";

import { priorPeriod, sourceExpenseMonthBounds } from "../src/lib/payroll/copilot/expense-review.ts";

export function runPayrollCopilotExpenseReviewTests() {
  // Expenses lag one month: June payroll pays out May's approved outstation trips.
  assert.deepEqual(priorPeriod({ month: 6, year: 2026 }), { month: 5, year: 2026 });
  assert.deepEqual(sourceExpenseMonthBounds({ month: 6, year: 2026 }), {
    start: "2026-05-01",
    end: "2026-05-31",
  });

  // January payroll pays out the PRIOR December (year rolls back too).
  assert.deepEqual(priorPeriod({ month: 1, year: 2026 }), { month: 12, year: 2025 });
  assert.deepEqual(sourceExpenseMonthBounds({ month: 1, year: 2026 }), {
    start: "2025-12-01",
    end: "2025-12-31",
  });

  // A short month (February, non-leap) resolves its correct last day.
  assert.deepEqual(sourceExpenseMonthBounds({ month: 3, year: 2026 }), {
    start: "2026-02-01",
    end: "2026-02-28",
  });
}
