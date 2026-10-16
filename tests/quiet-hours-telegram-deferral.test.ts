import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFERRED_TELEGRAM_UNDELIVERABLE_REASON,
  deferredTelegramSkipReason,
  isResendableTelegramPayload,
} from "../src/lib/notifications/system.ts";

/**
 * Quiet hours wrote a Telegram delivery `pending` that nothing would ever send — why this test exists.
 *
 * Inside a recipient's quiet hours, createSystemNotificationForRecipient holds Telegram back by
 * writing a `pending` row whose metadata.telegram the retry worker sends later.
 * buildDeferredTelegramPayload returns null when Telegram is off by governance or preference, or
 * the recipient has no connected chat. The branch still wrote the row `pending`, with no payload,
 * and reported `status: "pending"`.
 *
 * processTelegramDeliveryRetries passes over a row with no chat, title or message WITHOUT closing
 * it, so the row stayed pending for ever and kept a place in the worker's due window on every run.
 * Worse, releaseNoticeReached (the weekly attendance review) counts a Telegram `pending` as the
 * employee having been told — and that starts the answer deadline that ends in a salary deduction.
 * Push in the same branch already skipped its null payload; Telegram now does the same.
 *
 * The headline assertions open the source block: in the quiet-hours branch the skip check runs,
 * and skips, BEFORE the payload is attached and the row falls through to `pending`. Put the old
 * `if (telegramPayload) { … }` back, or drop the skip's `continue`, and one of them fires.
 *
 * The branch half is a source assertion rather than a behavioural one because the function reads
 * and writes through getSupabaseAdmin() with no injectable client, and this suite runs with
 * production credentials — calling it for real would write production rows and could send a real
 * Telegram message. Every slice is taken by MARKER, never by a fixed byte window.
 */

const SYSTEM = "../src/lib/notifications/system.ts";

function read(relative: string) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

function slice(source: string, startMarker: string, endMarker: string, label: string) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${label}: could not find ${JSON.stringify(startMarker)} — it was renamed or removed`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${label}: could not find ${JSON.stringify(endMarker)} after the start marker`);
  return source.slice(start, end);
}

const fullPayload = {
  actionUrl: "/employee-portals/attendance/digests",
  chatId: "123456789",
  emailAttempted: false,
  eventType: "week_released",
  message: "Your attendance week is ready to review.",
  module: "attendance_digest",
  title: "Weekly attendance",
};

export async function runQuietHoursTelegramDeferralTests() {
  // ── The source: the quiet-hours branch skips before it can write `pending` ────────────────
  const source = read(SYSTEM);
  const quietHoursBranch = slice(
    source,
    'if (quietHoursActive && !policy.bypassQuietHours && channel !== "in_app") {',
    'if (channel === "in_app") {',
    "quiet-hours branch",
  );
  const telegramBlock = slice(quietHoursBranch, 'if (channel === "telegram") {', 'if (channel === "push") {', "quiet-hours telegram block");

  const skipCheck = telegramBlock.indexOf("deferredTelegramSkipReason(telegramPayload)");
  const attach = telegramBlock.indexOf("deferredMetadata.telegram = telegramPayload;");
  assert.ok(skipCheck !== -1, "the quiet-hours Telegram block must ask deferredTelegramSkipReason whether its payload can wait");
  assert.ok(attach !== -1, "the quiet-hours Telegram block must still attach a sendable payload for the retry worker");
  const skipPath = telegramBlock.slice(skipCheck, attach);
  assert.match(
    skipPath,
    /status: "skipped"[\s\S]*status: "skipped"[\s\S]*continue;/,
    "a Telegram payload the retry worker cannot send must be written and reported `skipped`, and leave the loop, " +
      "BEFORE the payload is attached — otherwise it falls through to a `pending` row nothing will ever send",
  );
  assert.doesNotMatch(
    telegramBlock,
    /if \(telegramPayload\) \{/,
    "the old `if (telegramPayload) { … }` let a null payload fall through to `pending` — it must not come back",
  );

  // The retry worker and the deferral must judge "sendable" by the SAME rule, or a row the
  // deferral accepts can still be one the worker passes over for ever.
  const telegramWorker = slice(
    source,
    "export async function processTelegramDeliveryRetries",
    "export async function processPushDeliveryRetries",
    "telegram retry worker",
  );
  assert.match(
    telegramWorker,
    /if \(!isResendableTelegramPayload\(telegram\)\) \{/,
    "processTelegramDeliveryRetries must use isResendableTelegramPayload, the rule the quiet-hours deferral checks",
  );

  // ── The rule itself ───────────────────────────────────────────────────────────────────────
  assert.equal(
    deferredTelegramSkipReason(null),
    DEFERRED_TELEGRAM_UNDELIVERABLE_REASON,
    "no payload (Telegram off, or no connected chat) must be skipped with the undeliverable reason",
  );
  assert.equal(
    DEFERRED_TELEGRAM_UNDELIVERABLE_REASON,
    "Telegram is not deliverable for this recipient (disabled or not connected).",
  );
  assert.equal(deferredTelegramSkipReason(fullPayload), null, "a payload with a chat, title and message can wait for the worker");

  for (const missing of ["chatId", "title", "message"] as const) {
    const reason = deferredTelegramSkipReason({ ...fullPayload, [missing]: "" });
    assert.ok(reason, `a payload with an empty ${missing} can never be sent, so it must be skipped, not held pending`);
    assert.equal(isResendableTelegramPayload({ ...fullPayload, [missing]: "" }), false);
  }

  assert.equal(isResendableTelegramPayload(fullPayload), true);
  assert.equal(isResendableTelegramPayload(undefined), false, "a row with no metadata.telegram is not sendable");
  assert.equal(isResendableTelegramPayload(null), false);
  assert.equal(isResendableTelegramPayload({}), false);
}
