import assert from "node:assert/strict";

import { enforceMarketingSlaEmailBlock, isMarketingSlaEventType } from "../src/lib/notifications/marketing-sla-channel-guard.ts";

export function runMarketingSlaEmailBlockTests() {
  // A marketing SLA reminder/escalation must NEVER include the email channel — whatever it starts as.
  assert.deepEqual(enforceMarketingSlaEmailBlock(["in_app", "email", "telegram"], "marketing_requests", "escalation"), ["in_app", "telegram"]);
  assert.deepEqual(enforceMarketingSlaEmailBlock(["email"], "marketing_requests", "due_date_reminder"), []);
  assert.deepEqual(enforceMarketingSlaEmailBlock(["in_app", "email"], "marketing_requests", "overdue_reminder"), ["in_app"]);

  // Case-insensitive on both module and eventType.
  assert.deepEqual(enforceMarketingSlaEmailBlock(["in_app", "email"], "MARKETING_REQUESTS", "ESCALATION"), ["in_app"]);

  // The Telegram-failure fallback vector: a re-entry with channels ["email","in_app"] for a
  // marketing SLA event must still be stripped to no email.
  assert.deepEqual(enforceMarketingSlaEmailBlock(["email", "in_app"], "marketing_requests", "escalation"), ["in_app"]);

  // The OTHER marketing_requests lifecycle notifications are UNAFFECTED — only the 3 SLA
  // reminder/escalation eventTypes lose email.
  for (const eventType of ["request_submitted", "request_assigned", "request_approved", "request_rejected", "request_returned", "request_completed"]) {
    assert.deepEqual(
      enforceMarketingSlaEmailBlock(["in_app", "email"], "marketing_requests", eventType),
      ["in_app", "email"],
      `${eventType} must keep its email channel`,
    );
  }

  // A DIFFERENT module reusing one of these generic eventType strings must be unaffected —
  // the guard requires BOTH module and eventType to match, unlike the payslip guard's
  // eventType-only match (safe there because "payslip" is a near-unique substring).
  assert.deepEqual(enforceMarketingSlaEmailBlock(["in_app", "email"], "outstation", "escalation"), ["in_app", "email"]);
  assert.deepEqual(enforceMarketingSlaEmailBlock(["in_app", "email"], null, "escalation"), ["in_app", "email"]);

  // Dedupes while preserving order; leaves non-SLA email intact.
  assert.deepEqual(enforceMarketingSlaEmailBlock(["in_app", "in_app", "email"], "marketing_requests", "request_approved"), ["in_app", "email"]);

  // Predicate.
  assert.equal(isMarketingSlaEventType("marketing_requests", "escalation"), true);
  assert.equal(isMarketingSlaEventType("marketing_requests", "due_date_reminder"), true);
  assert.equal(isMarketingSlaEventType("marketing_requests", "overdue_reminder"), true);
  assert.equal(isMarketingSlaEventType("marketing_requests", "request_approved"), false);
  assert.equal(isMarketingSlaEventType("outstation", "escalation"), false);
  assert.equal(isMarketingSlaEventType(null, "escalation"), false);
  assert.equal(isMarketingSlaEventType("marketing_requests", null), false);
}
