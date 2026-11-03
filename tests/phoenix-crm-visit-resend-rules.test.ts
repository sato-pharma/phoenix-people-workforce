import assert from "node:assert/strict";

import { deviceClockSkewMinutes, NO_FIX_FOR_A_VISIT, parseQueuedSeconds, ROUGH_FIX_FOR_A_VISIT, roughFixForAVisit, UNVALIDATED_CUSTOMER_VISIT_REFUSED, VISIT_AWAY_FROM_PLACE } from "../src/lib/phoenix-crm/entry-rules.ts";
import {
  answerToRefusal,
  heldRefusalSentence,
  isReadyToSend,
  isTooLateToSend,
  loggedAgainStart,
  queuedSecondsAt,
  VISIT_LOG_AGAIN,
  VISIT_REFUSED_TITLE,
  VISIT_REMOVE,
  VISIT_RESEND_MAX_SECONDS,
  VISIT_TOO_LATE_TITLE,
  VISIT_WAITING_LINE,
  VISIT_WAITING_PILL,
  withoutVoiceNote,
} from "../src/lib/phoenix-crm/visit-resend-rules.ts";

/**
 * Phoenix CRM — when a held visit may be sent, and what its answer means (owner, 3 Nov 2026).
 *
 * The rules that decide whether a visit a phone held for want of signal goes by itself or waits for the rep. A
 * wrong answer here is either a visit lost, a false off-plan visit with a manager's notice nobody earned, or a
 * refusal shown about a visit that is safely on file.
 */

const MINUTE = 60_000;
/** 3 Nov 2026 is winter time, so Cairo is two hours ahead and the 02:00 close of the visit day is 00:00 UTC. */
const CLOSE_OF_DAY = Date.parse("2026-11-03T00:00:00.000Z");

function checkTheSentenceOnTheRow(): void {
  for (const untrueHere of [VISIT_AWAY_FROM_PLACE, NO_FIX_FOR_A_VISIT, ROUGH_FIX_FOR_A_VISIT, roughFixForAVisit({ accuracyMeters: 180 } as Parameters<typeof roughFixForAVisit>[0])]) {
    assert.equal(heldRefusalSentence(untrueHere), null, `a resend carries the press's reading, so this is untrue on the row: ${untrueHere}`);
  }
  assert.equal(heldRefusalSentence(UNVALIDATED_CUSTOMER_VISIT_REFUSED), UNVALIDATED_CUSTOMER_VISIT_REFUSED, "a sentence about the rep's own work still shows");
  assert.equal(heldRefusalSentence("This customer has left the list."), "This customer has left the list.");
  assert.equal(heldRefusalSentence(null), null);
  assert.equal(heldRefusalSentence("   "), null);
}

export function runPhoenixCrmVisitResendRulesTests(): void {
  checkTheSentenceOnTheRow();
  checkTheDuration();
  checkTooLate();
  checkReady();
  checkRefusals();
  checkLogAgain();
  checkTheWords();
  checkTheParsedValue();
}

function checkTheDuration(): void {
  const pressedAtMs = 1_000_000;
  assert.equal(queuedSecondsAt({ pressedAtMs }, pressedAtMs + 400), null, "under a second is a save that never waited");
  assert.equal(queuedSecondsAt({ pressedAtMs }, pressedAtMs - MINUTE), null, "a phone clock that ran backwards claims nothing");
  assert.equal(queuedSecondsAt({ pressedAtMs }, pressedAtMs + 5 * MINUTE + 700), 300, "whole seconds");
  assert.equal(
    queuedSecondsAt({ pressedAtMs }, pressedAtMs + 3 * 60 * MINUTE),
    VISIT_RESEND_MAX_SECONDS,
    "bounded, so the server's own limit never refuses a send over a clock jump",
  );
}

function checkTooLate(): void {
  const server = Date.parse("2026-11-03T08:00:00.000Z");
  const phone = 5_000_000_000;
  const held = (minutes: number) => ({ pressedAtMs: phone - minutes * MINUTE });

  assert.equal(isTooLateToSend(held(30), phone, server), false, "half an hour on the same day still sends");
  assert.equal(isTooLateToSend(held(120), phone, server), false, "exactly two hours still sends");
  assert.equal(isTooLateToSend(held(121), phone, server), true, "past two hours he logs it again");

  // The elapsed time is the phone's own: a phone an hour out measures a wait truly.
  assert.equal(isTooLateToSend(held(30), phone, server + 60 * MINUTE), false, "a server an hour from the phone's clock changes nothing");

  // A clock that ran backwards measures nothing, and the safe answer costs one tap and never a false visit.
  assert.equal(isTooLateToSend({ pressedAtMs: phone + MINUTE }, phone, server), true, "a backwards phone clock is too late");

  // The day is the server's.
  const justAfter = CLOSE_OF_DAY + 10 * MINUTE;
  assert.equal(isTooLateToSend(held(30), phone, justAfter), true, "pressed 01:40 Cairo, arriving 02:10: it would land on the wrong day");
  assert.equal(isTooLateToSend(held(5), phone, justAfter), false, "pressed 02:05 Cairo, arriving 02:10: the same visit day");
  assert.equal(isTooLateToSend(held(5), phone, CLOSE_OF_DAY - 10 * MINUTE), false, "pressed 01:45 Cairo, arriving 01:50: the same visit day");

  // How long the send may take counts on the arrival side only.
  assert.equal(isTooLateToSend(held(1), phone, CLOSE_OF_DAY - 20_000, 30_000), true, "leaving at 01:59:40 with 30 seconds to land can arrive after the close");
  assert.equal(isTooLateToSend(held(1), phone, CLOSE_OF_DAY - 60_000, 30_000), false, "leaving at 01:59:00 lands in time");
  assert.equal(isTooLateToSend(held(1), phone, CLOSE_OF_DAY + 120_000, 30_000), false, "pressed after the close and arriving after it: the same visit day");
  assert.equal(isTooLateToSend(held(1), phone, CLOSE_OF_DAY + 50_000, 30_000), true, "pressed ten seconds before the close: the landing time never moves the press");
}

