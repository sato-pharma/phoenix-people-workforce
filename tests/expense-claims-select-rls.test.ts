import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * expense_claims may be READ by `authenticated`, and only under the rule its predecessors used.
 *
 * THE INCIDENT (2026-08-12). PHOENIX_EXPENSE_CLAIMS_READ was set to "true" in production before
 * expense_claims had any of this. The read path runs as `authenticated`, the table had one policy
 * (service_role) and no grant, and /api/admin/outstation/expenses returned 500 for about three and
 * a half hours. The error carried its own hint — "GRANT SELECT ON public.expense_claims TO
 * authenticated" — and following that hint alone would have been the dangerous half of the job:
 * a grant with no matching SELECT policy either denies everything or, paired with a careless
 * policy, exposes all 375 claims to every logged-in user.
 *
 * What this file guards is the part a later edit is most likely to get wrong: the SELECT predicate
 * keeps the two legacy manage-predicates APART. outstation_expenses answered to
 * phx_can_manage_payroll(); outstation_expense_requests answered to phx_can_manage_outstation().
 * Collapsing them into one OR reads like a simplification and is a privilege widening — an
 * outstation manager gaining sight of rows only payroll could see.
 */
export async function runExpenseClaimsSelectRlsTests() {
  const sql = readFileSync(
    new URL("../supabase/migrations/20260812213000_expense_claims_select_rls.sql", import.meta.url),
    "utf8",
  );
  const code = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  // ── SELECT only. The switch that caused the incident is a READ switch. ─────
  assert.match(code, /grant select on public\.expense_claims to authenticated/i, "the read grant must be here");
  for (const write of ["insert", "update", "delete", "all"]) {
    assert.doesNotMatch(
      code,
      new RegExp(`grant\\s+${write}\\b[^;]*\\bto\\s+authenticated`, "i"),
      `this migration must not grant ${write.toUpperCase()} to authenticated — writes still go to the legacy tables`,
    );
  }

  // ── The grant comes AFTER the policy that makes it safe ───────────────────
  const policyAt = code.indexOf("create policy expense_claims_select_access");
  const grantAt = code.search(/grant select on public\.expense_claims to authenticated/i);
  assert.ok(policyAt > 0, "the select policy must exist");
  assert.ok(
    grantAt > policyAt,
    "the grant must come after the policy — a reader must never find the grant ahead of the protection",
  );

  // ── The two manage predicates stay APART, each tied to its provenance ─────
  assert.match(
    code,
    /legacy_expense_id is not null and \(select private\.phx_can_manage_payroll\(\)\)/,
    "a row from outstation_expenses must still answer to phx_can_manage_payroll",
  );
  assert.match(
    code,
    /legacy_request_id is not null and \(select private\.phx_can_manage_outstation\(\)\)/,
    "a row from outstation_expense_requests must still answer to phx_can_manage_outstation",
  );

  // The bare, provenance-free OR of both predicates is the widening this guards against. It is
  // legitimate for exactly one branch: a new-model claim with NEITHER legacy id.
  const bareOr = [...code.matchAll(/phx_can_manage_payroll\(\)\)\s*or\s*\(select private\.phx_can_manage_outstation/g)];
  assert.equal(
    bareOr.length,
    1,
    "the two manage predicates may only be OR'd together in the no-legacy-id branch — anywhere else " +
      "an outstation manager gains sight of payroll-only rows",
  );
  const guardedBranch = /legacy_expense_id is null\s*and legacy_request_id is null\s*and \(\(select private\.phx_can_manage_payroll/;
  assert.match(code, guardedBranch, "the combined branch must be gated on there being no legacy id at all");

  // ── The resigned-employee exclusion ───────────────────────────────────────
  //
  // Both legacy policies end with it, it is the clause with a privacy consequence, and it is the
  // easiest to lose when a predicate is reformatted.
  assert.match(
    code,
    /and not \(lower\(coalesce\(employee_hr_id, ''::text\)\) in \(select private\.phx_resigned_hr_ids\(\)\)\)/,
    "a manager must not see a resigned employee's expenses — this clause is copied from both legacy policies",
  );

  // ── RLS must be asserted, not assumed ─────────────────────────────────────
  assert.match(code, /relrowsecurity/, "the migration must assert RLS is actually on, or the policy is decoration");

  // ── The helpers are checked to exist before the policy leans on them ──────
  for (const fn of [
    "phx_can_manage_payroll",
    "phx_can_manage_outstation",
    "phx_has_company_access",
    "phx_current_hr_id",
    "phx_visible_hr_ids",
    "phx_resigned_hr_ids",
  ]) {
    assert.ok(code.includes(fn), `the migration must reference ${fn}`);
  }

  console.log("  expense_claims RLS: select-only, grant after policy, manage predicates kept apart");
  console.log("  expense_claims RLS: resigned-employee exclusion preserved from both legacy policies");
}
