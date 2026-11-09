import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isBlockedImageHost, isNonDeliverableEmail, pickDeliverableEmail, resolvesToBlockedAddress } from "@/lib/email/email-safety.ts";
import { guardAttachments, parseRetryAfter, sendPhoenixEmail } from "@/lib/email/send-phoenix-email.ts";
import { isDuplicateKeyError, suppressionReasonForEvent } from "@/lib/email/resend-webhook-events.ts";
import { createUnsubscribeToken, verifyUnsubscribeToken } from "@/lib/email/unsubscribe-token.ts";

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/**
 * Phase 2 — send layer, suppression, deliverability, unsubscribe.
 */
export async function runEmailSendHardeningTests() {
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
  // An IPv4-mapped IPv6 host is judged as the IPv4 host inside it, and Railway's private network is
  // internal (owner, 2026-11-09). Each URL goes through the real parser, which rewrites the address.
  for (const url of [
    "https://[::ffff:127.0.0.1]/signature.png",
    "https://[::ffff:a9fe:a9fe]/signature.png",
    "https://[0:0:0:0:0:ffff:0a00:0001]/signature.png",
    "https://postgres.railway.internal/signature.png",
    "https://phoenix-people-workforce.railway.internal./signature.png",
  ]) {
    assert.equal(isBlockedImageHost(new URL(url).hostname), true, `${url} must be blocked`);
  }
  for (const url of [
    "https://[::ffff:808:808]/signature.png",
    "https://phoenix-people-workforce-staging.up.railway.app/signature.png",
    "https://phoenix-hr.satopharma.com/assets/branding/phoenix-hr-signature-small.png",
  ]) {
    assert.equal(isBlockedImageHost(new URL(url).hostname), false, `${url} must be allowed`);
  }
  // Ranges the old text patterns missed: 0.0.0.0/8, CGNAT 100.64/10, all of fe80::/10, and every IPv6
  // spelling of an IPv4 host (compatible, SIIT, NAT64). The ranges end exactly at their edges.
  for (const url of [
    "https://0.1.2.3/signature.png",
    "https://100.64.0.1/signature.png",
    "https://100.127.255.255/signature.png",
    "https://[fe80::1]/signature.png",
    "https://[febf::1]/signature.png",
    "https://[::7f00:1]/signature.png",
    "https://[::ffff:0:7f00:1]/signature.png",
    "https://[64:ff9b::7f00:1]/signature.png",
    "https://[fd12:3456::1]/signature.png",
  ]) {
    assert.equal(isBlockedImageHost(new URL(url).hostname), true, `${url} must be blocked`);
  }
  for (const url of [
    "https://100.63.255.255/signature.png",
    "https://100.128.0.1/signature.png",
    "https://[fec0::1]/signature.png",
    "https://[::808:808]/signature.png",
    "https://[64:ff9b::808:808]/signature.png",
    // A NAME is never matched against an address pattern: these are ordinary public hosts.
    "https://10.example.com/signature.png",
    "https://127.cdn.example.net/signature.png",
  ]) {
    assert.equal(isBlockedImageHost(new URL(url).hostname), false, `${url} must be allowed`);
  }
  // A name is judged by what it resolves to: "localhost" answers loopback, and a literal address is
  // left to isBlockedImageHost.
  assert.equal(await resolvesToBlockedAddress("localhost"), true, "a name that resolves to loopback is refused");
  assert.equal(await resolvesToBlockedAddress("8.8.8.8"), false, "a literal address is not looked up");

  // --- Non-deliverable / synthetic recipient guard ---------------------------------
  // The Supabase-auth identity address is a login key, never a mailbox: it must be rejected
  // so it can never be handed to the provider and hard-bounce.
  for (const synthetic of [
    "phx-6161@auth.phoenix.local",
    "phx-622d3130@auth.phoenix.local",
    "anything@phoenix.local",
    "host@server.local",
    "no-at-sign",
    "missing@domain",
    "",
  ]) {
    assert.equal(isNonDeliverableEmail(synthetic), true, `${synthetic || "(empty)"} must be non-deliverable`);
  }
  assert.equal(isNonDeliverableEmail(null), true, "null is non-deliverable");
  for (const real of ["omar.anwar@satopharma.com", "a.b@futuretalents.satopharma.com", "person@example.com"]) {
    assert.equal(isNonDeliverableEmail(real), false, `${real} must be deliverable`);
  }
  // pickDeliverableEmail prefers the first real address; synthetic auth_email is skipped.
  assert.equal(
    pickDeliverableEmail("real@satopharma.com", "phx-6161@auth.phoenix.local"),
    "real@satopharma.com",
    "real work_email wins",
  );
  assert.equal(
    pickDeliverableEmail("phx-6161@auth.phoenix.local", "real@satopharma.com"),
    "real@satopharma.com",
    "synthetic is skipped even when listed first",
  );
  assert.equal(pickDeliverableEmail(null, "phx-6161@auth.phoenix.local"), null, "no real address → null (in-app only)");
  assert.equal(
    pickDeliverableEmail("phx-6161@auth.phoenix.local", "phx-622d3130@auth.phoenix.local"),
    null,
    "all-synthetic candidates → null (the production probation-reminder case)",
  );
  assert.equal(pickDeliverableEmail("  Mixed.Case@Satopharma.com  "), "Mixed.Case@Satopharma.com", "trims but preserves case");

  // --- Behavioral: a synthetic-only send NEVER reaches the provider ----------------
  // The load-bearing safety contract: addressing mail to the synthetic auth identity must
  // be a deterministic skip, with ZERO POST to the Resend API (a fake-address bounce is what
  // damaged sending-domain reputation). Stub fetch + env and assert the API is never called.
  {
    const savedEnv = {
      enabled: process.env.EMAIL_NOTIFICATIONS_ENABLED,
      key: process.env.RESEND_API_KEY,
      from: process.env.NOTIFICATION_EMAIL_FROM,
      force: process.env.PHOENIX_EMAIL_FORCE_TESTING,
      vercelEnv: process.env.VERCEL_ENV,
    };
    const savedFetch = globalThis.fetch;
    const calledUrls: string[] = [];
    try {
      process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
      process.env.RESEND_API_KEY = "test-key";
      process.env.NOTIFICATION_EMAIL_FROM = "Phoenix <phoenix@send.satopharma.com>";
      process.env.PHOENIX_EMAIL_FORCE_TESTING = "false";
      process.env.VERCEL_ENV = "production"; // ensure no testing-redirect interferes
      // Stub: succeed the cosmetic signature-image check; record every URL touched.
      globalThis.fetch = (async (input: unknown) => {
        const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
        calledUrls.push(url);
        return {
          ok: true,
          status: 200,
          headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "image/png" : null) },
          json: async () => ({ id: "should-not-be-used" }),
        } as unknown as Response;
      }) as typeof fetch;

      const result = await sendPhoenixEmail({
        to: ["phx-6161@auth.phoenix.local", "phx-622d3130@auth.phoenix.local"],
        subject: "probation feedback is due",
        html: "<p>x</p>",
        text: "x",
        idempotencyKey: "test-synthetic-only",
      });

      assert.equal(result.skipped, true, "a synthetic-only recipient list must be skipped");
      if (result.skipped) {
        assert.match(result.reason, /no deliverable recipient/i, "skip reason names the no-mailbox cause");
      }
      assert.equal(
        calledUrls.some((u) => u.includes("api.resend.com/emails")),
        false,
        "the Resend send API must NEVER be called for synthetic-only recipients",
      );
    } finally {
      globalThis.fetch = savedFetch;
      restoreEnv("EMAIL_NOTIFICATIONS_ENABLED", savedEnv.enabled);
      restoreEnv("RESEND_API_KEY", savedEnv.key);
      restoreEnv("NOTIFICATION_EMAIL_FROM", savedEnv.from);
      restoreEnv("PHOENIX_EMAIL_FORCE_TESTING", savedEnv.force);
      restoreEnv("VERCEL_ENV", savedEnv.vercelEnv);
    }
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
  // The raw provider POST + retry/error classification moved into the failover layer; the
  // send path now delegates to it. Assert the hardening in its new home so the locks still hold.
  const providersSource = readFileSync("src/lib/email/email-providers.ts", "utf8");
  const errorsSource = readFileSync("src/lib/email/email-errors.ts", "utf8");
  assert.match(sendSource, /from\("email_suppressions"\)/, "suppression must use the durable email_suppressions table");
  assert.match(sendSource, /loadComplaintSuppressionsFromEvents/, "must fail-closed for complaints on table error");
  assert.match(sendSource, /sendPreparedEmailWithFailover/, "send path must dispatch through the provider-failover layer");
  assert.match(errorsSource, /class RetryableEmailError/, "retryable error type must exist");
  assert.match(providersSource, /AbortSignal\.timeout/, "the provider POST must have a timeout");
  assert.match(providersSource, /response\.status === 429/, "must handle 429 rate limiting");
  assert.match(sendSource, /guardAttachments\(input\.attachments\)/, "attachments must be size-guarded before sending");
  assert.match(sendSource, /fanoutToBcc/, "BCC fan-out option must exist");
  assert.match(sendSource, /Signature image unreachable; sending email anyway/, "image check must be non-fatal");
  assert.match(sendSource, /removeNonDeliverable\(testingRecipients \?\? input\.to\)/, "send layer must drop synthetic recipients before suppression");
  assert.match(sendSource, /No deliverable recipient/, "all-synthetic must be a deterministic skip, not a send");

  const safetySource = readFileSync("src/lib/email/email-safety.ts", "utf8");
  assert.match(safetySource, /isBlockedImageHost\(parsed\.hostname\)/, "SSRF guard must match the parsed hostname");
  assert.match(safetySource, /export function isNonDeliverableEmail/, "non-deliverable guard must be exported");
  assert.match(safetySource, /export function pickDeliverableEmail/, "deliverable-email picker must be exported");

  // Recipient resolution must never prefer the synthetic auth_email over the real work_email.
  const policySource = readFileSync("src/lib/notifications/policy.ts", "utf8");
  assert.match(policySource, /pickDeliverableEmail\(candidate\.employee\?\.work_email, candidate\.auth\?\.auth_email\)/, "policy must resolve work_email over auth_email");
  assert.doesNotMatch(policySource, /candidate\.auth\?\.auth_email \?\? candidate\.employee\?\.work_email/, "policy must NOT prefer auth_email");
  const systemSource = readFileSync("src/lib/notifications/system.ts", "utf8");
  assert.match(systemSource, /pickDeliverableEmail\(workEmail, row\?\.auth_email\)/, "system recipient profile must resolve work_email over auth_email");
  assert.doesNotMatch(systemSource, /email:\s*row\?\.auth_email \?\? null/, "system must NOT use auth_email as the deliverable address");

  const webhookLib = readFileSync("src/lib/email/resend-webhook-events.ts", "utf8");
  assert.match(webhookLib, /email\.opened/, "opened events must be mapped");
  assert.match(webhookLib, /email\.clicked/, "clicked events must be mapped");
  assert.match(webhookLib, /from\("email_suppressions"\)/, "webhook must feed the suppression list");

  const webhookRoute = readFileSync("app/api/webhooks/resend/route.ts", "utf8");
  assert.match(webhookRoute, /try\s*{[\s\S]*recordResendWebhookEvent[\s\S]*catch/, "webhook record must be wrapped");
  
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
