import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  TRANSACTIONAL_EMAIL_TYPES,
  isRecipientPreferenceSuppression,
  isTransactionalEmailType,
} from "@/lib/email/transactional-types";

const sendSource = readFileSync(
  new URL("../src/lib/email/send-phoenix-email.ts", import.meta.url),
  "utf8",
);
const notificationEmailSource = readFileSync(
  new URL("../src/lib/notifications/email.ts", import.meta.url),
  "utf8",
);
const unsubscribeRouteSource = readFileSync(
  new URL("../app/api/email/unsubscribe/[token]/route.ts", import.meta.url),
  "utf8",
);

/**
 * One unsubscribe click used to lock an employee out of their own account.
 *
 * The unsubscribe endpoint refused to unsubscribe transactional types, and its landing page
 * promised "You will still receive account and security emails." But unsubscribing from ANY
 * other type wrote a durable row into email_suppressions, and loadSuppressedRecipients()
 * filtered every outgoing address against that table without regard for what was being sent.
 * So a click on a birthday or SLA email permanently blocked that person's password-reset and
 * account-setup links — while the page they clicked told them the opposite.
 *
 * A corporate mail-security link scanner issuing a plain GET was enough to trigger it, since
 * the GET is a state-changing write.
 */
export function runTransactionalEmailNotUnsubscribableTests() {
  // ── The rule, behaviourally ────────────────────────────────────────────────
  for (const type of ["password_reset", "user_created", "password_setup"]) {
    assert.equal(isTransactionalEmailType(type), true, `"${type}" is account recovery and must always be deliverable`);
  }
  assert.equal(isTransactionalEmailType("PASSWORD_RESET"), true, "type matching must be case-insensitive");
  assert.equal(isTransactionalEmailType("  password_reset  "), true, "type matching must tolerate whitespace");

  for (const type of ["birthday", "marketing_sla", "general", "resignation", ""]) {
    assert.equal(isTransactionalEmailType(type), false, `"${type}" is not transactional and stays unsubscribable`);
  }
  assert.equal(isTransactionalEmailType(null), false);
  assert.equal(isTransactionalEmailType(undefined), false);

  // Only a recipient's OWN preference is overridden. Provider signals are not.
  assert.equal(isRecipientPreferenceSuppression("unsubscribe"), true);
  for (const reason of ["hard_bounce", "complaint", "manual", "", null, undefined]) {
    assert.equal(
      isRecipientPreferenceSuppression(reason as string),
      false,
      `"${reason}" is not a recipient preference — it must keep suppressing even transactional mail`,
    );
  }

  // ── The send path must actually apply it ───────────────────────────────────
  assert.match(
    sendSource,
    /\.select\("address,expires_at,reason"\)/,
    "the suppression lookup must read `reason`, or it cannot tell an unsubscribe from a hard bounce",
  );
  assert.match(
    sendSource,
    /if \(transactional && isRecipientPreferenceSuppression\(row\.reason\)\) continue;/,
    "a transactional email must ignore an unsubscribe-reason suppression — otherwise the unsubscribe page's promise is false and people are locked out of password reset",
  );
  assert.match(
    sendSource,
    /loadSuppressedRecipients\(allCandidates, \{ notificationType: input\.notificationType \}\)/,
    "the send path must pass the notification type through, or every email looks the same to the suppression filter",
  );

  // The notification layer has the type and must forward it.
  assert.match(
    notificationEmailSource,
    /notificationType: input\.notificationType,/,
    "notifications/email.ts must forward notificationType to sendPhoenixEmail",
  );

  // ── Hard bounces and complaints must STILL suppress everything ─────────────
  // This is the assertion that stops the fix becoming a deliverability leak.
  assert.doesNotMatch(
    sendSource,
    /if \(transactional\) continue;/,
    "transactional mail must not bypass ALL suppressions — a hard bounce or complaint still has to hold, or we keep mailing dead addresses and burn sending reputation",
  );

  // ── The two lists must be one list ─────────────────────────────────────────
  assert.match(
    unsubscribeRouteSource,
    /const nonUnsubscribableTypes = TRANSACTIONAL_EMAIL_TYPES;/,
    "the unsubscribe route must use the SHARED transactional list — two copies of a security-relevant set drift apart, and half a promise is what caused this",
  );
  assert.equal(TRANSACTIONAL_EMAIL_TYPES.size, 3, "transactional set is password_reset, user_created, password_setup");
}
