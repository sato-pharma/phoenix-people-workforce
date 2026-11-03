import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  STAGING_TEST_SIGN_IN_KEY_MIN_LENGTH,
  isStagingTestSignInEnabled,
  stagingTestSignInKeyMatches,
} from "@/lib/auth/staging-test-sign-in";

import { stripComments } from "./support/comment-strip.ts";

// The staging test sign-in (owner, 2026-11-03: "a staging-only way for a Claude session to sign in as
// a test account … never on production", and "I'll set the key"). A TEST account may sign in on
// staging with the owner's key instead of its own password. This suite pins that each of the three
// halves refuses on its own, that a real account never signs in with the key, and that the key is
// tried only after the account's own password failed.

const KEYS = ["APP_ENV", "PHOENIX_STAGING_TEST_SIGNIN_KEY", "NEXT_PUBLIC_SUPABASE_URL"] as const;
const KEY = "k".repeat(STAGING_TEST_SIGN_IN_KEY_MIN_LENGTH);
const STAGING_URL = "https://cifwmndunmlxjhyjugxa.supabase.co";
const PRODUCTION_URL = "https://ozucdzovmcqvepbozvqf.supabase.co";

function withEnv(values: Partial<Record<(typeof KEYS)[number], string | undefined>>, body: () => void) {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of KEYS) {
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    body();
  } finally {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const test = { isTestPersona: true };
const real = { isTestPersona: false };

export function runStagingTestSignInTests(): void {
  // ── All three halves present: a test account signs in with the key, and only with the key ──────
  withEnv({ APP_ENV: "staging", NEXT_PUBLIC_SUPABASE_URL: STAGING_URL, PHOENIX_STAGING_TEST_SIGNIN_KEY: KEY }, () => {
    assert.equal(isStagingTestSignInEnabled(), true);
    assert.equal(stagingTestSignInKeyMatches(test, KEY), true, "a test account signs in with the key");
    assert.equal(stagingTestSignInKeyMatches(real, KEY), false, "a real account NEVER signs in with the key");
    assert.equal(stagingTestSignInKeyMatches(test, `${KEY}x`), false, "a wrong key is refused");
    assert.equal(stagingTestSignInKeyMatches(test, ""), false, "an empty password is refused");
  });

  // ── Each half refuses on its own ────────────────────────────────────────────────────────────────
  for (const [label, env] of [
    ["APP_ENV production", { APP_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: STAGING_URL, PHOENIX_STAGING_TEST_SIGNIN_KEY: KEY }],
    ["APP_ENV unset", { NEXT_PUBLIC_SUPABASE_URL: STAGING_URL, PHOENIX_STAGING_TEST_SIGNIN_KEY: KEY }],
    ["APP_ENV mistyped", { APP_ENV: "Staging", NEXT_PUBLIC_SUPABASE_URL: STAGING_URL, PHOENIX_STAGING_TEST_SIGNIN_KEY: KEY }],
    ["no key", { APP_ENV: "staging", NEXT_PUBLIC_SUPABASE_URL: STAGING_URL }],
    ["a short key", { APP_ENV: "staging", NEXT_PUBLIC_SUPABASE_URL: STAGING_URL, PHOENIX_STAGING_TEST_SIGNIN_KEY: KEY.slice(1) }],
    ["a staging label on the PRODUCTION database", { APP_ENV: "staging", NEXT_PUBLIC_SUPABASE_URL: PRODUCTION_URL, PHOENIX_STAGING_TEST_SIGNIN_KEY: KEY }],
  ] as const) {
    withEnv(env, () => {
      assert.equal(isStagingTestSignInEnabled(), false, `${label} opens nothing`);
      assert.equal(stagingTestSignInKeyMatches(test, env.PHOENIX_STAGING_TEST_SIGNIN_KEY ?? KEY), false, `${label}: the key is refused`);
    });
  }

  // ── Wired into the one credential check, after the account's own password ──────────────────────
  const credentials = stripComments(readFileSync(join(process.cwd(), "src/lib/auth/credentials.ts"), "utf8"));
  const start = credentials.indexOf("export async function authenticateLoginId(");
  const body = credentials.slice(start, credentials.indexOf("\nexport ", start + 10));
  const bcrypt = body.indexOf("await bcrypt.compare(password, row.password_hash)");
  const key = body.indexOf("stagingTestSignInKeyMatches({ isTestPersona: row.is_test_persona === true }, password)");
  assert.ok(bcrypt > 0 && key > bcrypt, "the key is tried only after the account's own password");
  assert.match(body, /!passwordMatches && stagingTestSignInKeyMatches\(/, "a matching password never reaches the key");
  assert.ok(
    body.indexOf("isLinkedEmployeeAccessRevoked(") > key,
    "a key sign-in still meets the mirrored person's departure check",
  );
  // The key is read in exactly one place.
  const elsewhere = ["src/lib/auth/server.ts", "app/api/auth/login/route.ts"].filter((file) =>
    readFileSync(join(process.cwd(), file), "utf8").includes("PHOENIX_STAGING_TEST_SIGNIN_KEY"),
  );
  assert.deepEqual(elsewhere, [], "the staging key is read only by src/lib/auth/staging-test-sign-in.ts");
}
