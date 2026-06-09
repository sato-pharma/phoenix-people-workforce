import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isBlockedImageHost } from "@/lib/email/email-safety.ts";
import { guardAttachments, parseRetryAfter } from "@/lib/email/send-phoenix-email.ts";
import { isDuplicateKeyError, suppressionReasonForEvent } from "@/lib/email/resend-webhook-events.ts";
import { createUnsubscribeToken, verifyUnsubscribeToken } from "@/lib/email/unsubscribe-token.ts";

/**
 * Phase 2 — send layer, suppression, deliverability, unsubscribe.
 */
export function runEmailSendHardeningTests() {
  // --- Suppression decisions (hard/soft/complaint) ---------------------------------
  const complaint = suppressionReasonForEvent({ status: "complained", raw_event: { data: {} } });
  assert.equal(complaint?.reason, "complaint");
  assert.equal(complaint?.expiresAt, null, "a complaint suppresses permanently (fail-closed)");

  const permanent = suppressionReasonForEvent({ status: "bounced", raw_event: { data: { bounce: { type: "Permanent" } } } });
  assert.equal(permanent?.reason, "hard_bounce");
  assert.equal(permanent?.expiresAt, null, "a permanent bounce suppresses indefinitely");

  const transient = suppressionReasonForEvent({ status: "bounced", raw_event: { data: { bounce: { subType: "Transient" } } } });
  assert.equal(transient?.reason, "hard_bounce");
  assert.ok(transient?.expiresAt, "a transient/soft bounce auto-recovers (has an expiry)");

  assert.equal(suppressionReasonForEvent({ status: "delivered", raw_event: { data: {} } }), null);
  assert.equal(suppressionReasonForEvent({ status: "sent", raw_event: { data: {} } }), null);

  // --- Retry-After parsing ---------------------------------------------------------
  assert.equal(parseRetryAfter("3"), 3000);
  assert.equal(parseRetryAfter("120"), 120000);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter("not-a-number"), undefined);
  const base = 1_000_000;
  const future = new Date(base + 5000).toUTCString();
  const parsed = parseRetryAfter(future, base);
  assert.ok(parsed !== undefined && parsed >= 0 && parsed <= 5000, "HTTP-date Retry-After resolves to ms-until");

  // --- Attachment size guard -------------------------------------------------------
  assert.equal(guardAttachments(undefined), undefined);
  assert.equal(guardAttachments([]), undefined);
  const small = guardAttachments([{ content: Buffer.from("hello").toString("base64"), filename: "a.txt" }]);
  assert.equal(small?.length, 1, "an under-budget attachment passes through");

  // --- SSRF host blocking ----------------------------------------------------------
  for (const blocked of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.1", "169.254.169.254", "172.16.0.1", "::1", "0.0.0.0"]) {
    assert.equal(isBlockedImageHost(blocked), true, `${blocked} must be blocked`);
  }
  for (const ok of ["mail.satopharma.com", "futuretalents.satopharma.com", "8.8.8.8", "171.16.0.1"]) {
    assert.equal(isBlockedImageHost(ok), false, `${ok} must be allowed`);
  }

  // --- Unsubscribe token sign/verify roundtrip -------------------------------------
  const savedSecret = process.env.PHOENIX_AUTH_SECRET;
  try {
    process.env.PHOENIX_AUTH_SECRET = "test-secret-for-unsubscribe-tokens";
    const token = createUnsubscribeToken("Person@Example.com", "resignation");
    const payload = verifyUnsubscribeToken(token);
    assert.equal(payload?.addr, "person@example.com", "address is normalised + recovered");
    assert.equal(payload?.type, "resignation");
    assert.equal(verifyUnsubscribeToken(token + "x"), null, "a tampered token must not verify");
    assert.equal(verifyUnsubscribeToken("garbage"), null);
    assert.equal(verifyUnsubscribeToken(createUnsubscribeToken("a@b.com", "offer", -1)), null, "an expired token must not verify");
    // A token signed with a different secret must not verify.
    process.env.PHOENIX_AUTH_SECRET = "a-different-secret";
    assert.equal(verifyUnsubscribeToken(token), null, "wrong secret must not verify");
  } finally {
    if (savedSecret === undefined) delete process.env.PHOENIX_AUTH_SECRET;
    else process.env.PHOENIX_AUTH_SECRET = savedSecret;
  }

  // --- Duplicate-key detection -----------------------------------------------------
  assert.equal(isDuplicateKeyError({ code: "23505" }), true);
  assert.equal(isDuplicateKeyError(new Error("duplicate key value violates unique constraint")), true);
  assert.equal(isDuplicateKeyError(new Error("some other error")), false);

  // --- Source locks ----------------------------------------------------------------
  const sendSource = readFileSync("src/lib/email/send-phoenix-email.ts", "utf8");
  assert.match(sendSource, /from\("email_suppressions"\)/, "suppression must use the durable email_suppressions table");
  assert.match(sendSource, /loadComplaintSuppressionsFromEvents/, "must fail-closed for complaints on table error");
  assert.match(sendSource, /class RetryableEmailError/, "retryable error type must exist");
  assert.match(sendSource, /AbortSignal\.timeout/, "the Resend POST must have a timeout");
  assert.match(sendSource, /response\.status === 429/, "must handle 429 rate limiting");
  assert.match(sendSource, /guardAttachments\(input\.attachments\)/, "attachments must be size-guarded before sending");
  assert.match(sendSource, /fanoutToBcc/, "BCC fan-out option must exist");
  assert.match(sendSource, /Signature image unreachable; sending email anyway/, "image check must be non-fatal");

  const safetySource = readFileSync("src/lib/email/email-safety.ts", "utf8");
  assert.match(safetySource, /isBlockedImageHost\(parsed\.hostname\)/, "SSRF guard must match the parsed hostname");

  const webhookLib = readFileSync("src/lib/email/resend-webhook-events.ts", "utf8");
  assert.match(webhookLib, /email\.opened/, "opened events must be mapped");
  assert.match(webhookLib, /email\.clicked/, "clicked events must be mapped");
  assert.match(webhookLib, /from\("email_suppressions"\)/, "webhook must feed the suppression list");

  const webhookRoute = readFileSync("app/api/webhooks/resend/route.ts", "utf8");
  assert.match(webhookRoute, /try\s*{[\s\S]*recordResendWebhookEvent[\s\S]*catch/, "webhook record must be wrapped");
  assert.match(webhookRoute, /captureException/, "webhook errors must reach Sentry");
  assert.match(webhookRoute, /503/, "transient webhook errors must return 503 (Resend retries)");

  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.match(registry, /\/api\/email\/unsubscribe\/:token/, "unsubscribe route must be registered");
  const proxySource = readFileSync("proxy.ts", "utf8");
  assert.match(proxySource, /\/api\/email\/unsubscribe\//, "unsubscribe route must be CSRF-exempt");

  const healthSource = readFileSync("app/api/health/email/route.ts", "utf8");
  assert.match(healthSource, /forceTesting/, "health check must surface force-testing");
  assert.match(healthSource, /redirected to testing recipients in production/, "health must warn on prod redirect");

  const notificationsEmail = readFileSync("src/lib/notifications/email.ts", "utf8");
  assert.match(notificationsEmail, /createUnsubscribeToken/, "notification headers must use the HTTPS one-click token");
  assert.match(notificationsEmail, /fanoutToBcc: true/, "notification fan-out must use BCC");

  const templateService = readFileSync("src/lib/email-templates/service.ts", "utf8");
  assert.match(templateService, /createUnsubscribeToken/, "templated emails must use the HTTPS one-click token");
  assert.match(templateService, /fanoutToBcc: true/, "templated fan-out must use BCC");
}
