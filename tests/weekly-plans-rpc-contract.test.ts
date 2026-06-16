import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/**
 * Migration 20260617090000_weekly_plans_atomic_rpcs.sql introduced four
 * SECURITY DEFINER functions that bundle every weekly-plan state transition
 * into a single atomic write with an optimistic-lock check against the
 * employee_plan_headers.revision column. This test pins:
 *   - the migration exists,
 *   - the four RPCs are defined with SECURITY DEFINER,
 *   - each RPC SELECTs the header FOR UPDATE,
 *   - each RPC raises the typed `weekly_plan_revision_conflict` error code
 *     on a revision mismatch,
 *   - service.ts no longer issues the bare multi-step writes the audit
 *     flagged (UPDATE header THEN INSERT decision-without-RPC, etc.),
 *   - service.ts calls each RPC via supabase.rpc("phx_weekly_plan_…").
 *
 * Pattern mirrors tests/position-vacancy-status-integrity.test.ts.
 */
export function runWeeklyPlansRpcContractTests() {
  const migrationsDir = new URL("../supabase/migrations/", import.meta.url);
  const migrations = readdirSync(migrationsDir);
  const atomicMigration = migrations.find((file) => /weekly_plans_atomic_rpcs\.sql$/.test(file));
  assert.ok(
    atomicMigration,
    "expected a weekly_plans_atomic_rpcs.sql migration to exist (PR 1 of the 10/10 plan)",
  );

  const sql = readFileSync(new URL(atomicMigration!, migrationsDir), "utf8");

  // ── Each RPC is defined SECURITY DEFINER ───────────────────────────────────
  for (const rpc of [
    "phx_weekly_plan_submit",
    "phx_weekly_plan_decide",
    "phx_weekly_plan_acknowledge",
    "phx_weekly_plan_cancel",
  ]) {
    const definitionPattern = new RegExp(
      `create or replace function public\\.${rpc}[\\s\\S]*?security definer`,
      "i",
    );
    assert.match(sql, definitionPattern, `${rpc} must be defined SECURITY DEFINER`);

    const grantPattern = new RegExp(`grant execute on function public\\.${rpc}[^;]*to service_role`, "i");
    assert.match(sql, grantPattern, `${rpc} must be GRANTed to service_role only`);

    // Supabase's default privileges silently grant EXECUTE to authenticated +
    // anon at create time, so REVOKE FROM PUBLIC alone is not enough — all
    // three must be stripped to leave service_role (and the postgres owner)
    // as the only callers. This test pins that pattern.
    const revokePattern = new RegExp(
      `revoke execute on function public\\.${rpc}[^;]*from public,\\s*authenticated,\\s*anon`,
      "i",
    );
    assert.match(
      sql,
      revokePattern,
      `${rpc} must REVOKE EXECUTE from public, authenticated, anon (Supabase defaults grant authenticated+anon at create time)`,
    );
  }

  // ── Optimistic-lock pattern: SELECT FOR UPDATE + revision-conflict raise ──
  const forUpdateCount = (sql.match(/for update/gi) ?? []).length;
  assert.ok(
    forUpdateCount >= 4,
    `expected at least 4 SELECT FOR UPDATE clauses (one per RPC); found ${forUpdateCount}`,
  );

  const conflictCount = (sql.match(/weekly_plan_revision_conflict/g) ?? []).length;
  assert.ok(
    conflictCount >= 4,
    `expected each RPC to raise weekly_plan_revision_conflict; found ${conflictCount} mentions`,
  );

  // ── State-machine guard helper exists + mirrors plan-v1.ts transitions ──
  assert.match(
    sql,
    /create or replace function public\.phx_weekly_plan_next_status/i,
    "phx_weekly_plan_next_status helper must exist to mirror plan-v1.ts transitions in SQL",
  );
  assert.match(
    sql,
    /weekly_plan_invalid_transition/,
    "next-status helper must raise weekly_plan_invalid_transition on forbidden actions",
  );

  // ── service.ts calls each RPC via supabase.rpc(…) ─────────────────────────
  const serviceSource = source("src/lib/weekly-planning/service.ts");
  for (const rpc of [
    "phx_weekly_plan_submit",
    "phx_weekly_plan_decide",
    "phx_weekly_plan_acknowledge",
  ]) {
    const callPattern = new RegExp(`rpc\\("${rpc}"`);
    assert.match(serviceSource, callPattern, `service.ts must call ${rpc} via supabase.rpc()`);
  }

  // ── Error class wired through to route handlers ───────────────────────────
  assert.match(
    serviceSource,
    /export class WeeklyPlanRpcError extends Error/,
    "WeeklyPlanRpcError must be exported so route handlers can map it to HTTP 409",
  );
  assert.match(
    serviceSource,
    /weekly_plan_revision_conflict/,
    "service.ts must recognise the weekly_plan_revision_conflict prefix from the RPC",
  );
  assert.match(
    serviceSource,
    /weekly_plan_invalid_transition/,
    "service.ts must recognise the weekly_plan_invalid_transition prefix from the RPC",
  );

  for (const route of [
    "app/api/weekly-plans/route.ts",
    "app/api/weekly-plans/[id]/route.ts",
    "app/api/weekly-plans/[id]/decision/route.ts",
    "app/api/weekly-plans/[id]/acknowledge/route.ts",
  ]) {
    const routeSource = source(route);
    assert.match(
      routeSource,
      /isWeeklyPlanRpcError/,
      `${route} must import isWeeklyPlanRpcError and surface conflict/not-found as 409/404`,
    );
  }

  // ── Service no longer issues the bare-update path the audit flagged ───────
  // decideEmployeePlan: previously did `.from("employee_plan_headers").update(patch).eq("id", planId)`
  // followed by a separate recordDecision insert. Both moved into the RPC.
  assert.doesNotMatch(
    serviceSource,
    /from\("employee_plan_headers"\)\.update\(patch\)/,
    "decideEmployeePlan must no longer write the header outside the phx_weekly_plan_decide RPC",
  );

  // ── Items writer (replacePlanItems) intentionally stays outside the RPC ──
  // because it only runs while the plan is in an editable status (draft /
  // *_returned) — no decision can land then, so the brief delete-then-insert
  // window is safe. Confirm the helper still exists and is still called.
  assert.match(
    serviceSource,
    /async function replacePlanItems/,
    "replacePlanItems must still exist (items writer stays outside the RPC by design)",
  );
}
