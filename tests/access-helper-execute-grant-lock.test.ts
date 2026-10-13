import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// The Supabase advisor raises `authenticated_security_definer_function_executable` eleven times, and
// every reading of that WARN tempts the same migration: take `authenticated`'s EXECUTE off the
// helpers. It is the wrong migration, in both directions, and the repository has now drafted it
// twice (2026-10-08, 2026-10-13) off a `pg_policy` scan that read 0 callers.
//
//  - Five of the eleven are load-bearing in LIVE RLS (91 policies between them, all `to
//    authenticated`): a policy expression is evaluated with the QUERYING role's privileges, so
//    revoking the grant breaks payroll, deductions and sales reads for every signed-in user.
//  - The other six look spare to a `pg_policy` scan and are not: `scripts/phase24-*` calls five of
//    them BY RPC as a signed-in `authenticated` user, through a local `rpcValue(client, name)`
//    helper — which is why grepping for `rpc("current_…")` finds nothing and reads as proof of no
//    caller — and `phase25-*`/`phase26-*` reach the sixth through policies they create at smoke time.
//
// So this file pins the decision AND the evidence it rests on. It is static: no database, no network.

const ELEVEN = [
  "current_access_can_manage_employees",
  "current_access_can_manage_payroll",
  "current_access_can_see_employee",
  "current_access_hr_id",
  "current_access_is_company_reader",
  "current_access_is_finance",
  "current_access_is_hr",
  "current_access_is_super_admin",
  "current_access_role",
  "current_access_scope",
  "current_phoenix_role",
] as const;

// phase24 asserts each of these against the signed-in role's expected answer, by RPC.
const CALLED_BY_REAL_AUTH_SMOKE = [
  "current_phoenix_role",
  "current_access_role",
  "current_access_scope",
  "current_access_is_finance",
  "current_access_can_manage_payroll",
] as const;

const MIGRATIONS_DIR = "supabase/migrations";
const BASELINE_JSON = "scripts/advisor-baseline.json";
const BASELINE_DOC = "docs/security/supabase-advisor-baseline.md";
const PHASE24 = "scripts/phase24-real-auth-rls-api-smoke.ts";
const SMOKE_SCRIPTS = [
  "scripts/phase25-staging-rls-mutation-smoke.ts",
  "scripts/phase26-staging-browser-auth-mutation-smoke.ts",
];

const read = (file: string) => readFileSync(file, "utf8");

// A revoke of EXECUTE (or ALL) on a function, from a grantee list that includes a BROWSER role.
// `FROM PUBLIC` alone is deliberately not a match: the production schema baseline revokes PUBLIC on
// every function and then grants the browser roles back, which is the posture we are keeping.
const REVOKE = /revoke\s+(?:all(?:\s+privileges)?|execute)\s+on\s+function\s+([^;]*?)\s+from\s+([^;]*);/gis;

type Hit = { file: string; fn: string; grantees: string };

function revokesOfTheEleven(dir: string): Hit[] {
  const hits: Hit[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
    const sql = read(path.join(dir, file));
    for (const match of sql.matchAll(REVOKE)) {
      const grantees = match[2].toLowerCase();
      if (!/\b(anon|authenticated)\b/.test(grantees)) continue;
      const fn = ELEVEN.find((name) => new RegExp(`\\b${name}\\b`).test(match[1]));
      if (fn) hits.push({ file, fn, grantees: grantees.replace(/\s+/g, " ").trim() });
    }
  }
  return hits;
}

export async function runAccessHelperExecuteGrantLockTests() {
  // 1. No migration may take a browser role's EXECUTE off any of the eleven.
  const migrations = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
  assert.ok(migrations.length > 500, `expected the full migration history, read ${migrations.length} files`);
  const hits = revokesOfTheEleven(MIGRATIONS_DIR);
  assert.deepEqual(
    hits,
    [],
    "a migration revokes a browser role's EXECUTE on an access helper RLS depends on — " +
      "that breaks live payroll RLS and the real-auth smokes, and closes nothing a browser can " +
      "reach (all eleven are already search_path=public pinned with no EXECUTE for anon). " +
      "Read the accepted triage in docs/security/supabase-advisor-baseline.md before changing it:\n" +
      hits.map((h) => `  ${h.file}: ${h.fn} from ${h.grantees}`).join("\n"),
  );

  // 2. The advisor baseline still ACCEPTS all eleven, as a warn, not as something to drive to zero.
  const baseline = JSON.parse(read(BASELINE_JSON)) as {
    categories: Record<string, { accepted: number; severity: string; why: string }>;
  };
  const category = baseline.categories.authenticated_security_definer_function_executable;
  assert.ok(category, `${BASELINE_JSON} no longer carries the advisor category at all`);
  assert.equal(
    category.accepted,
    ELEVEN.length,
    `${BASELINE_JSON} accepts ${category.accepted} but this lock lists ${ELEVEN.length} helpers — ` +
      "if a helper was legitimately revoked, update both and the doc's audit in one change",
  );
  assert.equal(category.severity, "warn");
  assert.match(
    category.why,
    /rpcValue/,
    `${BASELINE_JSON} must keep the reason the "spare" six are not spare — the phase24 rpcValue helper`,
  );

  // 3. The written audit names every one of the eleven, so the next reader triages instead of guessing.
  const doc = read(BASELINE_DOC);
  for (const name of ELEVEN) {
    assert.ok(doc.includes(name), `${BASELINE_DOC} does not name ${name} anywhere in the audit`);
  }

  // 4. The evidence: phase24 still calls the five by RPC, phase25/26 still reach can_see_employee.
  const phase24 = read(PHASE24);
  assert.match(
    phase24,
    /async function rpcValue</,
    `${PHASE24} no longer has the rpcValue helper — the audit's "called as authenticated" evidence ` +
      "is written in terms of it, so re-read and re-word the triage rather than deleting this check",
  );
  for (const name of CALLED_BY_REAL_AUTH_SMOKE) {
    assert.ok(
      new RegExp(`rpcValue<[^>]*>\\(client,\\s*"${name}"\\)`).test(phase24),
      `${PHASE24} no longer calls ${name} by RPC as a signed-in user — that call is the proof the ` +
        "grant is load-bearing, and the advisor triage cites it",
    );
  }
  for (const file of SMOKE_SCRIPTS) {
    assert.ok(
      read(file).includes("can_see_employee"),
      `${file} no longer references can_see_employee — it is the sixth helper's only caller`,
    );
  }
}
