import assert from "node:assert/strict";

import {
  brevoProviderEventId,
  parseBrevoWebhookEvent,
  verifyBrevoWebhookAuth,
} from "../src/lib/email/brevo-webhook-events.ts";

export function runBrevoWebhookEventsTests() {
  const secret = "sekret-token-123";
  const base = "https://phoenix-hr.satopharma.com/api/webhooks/brevo";

  // --- Auth (shared secret via query token or header) -----------------------------
  assert.equal(verifyBrevoWebhookAuth({ url: `${base}?token=${secret}`, headers: new Headers(), secret }), true, "query token accepted");
  assert.equal(verifyBrevoWebhookAuth({ url: base, headers: new Headers({ "x-brevo-token": secret }), secret }), true, "header token accepted");
  assert.equal(verifyBrevoWebhookAuth({ url: `${base}?token=wrong`, headers: new Headers(), secret }), false, "wrong token rejected");
  assert.equal(verifyBrevoWebhookAuth({ url: base, headers: new Headers(), secret }), false, "missing token rejected");
  assert.equal(verifyBrevoWebhookAuth({ url: `${base}?token=${secret}`, headers: new Headers(), secret: "" }), false, "empty secret rejects");

  // --- Event → status mapping -----------------------------------------------------
  const statusFor = (event: string) =>
    parseBrevoWebhookEvent({ event, email: "a@b.com", "message-id": "<m1>", date: "2026-07-13T10:00:00Z" }).status;
  assert.equal(statusFor("opened"), "opened");
  assert.equal(statusFor("unique_opened"), "opened");
  assert.equal(statusFor("loadedByProxy"), "opened");
  assert.equal(statusFor("click"), "clicked");
  assert.equal(statusFor("delivered"), "delivered");
  assert.equal(statusFor("hard_bounce"), "bounced");
  assert.equal(statusFor("soft_bounce"), "bounced");
  assert.equal(statusFor("invalid_email"), "bounced");
  assert.equal(statusFor("blocked"), "suppressed");
  assert.equal(statusFor("spam"), "complained");
  assert.equal(statusFor("unsubscribed"), "unsubscribed");
  assert.equal(statusFor("deferred"), "failed");
  assert.equal(statusFor("request"), "sent");
  assert.equal(statusFor("who_knows"), "unknown");

  // --- Field extraction -----------------------------------------------------------
  const row = parseBrevoWebhookEvent({
    event: "click",
    email: "Anwar@Sato.com",
    "message-id": "<abc@brevo>",
    date: "2026-07-13T10:00:00Z",
    subject: "Weekly plan",
    link: "https://phoenix-hr.satopharma.com/plans",
    sender_email: "no-reply@send.satopharma.com",
  });
  assert.equal(row.provider, "brevo");
  assert.equal(row.event_type, "brevo.click");
  assert.equal(row.status, "clicked");
  assert.deepEqual(row.recipients, ["Anwar@Sato.com"]);
  assert.equal(row.subject, "Weekly plan");
  assert.equal(row.sender, "no-reply@send.satopharma.com");
  assert.equal(row.provider_message_id, "<abc@brevo>");
  assert.ok(row.occurred_at.startsWith("2026-07-13T10:00:00"), "occurred_at parsed from date");

  // occurred_at falls back to ts_event (epoch seconds) when no date string is present.
  const epochRow = parseBrevoWebhookEvent({ event: "opened", email: "a@b.com", ts_event: 1768300800 });
  assert.ok(!Number.isNaN(new Date(epochRow.occurred_at).getTime()), "occurred_at parsed from ts_event");

  // --- Dedup id -------------------------------------------------------------------
  assert.equal(brevoProviderEventId({ id: 42, event: "opened" }), "brevo:42", "explicit id preferred");
  const p = { event: "click", "message-id": "<m>", date: "2026-07-13T10:00:00Z", link: "https://a" };
  assert.equal(brevoProviderEventId(p), brevoProviderEventId({ ...p }), "same payload → same id (retry-safe)");
  assert.notEqual(brevoProviderEventId(p), brevoProviderEventId({ ...p, link: "https://b" }), "different clicked link → different id");
  assert.notEqual(brevoProviderEventId(p), brevoProviderEventId({ ...p, event: "opened" }), "different event → different id");
}
