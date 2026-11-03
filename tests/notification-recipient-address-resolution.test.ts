import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * P0 regression coverage: an automated email must never substitute the shared HR inbox for a
 * recipient whose address failed to resolve.
 *
 * Production incident (verified 2026-08-08 against ozucdzovmcqvepbozvqf): 67 notifications went
 * out with the intended person absent from To, CC and BCC — To was phoenix@satopharma.com, the
 * shared inbox — and every one was recorded `sent`. Two independent masking paths caused it:
 *
 *   1. buildChannelEmailInput emitted an empty `recipients` when the recipient had no
 *      work_email. resolveNotificationDelivery could not tell that from "policy-routed", so it
 *      fell through to the stored policy — whose "general" entry is recipient_modes
 *      ["hr_notifications"] — and mailed the inbox. PHX-1, a Super Admin account with no
 *      work_email at all, silently redirected 43 direct-order/weekly-plan emails this way.
 *   2. include_hr_inbox = true (contract_renewal, leave, resignation, probation) let the inbox
 *      alone satisfy the non-empty check when the manager chain resolved nobody.
 *
 * The trigger that made it acute was a THIRD defect: PR #1872 selected `employees.name_en`, a
 * column that does not exist, and the lookup ignored PostgREST's `error`, so work_email became
 * null for every recipient for ~13h with no log line anywhere.
 *
 * resolveNotificationDelivery is DB-bound (it loads the stored policy first), so the guards are
 * pinned by source assertions — including their ORDER, which is the part that carries the
 * meaning: a guard that runs after the recipient lists are merged cannot prevent the fallback.
 */
export function runNotificationRecipientAddressResolutionTests() {
  const emailSource = readFileSync("src/lib/notifications/email.ts", "utf8");
  const systemSource = readFileSync("src/lib/notifications/system.ts", "utf8");

  // ── The signal itself ──────────────────────────────────────────────────────────────────────
  assert.match(
    emailSource,
    /recipientAddressUnresolved\?: boolean;/,
    "NotificationEmailInput must carry an explicit unresolved-address flag; an empty `recipients` is ambiguous with legitimate policy routing",
  );
  assert.match(
    systemSource,
    /recipientAddressUnresolved:\s*\n?\s*!\(input\.email\?\.recipients && input\.email\.recipients\.length > 0\) && !recipient\.email,/,
    "buildChannelEmailInput must set the flag whenever the one targeted person has no deliverable address",
  );

  // ── GUARD 1: a named person with no address is a failure, not an inbox fallback ────────────
  const guard1 = emailSource.indexOf(
    "if (input.recipientAddressUnresolved && !hasExplicitRecipients && personRecipients.length === 0) {",
  );
  assert.notEqual(
    guard1,
    -1,
    "resolveNotificationDelivery must skip when the intended recipient has no address AND no policy mode resolved anyone else",
  );
  assert.match(
    emailSource,
    /notification_email_recipient_address_missing/,
    "a missing recipient address must be logged as an error, not swallowed — silence is what hid this for two weeks",
  );
  // The auth emails (password setup/reset, user_created) pass candidateEmail and leave
  // `recipients` empty, so they reach GUARD 1 with the flag set — and a brand-new account has no
  // work_email yet. Without the personRecipients term the guard would block exactly the welcome
  // and password-reset mail it is meant to protect, so that term must never be "simplified" away.
  const personRecipientsResolved = emailSource.indexOf("const personRecipients = cleanEmailList(");
  assert.notEqual(personRecipientsResolved, -1, "person-mode recipients must be resolved into their own list");
  assert.ok(
    personRecipientsResolved < guard1,
    "GUARD 1 must run AFTER recipients are resolved, so candidate-mode auth emails (password setup/reset) still send",
  );

  // ── GUARD 2: the HR inbox must not rescue an empty person-mode resolution ──────────────────
  assert.match(
    emailSource,
    /const personModes = requestedModes\.filter\(\(mode\) => mode !== "hr_notifications"\);/,
    "person-resolving modes must be tracked separately from the shared-inbox mode",
  );
  const guard2 = emailSource.indexOf(
    "if (!hasExplicitRecipients && personModes.length > 0 && personRecipients.length === 0) {",
  );
  assert.notEqual(guard2, -1, "resolveNotificationDelivery must skip when every person-resolving mode resolves nobody");
  assert.match(
    emailSource,
    /notification_email_policy_recipients_missing/,
    "a policy that resolves no real people must be logged as an error",
  );

  // ── Order is the invariant: both guards must precede the merge that adds the inbox ─────────
  const hrInboxMerge = emailSource.indexOf("const hrRecipients = policy.includeHrInbox ? recipientsFromEnv() : [];");
  const rawCombined = emailSource.indexOf("const rawCombined = hasExplicitRecipients");
  assert.notEqual(hrInboxMerge, -1, "the HR inbox merge must still exist for genuinely inbox-routed mail");
  assert.notEqual(rawCombined, -1, "the recipient merge must still exist");
  assert.ok(
    guard1 < rawCombined,
    "GUARD 1 must run before recipients are merged, or the inbox can still stand in for the missing person",
  );
  assert.ok(
    hrInboxMerge < guard1,
    "the inbox list is resolved first but must not be consulted by the guards — only by the merge below them",
  );
  assert.ok(
    guard2 < rawCombined,
    "GUARD 2 must run before recipients are merged, or the inbox still makes the list non-empty and the send proceeds",
  );

  // ── The trigger: the employees lookup must fail loudly ─────────────────────────────────────
  assert.match(
    systemSource,
    /const \{ data: employee, error: employeeQueryError \} = await supabase/,
    "loadRecipientProfile must destructure the PostgREST error; ignoring it turned a bad column into a silent null work_email",
  );
  assert.match(
    systemSource,
    /if \(employeeQueryError\) throw employeeQueryError;/,
    "a failed employees lookup must throw into the existing catch, not degrade every recipient to no-address",
  );
  // Scoped to the select itself, not any mention: the comment above the query names the phantom
  // column deliberately, and a bare /name_en/ would match that and fail on its own documentation.
  assert.doesNotMatch(
    systemSource,
    /\.select\("[^"]*name_en/,
    "employees has no name_en column (verified in production) — selecting it nulls work_email for every recipient",
  );
  assert.match(
    systemSource,
    /\.select\("work_email, name:full_name, nickname"\)/,
    "the recipient lookup must select full_name, the column that actually exists, and nickname, so the greeting reads the display name",
  );
  assert.match(
    systemSource,
    /name: employeeName \?\? row\?\.name \?\? null,/,
    "the employee's display name outranks the login's copy, which still holds the full name until that person's record is next saved",
  );
}
