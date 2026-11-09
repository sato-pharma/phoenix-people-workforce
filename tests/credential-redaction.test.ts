import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import {
  CREDENTIAL_REMOVED,
  redactCredentialEmailBody,
  redactCredentialLinks,
  redactCredentialLinksInJson,
} from "../src/lib/email/credential-redaction.ts";
import { parseBrevoWebhookEvent } from "../src/lib/email/brevo-webhook-events.ts";
import { parseResendWebhookEvent } from "../src/lib/email/resend-webhook-events.ts";

/**
 * NO RECORD KEEPS A USABLE PASSWORD CODE OR SET-YOUR-PASSWORD LINK (owner, 9 Nov 2026).
 *
 * After the outbox was sealed (#183), production still held 33 reset codes and 162 links in the
 * Notification Confidence Gate's copy of every email, links in 160 notification rows, 511 provider
 * click events, 20 audit entries and one internal message. Each is now stripped before it is stored.
 */
export async function runCredentialRedactionTests() {
  const token = "fakeSetupLinkTokenForTheRedactionTest";
  const link = `https://phoenix-hr.satopharma.com/password-setup/${token}`;
  const code = "482913";

  // ── 1. the helpers ────────────────────────────────────────────────────────────────────────────
  assert.equal(redactCredentialLinks(`Open ${link} now`), `Open https://phoenix-hr.satopharma.com/password-setup/${CREDENTIAL_REMOVED} now`);
  assert.equal(redactCredentialLinks("/password-setup/short"), "/password-setup/short", "only a token-length run is a token");

  const text = `Your code: ${code}\nExpires: 11/9/2026, 4:52:10 AM (Cairo)\n`;
  const html = `<td style="color:#003366;padding:12px 16px">Your code</td><td style="color:#1f2933">⁨${code}⁩</td>`;
  const codeText = redactCredentialEmailBody(text, "password_reset_code");
  const codeHtml = redactCredentialEmailBody(html, "password_reset_code");
  assert.ok(!codeText.includes(code) && !codeHtml.includes(code), "the six digits are gone from the text and the HTML");
  assert.ok(codeText.includes("11/9/2026, 4:52:10 AM"), "the expiry stays readable");
  assert.ok(codeHtml.includes("#003366") && codeHtml.includes("#1f2933"), "a six-digit colour is not a code");
  assert.ok(!redactCredentialEmailBody(`<a href="${link}">Set your password</a>`, "password_setup_link").includes(token), "the link email keeps no token");
  assert.equal(redactCredentialEmailBody(text, null), text, "any other email is stored as it was");
  assert.equal(redactCredentialEmailBody(text, "payslip"), text, "an unknown stamp redacts nothing");

  // ── 2. the provider's click events ────────────────────────────────────────────────────────────
  const resend = parseResendWebhookEvent(
    { created_at: "2026-11-06T10:57:12.725Z", data: { click: { link }, email_id: "em_1", to: ["someone@satopharma.com"] }, type: "email.clicked" },
    "evt_1",
  );
  assert.ok(!JSON.stringify(resend.raw_event).includes(token), "a Resend click on the link is stored without its token");
  assert.equal(resend.provider_message_id, "em_1", "the rest of the event is unchanged");
  const brevoPayload = { email: "someone@satopharma.com", event: "click", link, "message-id": "<m1>", ts_epoch: 1 };
  const brevo = parseBrevoWebhookEvent(brevoPayload);
  assert.ok(!JSON.stringify(brevo.raw_event).includes(token), "a Brevo click on the link is stored without its token");
  assert.equal(brevo.provider_event_id, parseBrevoWebhookEvent(brevoPayload).provider_event_id, "its event id is still read from the real payload, so a repeat still dedupes");
  const plain = { a: 1, b: ["x"] };
  assert.equal(redactCredentialLinksInJson(plain), plain, "a payload with no link is stored untouched");

  // ── 3. the wiring ────────────────────────────────────────────────────────────────────────────
  const gate = readFileSync("src/lib/notifications/confidence-gate.ts", "utf8");
  assert.match(gate, /rendered_html: redactCredentialEmailBody\(input\.html, credentialEmail\),/, "the gate stores the redacted HTML");
  assert.match(gate, /rendered_text: redactCredentialEmailBody\(input\.text, credentialEmail\),/, "and the redacted text");
  assert.match(gate, /if \(held\.checks\.some\(\(check\) => check\.name === CREDENTIAL_REMOVED_CHECK\)\) \{\s*throw conflictError/, "a held credential email can never be re-sent from review without its code");
  const send = readFileSync("src/lib/email/send-phoenix-email.ts", "utf8");
  assert.match(send, /credentialEmail: input\.credentialEmail \?\? null,\s*from: prepared\.from,/, "every send hands the gate its credential stamp");
  const setup = readFileSync("src/lib/auth/password-setup.ts", "utf8");
  assert.doesNotMatch(setup, /actionUrl: setupPath/, "the notification row never stores the link");
  assert.match(setup, /ctaHref: setupPath,/, "while the email's own button still carries it");

  const migrations = readdirSync("supabase/migrations").filter((name) => name.endsWith("_credential_links_redacted_from_records.sql"));
  assert.equal(migrations.length, 1, "one migration clears what was stored before");
  const sql = readFileSync(`supabase/migrations/${migrations[0]}`, "utf8");
  for (const table of ["notification_send_reviews", "notification_events", "email_delivery_events", "audit_logs", "internal_messages"]) {
    assert.match(sql, new RegExp(`update public\\.${table}\\b`), `it clears ${table}`);
  }
}
