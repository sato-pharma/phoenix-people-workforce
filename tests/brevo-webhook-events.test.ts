import assert from "node:assert/strict";

import {
  brevoProviderEventId,
  parseBrevoWebhookEvent,
  verifyBrevoWebhookAuth,
} from "../src/lib/email/brevo-webhook-events.ts";

export function runBrevoWebhookEventsTests() {
  const secret = "sekret-token-123";
  const base = "https://phoenix-hr.satopharma.com/api/webhooks/brevo";

  // --- Auth (shared secret in the Authorization: Bearer header ONLY) -----------------
  // Audit point 20 (owner-approved 2026-10-26) changed this contract on purpose: `?token=` and
  // `x-brevo-token` used to be ACCEPTED and are now refused. The full proof, the route included, is
  // tests/brevo-webhook-bearer-auth.test.ts.
  const bearer = (value: string) => new Headers({ authorization: `Bearer ${value}` });
  assert.equal(verifyBrevoWebhookAuth({ url: base, headers: bearer(secret), secret }), true, "Bearer token accepted");
  assert.equal(verifyBrevoWebhookAuth({ url: `${base}?token=${secret}`, headers: new Headers(), secret }), false, "query token refused");
  assert.equal(verifyBrevoWebhookAuth({ url: base, headers: new Headers({ "x-brevo-token": secret }), secret }), false, "x-brevo-token header refused");
  assert.equal(verifyBrevoWebhookAuth({ url: base, headers: bearer("wrong"), secret }), false, "wrong token rejected");
  assert.equal(verifyBrevoWebhookAuth({ url: base, headers: new Headers(), secret }), false, "missing token rejected");
  assert.equal(verifyBrevoWebhookAuth({ url: base, headers: bearer(secret), secret: "" }), false, "empty secret rejects");

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

  // occurred_at prefers the UTC epoch (ts_event) — exact, not skewed.
  const epochRow = parseBrevoWebhookEvent({ event: "opened", email: "a@b.com", ts_event: 1768300800, date: "2026-01-13 12:00:00" });
  assert.equal(epochRow.occurred_at, new Date(1768300800 * 1000).toISOString(), "occurred_at uses ts_event epoch (UTC), not the naive date");

  // A naive local `date` string (no offset) and no epoch must NOT be trusted as UTC (that skewed
  // Brevo times by the account's TZ). It falls back to receive time, so it never equals the naive value.
  const naiveRow = parseBrevoWebhookEvent({ event: "opened", email: "a@b.com", date: "2026-07-13 21:35:58" });
  assert.notEqual(naiveRow.occurred_at, "2026-07-13T21:35:58.000Z", "naive local date must not be recorded as UTC");

  // --- Dedup id -------------------------------------------------------------------
  // 🔴 Brevo's `id` is the WEBHOOK's id, identical on every event it sends, so it must never be the
  // key: keying on it upserted every Brevo event onto ONE row, and production held exactly one, ever.
  const webhookId = 2080303;
  const openA = { id: webhookId, event: "opened", email: "a@satopharma.com", "message-id": "<m>", ts_epoch: 1785411455288 };
  assert.notEqual(brevoProviderEventId(openA), `brevo:${webhookId}`, "the webhook id is never the event key");
  assert.notEqual(
    brevoProviderEventId(openA),
    brevoProviderEventId({ ...openA, event: "delivered" }),
    "two events from the same webhook → two ids",
  );
  assert.notEqual(
    brevoProviderEventId(openA),
    brevoProviderEventId({ ...openA, email: "b@satopharma.com" }),
    "same message, same instant, another recipient of the batch → another id",
  );
  assert.equal(
    brevoProviderEventId(openA),
    brevoProviderEventId({ ...openA, email: "A@SatoPharma.com" }),
    "recipient casing does not split a retry",
  );
  assert.equal(statusFor("proxy_open"), "opened");
  assert.equal(statusFor("unique_proxy_open"), "opened");
  const p = { event: "click", "message-id": "<m>", date: "2026-07-13T10:00:00Z", link: "https://a" };
  assert.equal(brevoProviderEventId(p), brevoProviderEventId({ ...p }), "same payload → same id (retry-safe)");
  assert.notEqual(brevoProviderEventId(p), brevoProviderEventId({ ...p, link: "https://b" }), "different clicked link → different id");
  assert.notEqual(brevoProviderEventId(p), brevoProviderEventId({ ...p, event: "opened" }), "different event → different id");
}
