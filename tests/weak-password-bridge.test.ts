import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  provisionReplacingWeakPassword,
  type SupabaseAuthIdentity,
  type SupabaseAuthProvisionInput,
  unguessableBridgeSecret,
} from "../src/lib/auth/supabase-identity.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * A password GoTrue refuses as weak must not leave the Supabase bridge broken for ever.
 *
 * Phoenix accepts any password of 8+ characters; GoTrue refuses the ones on its leaked-password
 * list. Until 23 Oct 2026 that refusal threw out of provisionSupabaseAuthIdentity, so the login
 * repair failed on EVERY sign-in for as long as the password stood (two Medical Reps that day), a
 * self-service change swallowed it in an empty catch and left the OLD password live on Supabase, and
 * a person with no Supabase user yet never got one. The fix writes an unguessable random secret
 * into Supabase instead and mints the session from a single-use server token.
 */

const IDENTITY: SupabaseAuthIdentity = {
  authEmail: "phx-70642d30303034@auth.phoenix.local",
  authUserId: "11111111-2222-3333-4444-555555555555",
  coarseRole: "employee",
};

const INPUT: SupabaseAuthProvisionInput = {
  authUserId: IDENTITY.authUserId,
  hrId: "PD-0004",
  isActive: true,
  loginId: "PD-0004",
  password: "Password123",
  role: "Medical Rep",
};

/** What supabase-js throws when GoTrue refuses a password as weak. */
function weakPasswordError() {
  return Object.assign(new Error("Password is known to be weak and easy to guess, please choose a different one."), {
    code: "weak_password",
    name: "AuthWeakPasswordError",
    status: 422,
  });
}

const NOT_YET_REPLACED = async () => false;

async function runReplacementRule() {
  // 1 · The refusal is answered with a random secret, and the caller is told.
  const tried: SupabaseAuthProvisionInput[] = [];
  const replaced = await provisionReplacingWeakPassword(INPUT, async (attempt) => {
    tried.push(attempt);
    if (attempt.password === INPUT.password) throw weakPasswordError();
    return IDENTITY;
  }, NOT_YET_REPLACED);
  assert.equal(tried.length, 2, "a weak refusal is retried exactly once");
  assert.equal(tried[0].password, INPUT.password, "the person's own password is tried first — it may be fine");
  assert.notEqual(tried[0].bridgePasswordReplaced, true, "the person's own password is never marked as the replacement");
  assert.notEqual(tried[1].password, INPUT.password, "the retry must NOT send the refused password again");
  assert.ok(
    typeof tried[1].password === "string" && tried[1].password.length >= 40,
    `the replacement must be a long random secret (32 random bytes), got ${String(tried[1].password).length} characters`,
  );
  assert.equal(tried[1].bridgePasswordReplaced, true, "the retry marks the Supabase user as holding the random secret");
  assert.equal(replaced.weakPasswordReplaced, true, "the caller must learn the typed password no longer signs in to Supabase");
  assert.equal(replaced.authUserId, IDENTITY.authUserId, "the identity returned is the one the retry provisioned");

  // 2 · Two first-time refusals never share a secret, and every secret passes any character rule.
  const secrets = new Set<string>();
  for (let i = 0; i < 3; i += 1) {
    await provisionReplacingWeakPassword(INPUT, async (attempt) => {
      if (attempt.password === INPUT.password) throw weakPasswordError();
      secrets.add(String(attempt.password));
      return IDENTITY;
    }, NOT_YET_REPLACED);
  }
  assert.equal(secrets.size, 3, "every replacement secret is freshly random");
  for (let i = 0; i < 200; i += 1) {
    const secret = unguessableBridgeSecret();
    assert.ok(
      /[a-z]/.test(secret) && /[A-Z]/.test(secret) && /\d/.test(secret) && /[^A-Za-z0-9]/.test(secret),
      `a replacement secret must hold a lower-case letter, an upper-case letter, a digit and a symbol, every time — base64url alone leaves a quarter of them with no symbol: ${secret.length} chars`,
    );
  }

  // 3 · ALREADY replaced: the secret is kept, never rotated on every login.
  const again: SupabaseAuthProvisionInput[] = [];
  const asked: string[] = [];
  const kept = await provisionReplacingWeakPassword(INPUT, async (attempt) => {
    again.push(attempt);
    if (attempt.password === INPUT.password) throw weakPasswordError();
    return IDENTITY;
  }, async (authUserId) => {
    asked.push(authUserId);
    return true;
  });
  assert.deepEqual(asked, [IDENTITY.authUserId], "the mark is read for the linked Supabase user, once");
  assert.equal(again.length, 2, "the person's own password is still tried first — it may have become acceptable");
  assert.equal(
    again[1].password,
    null,
    "a user already holding the random secret must get a metadata-only update — writing a new secret on every login costs a password write per sign-in and can end the person's other Supabase sessions",
  );
  assert.equal(kept.weakPasswordReplaced, true, "and the caller still mints the session without the password");

  // 4 · An unreadable mark falls back to a fresh secret (always safe), and no Supabase user means no read.
  const unreadable: SupabaseAuthProvisionInput[] = [];
  await provisionReplacingWeakPassword(INPUT, async (attempt) => {
    unreadable.push(attempt);
    if (attempt.password === INPUT.password) throw weakPasswordError();
    return IDENTITY;
  }, async () => {
    throw new Error("network");
  });
  assert.ok(typeof unreadable[1].password === "string" && unreadable[1].password.length >= 40, "an unreadable mark writes a fresh secret rather than none");
  let reads = 0;
  await provisionReplacingWeakPassword({ ...INPUT, authUserId: null }, async (attempt) => {
    if (attempt.password === INPUT.password) throw weakPasswordError();
    return IDENTITY;
  }, async () => {
    reads += 1;
    return true;
  });
  assert.equal(reads, 0, "with no linked Supabase user there is no mark to read");

  // 5 · A password GoTrue accepts is stored as typed, and nothing is flagged.
  let calls = 0;
  const accepted = await provisionReplacingWeakPassword(INPUT, async () => {
    calls += 1;
    return IDENTITY;
  }, NOT_YET_REPLACED);
  assert.equal(calls, 1, "an accepted password is provisioned once");
  assert.notEqual(accepted.weakPasswordReplaced, true, "an accepted password must keep the password sign-in");

  // 6 · Every OTHER failure is still a failure — a bridge outage must never be papered over.
  const outage = Object.assign(new Error("Invalid login credentials"), { name: "AuthApiError", status: 400 });
  calls = 0;
  await assert.rejects(
    provisionReplacingWeakPassword(INPUT, async () => {
      calls += 1;
      throw outage;
    }, NOT_YET_REPLACED),
    (error) => error === outage,
    "a non-weak failure must surface unchanged",
  );
  assert.equal(calls, 1, "a non-weak failure is never retried with a random secret");

  // 7 · No password to replace (a metadata-only update) — nothing to retry with.
  calls = 0;
  await assert.rejects(
    provisionReplacingWeakPassword({ ...INPUT, password: null }, async () => {
      calls += 1;
      throw weakPasswordError();
    }, NOT_YET_REPLACED),
    "with no password in the request there is no password to replace",
  );
  assert.equal(calls, 1, "a passwordless call is never retried");
}

