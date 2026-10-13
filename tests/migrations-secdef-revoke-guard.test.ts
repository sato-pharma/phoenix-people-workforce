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

  // ── And every function a new migration creates must PIN search_path — per FUNCTION ────────────
  //
  // A function with no `set search_path` resolves its unqualified names through whatever the
  // CALLER's search_path happens to be; production's linter calls it `function_search_path_mutable`
  // and the floor is 0. It stood at 2 on 2026-10-13: `public.sos_unmapped_customers` and
  // `public.phoenix_crm_customers_no_double_add`, both pinned by
  // 20261013030000_pin_search_path_on_the_last_two_functions.sql.
  //
  // 🔴 PER FUNCTION, BECAUSE THE MISS THAT PROMPTED IT WOULD PASS A PER-FILE CHECK.
  // 20261012200000_phoenix_crm_a_doctor_is_on_a_seat_once.sql pins search_path on both of its
  // SECURITY DEFINER functions and missed the third — a trigger function, SECURITY INVOKER — so the
  // file carries the clause twice and still left one function mutable.
  const SEARCH_PATH_CUTOFF = "20261013000000";
  const stripComments = (raw: string) =>
    raw
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("--");
        return idx >= 0 ? line.slice(0, idx) : line;
      })
      .join("\n");

  const unpinned: string[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && /^\d{14}_/.test(f) && f.slice(0, 14) >= SEARCH_PATH_CUTOFF)
    .sort()) {
    const sql = stripComments(readFileSync(`${dir}/${file}`, "utf8"));
    const creates = /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi;
    let match: RegExpExecArray | null;
    while ((match = creates.exec(sql)) !== null) {
      const rest = sql.slice(match.index);
      const bodyAt = rest.search(/\bas\s+(?:\$[a-z0-9_]*\$|'|begin\s+atomic\b)/i);
      const header = bodyAt === -1 ? rest : rest.slice(0, bodyAt);
      if (!/\bset\s+search_path\b/i.test(header)) unpinned.push(`${file}: public.${match[1]}()`);
    }
  }
  assert.deepEqual(
    unpinned,
    [],
    `Every function created by a migration dated >= ${SEARCH_PATH_CUTOFF} must pin search_path in its ` +
      `header (set search_path to 'public'), per function — a sibling in the same file carrying the ` +
      `clause does not cover it. Unpinned: ${unpinned.join(", ")}`,
  );

  // The fast check carries the same rule (scripts/check-migrations.mjs rule 4b), so it surfaces in
  // under a second instead of after a build — the reason the SECURITY DEFINER rule above is
  // duplicated there too. Pin the rule's presence AND the fact that the message names the function.
  const checkSource = readFileSync("scripts/check-migrations.mjs", "utf8");
  assert.match(
    checkSource,
    /without pinning search_path/,
    "scripts/check-migrations.mjs must fail on a function created without a pinned search_path — " +
      "this test only runs inside the full suite, and the per-file blind spot is what let the last one through",
  );
  assert.match(
    checkSource,
    /SEARCH_PATH_CUTOFF/,
    "the fast check's rule must carry its own cutoff constant, so it ratchets on new work rather than " +
      "sweeping 865 historical migrations",
  );
}
