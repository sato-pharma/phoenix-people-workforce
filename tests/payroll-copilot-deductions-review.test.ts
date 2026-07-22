import assert from "node:assert/strict";

import {
  candidateOverlapsWindow,
  monthKeysForWindow,
} from "../src/lib/payroll/copilot/deductions-review.ts";
import type { CycleWindow } from "../src/lib/payroll/copilot/cycle-window.ts";

// The "July" payroll cycle: 24 Jun -> 23 Jul — spans two calendar months.
const JULY_CYCLE: CycleWindow = {
  cycleKey: "2026-07",
  startIso: "2026-06-24",
  endIso: "2026-07-23",
  anchorDay: 24,
};

export function runPayrollCopilotDeductionsReviewTests() {
  // A cycle spanning two calendar months needs both month_keys queried —
  // deduction_candidates.month_key is stamped by calendar month, not cycle.
  assert.deepEqual(monthKeysForWindow(JULY_CYCLE), ["2026-06", "2026-07"]);

  // A cycle that happens to align exactly with a calendar month (anchor day 1)
  // only needs one month_key.
  const alignedCycle: CycleWindow = {
    cycleKey: "2026-08",
    startIso: "2026-08-01",
    endIso: "2026-08-31",
    anchorDay: 1,
  };
  assert.deepEqual(monthKeysForWindow(alignedCycle), ["2026-08"]);

  // A candidate dated inside the window overlaps...
  assert.equal(candidateOverlapsWindow(["2026-06-30"], JULY_CYCLE), true);
  assert.equal(candidateOverlapsWindow(["2026-07-23"], JULY_CYCLE), true);
  // ...one dated before/after the window does not, even though its calendar
  // month_key would still have matched a naive month-only filter.
  assert.equal(candidateOverlapsWindow(["2026-06-23"], JULY_CYCLE), false);
  assert.equal(candidateOverlapsWindow(["2026-07-24"], JULY_CYCLE), false);
  // Multiple dates: any single overlapping date is enough.
  assert.equal(candidateOverlapsWindow(["2026-05-01", "2026-07-01"], JULY_CYCLE), true);
  assert.equal(candidateOverlapsWindow([], JULY_CYCLE), false);
}
