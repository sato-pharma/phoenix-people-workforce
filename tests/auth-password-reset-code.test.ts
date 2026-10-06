import assert from "node:assert/strict";

import { looksLikeEmail } from "../src/lib/auth/credentials.ts";
import {
  evaluatePasswordResetCode,
  generatePasswordResetCode,
  hashPasswordResetCode,
  normalizePasswordResetCode,
  passwordResetCodeMaxAttempts,
  type ResetCodeRow,
} from "../src/lib/auth/password-reset-code.ts";

/**
 * Self-service password-reset CODE logic (owner, 2026-10-06). A 6-digit code is only safe because of
 * the attempt cap, the expiry and the login-bound HMAC — so those are pinned here against the real
 * functions, not a source grep. If any one of them regresses, an attacker could brute-force a
 * colleague's reset code, so each assertion below is written so that loosening the rule makes it fire.
 */
export function runAuthPasswordResetCodeTests() {
  const priorSecret = process.env.PHOENIX_AUTH_SECRET;
  process.env.PHOENIX_AUTH_SECRET = "test-secret-for-reset-codes";

  try {
    // ── looksLikeEmail routes an email to the email door and never misroutes an HR_ID ──────────
    assert.equal(looksLikeEmail("name@satopharma.com"), true, "a well-formed address is an email");
    assert.equal(looksLikeEmail("  Name@SatoPharma.com  "), true, "it trims and is case-insensitive");
    assert.equal(looksLikeEmail("B-10"), false, "an HR_ID has no @ and is never treated as an email");
    assert.equal(looksLikeEmail("name@"), false, "a half-typed address is not an email");
    assert.equal(looksLikeEmail("name@localhost"), false, "no dot after the @ is not an email");
    assert.equal(looksLikeEmail(""), false, "empty is not an email");

    // ── generatePasswordResetCode is exactly six digits ───────────────────────────────────────
    for (let i = 0; i < 200; i += 1) {
      const code = generatePasswordResetCode();
      assert.match(code, /^\d{6}$/, `generated code must be 6 digits, got ${JSON.stringify(code)}`);
    }

    // ── normalizePasswordResetCode keeps only the digits ──────────────────────────────────────
    assert.equal(normalizePasswordResetCode("12 34-56"), "123456", "spaces and dashes are stripped");
    assert.equal(normalizePasswordResetCode("abc"), "", "non-digits collapse to empty");
    assert.equal(normalizePasswordResetCode(null), "", "null is empty");

    // ── hashPasswordResetCode: deterministic, login-bound, code-bound, normalization-stable ────
    const h = (login: string, code: string) => hashPasswordResetCode(login, code);
    assert.equal(h("b-10", "123456"), h("b-10", "123456"), "same inputs hash the same");
    assert.notEqual(h("b-10", "123456"), h("b-10", "123457"), "a different code hashes differently");
    assert.notEqual(h("b-10", "123456"), h("a-12", "123456"), "a code is bound to its login_id");
    assert.equal(h("B-10", "123456"), h("b-10", "123456"), "login_id is compared case-insensitively");
    assert.equal(h("b-10", "12 34-56"), h("b-10", "123456"), "the code is normalized before hashing");
    const hashUnderSecretA = h("b-10", "123456");
    process.env.PHOENIX_AUTH_SECRET = "a-different-secret";
    const hashUnderSecretB = h("b-10", "123456");
    process.env.PHOENIX_AUTH_SECRET = "test-secret-for-reset-codes";
    assert.notEqual(
      hashUnderSecretA,
      hashUnderSecretB,
      "the hash depends on the secret (a leaked table cannot be reversed without the key)",
    );

    // ── evaluatePasswordResetCode: the whole decision ─────────────────────────────────────────
    const now = Date.parse("2026-10-06T12:00:00.000Z");
    const future = new Date(now + 10 * 60 * 1000).toISOString();
    const past = new Date(now - 60 * 1000).toISOString();
    const baseRow = (over: Partial<ResetCodeRow>): ResetCodeRow => ({
      attempts: 0,
      code_hash: hashPasswordResetCode("b-10", "123456"),
      consumed_at: null,
      expires_at: future,
      login_id: "b-10",
      max_attempts: passwordResetCodeMaxAttempts,
      ...over,
    });

    assert.equal(
      evaluatePasswordResetCode({ code: "123456", now, row: baseRow({}) }).status,
      "ok",
      "the correct code on a fresh, live row verifies",
    );

    const wrong = evaluatePasswordResetCode({ code: "000000", now, row: baseRow({ attempts: 1 }) });
    assert.equal(wrong.status, "mismatch", "a wrong code is a mismatch");
    assert.equal(wrong.status === "mismatch" && wrong.nextAttempts, 2, "a mismatch increments attempts");
    assert.equal(wrong.status === "mismatch" && wrong.locked, false, "still below the cap is not locked");

    const lastTry = evaluatePasswordResetCode({
      code: "000000",
      now,
      row: baseRow({ attempts: passwordResetCodeMaxAttempts - 1 }),
    });
    assert.equal(lastTry.status === "mismatch" && lastTry.locked, true, "the wrong try that hits the cap locks");

    assert.equal(
      evaluatePasswordResetCode({ code: "123456", now, row: baseRow({ attempts: passwordResetCodeMaxAttempts }) }).status,
      "locked",
      "a code at its attempt cap is locked even for the correct code",
    );
    assert.equal(
      evaluatePasswordResetCode({ code: "123456", now, row: baseRow({ expires_at: past }) }).status,
      "expired",
      "an expired code never verifies",
    );
    assert.equal(
      evaluatePasswordResetCode({ code: "123456", now, row: baseRow({ consumed_at: new Date(now).toISOString() }) }).status,
      "consumed",
      "a consumed code can never be reused",
    );
    assert.equal(
      evaluatePasswordResetCode({ code: "123456", now, row: null }).status,
      "mismatch",
      "no live row reads as a mismatch, so an unknown account and a wrong code are indistinguishable",
    );

    // The HMAC is bound to the row's own login_id: a hash minted for one login must not verify for
    // another even with the right digits — the account-takeover case the binding exists to stop.
    assert.equal(
      evaluatePasswordResetCode({
        code: "123456",
        now,
        row: baseRow({ login_id: "a-12", code_hash: hashPasswordResetCode("b-10", "123456") }),
      }).status,
      "mismatch",
      "a code hashed for b-10 must not verify against a-12's row",
    );
  } finally {
    if (priorSecret === undefined) delete process.env.PHOENIX_AUTH_SECRET;
    else process.env.PHOENIX_AUTH_SECRET = priorSecret;
  }
}
