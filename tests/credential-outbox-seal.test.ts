import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

import {
  openCredentialFields,
  outboxDedupeDigest,
  redactedCredentialPayload,
  sealCredentialFields,
} from "../src/lib/notifications/credential-seal.ts";

/**
 * A RESET CODE OR A SET-YOUR-PASSWORD LINK NEVER SITS READABLE IN THE EMAIL OUTBOX (owner, 9 Nov 2026).
 *
 * The outbox stored the whole email as its payload, so production's notification_outbox held 37 reset
 * codes and 117 set-your-password links in plain text, kept 90 days. Now the code and the link are
 * sealed before the row is written, opened only in memory to send, and deleted once the row is done.
 */
export async function runCredentialOutboxSealTests() {
  const priorSecret = process.env.PHOENIX_AUTH_SECRET;
  process.env.PHOENIX_AUTH_SECRET = "test-secret-for-the-credential-outbox-seal";
  try {
    const code = "482913";
    const token = "Zx81kQp_4mWv9TnB2cRe7yHs";
    const resetCode = {
      credentialEmail: "password_reset_code" as const,
      ctaHref: "/password-reset",
      metrics: [
        { label: "Your code", value: code },
        { label: "Expires", value: "11/9/2026, 4:52:10 AM (Cairo)" },
      ],
      recipients: ["someone@satopharma.com"],
      subject: "Reset your Phoenix password",
      summary: "Enter this 6-digit code",
      title: "Password reset",
    };
    const setupLink = {
      credentialEmail: "password_setup_link" as const,
      ctaHref: `/password-setup/${token}`,
      metrics: [{ label: "Login ID", value: "B-77" }],
      recipients: ["someone@satopharma.com"],
      subject: "Set your Phoenix password",
      summary: "Set your password",
      title: "Account setup",
    };

    // ── 1. what the outbox writes ─────────────────────────────────────────────────────────────────
    const sealedCode = sealCredentialFields(resetCode);
    const sealedLink = sealCredentialFields(setupLink);
    assert.ok(!JSON.stringify(sealedCode).includes(code), "the stored payload does not carry the six digits");
    assert.ok(!JSON.stringify(sealedLink).includes(token), "the stored payload does not carry the link's token");
    for (const sealed of [sealedCode, sealedLink]) {
      assert.equal(sealed.metrics, undefined, "metrics are not written readable");
      assert.equal(sealed.ctaHref, undefined, "the button link is not written readable");
      assert.match(String(sealed.sealedCredential), /^v1:/, "they are written sealed instead");
    }
    assert.equal(sealedCode.subject, resetCode.subject, "the rest of the email (subject, recipients) stays readable for the activity screens");
    assert.deepEqual(sealedCode.recipients, resetCode.recipients);

    const ordinary = { ctaHref: "/leave", metrics: [{ label: "Days", value: 3 }], subject: "Leave approved", summary: "", title: "" };
    assert.equal(sealCredentialFields(ordinary), ordinary, "every other email is stored exactly as before");
    assert.equal(sealCredentialFields({ ...ordinary, credentialEmail: "payslip" }).metrics, ordinary.metrics, "an unknown stamp seals nothing");

    // ── 2. what the sender reads ─────────────────────────────────────────────────────────────────
    const opened = openCredentialFields(sealedCode);
    assert.deepEqual(opened.metrics, resetCode.metrics, "the code is back, in memory, to send");
    assert.equal(opened.ctaHref, resetCode.ctaHref);
    assert.equal(opened.sealedCredential, undefined, "the opened payload carries no seal");
    assert.equal(openCredentialFields(setupLink), setupLink, "a row queued before the seal still sends as it is");

    process.env.PHOENIX_AUTH_SECRET = "a-different-secret-after-a-rotation";
    assert.throws(() => openCredentialFields(sealedCode), "a seal the current secret cannot open fails the attempt, never sends an empty code");
    process.env.PHOENIX_AUTH_SECRET = "test-secret-for-the-credential-outbox-seal";

    // ── 3. what a finished row keeps ─────────────────────────────────────────────────────────────
    for (const finished of [redactedCredentialPayload(opened), redactedCredentialPayload(sealedLink)]) {
      assert.ok(finished, "a finished credential row is redacted");
      const text = JSON.stringify(finished);
      assert.ok(!text.includes(code) && !text.includes(token), "neither the code nor the link survives");
      assert.equal(finished?.sealedCredential, undefined, "nor its seal");
      assert.equal(finished?.credentialRedacted, true);
      assert.equal(finished?.subject !== undefined, true, "the subject stays for the activity screens");
    }
    assert.equal(redactedCredentialPayload(ordinary), null, "any other finished email is left untouched");

    // ── 4. the dedupe key cannot be brute-forced back to the code ────────────────────────────────
    const json = JSON.stringify(resetCode);
    const plain = createHash("sha256").update(json).digest("hex");
    assert.notEqual(outboxDedupeDigest(json, "password_reset_code"), plain, "a credential email's key is not a plain hash of its code");
    assert.equal(outboxDedupeDigest(json, "password_reset_code"), outboxDedupeDigest(json, "password_reset_code"), "but it is stable, so a double enqueue still dedupes");
    assert.equal(outboxDedupeDigest(json, null), plain, "every other email keeps its existing key");

    // ── 5. the outbox uses all of it ─────────────────────────────────────────────────────────────
    const outbox = readFileSync("src/lib/notifications/email.ts", "utf8");
    assert.match(outbox, /payload: \{ \.\.\.sealCredentialFields\(input\), originEnvironment: enqueueOriginEnvironment\(\) \}/, "the outbox writes the sealed payload");
    assert.match(outbox, /claimed = \{ \.\.\.claimedRow, payload: openCredentialFields\(claimedRow\.payload\) \};/, "and opens it after claiming the row");
    assert.match(outbox, /outboxDedupeDigest\(JSON\.stringify\(normalizeNotificationPayload\(input\)\), input\.credentialEmail\)/, "the dedupe key goes through the keyed digest");
    assert.equal((outbox.match(/\.\.\.finishedCredentialPayload\(row\.payload\)/g) ?? []).length, 2, "sent and skipped rows drop the credential");
    assert.match(outbox, /\.\.\.\(terminal \? finishedCredentialPayload\(row\.payload\) : \{\}\)/, "an out-of-retries row drops it too, while a row still retrying keeps its seal");

    const migrations = readdirSync("supabase/migrations").filter((name) => name.endsWith("_notification_outbox_redact_credentials.sql"));
    assert.equal(migrations.length, 1, "one migration clears the rows written before the seal");
    const sql = readFileSync(`supabase/migrations/${migrations[0]}`, "utf8");
    assert.match(sql, /status in \('sent', 'skipped'\)\s*or \(status = 'failed' and attempts >= max_attempts\)/, "and only finished rows, never one still waiting to send");
    assert.match(sql, /payload - 'metrics' - 'ctaHref' - 'sealedCredential'/);
  } finally {
    if (priorSecret === undefined) delete process.env.PHOENIX_AUTH_SECRET;
    else process.env.PHOENIX_AUTH_SECRET = priorSecret;
  }
}