function runCallerSourceAssertions() {
  const identity = stripComments(readFileSync("src/lib/auth/supabase-identity.ts", "utf8"));
  const login = stripComments(readFileSync("app/api/auth/login/route.ts", "utf8"));
  const change = stripComments(readFileSync("src/lib/auth/change-password.ts", "utf8"));
  const setup = stripComments(readFileSync("src/lib/auth/password-setup.ts", "utf8"));

  // The real provisioning goes through the rule above, not around it, with the real mark reader.
  assert.ok(
    /export async function provisionSupabaseAuthIdentity\([\s\S]*?\{\s*return provisionReplacingWeakPassword\([\s\S]*?holdsReplacedBridgeSecret,?\s*\);/.test(identity),
    "provisionSupabaseAuthIdentity must route every caller through provisionReplacingWeakPassword, reading the mark with holdsReplacedBridgeSecret",
  );
  assert.ok(
    /\.\.\.\(input\.password \? \{ bridge_password_replaced: input\.bridgePasswordReplaced === true \} : \{\}\)/.test(identity),
    "the mark is written ONLY alongside a password, so a metadata-only update (which GoTrue merges key by key) leaves it in place",
  );

  // The password-free session: a token minted and exchanged on the server, and NOTHING sent.
  const mint = /export async function createSupabaseAuthSessionWithoutPassword[\s\S]*?\n}\n/.exec(identity)?.[0] ?? "";
  assert.ok(mint, "createSupabaseAuthSessionWithoutPassword must exist");
  assert.ok(
    /createSupabaseAuthSessionWithoutPassword\(\s*loginId: string,?\s*\)/.test(mint) && /email: buildPhoenixAuthEmail\(loginId\)/.test(mint),
    "it takes the LOGIN ID and builds the address itself — a magic-link token for an address GoTrue does not know can create that user",
  );
  assert.ok(/auth\.admin\.generateLink\(\{[\s\S]*?type: "magiclink"/.test(mint), "the token comes from the admin API's generateLink");
  assert.ok(/auth\.verifyOtp\(\{[\s\S]*?token_hash: tokenHash/.test(mint), "and is exchanged at once with verifyOtp's token_hash");
  assert.ok(
    !/signInWithOtp|inviteUserByEmail|resetPasswordForEmail|\.resend\(/.test(mint),
    "the password-free session must never use a call that SENDS an email — generateLink only returns the token",
  );

  // Both places that sign in after provisioning choose the path by the flag.
  assert.ok(
    /supabaseSession = repairedIdentity\.weakPasswordReplaced\s*\?\s*await createSupabaseAuthSessionWithoutPassword\(user\.loginId\)\s*:\s*await createSupabaseAuthSession\(user\.loginId, password\)/.test(login),
    "the login repair must mint the session without the password when the password was replaced — signing in with the typed password then fails by construction",
  );
  assert.ok(
    /supabaseSession = supabaseWeakPasswordReplaced\s*\?\s*await createSupabaseAuthSessionWithoutPassword\(input\.loginId\)\s*:\s*await createSupabaseAuthSession\(input\.loginId, input\.newPassword\)/.test(change),
    "a self-service password change must do the same",
  );
  assert.ok(
    /supabaseWeakPasswordReplaced = identity\.weakPasswordReplaced === true;/.test(setup) &&
      /newValues: \{[\s\S]*?supabaseWeakPasswordReplaced,[\s\S]*?\}/.test(setup),
    "a password setup must record on its audit row that Supabase holds a random secret — its bridgeWarning no longer shows it",
  );

  // The swallowed sync failure leaves a trace now.
  assert.ok(
    /\} catch \(error\) \{\s*supabaseBridgeError = errorMessageOf\(error\);\s*\}/.test(change),
    "a failed Supabase sync on a password change must be kept, not swallowed by an empty catch",
  );
  assert.ok(
    /newValues: \{[\s\S]*?supabaseBridgeError,[\s\S]*?supabaseWeakPasswordReplaced,[\s\S]*?\}/.test(change),
    "and it must reach the password-change audit row, with whether the password was replaced",
  );
}

export async function runWeakPasswordBridgeTests() {
  await runReplacementRule();
  runCallerSourceAssertions();
}
