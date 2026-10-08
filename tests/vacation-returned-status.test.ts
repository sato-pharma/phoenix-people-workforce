import assert from "node:assert/strict";

import { normalizeVacationRequestStatus } from "../src/lib/vacation/calculations.ts";
import { buildVacationSlaStatus } from "../src/lib/vacation/service.ts";
import { VACATION_STATUSES } from "../src/lib/vacation/types.ts";

/**
 * A leave request the approver RETURNED to the employee must read as returned everywhere.
 *
 * The row reader listed the statuses by hand and left "returned" out, so it fell back to
 * pending_manager: VAC-0653 (returned by HR on 2026-10-08 for a missing event photo) showed
 * "Pending Manager", sat in the approvers' "Awaiting your response" queue, and the employee's
 * resubmit refused it because it checks for "returned".
 */
export async function runVacationReturnedStatusTests() {
  // 1 ── THE HEADLINE: a returned request stays returned.
  assert.equal(
    normalizeVacationRequestStatus("returned"),
    "returned",
    "a returned leave request must read as returned, not fall back to Pending Manager",
  );

  // 2 ── Every status the system defines passes through unchanged, so a new one cannot be dropped
  // the same way again.
  for (const option of VACATION_STATUSES) {
    assert.equal(normalizeVacationRequestStatus(option.value), option.value, `${option.value} must pass through`);
  }

  // 3 ── Only an unknown value falls back.
  assert.equal(normalizeVacationRequestStatus("something_else"), "pending_manager");
  assert.equal(normalizeVacationRequestStatus(null), "pending_manager");

  // 4 ── A returned request waits on the employee, so no approver's SLA clock runs on it: a month
  // old, it is still not "SLA overdue".
  const sla = buildVacationSlaStatus({
    now: new Date("2026-11-09T10:00:00Z"),
    request: { created_at: "2026-10-01T08:00:00Z", manager_decision_at: "2026-10-02T08:00:00Z", status: "returned" },
    settings: { hrPendingBusinessDays: 2, managerPendingBusinessDays: 1, reminderIntervalDays: 1 },
  });
  assert.equal(sla.isOverdue, false, "a returned request must never show SLA overdue");
  assert.equal(sla.stage, "returned");
  assert.equal(sla.dueAt, null);
}
