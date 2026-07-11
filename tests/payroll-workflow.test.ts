import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

  // Regression for audit finding M10: "payroll.payslip_available" was defined in
  // notifications/policy.ts but no code path ever fired it, so employees had no signal their
  // payslip was ready. "approve" is confirmed above as the transition that first enters the
  // published-payslip status set ("under_review" -> "approved") — the workflow route must fire
  // one payslip-available notification per employee in the batch on exactly that transition, and
  // it must never block the response if notification delivery fails.
  const workflowRouteSource = readFileSync("app/api/payroll/[id]/workflow/route.ts", "utf8");
  assert.match(
    workflowRouteSource,
    /if \(action === "approve"\) \{\s*await notifyEmployeesPayslipAvailable\(updated\.id\);\s*\}/,
    "the payslip-available notification fires on the approve transition, and only that transition",
  );
  assert.match(
    workflowRouteSource,
    /eventType: "payslip_available"/,
    "the notification uses the payroll.payslip_available policy key (module: \"payroll\" + eventType: \"payslip_available\")",
  );
  assert.match(
    workflowRouteSource,
    /module: "payroll"/,
  );
  assert.match(
    workflowRouteSource,
    /recipientHrId: hrId,[\s\S]*?subjectHrId: hrId,/,
    "the notification targets the explicit-recipient path with recipientHrId === subjectHrId, satisfying explicitRecipientAllowed for a sensitive payroll notification",
  );
  assert.match(
    workflowRouteSource,
    /catch \(error\) \{\s*console\.error\("\[payroll-workflow\] failed to send payslip-available notifications", error\);\s*\}/,
    "a notification-send failure is caught and logged, never thrown back into the workflow response",
  );
}
