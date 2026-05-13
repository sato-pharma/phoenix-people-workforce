import assert from "node:assert/strict";

import { PayrollConflictError } from "../src/lib/payroll/errors.ts";
import { getPayrollWorkflowTransition } from "../src/lib/payroll/workflow.ts";

export function runPayrollWorkflowTests() {
  assert.equal(getPayrollWorkflowTransition("uploaded", "mark_part1_ready").nextStatus, "part1_ready");
  assert.equal(getPayrollWorkflowTransition("part1_ready", "mark_part1_paid").nextStatus, "part1_paid");
  assert.equal(getPayrollWorkflowTransition("part1_paid", "open_adjustments").nextStatus, "adjustments_open");
  assert.equal(getPayrollWorkflowTransition("adjustments_open", "mark_part2_ready").nextStatus, "part2_ready");
  assert.equal(getPayrollWorkflowTransition("part2_ready", "mark_review").nextStatus, "under_review");
  assert.equal(getPayrollWorkflowTransition("under_review", "approve").nextStatus, "approved");
  assert.equal(getPayrollWorkflowTransition("approved", "lock").nextStatus, "locked");
  assert.equal(getPayrollWorkflowTransition("under_review", "reject", "Wrong totals").nextStatus, "rejected");
  assert.equal(getPayrollWorkflowTransition("rejected", "reopen").nextStatus, "adjustments_open");

  assert.throws(
    () => getPayrollWorkflowTransition("uploaded", "approve"),
    PayrollConflictError,
  );
  assert.throws(
    () => getPayrollWorkflowTransition("uploaded", "mark_review"),
    PayrollConflictError,
  );
  assert.throws(
    () => getPayrollWorkflowTransition("approved", "reopen"),
    PayrollConflictError,
  );
  assert.throws(
    () => getPayrollWorkflowTransition("locked", "reopen"),
    PayrollConflictError,
  );
  assert.throws(
    () => getPayrollWorkflowTransition("under_review", "reject", " "),
    PayrollConflictError,
  );
}
