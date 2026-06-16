import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

/**
 * Concurrency contract for the decideEmployeePlan path.
 *
 * Migration 20260617090000 introduced phx_weekly_plan_decide, which takes the
 * caller's `expected_revision`, SELECT FOR UPDATEs the header, and raises
 * `weekly_plan_revision_conflict` if the row has moved on. The service-side
 * wrapper rethrows that as `WeeklyPlanRpcError({code:"revision_conflict"})`,
 * which the route handler maps to HTTP 409.
 *
 * This test pins two things from the TS layer (the actual SQL race is
 * verified by PR 4 against prod with TEST-WP-* tagged rows):
 *
 *   1. The service.ts function passes the freshly-loaded `plan.revision`
 *      into the RPC's `p_expected_revision` argument — i.e. the optimistic
 *      lock is wired and not silently zeroed.
 *   2. A direct rpc-error payload whose message starts with
 *      `weekly_plan_revision_conflict:` is rethrown as a WeeklyPlanRpcError
 *      with the right code / HTTP 409 status. This is the path the route
 *      handler matches on to produce the user-facing "refresh and try
 *      again" diagnostic.
 */
export function runWeeklyPlansConcurrencyTests() {
  const serviceSource = readFileSync(
    new URL("../src/lib/weekly-planning/service.ts", import.meta.url),
    "utf8",
  );

  // ── (1) decideEmployeePlan threads plan.revision into the RPC ─────────────
  // The decide flow reads the plan, computes nextStatus client-side for the
  // audit log, then calls rpcDecidePlan with `expectedRevision: plan.revision`.
  // The closure around `plan.revision` is the optimistic-lock token; nothing
  // else may be substituted. A regression that hard-codes a constant (e.g. 0
  // or 1) would silently disable conflict detection.
  assert.match(
    serviceSource,
    /await rpcDecidePlan\(\{[\s\S]*?expectedRevision: plan\.revision[\s\S]*?\}\)/,
    "decideEmployeePlan must pass plan.revision (the fresh read) as expectedRevision to rpcDecidePlan",
  );

  // The rpc-call wrapper itself maps the inbound TS field to the SQL
  // p_expected_revision parameter. If anyone renames or drops this field,
  // the optimistic-lock guard becomes a no-op.
  assert.match(
    serviceSource,
    /rpc\("phx_weekly_plan_decide"[\s\S]*?p_expected_revision: input\.expectedRevision/,
    "rpcDecidePlan must thread input.expectedRevision into the RPC's p_expected_revision arg",
  );

  // ── (2) Conflict-error rethrow shape ─────────────────────────────────────
  // The TS layer recognises the supabase-js error whose `.message` starts
  // with `weekly_plan_revision_conflict:` (the prefix the SQL function uses
  // in `RAISE EXCEPTION '...'`) and rethrows it as a typed
  // WeeklyPlanRpcError with HTTP 409 status. Any future refactor of the
  // error class must preserve this prefix-match.
  assert.match(
    serviceSource,
    /if \(message\.startsWith\("weekly_plan_revision_conflict"\)\)[\s\S]*?WeeklyPlanRpcError\(\s*"revision_conflict"/,
    "rethrowWeeklyPlanRpcError must recognise weekly_plan_revision_conflict: and emit revision_conflict",
  );
  assert.match(
    serviceSource,
    /this\.status = code === "not_found" \? 404 : 409/,
    "WeeklyPlanRpcError must map revision_conflict and invalid_transition to HTTP 409",
  );

  // ── (3) Acknowledge path threads its own revision token ──────────────────
  // The acknowledge RPC takes the same revision lock; concurrent HR acks on
  // a final_approved plan must not double-update.
  assert.match(
    serviceSource,
    /await rpcAcknowledgePlan\(\{[\s\S]*?expectedRevision: plan\.revision[\s\S]*?\}\)/,
    "acknowledgeEmployeePlan must pass plan.revision into rpcAcknowledgePlan",
  );

  // ── (4) Submit paths read-then-pass-revision pattern ────────────────────
  // Three submit paths exist: create-new (plan.revision == 1), revise-from-
  // closed (new revision row), and editable-update (existing.revision). All
  // must hand a real revision number to rpcSubmitPlan; we assert at least
  // three distinct call sites exist (one per path).
  const submitCallSites = (serviceSource.match(/await rpcSubmitPlan\(\{/g) ?? []).length;
  assert.ok(
    submitCallSites >= 3,
    `expected at least 3 rpcSubmitPlan call sites (create-new, revise, editable-update); found ${submitCallSites}`,
  );
}