function checkReady(): void {
  const now = 1_000_000;
  assert.equal(isReadyToSend({ status: "waiting", sendingUntilMs: 0 }, now), true);
  assert.equal(isReadyToSend({ status: "waiting", sendingUntilMs: now + 1 }, now), false, "somebody's request is still in flight");
  assert.equal(isReadyToSend({ status: "refused", sendingUntilMs: 0 }, now), false, "a refused visit waits for the rep, never the runner");
  assert.equal(isReadyToSend({ status: "too_late", sendingUntilMs: 0 }, now), false, "so does one past its time");
}

function checkRefusals(): void {
  const typed = { comment: "Saw the doctor", voiceNotePath: "voice/a.webm" };
  const spokenOnly = { comment: "  ", voiceNotePath: "voice/a.webm" };
  const noVoice = { comment: "Saw the doctor" };

  assert.equal(answerToRefusal({ code: "phoenix_crm_outside_area", idIsOnFile: true, body: noVoice }), "settled", "the id on file settles any refusal");
  assert.equal(answerToRefusal({ code: "phoenix_crm_already_visited", idIsOnFile: false, body: noVoice }), "settled", "already visited settles in silence");
  assert.equal(answerToRefusal({ code: "phoenix_crm_voice_expired", idIsOnFile: false, body: typed }), "send_without_voice", "his typed comment stands");
  assert.equal(answerToRefusal({ code: "phoenix_crm_voice_expired", idIsOnFile: false, body: spokenOnly }), "show_refusal", "with no typed comment there is nothing to keep");
  assert.equal(answerToRefusal({ code: "phoenix_crm_voice_expired", idIsOnFile: false, body: noVoice }), "show_refusal", "a voice refusal on a save with no note is a real one");
  assert.equal(answerToRefusal({ code: "phoenix_crm_outside_area", idIsOnFile: false, body: noVoice }), "show_refusal");
  assert.equal(answerToRefusal({ code: null, idIsOnFile: false, body: noVoice }), "show_refusal");

  const stripped = withoutVoiceNote({ id: "visit-1", comment: "Saw the doctor", voiceNotePath: "voice/a.webm", voiceNoteSeconds: 12, voiceNoteBytes: 900 });
  assert.deepEqual(stripped, { id: "visit-1", comment: "Saw the doctor", voiceNotePath: null, voiceNoteSeconds: null, voiceNoteBytes: null }, "only the note comes off");
}

function checkLogAgain(): void {
  assert.equal(loggedAgainStart(null), null, "a fresh visit starts fresh");
  assert.deepEqual(
    loggedAgainStart({ body: { comment: "Saw the doctor", products: ["a", 7, "b"] } }),
    { comment: "Saw the doctor", products: ["a", "b"] },
    "his own words and picks, and nothing that is not one",
  );
  assert.deepEqual(loggedAgainStart({ body: {} }), { comment: "", products: [] }, "an old entry with neither still opens");
}

function checkTheWords(): void {
  const words = [VISIT_WAITING_PILL, VISIT_WAITING_LINE, VISIT_REFUSED_TITLE, VISIT_TOO_LATE_TITLE, VISIT_LOG_AGAIN, VISIT_REMOVE].join(" ").toLowerCase();
  for (const banned of ["check", "distance", "clock", "late", "gps", "location", "flag", "review", "manager"]) {
    assert.equal(words.includes(banned), false, `Golden Rule #1: the rep's words never say "${banned}"`);
  }
}

function checkTheParsedValue(): void {
  assert.equal(parseQueuedSeconds(600), 600);
  assert.equal(parseQueuedSeconds(1), 1);
  assert.equal(parseQueuedSeconds(VISIT_RESEND_MAX_SECONDS), VISIT_RESEND_MAX_SECONDS);
  for (const forged of [0, -5, 7_201, 12.5, "600", null, undefined, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(parseQueuedSeconds(forged), null, `not a duration: ${String(forged)}`);
  }

  const arrival = new Date("2026-11-03T10:30:00.000Z");
  const tapped = "2026-11-03T10:00:00.000Z";
  assert.equal(deviceClockSkewMinutes(tapped, arrival, 1_800), 0, "a phone that merely waited half an hour has a true clock");
  assert.equal(deviceClockSkewMinutes(tapped, arrival), -30, "the same tap with no wait claimed still reads as a gap");
  assert.equal(deviceClockSkewMinutes("2026-11-03T08:00:00.000Z", arrival, 1_800), -120, "a clock truly two hours out still shows");
  assert.equal(deviceClockSkewMinutes(null, arrival, 1_800), null);
}
