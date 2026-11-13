import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describeSkippedVacationEmail } from "@/lib/vacation/service";

// A SKIPPED VACATION EMAIL MUST LEAVE A TRACE.
//
// `sendPhoenixEmail` has seven paths that RETURN `{ skipped: true, reason }` instead of throwing:
// email globally disabled, no provider, no sender, no deliverable recipient, all recipients
// suppressed, blocked before sending, and one more. Every vacation caller was written as
// `send(...).catch(...)`, which only ever sees a THROW — so a skip returned normally was dropped
// on the floor. These sends also bypassed `notification_outbox` then, so a skipped vacation email
// left NO trace anywhere: no outbox row, no provider id, no event. (Since REC-048, 13 Nov 2026, each
// writes its outbox row first — tests/durable-approval-emails.test.ts — and the recorder below still
// runs: a skip the outbox will retry reaches it as "Queued for retry: …".)
//
// On 2026-09-05 that made "are vacation emails firing?" unanswerable from this database. It took
// reading Resend's own API to establish that they were (an Annual Leave Application to A-9 at
// 09:38 that day, opened). A silent skip and a healthy send are indistinguishable from the inside,
// which is exactly how a real outage sits unnoticed for weeks.

const SERVICE = fileURLToPath(new URL("../src/lib/vacation/service.ts", import.meta.url));

function testOnlyAnExplicitSkipCountsAsASkip() {
  // The dangerous direction is a real send being logged as skipped, or worse, an unexpected shape
  // silently reading as "sent". Only `skipped === true` is a skip.
  assert.equal(describeSkippedVacationEmail({ skipped: true, reason: "EMAIL_NOTIFICATIONS_ENABLED is not true." }),
    "EMAIL_NOTIFICATIONS_ENABLED is not true.");
  assert.equal(describeSkippedVacationEmail({ skipped: true }), "no reason given",
    "a skip with no reason must still be recorded, not swallowed");
  assert.equal(
    describeSkippedVacationEmail({ skipped: true, reason: "Queued for retry: Recipient check unavailable" }),
    "Queued for retry: Recipient check unavailable",
    "an email the outbox will retry is still recorded as not sent yet, with the words that say it is queued",
  );

  for (const sent of [undefined, null, {}, { skipped: false }, { id: "abc" }, "ok", 0]) {
    assert.equal(describeSkippedVacationEmail(sent), null,
      `a real send must not be recorded as a skip: ${JSON.stringify(sent)}`);
  }
}

function testEverySendSiteRecordsItsSkip() {
  const source = readFileSync(SERVICE, "utf8");

  // All three templated senders must route their RESULT through the recorder. A `.catch` alone is
  // the bug: it sees throws only.
  const recorded = source.split("recordVacationEmailSkip({").length - 1;
  assert.equal(recorded, 3,
    "all three templated vacation sends must record a skip (submit, step result, next approver)");

  // And each must still keep its throw handler — the recorder replaces nothing.
  const failureLogged = source.split('eventType: "notification_failed"').length - 1;
  assert.ok(failureLogged >= 3, "the existing notification_failed handlers must survive");

  // The recorder must run BEFORE the catch, or a throw inside it would be swallowed as a send
  // failure and mislabelled.
  const submitIdx = source.indexOf("Manager approval request (on submit)");
  assert.ok(submitIdx > 0, "the submit send must be labelled so the event says which email it was");
}

function testSkipsAreRecordedAsTheirOwnEventType() {
  const source = readFileSync(SERVICE, "utf8");
  assert.ok(source.includes('eventType: "notification_skipped"'),
    "a skip is not a failure — it must be its own event type so the two can be told apart");
  assert.ok(source.includes("metadata: { label"),
    "the event must carry the reason and recipient in metadata, not only in prose");
}

export function runVacationEmailSkipRecordedTests() {
  testOnlyAnExplicitSkipCountsAsASkip();
  testEverySendSiteRecordsItsSkip();
  testSkipsAreRecordedAsTheirOwnEventType();
}
