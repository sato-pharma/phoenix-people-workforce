import assert from "node:assert/strict";

import {
  expandComposerSend,
  firstRecipient,
  foldDeliveryEvent,
  matchesEmailActivityFilters,
  providerFor,
  type EmailActivityRow,
} from "../src/lib/email/engagement.ts";

export function runEmailActivityTests() {
  // Provider is inferred from the outbox provider_message_id: Brevo sends via its mailin relay.
  assert.equal(providerFor("<202607131830.88506535223@smtp-relay.mailin.fr>"), "brevo");
  assert.equal(providerFor("0be6ad55-d5b8-4a5e-a8f0-e70ef9b6004c"), "resend");
  assert.equal(providerFor("f216c0c1-cc9c-42fc-ae15-cb215c2b3aa0"), "resend");
  assert.equal(providerFor(null), "unknown");
  assert.equal(providerFor(""), "unknown");

  // Recipient comes from the payload; falls back to recipientHrId then a "(routed)" placeholder.
  assert.equal(firstRecipient({ recipients: ["anwar.gaweesh@satopharma.com"] }), "anwar.gaweesh@satopharma.com");
  assert.equal(firstRecipient({ recipients: ["a@b.com", "c@d.com"] }), "a@b.com");
  assert.equal(firstRecipient({ recipients: [], recipientHrId: "B-10" }), "B-10");
  assert.equal(firstRecipient({ recipientHrId: "AA" }), "AA");
  assert.equal(firstRecipient({}), "(routed)");
  assert.equal(firstRecipient(null), "(routed)");

  // --- Composer sends --------------------------------------------------------------------------------
  // The Sato Email composer never writes notification_outbox, so Email Activity reads sato_email_sends
  // too: one row per send, recipients flat, one outcome per batch. Batches are consecutive slices of
  // that list, so each person gets their OWN batch's message id — taken in batchIndex order, whatever
  // order the outcomes were stored in.
  const b1 = "<202609142008.31572445861@smtp-relay.mailin.fr>";
  const b2 = "<202609142008.70473695409@smtp-relay.mailin.fr>";
  const people = expandComposerSend({
    created_at: "2026-09-14T20:08:28.348Z",
    id: "send-1",
    outcomes: [
      { batchIndex: 1, id: b2, reason: null, recipients: 2, status: "sent" },
      { batchIndex: 0, id: b1, reason: null, recipients: 3, status: "sent" },
    ],
    recipient_emails: ["a@satopharma.com", "b@satopharma.com", "c@satopharma.com", "d@satopharma.com", "e@satopharma.com"],
    subject: "Future Talents 2026 | Closing Session Invitation",
  });
  assert.equal(people.length, 5, "every recipient of a composer send becomes a row");
  assert.deepEqual(people.map((person) => person.messageId), [b1, b1, b1, b2, b2], "each person carries their own batch's message");
  assert.deepEqual(people.map((person) => person.recipientEmail), ["a@satopharma.com", "b@satopharma.com", "c@satopharma.com", "d@satopharma.com", "e@satopharma.com"]);
  assert.equal(new Set(people.map((person) => person.id)).size, 5, "row ids are unique within a send");
  assert.ok(people.every((person) => person.sendStatus === "sent" && person.failedReason === null));
  assert.equal(providerFor(people[0].messageId), "brevo");

  // A skipped batch keeps its reason; anyone no outcome accounts for is still shown, never dropped.
  const partial = expandComposerSend({
    created_at: "2026-09-14T20:00:00.000Z",
    id: "send-2",
    outcomes: [{ batchIndex: 0, id: null, reason: "Blocked before sending — test", recipients: 1, status: "skipped" }],
    recipient_emails: ["x@satopharma.com", "y@satopharma.com"],
    subject: "s",
  });
  assert.equal(partial.length, 2, "an unaccounted recipient is not dropped");
  assert.equal(partial[0].failedReason, "Blocked before sending — test");
  assert.equal(partial[0].sendStatus, "skipped");
  assert.equal(partial[1].messageId, null);
  assert.equal(partial[1].sendStatus, "unknown");

  // Events fold into one aggregate; the latest timestamp wins.
  const agg = { bounced: false, clicked: false, delivered: false, lastActivityAt: null, opened: false };
  foldDeliveryEvent(agg, { occurred_at: "2026-09-14T20:08:33.000Z", status: "delivered" });
  foldDeliveryEvent(agg, { occurred_at: "2026-09-14T20:30:00.000Z", status: "opened" });
  foldDeliveryEvent(agg, { occurred_at: "2026-09-14T20:10:00.000Z", status: "bounced" });
  assert.deepEqual(agg, { bounced: true, clicked: false, delivered: true, lastActivityAt: "2026-09-14T20:30:00.000Z", opened: true });

  // Filters read the finished row, so composer and outbox rows are filtered identically.
  const row: EmailActivityRow = {
    bounced: false,
    clicked: false,
    delivered: true,
    failedReason: null,
    id: "send-1:a@satopharma.com",
    lastActivityAt: null,
    opened: true,
    provider: "brevo",
    recipientEmail: "a@satopharma.com",
    recipientName: "Anwar Gaweesh",
    sendStatus: "sent",
    sentAt: "2026-09-14T20:08:28.348Z",
    subject: "Future Talents 2026 | Closing Session Invitation",
  };
  assert.equal(matchesEmailActivityFilters(row, { provider: "brevo" }), true);
  assert.equal(matchesEmailActivityFilters(row, { provider: "resend" }), false);
  assert.equal(matchesEmailActivityFilters(row, { activity: "opened" }), true);
  assert.equal(matchesEmailActivityFilters(row, { activity: "clicked" }), false);
  assert.equal(matchesEmailActivityFilters(row, { activity: "not_sent" }), false);
  assert.equal(matchesEmailActivityFilters(row, { search: "closing session" }), true);
  assert.equal(matchesEmailActivityFilters(row, { search: "GAWEESH" }), true);
  assert.equal(matchesEmailActivityFilters(row, { search: "nobody" }), false);
}
