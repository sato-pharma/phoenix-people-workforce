// The staging test sign-in — ONE definition, read by `authenticateLoginId`.
//
// WHY (owner, 2026-11-03). A test account's password is chosen by the owner alone, through a one-time
// link from /admin/test-accounts, and no Claude session will type a password on production. So no
// session could rehearse a flow as a test account — the Sohag → Assiut stop rehearsal stopped twice at
// the sign-in. On STAGING only, a TEST account (`is_test_persona`) may sign in through the ordinary
// login form with a shared key the owner sets on the staging service instead of its own password.
//
// THREE HALVES, ALL REQUIRED, each refusing on its own:
//   1. `APP_ENV` is exactly `staging` — positive, like the CI smoke login's `ci`: an unset or mistyped
//      APP_ENV opens nothing (it went unset once already, 2026-08 — AGENTS.md §2.3).
//   2. `PHOENIX_STAGING_TEST_SIGNIN_KEY` is set and at least 32 characters long. The owner sets it on
//      the staging Railway service only; it is never a production variable.
//   3. The app is NOT pointed at the production database (`NEXT_PUBLIC_SUPABASE_URL` does not name
//      the production project ref) — a staging label on a production database opens nothing.
// And the account must be a test account: a real login never signs in with the key, whatever it is.
//
// Every read is a literal `process.env.X` at call time — `APP_ENV` is never inlined by the bundler.

import { timingSafeEqual } from "node:crypto";

/** The shortest key the gate accepts — a short key would be guessable through the login form. */
export const STAGING_TEST_SIGN_IN_KEY_MIN_LENGTH = 32;

/** The production Supabase project (AGENTS.md §3). The key never works against it. */
const PRODUCTION_SUPABASE_REF = "ozucdzovmcqvepbozvqf";

/** True only on staging, with a long enough key set, and never against the production database. */
export function isStagingTestSignInEnabled(): boolean {
  const key = process.env.PHOENIX_STAGING_TEST_SIGNIN_KEY ?? "";
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  return (
    process.env.APP_ENV === "staging" &&
    key.length >= STAGING_TEST_SIGN_IN_KEY_MIN_LENGTH &&
    !supabaseUrl.includes(PRODUCTION_SUPABASE_REF)
  );
}

/** Whether `presented` is the staging key for this account — a test account only, compared in constant time. */
export function stagingTestSignInKeyMatches(account: { isTestPersona: boolean }, presented: string): boolean {
  if (!account.isTestPersona || !isStagingTestSignInEnabled()) return false;
  const expected = Buffer.from(process.env.PHOENIX_STAGING_TEST_SIGNIN_KEY ?? "", "utf8");
  const given = Buffer.from(String(presented ?? ""), "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
