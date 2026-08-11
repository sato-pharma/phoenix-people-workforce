import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

/**
 * Every direct_order_* table must have RLS enabled somewhere in the migration history.
 *
 * WHY THIS EXISTS. The MIGRATION LEDGER for `direct_order_pharmacy_validations` (created
 * 2026-08-05) contains no `enable row level security` — four days before 20260809130000 removed the
 * `public` schema default, so in the ledger it inherits anon=arwdDxtm. It was also missed by the
 * revoke sweep that listed the module's other six tables, and no test caught it:
 * phase21-security-hardening asserts RLS on ONE named table, and nothing enumerated new ones.
 *
 * PRODUCTION WAS NEVER EXPOSED — verified against live `pg_class`/`pg_policy` on 2026-08-12: RLS
 * enabled, one `service_role`-named policy, and anon/authenticated absent from the ACL entirely
 * (`has_table_privilege('anon', …, 'SELECT')` = false). The defect is schema-as-code: an environment
 * REBUILT from these migrations gets an unprotected table. That is what this test guards.
 *
 * This is the third table in this repo to ship with that ledger signature (see
 * 20260806010000_share_links_rls_parity.sql, which names backup_employee_crm_identity_20260805 as
 * its precedent). A per-table assertion would have to be remembered for table four; this discovers
 * the tables instead, so a new direct_order_* table without RLS fails on the migration that creates
 * it rather than in a later audit.
 */
export async function runDirectOrderRlsCoverageTests() {
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const all = files.map((f) => readFileSync(new URL(f, dir), "utf8")).join("\n");

  // Discover every direct_order_* table the migrations create, rather than listing them by hand.
  const created = new Set<string>();
  for (const m of all.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(direct_order[a-z_]*)/gi)) {
    created.add(m[1].toLowerCase());
  }
  assert.ok(
    created.size >= 6,
    `expected to discover the direct_order_* tables from migration DDL, found ${created.size} — the ` +
      "regex has drifted from the schema and this test is no longer guarding anything",
  );

  const rlsEnabled = new Set<string>();
  // Static form: alter table public.foo enable row level security;
  for (const m of all.matchAll(
    /alter\s+table\s+(?:public\.)?(direct_order[a-z_]*)\s+enable\s+row\s+level\s+security/gi,
  )) {
    rlsEnabled.add(m[1].toLowerCase());
  }
  // DYNAMIC form: 20260806010000_share_links_rls_parity.sql enables RLS inside a plpgsql loop —
  // `execute format('alter table public.%I enable row level security', v_table)` — over a table
  // list. A static-only regex reports that table as unprotected, which is a false alarm that would
  // get "fixed" by adding a duplicate migration. Credit the tables named in such a loop.
  if (/execute\s+format\(\s*'alter\s+table\s+public\.%I\s+enable\s+row\s+level\s+security'/i.test(all)) {
    for (const m of all.matchAll(/'(direct_order[a-z_]*)'/gi)) {
      rlsEnabled.add(m[1].toLowerCase());
    }
  }

  const missing = [...created].filter((t) => !rlsEnabled.has(t)).sort();
  assert.deepEqual(
    missing,
    [],
    `direct_order_* table(s) with no RLS in the migration ledger: ${missing.join(", ")}. Any ` +
      "environment rebuilt from these migrations creates it reachable through PostgREST with the " +
      "anon key — see 20260812090000_direct_order_pharmacy_validations_rls.sql, which closed the " +
      "same gap for that table.",
  );

  console.log(`  direct-orders RLS coverage: ${created.size} tables discovered, all RLS-enabled`);
}
