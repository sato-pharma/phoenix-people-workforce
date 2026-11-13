import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildPunchFeedStalledMessage, PUNCH_FEED_STALLED_TITLE } from "../src/lib/attendance/punch-feed-stalled-message.ts";
import { operatorWatchBlocksTelegramFallback } from "../src/lib/notifications/operator-watch-channel-guard.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE PUNCH-FEED ALARM ALSO REACHES TELEGRAM (integration audit, 13 Nov 2026, finding ISS-034).
//
// A working day with no fingerprint punch stored was already noticed, and told in-app and by push,
// which only someone with Phoenix open reads. Every other operator alarm also reaches Telegram.
//
// Imports the pure wording and reads the sender as text. It never reaches createSystemNotification,
// so this suite sends nothing.
// ─────────────────────────────────────────────────────────────────────────────

const read = (path: string) => stripComments(readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n"));

/** What is wrong with the alarm's wiring, or nothing. Exported so the pin can be handed a broken copy. */
export function punchFeedTelegramWiringProblems(alarm: string, sender: string): string[] {
  const problems: string[] = [];
  const toggle = alarm.indexOf('resolveNotificationRoleEnabled("attendance_ingestion_alert")');
  const healthy = alarm.indexOf('if (health.status === "healthy")');
  const send = alarm.indexOf("sendPunchFeedStalledTelegram({");
  if (send < 0) problems.push("the alarm never sends its Telegram half");
  if (send >= 0 && (toggle < 0 || toggle > send)) problems.push("the Telegram half is sent before the admin toggle is read, so a switched-off alarm would still message");
  if (send >= 0 && (healthy < 0 || healthy > send)) problems.push("the Telegram half is sent before the feed is judged, so a healthy feed would message");
  if (!sender.includes('channels: ["telegram"]')) problems.push("the sender does not ask for Telegram alone");
  if (/"email"/.test(sender)) problems.push("the sender names email");
  if (!/\bmodule: "system"/.test(sender)) problems.push('the sender is not on module "system", the only module Telegram is switched on for');
  if (!sender.includes('AUDIENCE_KEY = "attendance_ingestion_alert"')) problems.push("the sender does not use the alarm's own audience, so the toggle and the recipients would part");
  if (!sender.includes("`attendance-punch-feed-stalled:${input.dayIso}:${recipient.hrId}`")) {
    problems.push("the message is not keyed once per person per Cairo day, so the five-minute pass would repeat it");
  }
  return problems;
}

export function runPunchFeedStalledTelegramTests() {
  // ── The words he is sent ────────────────────────────────────────────────────────────────────
  const oneDay = buildPunchFeedStalledMessage({ lastIngestedAt: "2026-11-11T13:42:10.000Z", missedWorkingDays: 1 });
  assert.match(oneDay, /^No fingerprint punch has reached Phoenix for 1 working day\.$/m, "one day is singular");
  assert.match(oneDay, /The last one arrived on 11 Nov 2026 15:42:10 Cairo\./, "the last punch is given in Cairo time, never UTC");
  assert.match(oneDay, /office network/, "and it says what has to be true for the feed to come back");

  const threeDays = buildPunchFeedStalledMessage({ lastIngestedAt: "2026-11-08T08:00:00.000Z", missedWorkingDays: 3 });
  assert.match(threeDays, /for 3 working days\./, "several days are counted");

  for (const never of [
    buildPunchFeedStalledMessage({ lastIngestedAt: null, missedWorkingDays: 99 }),
    buildPunchFeedStalledMessage({ lastIngestedAt: null, missedWorkingDays: 2 }),
  ]) {
    assert.match(never, /^No fingerprint punch has ever reached Phoenix\.$/m, "no punch at all is said as that");
    assert.doesNotMatch(never, /99|The last one arrived/, "never as 99 days, and never with a last-arrival line it cannot fill");
  }
  for (const message of [oneDay, threeDays]) {
    assert.doesNotMatch(message, /\b[A-Z]-\d+\b|attendance_|ingestion/i, "no HR id, event name or internal word reaches him");
  }
  assert.equal(PUNCH_FEED_STALLED_TITLE, "Fingerprint punches have stopped arriving");

  // ── A failed Telegram send never becomes an email ───────────────────────────────────────────
  assert.equal(operatorWatchBlocksTelegramFallback("attendance_punch_feed_stalled"), true, "the alarm's in-app half was written as never email; the Telegram half holds the same rule");

  // ── The wiring ──────────────────────────────────────────────────────────────────────────────
  const alarm = read("../src/lib/attendance/ingestion-health.ts");
  const sender = read("../src/lib/attendance/punch-feed-stalled-telegram.ts");
  assert.deepEqual(punchFeedTelegramWiringProblems(alarm, sender), []);
  assert.ok(sender.includes('EVENT_TYPE = "attendance_punch_feed_stalled"'), "the event name the guard lists is the one the sender uses");
  assert.ok(alarm.includes('channels: ["in_app", "push"]'), "the in-app and push notice keeps its own channel list");

  // The pin must fire on a broken copy, or it proves nothing.
  const unsent = alarm.replace("sendPunchFeedStalledTelegram({", "skipTheTelegramHalf({");
  assert.ok(punchFeedTelegramWiringProblems(unsent, sender).some((problem) => problem.includes("never sends")), "an alarm with no Telegram half is caught");
  const beforeToggle = alarm.replace('resolveNotificationRoleEnabled("attendance_ingestion_alert")', "alwaysOn()");
  assert.ok(punchFeedTelegramWiringProblems(beforeToggle, sender).some((problem) => problem.includes("admin toggle")), "an alarm that ignores the admin toggle is caught");
  const withEmail = sender.replace('channels: ["telegram"]', 'channels: ["telegram", "email"]');
  assert.ok(punchFeedTelegramWiringProblems(alarm, withEmail).some((problem) => problem.includes("email")), "a sender that adds email is caught");
  const wrongModule = sender.replace('module: "system"', 'module: "attendance"');
  assert.ok(punchFeedTelegramWiringProblems(alarm, wrongModule).some((problem) => problem.includes('module "system"')), "a sender on a module Telegram is off for is caught");
  const everyRun = sender.replace("${input.dayIso}:", "");
  assert.ok(punchFeedTelegramWiringProblems(alarm, everyRun).some((problem) => problem.includes("once per person per Cairo day")), "a key without the day is caught");
}
