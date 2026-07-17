import assert from "node:assert/strict";

import { enforcePayslipEmailBlock, isPayslipEventType } from "../src/lib/notifications/payslip-channel-guard.ts";

export function runPayslipEmailBlockTests() {
  // A payslip notification must NEVER include the email channel — whatever it starts as.
  assert.deepEqual(enforcePayslipEmailBlock(["in_app", "email", "telegram"], "payslip_available"), ["in_app", "telegram"]);
  assert.deepEqual(enforcePayslipEmailBlock(["email"], "payslip_available"), []);

  // Case-insensitive + substring match on the eventType.
  assert.deepEqual(enforcePayslipEmailBlock(["in_app", "email"], "PAYSLIP_AVAILABLE"), ["in_app"]);
  assert.deepEqual(enforcePayslipEmailBlock(["in_app", "email"], "payroll.payslip.ready"), ["in_app"]);

  // The Telegram-failure fallback vector: a re-entry with channels ["email","in_app"] for a payslip
  // must still be stripped to no email.
  assert.deepEqual(enforcePayslipEmailBlock(["email", "in_app"], "payslip_available"), ["in_app"]);

  // Non-payslip notifications are UNAFFECTED — legitimate payroll-admin emails keep email.
  assert.deepEqual(enforcePayslipEmailBlock(["in_app", "email"], "workflow_updated"), ["in_app", "email"]);
  assert.deepEqual(enforcePayslipEmailBlock(["in_app", "email"], "salary_upload_imported"), ["in_app", "email"]);

  // Dedupes while preserving order; leaves non-payslip email intact.
  assert.deepEqual(enforcePayslipEmailBlock(["in_app", "in_app", "email"], "brevo.click"), ["in_app", "email"]);

  // Predicate.
  assert.equal(isPayslipEventType("payslip_available"), true);
  assert.equal(isPayslipEventType("PAYSLIP"), true);
  assert.equal(isPayslipEventType("workflow_updated"), false);
  assert.equal(isPayslipEventType(null), false);
  assert.equal(isPayslipEventType(undefined), false);
}
