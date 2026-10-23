import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { shouldRepairSupabaseAuthBridge } from "../src/lib/auth/supabase-bridge-repair.ts";
import { clientSafeErrorMessage } from "../src/lib/http/api-errors.ts";

function source(path: string) {
  return readFileSync(path, "utf8");
}

/** What `supabase.auth.signInWithPassword` throws when GoTrue refuses the password. */
function authApiError(message: string) {
  const error = new Error(message);
  error.name = "AuthApiError";
  (error as Error & { status?: number }).status = 400;
  return error;
}

/**
 * The bridge repair must be CLASSIFIED ON THE RAW MESSAGE.
 *
 * `clientSafeErrorMessage` redacts an infrastructure error, and `AuthApiError` is one by name — so
 * it answers with the caller's fallback sentence, never "Invalid login credentials". The login
 * route tested the redacted sentence against the repairable-failure pattern until 23 Oct 2026,
 * which could never match: repair was skipped for every user who already had an identity, the
 * login fell through to the warning path, and a SUCCESSFUL login left a `Failed to create Supabase
 * auth session` row in `app_error_events` (14 rows, 11 real people, all signed in).
 */
function runBridgeRepairClassificationTests() {
  const fallback = "Failed to create Supabase auth session.";
  const refused = authApiError("Invalid login credentials");

  // The premise: redaction really does throw GoTrue's words away.
  assert.equal(
    clientSafeErrorMessage(refused, fallback, { report: false }),
    fallback,
    "AuthApiError is infrastructure, so the client-safe message is the fallback — never GoTrue's text",
  );

  // The bug this pins: an existing identity plus a refused password must still repair.
  assert.equal(
    shouldRepairSupabaseAuthBridge({
      authEmail: "b-10@phoenix.local",
      authUserId: "11111111-2222-3333-4444-555555555555",
      error: refused,
    }),
    true,
    "a user WITH an identity whose Supabase password is refused must still repair — Phoenix already verified that password, so the bridge is what drifted",
  );

  // Classifying on the redacted sentence is exactly what must never come back.
  assert.equal(
    shouldRepairSupabaseAuthBridge({
      authEmail: "b-10@phoenix.local",
      authUserId: "11111111-2222-3333-4444-555555555555",
      error: new Error(fallback),
    }),
    false,
    "the fallback sentence itself is not a repairable failure — if this ever reads true the pattern has been widened into matching its own redaction",
  );

  // A missing half of the link repairs whatever the message says.
  assert.equal(
    shouldRepairSupabaseAuthBridge({ authEmail: null, authUserId: null, error: authApiError("boom") }),
    true,
    "no identity at all must always repair",
  );
  assert.equal(
    shouldRepairSupabaseAuthBridge({
      authEmail: null,
      authUserId: "11111111-2222-3333-4444-555555555555",
      error: authApiError("boom"),
    }),
    true,
    "an id with no auth email is a half-built link and must repair",
  );

  // A genuine outage is not a credential drift: it warns, it does not re-provision.
  assert.equal(
    shouldRepairSupabaseAuthBridge({
      authEmail: "b-10@phoenix.local",
      authUserId: "11111111-2222-3333-4444-555555555555",
      error: authApiError("upstream connect error or disconnect/reset before headers"),
    }),
    false,
    "an unreachable GoTrue must NOT drag the login into a re-provision it cannot complete",
  );

  // And the route must call it rather than re-implementing the test on a redacted string.
  // Comments are stripped first: the route explains the old defect in prose, and that prose
  // names the very call this asserts is gone.
  const loginRoute = source("app/api/auth/login/route.ts");
  const loginRouteCode = loginRoute.replace(/^\s*(?:\/\/|\*|\/\*).*$/gm, "");
  assert.match(
    loginRouteCode,
    /const shouldRepairBridge = shouldRepairSupabaseAuthBridge\(/,
    "the login route must classify through shouldRepairSupabaseAuthBridge",
  );
  assert.doesNotMatch(
    loginRouteCode,
    /clientSafeErrorMessage\([^)]*\{\s*report:\s*false\s*\}\s*\)/,
    "nothing in the login route may classify on a redacted message again — that is the defect itself",
  );
}

// Locks the login-bridge hardening: a failed Supabase-auth sign-in on the login
// hot path must NOT fall into the paginated user scan / admin.createUser sequence
// (that thrash is what produced the ~10s "Signing in…"). Also locks the one-time
// password-hash re-sync migration that makes GoTrue verify the same password Phoenix
// already does.
export function runLoginBridgeResyncHardeningTests() {
  runBridgeRepairClassificationTests();

  const identity = source("src/lib/auth/supabase-identity.ts");

  // Paginated email scan is bounded (no 10-page worst case).
  assert.doesNotMatch(identity, /page\s*<=\s*10/, "the auth-user scan must not page up to 10");
  assert.match(identity, /authUserListMaxPages\s*=\s*3/, "the auth-user scan must be capped to a few pages");
  assert.match(identity, /page\s*<=\s*authUserListMaxPages/, "the scan loop must use the capped page bound");

  // provisionSupabaseAuthIdentity accepts a hotPath option and short-circuits on it.
  assert.match(identity, /options\?:\s*\{\s*hotPath\?:\s*boolean\s*\}/, "must accept a hotPath option");
  assert.match(identity, /if\s*\(options\?\.hotPath(?:\s*&&\s*![a-zA-Z0-9_]+)?\)\s*throw/, "hotPath must fail fast instead of scanning/creating");

  // Login route uses the hot-path fast-fail (never the heavy repair) on the login request.
  const loginRoute = source("app/api/auth/login/route.ts");
  assert.match(
    loginRoute,
    /provisionSupabaseAuthIdentity\([\s\S]*?\},\s*\{\s*hotPath:\s*true\s*\}\)/,
    "login must call the bridge repair with hotPath:true",
  );

  // The one-time re-sync migration exists and is scoped + reversible.
  const migrationDir = "supabase/_migrations_archive/pre-baseline-2026-07-11";
  const migrationFile = readdirSync(migrationDir).find((name) =>
    name.includes("resync_gotrue_password_hashes"),
  );
  assert.ok(migrationFile, "the GoTrue password-hash re-sync migration must be present");

  const migration = source(`${migrationDir}/${migrationFile}`);
  assert.match(migration, /cleanup_backup\.auth_users_pw_backup/, "must back up the column before updating");
  assert.match(migration, /update auth\.users/, "must re-sync auth.users password hashes");
  assert.match(migration, /encrypted_password\s*=\s*a\.password_hash/, "must copy the Phoenix hash into GoTrue");
  assert.match(migration, /encrypted_password is distinct from a\.password_hash/, "must only touch mismatched rows");
  assert.match(migration, /a\.password_hash like '\$2%'/, "must only copy well-formed bcrypt hashes");
}
