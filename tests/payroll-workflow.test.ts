import assert from "node:assert/strict";

import { PayrollConflictError } from "../src/lib/payroll/errors.ts";
import { getPayrollWorkflowTransition } from "../src/lib/payroll/workflow.ts";

export function runPayrollWorkflowTests() {
  assert.equal(getPayrollWorkflowTransition("uploaded", "mark_review").nextStatus, "under_review");
  assert.equal(getPayrollWorkflowTransition("under_review", "approve").nextStatus, "approved");
  assert.equal(getPayrollWorkflowTransition("approved", "lock").nextStatus, "locked");
  assert.equal(getPayrollWorkflowTransition("under_review", "reject", "Wrong totals").nextStatus, "rejected");
  assert.equal(getPayrollWorkflowTransition("rejected", "reopen").nextStatus, "uploaded");

  assert.throws(
    () => getPayrollWorkflowTransition("uploaded", "approve"),
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
