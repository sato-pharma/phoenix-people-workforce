import { strict as assert } from "node:assert";

import {
  addDays,
  inclusiveDayCount,
  resolveCycleWindow,
} from "../src/lib/payroll/copilot/cycle-window.ts";

export function runPayrollCopilotCycleWindowTests() {
  // --- date helpers ---
  assert.equal(addDays("2026-07-23", 1), "2026-07-24");
  assert.equal(addDays("2026-06-30", 1), "2026-07-01");
  assert.equal(addDays("2026-02-28", 1), "2026-03-01", "2026 is not a leap year");
  assert.equal(addDays("2025-12-31", 1), "2026-01-01", "year boundary");
  assert.equal(inclusiveDayCount("2026-06-24", "2026-07-23"), 30);
  assert.equal(inclusiveDayCount("2026-07-15", "2026-07-15"), 1);

  // --- resolveCycleWindow (anchor 24) ---
  const midJuly = resolveCycleWindow("2026-07-03", 24);
  assert.equal(midJuly.startIso, "2026-06-24", "a date before the 24th belongs to the prior-month cycle");
  assert.equal(midJuly.endIso, "2026-07-23");
  assert.equal(midJuly.cycleKey, "2026-07");

  const onAnchor = resolveCycleWindow("2026-07-24", 24);
  assert.equal(onAnchor.startIso, "2026-07-24", "the anchor day starts the next cycle");
  assert.equal(onAnchor.endIso, "2026-08-23");
  assert.equal(onAnchor.cycleKey, "2026-08");

  const janBackToDec = resolveCycleWindow("2026-01-10", 24);
  assert.equal(janBackToDec.startIso, "2025-12-24", "January before the 24th reaches back to December");
  assert.equal(janBackToDec.endIso, "2026-01-23");
  assert.equal(janBackToDec.cycleKey, "2026-01");

  const decForward = resolveCycleWindow("2026-12-25", 24);
  assert.equal(decForward.startIso, "2026-12-24");
  assert.equal(decForward.endIso, "2027-01-23", "December after the 24th rolls into next year");
  assert.equal(decForward.cycleKey, "2027-01");
}
