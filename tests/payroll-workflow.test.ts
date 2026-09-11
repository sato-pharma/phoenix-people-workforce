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
  // published-payslip status set ("under_review" -> "approved").
  //
  // THE SENDER MOVED OUT OF THIS ROUTE (finding 15). It was a helper private to this file, which
  // is precisely why Automated Payroll — the live payroll path — could not reach it and silently
  // went without one for 205 people. It now lives in `@/lib/payroll/notify-payslip-available` and
  // both paths call the same copy, so the four properties this test has always guarded are checked
  // where they now live rather than dropped.
  const workflowRouteSource = readFileSync("app/api/payroll/[id]/workflow/route.ts", "utf8");
  assert.match(
    workflowRouteSource,
    /if \(action === "approve"\) \{\s*await notifyPayslipAvailable\(\{ batchId: updated\.id \}\);\s*\}/,
    "the payslip-available notification fires on the approve transition, and only that transition",
  );
  assert.match(
    workflowRouteSource,
    /import \{ notifyPayslipAvailable \} from "@\/lib\/payroll\/notify-payslip-available"/,
    "and it uses the shared sender rather than a copy private to this route",
  );

  const payslipSenderSource = readFileSync("src/lib/payroll/notify-payslip-available.ts", "utf8");
  assert.match(
    payslipSenderSource,
    /eventType: "payslip_available"/,
    "the notification uses the payroll.payslip_available policy key (module: \"payroll\" + eventType: \"payslip_available\")",
  );
  assert.match(payslipSenderSource, /module: "payroll"/);
  assert.match(
    payslipSenderSource,
    /recipientHrId: hrId,[\s\S]*?subjectHrId: hrId,/,
    "the notification targets the explicit-recipient path with recipientHrId === subjectHrId, satisfying explicitRecipientAllowed for a sensitive payroll notification",
  );
  assert.match(
    payslipSenderSource,
    /catch \(error\) \{\s*logError\("Payroll: could not tell one employee their payslip is ready"/,
    "a notification-send failure is caught and logged, never thrown back into the workflow response",
  );
  // Stronger than before: the failure is now COUNTED as well as caught, so a month that told
  // nobody is readable afterwards instead of merely quiet.
  assert.match(
    payslipSenderSource,
    /failed: outcomes\.filter\(\(sent\) => !sent\)\.length/,
    "and the count of failures is returned to the caller",
  );
}
