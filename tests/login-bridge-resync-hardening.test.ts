import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

function source(path: string) {
  return readFileSync(path, "utf8");
}

// Locks the login-bridge hardening: a failed Supabase-auth sign-in on the login
// hot path must NOT fall into the paginated user scan / admin.createUser sequence
// (that thrash is what produced the ~10s "Signing in…"). Also locks the one-time
// password-hash re-sync migration that makes GoTrue verify the same password Phoenix
// already does.
export function runLoginBridgeResyncHardeningTests() {
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
  const migrationDir = "supabase/migrations";
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
