import assert from "node:assert/strict";

import { firstRecipient, providerFor } from "../src/lib/email/engagement.ts";

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
}
