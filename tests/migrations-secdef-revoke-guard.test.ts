import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// Recurrence guard for the "anon can EXECUTE new public SECURITY DEFINER functions" leak class.
//
// Root cause (see 20260719170000_phx_harden_public_function_default_execute.sql): a new function in
// `public` inherits the built-in PostgreSQL default grant of EXECUTE to PUBLIC, and every login role
// (incl. anon/authenticated) is a member of PUBLIC — so each newly created SECURITY DEFINER RPC is
// silently callable by the anonymous public key unless a migration explicitly revokes it (exactly how
// the analytics_* overloads leaked, see 20260719160500). The hardening migration flips the DB default,
// but that default is platform-managed and might be reset — so this test is the reliable, in-repo,
// CI-enforced backstop: from the hardening migration forward, any migration that CREATEs a public
// SECURITY DEFINER function MUST also REVOKE EXECUTE FROM PUBLIC (the operative grantee — revoking only
// anon/authenticated is a no-op against a PUBLIC grant).
//
// Historical migrations before the cutoff are grandfathered — the current live exposure they created
// is closed by the explicit + sweep revokes in 20260719160000 and the default-privileges hardening.
export function runMigrationsSecdefRevokeGuardTests() {
  // Cutoff = the hardening migration. Every migration named on/after this must self-revoke.
  const CUTOFF = "20260719170000";
  const dir = "supabase/migrations";
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => /^\d{14}_/.test(f))
    .filter((f) => f.slice(0, 14) >= CUTOFF)
    .sort();

  const offenders: string[] = [];

  for (const file of files) {
    const raw = readFileSync(`${dir}/${file}`, "utf8");
    // Strip line comments so an explanatory comment mentioning "security definer" or a quoted
    // example can't create a false positive or hide a real one.
    const sql = raw
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("--");
        return idx >= 0 ? line.slice(0, idx) : line;
      })
      .join("\n");
    const lower = sql.toLowerCase();

    // Does this migration create a function in the public schema that is SECURITY DEFINER?
    const createsPublicFunction =
      /\bcreate\s+(or\s+replace\s+)?function\s+(public\.)?[a-z_][a-z0-9_]*\s*\(/i.test(sql);
    const hasSecurityDefiner = /\bsecurity\s+definer\b/i.test(sql);
    if (!createsPublicFunction || !hasSecurityDefiner) continue;

    // It must also revoke EXECUTE from PUBLIC (the operative grantee — anon/authenticated inherit
    // EXECUTE via PUBLIC membership, so revoking only those two is a no-op against a PUBLIC grant).
    // Accept an explicit `revoke execute on function ... from ... public ...` or a DO-block sweep
    // that revokes from public via dynamic SQL. We check a revoke-execute statement exists AND
    // `public` appears as a revoke target.
    const hasRevokeExecute = /\brevoke\s+execute\s+on\s+function\b/i.test(lower) ||
      /\brevoke\s+execute\s+on\s+functions\b/i.test(lower) || // ALTER DEFAULT PRIVILEGES form
      /execute\s+format\([^)]*revoke\s+execute/i.test(sql); // sweep via dynamic SQL
    // `from ... public` — the revoke's grantee list includes PUBLIC. Matches "from public",
    // "from public, anon, authenticated", and the dynamic `%s from public, ...` sweep form.
    const revokesPublic = /\bfrom\s+[^;]*\bpublic\b/i.test(lower);

    if (!(hasRevokeExecute && revokesPublic)) {
      offenders.push(file);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Every migration dated >= ${CUTOFF} that creates a public SECURITY DEFINER function must also ` +
      `REVOKE EXECUTE on that function FROM PUBLIC (anon/authenticated inherit EXECUTE via PUBLIC, so ` +
      `revoking only those is a no-op). Offending migrations: ${offenders.join(", ")}`,
  );

  // Sanity: the guard is actually scanning something (so a glob/path regression can't make it a
  // silent no-op). The hardening migration itself must be present at/after the cutoff.
  assert.ok(
    files.includes("20260719170000_phx_harden_public_function_default_execute.sql"),
    "the default-privileges hardening migration must exist and be scanned by this guard",
  );
}
