import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { ApiError } from "../src/lib/http/api-errors.ts";
import { assertRealSessionForDecision, isPreviewSession } from "../src/lib/auth/preview-session-guard.ts";

/**
 * A preview session may LOOK at anything and DECIDE nothing.
 *
 * ── WHAT HAPPENED ─────────────────────────────────────────────────────────────────────────────
 *
 * 2026-09-03, 00:43 Cairo: an outstation expense of 383.62 was approved on PRODUCTION by
 * `dev.preview` — a dev-preview session, not a person. It landed in
 * `outstation_expenses.approved_by` and travelled through `phx_refresh_expense_claims` into
 * `expense_claims.decided_by_hr_id`, the column the claims screen reads to answer "who decided
 * this". Nothing was paid, because that row carried no approved amount. That was luck.
 *
 * ── THE ASSERTION THAT MATTERS MOST IS THE ENVIRONMENT ONE ────────────────────────────────────
 *
 * The natural "improvement" to this guard is to scope it: *surely this only matters in
 * production?* That change would restore the exact hole. `.env.local` points at the production
 * Supabase project, so `pnpm run dev` writes production data from a runtime that reports itself as
 * development — the dangerous caller is precisely the one an `isProductionRuntime()` check waves
 * through, while the code reads as though it were protected.
 *
 * So the guard is pinned as having NO environment term at all, and this test says why in its own
 * failure message.
 */
export function runPreviewSessionCannotDecideTests() {
  // ── who is a preview session ─────────────────────────────────────────────────────────────────
  assert.equal(isPreviewSession({ source: "dev-header" }), true, "dev-auth is a preview session");
  assert.equal(isPreviewSession({ source: "session" }), false, "a real signed-in person is not");
  assert.equal(isPreviewSession({ source: "system" }), false, "a system caller is not");
  assert.equal(isPreviewSession({ source: "guest" }), false, "an unauthenticated caller is not");

  // ── and what it may not do ───────────────────────────────────────────────────────────────────
  let thrown: unknown = null;
  try {
    assertRealSessionForDecision({ source: "dev-header" }, "approve an outstation expense");
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof ApiError, "a preview session must be refused with an ApiError");
  assert.equal((thrown as ApiError).status, 403, "refusing a preview decision is a 403");
  assert.match(
    (thrown as ApiError).message,
    /approve an outstation expense/,
    "the refusal must name the decision it stopped, so a developer knows what they hit",
  );
  assert.match(
    (thrown as ApiError).message,
    /Sign in as yourself/,
    "and must say how to proceed - the fix is not obvious to somebody who forgot they were previewing",
  );

  for (const source of ["session", "system", "guest"] as const) {
    assert.doesNotThrow(
      () => assertRealSessionForDecision({ source }, "approve an outstation expense"),
      `${source} must pass straight through - this guard is about previews, not about authority`,
    );
  }

  // ── THE ENVIRONMENT PIN ──────────────────────────────────────────────────────────────────────
  const guard = readFileSync("src/lib/auth/preview-session-guard.ts", "utf8");
  const body = guard.slice(guard.indexOf("export function isPreviewSession"));
  for (const term of ["isProductionRuntime", "APP_ENV", "NODE_ENV", "VERCEL_ENV", "currentEnvironmentLabel"]) {
    assert.equal(
      body.includes(term),
      false,
      `the guard must not test ${term}. The incident was a LOCAL runtime holding PRODUCTION `
        + `credentials, so an environment check waves through the only caller this exists to stop `
        + `- while reading as though it were protected.`,
    );
  }

  // ── PAYROLL: every write path, found by what it stamps rather than by a hand-kept list ──────
  //
  // A list of guarded function names goes stale the first time somebody adds an eleventh
  // mutation, and goes stale silently - the new one is simply absent from the list, and nothing
  // reads as wrong. So the set is DERIVED: `actorId(access)` is what stamps who did a thing, it
  // is called by all ten payroll write paths and by no read path, so any function that calls it
  // is by definition writing as somebody and must refuse a preview session first.
  //
  // The guard could not go inside assertAutomatedPayrollHrActor, which would have covered
  // everything in one line: that same assert gates the READ paths too (getRunView,
  // getReconciliation, getPopulationDiff, buildRunSheet), and blocking those would break the
  // one thing a preview session legitimately exists to do - look at the app as another role.
  const payroll = readFileSync("src/lib/automated-payroll/run-service.ts", "utf8");
  const payrollLines = payroll.split("\n");
  const bodies = new Map<string, string[]>();
  let currentFn = "(module scope)";
  for (const line of payrollLines) {
    const declared = /^export (?:async )?function (\w+)/.exec(line);
    if (declared) currentFn = declared[1];
    const body = bodies.get(currentFn) ?? [];
    body.push(line);
    bodies.set(currentFn, body);
  }

  const stampsAnActor: string[] = [];
  const unguarded: string[] = [];
  for (const [name, body] of bodies) {
    const text = body.join("\n");
    if (!text.includes("actorId(access)")) continue;
    stampsAnActor.push(name);
    if (!text.includes("assertRealSessionForDecision(access,")) unguarded.push(name);
  }

  // A positive control. If the marker ever stops appearing - renamed, or the stamping moved -
  // every function would read as clean and this whole check would certify nothing.
  assert.ok(
    stampsAnActor.length >= 10,
    `only ${stampsAnActor.length} payroll functions stamp an actor; the marker this check relies `
      + `on has moved, so the sweep is measuring nothing`,
  );
  assert.deepEqual(
    unguarded,
    [],
    `these payroll functions write as somebody but do not refuse a preview session first - add `
      + `assertRealSessionForDecision(access, "...") ABOVE the authority check:\n`
      + unguarded.join("\n"),
  );

  // ── and the actor they stamp is the canonical HR id, with the markers left alone ────────────
  //
  // Same shape and same trap as outstation_expenses.approved_by: an HR id, else a login id, else
  // the `system` marker. Canonicalising the whole expression would stamp SYSTEM and DEV.PREVIEW
  // into salary_batches.approved_by and every payroll audit row.
  const payrollPermissions = readFileSync("src/lib/automated-payroll/permissions.ts", "utf8");
  assert.ok(
    payrollPermissions.includes("return hrIdForStorage(access.hrId) ?? access.loginId ?? \"system\";"),
    "actorId must canonicalise ONLY the HR-id branch - access.hrId is the lowercase comparison "
      + "key, and stamping it splits one person in two in every per-actor payroll report",
  );

  // ── and it must run BEFORE the permission check, because a preview can hold any role ─────────
  const expenses = readFileSync("src/lib/outstation/expenses.ts", "utf8");
  const guardAt = expenses.indexOf('assertRealSessionForDecision(accessContext, "approve an outstation expense")');
  const permissionAt = expenses.indexOf("assertManualPayrollExpenseApprovalAccess(accessContext)");
  assert.ok(guardAt > -1, "the outstation approval path must refuse a preview session");
  assert.ok(permissionAt > -1, "the manual payroll approval permission check must still be there");
  assert.ok(
    guardAt < permissionAt,
    "the preview guard must come BEFORE the permission check - a preview session can be minted "
      + "holding any role, so every check after it would pass",
  );
}
