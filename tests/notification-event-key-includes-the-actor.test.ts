import assert from "node:assert/strict";

import {
  systemNotificationEventKeyForTest,
  type CreateSystemNotificationInput,
} from "../src/lib/notifications/system.ts";

// `notification_events` is upserted `onConflict: "event_key"`, so two notices that hash to one key
// are ONE row and the second write overwrites the first. Before 2026-10-23 the hash left the ACTOR
// out, so two different senders raising the same templated notice for the same recipient collided:
// the recipient was left with one notification where two people had acted, and the survivor was
// whichever was written last. The sender's name normally lives in the message, not the title, so
// nothing else in the hash told them apart.

const base: CreateSystemNotificationInput = {
  actionUrl: "/admin/deductions/42",
  eventType: "deduction_comment_added",
  message: "A new comment was added.",
  module: "payroll",
  recipientHrId: "B-158",
  title: "New comment on your deduction",
};

export function runNotificationEventKeyIncludesTheActorTests() {
  const fromFirstSender = systemNotificationEventKeyForTest({ ...base, actorId: "B-10" });
  const fromSecondSender = systemNotificationEventKeyForTest({ ...base, actorId: "B-1" });

  assert.notEqual(
    fromFirstSender,
    fromSecondSender,
    "two senders raising the same notice for one recipient must not share an event key — the upsert makes the second overwrite the first",
  );

  // Dedup is the whole point of the key, so the SAME sender repeating itself must still collapse.
  assert.equal(
    systemNotificationEventKeyForTest({ ...base, actorId: "B-10" }),
    fromFirstSender,
    "the same sender, same notice, same recipient is one event — the key must be stable so a retry updates rather than duplicates",
  );

  // `cleanText` folds both empties to "", so a caller that omits the actor and one that passes null
  // must not drift apart into two rows.
  assert.equal(
    systemNotificationEventKeyForTest({ ...base, actorId: null }),
    systemNotificationEventKeyForTest(base),
    "a null actor and an absent actor are the same absence and must key identically",
  );

  // A notice with no actor must still differ from one with an actor, or the system-raised copy and
  // a person's copy would land on one row.
  assert.notEqual(
    systemNotificationEventKeyForTest(base),
    fromFirstSender,
    "a system-raised notice with no actor must not share a key with the same notice raised by a person",
  );

  // An explicit idempotencyKey is the caller's own identity for the event and still wins outright.
  const explicit = { ...base, metadata: { idempotencyKey: "deduction:42:comment" } };
  assert.equal(
    systemNotificationEventKeyForTest({ ...explicit, actorId: "B-10" }),
    "deduction:42:comment",
    "a caller-supplied idempotencyKey is the event key verbatim — the actor never rewrites it",
  );
  assert.equal(
    systemNotificationEventKeyForTest({ ...explicit, actorId: "B-10" }),
    systemNotificationEventKeyForTest({ ...explicit, actorId: "B-1" }),
    "two senders sharing an explicit idempotencyKey are deliberately one event — that is the caller's call, not this hash's",
  );
}
