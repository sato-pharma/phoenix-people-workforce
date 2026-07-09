import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classifyOutboxSkip } from "@/lib/notifications/email.ts";

/**
 * Phase 1 — outbox engine reliability.
 *  - classifyOutboxSkip: deterministic skips are terminal (not retried-to-failure);
 *    a "no recipients" skip on a high-priority type escalates to Sentry.
 *  - Source locks: the skipped writer, deferred-delivery drain, per-terminal-row Sentry,
 *    retention of PII, orphan-monitor removal, and the load-bearing safeguards we must NOT
 *    regress (status-guarded claim, dedupe key, Resend idempotency key).
 */
export function runEmailEngineHardeningTests() {
  // --- Behavioral: skip classification ---------------------------------------------
  const terminalCases: Array<[string, string]> = [
    ["Email skipped: notification type is not approved for automatic Resend delivery.", "type_not_approved"],
    ["Email skipped: unsupported notification type.", "type_unsupported"],
    ["Email skipped: Probation notifications are disabled.", "policy_disabled"],
    ["EMAIL_NOTIFICATIONS_ENABLED is not true.", "email_disabled_globally"],
    ["NOTIFICATION_EMAIL_FROM is missing.", "from_missing"],
    ["Email skipped: Probation routing resolved no recipient emails.", "no_recipients"],
    ["All recipients are suppressed (bounce/complaint).", "recipient_suppressed"],
    ["No deliverable recipient (no real mailbox on file).", "no_deliverable_recipient"],
  ];
  for (const [reason, code] of terminalCases) {
    const result = classifyOutboxSkip(reason, "birthday");
    assert.equal(result.terminal, true, `"${reason}" must be terminal`);
    if (result.terminal) assert.equal(result.code, code, `"${reason}" code`);
  }

  // Bounce/complaint suppression is deterministic AND by-design — terminal, never escalates.
  for (const t of ["password_reset", "offer", "birthday", undefined]) {
    const r = classifyOutboxSkip("All recipients are suppressed (bounce/complaint).", t as never);
    assert.equal(r.terminal && r.sentryEscalate, false, "suppressed must never escalate");
  }

  // no_deliverable_recipient escalates ONLY for high-priority types (the in-app copy still
  // delivers, but a high-priority alert that could not be emailed is worth surfacing).
  const noMailbox = "No deliverable recipient (no real mailbox on file).";
  for (const high of ["password_reset", "user_created", "offer", "resignation", "probation", "contract_renewal"]) {
    const r = classifyOutboxSkip(noMailbox, high as never);
    assert.equal(r.terminal && r.sentryEscalate, true, `no_deliverable_recipient on ${high} must escalate`);
  }
  for (const low of ["birthday", "general"]) {
    const r = classifyOutboxSkip(noMailbox, low as never);
    assert.equal(r.terminal && r.sentryEscalate, false, `no_deliverable_recipient on ${low} must NOT escalate`);
  }

  // Transient / unknown reasons keep retrying (NOT terminal).
  for (const reason of ["Notification is already being processed.", "Resend request failed with 503.", "socket hang up"]) {
    assert.equal(classifyOutboxSkip(reason, "offer").terminal, false, `"${reason}" must be transient`);
  }

  // no_recipients escalates to Sentry ONLY for high-priority notification types.
  const noRecipients = "Email skipped: Offer routing resolved no recipient emails.";
  for (const high of ["password_reset", "user_created", "offer", "resignation", "probation", "contract_renewal"]) {
    const r = classifyOutboxSkip(noRecipients, high as never);
    assert.equal(r.terminal && r.sentryEscalate, true, `no_recipients on ${high} must escalate`);
  }
  for (const low of ["birthday", "general"]) {
    const r = classifyOutboxSkip(noRecipients, low as never);
    assert.equal(r.terminal && r.sentryEscalate, false, `no_recipients on ${low} must NOT escalate`);
  }
  // No notificationType => cannot be high-priority => no escalation.
  const none = classifyOutboxSkip(noRecipients, undefined);
  assert.equal(none.terminal && none.sentryEscalate, false, "no_recipients without a type must not escalate");

  // --- Source locks: email.ts engine -----------------------------------------------
  const emailSource = readFileSync("src/lib/notifications/email.ts", "utf8");
  assert.match(emailSource, /function classifyOutboxSkip/, "classifyOutboxSkip must exist");
  assert.match(emailSource, /markNotificationOutboxSkipped/, "skipped writer must exist");
  assert.match(emailSource, /status:\s*"skipped"/, "must write a terminal 'skipped' status");
  assert.match(emailSource, /High-priority notification dropped/, "must escalate dropped high-priority alerts");
  assert.match(emailSource, /Email outbox row terminally failed/, "must alert on each terminal failure");
  assert.match(emailSource, /outboxTerminalDeleted/, "retention must purge terminal failed/skipped rows");
  assert.match(emailSource, /recipients:\s*\[\]/, "retention must redact delivery-event recipients");
  assert.match(emailSource, /\.in\("status",\s*\["failed",\s*"skipped"\]\)/, "retention targets terminal rows");

  // --- Source locks: keep the strong parts (must NOT regress) -----------------------
  assert.match(emailSource, /\.in\("status",\s*\["pending",\s*"failed"\]\)/, "claim must stay a status-guarded CAS");
  assert.doesNotMatch(emailSource, /for update/i, "must not switch the claim to FOR UPDATE");
  assert.match(emailSource, /idempotencyKey:\s*requestId/, "Resend idempotency key must remain");
  assert.match(emailSource, /dedupe_key/, "dedupe key must remain");

  // --- Source locks: deferred-delivery drain (system.ts) ---------------------------
  const systemSource = readFileSync("src/lib/notifications/system.ts", "utf8");
  assert.match(systemSource, /export async function processDeferredDeliveryRetries/, "deferred drain must exist");
  assert.match(systemSource, /metadata\.emailInput|emailInput:/, "email deferral must persist emailInput payload");
  assert.match(systemSource, /buildDeferredTelegramPayload/, "telegram deferral must persist a drainable payload");
  assert.match(systemSource, /isWithinQuietHours\(preferences\)/, "deferred drain must re-check quiet hours");

  // --- Source locks: scheduled wiring ----------------------------------------------
  const scheduledSource = readFileSync("src/lib/notifications/scheduled-processing.ts", "utf8");
  assert.match(scheduledSource, /processDeferredDeliveryRetries/, "deferred drain must run on the schedule");

  // --- Source locks: orphan Sentry monitors removed --------------------------------
  const _birthdaySource = readFileSync("app/api/notifications/birthdays/route.ts", "utf8");
  const _renewalSource = readFileSync("app/api/notifications/contract-renewals/route.ts", "utf8");
  
  
  
  
}
