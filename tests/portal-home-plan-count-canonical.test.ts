// verified failing at be6a565c (pre-fix: home-snapshot.ts queried .from("weekly_plans") directly;
// reverting the fix fires assertion 1, this file's headline, not an incidental neighbour)
//
// The portal home card "plans awaiting my approval" used to run its own count against
// `weekly_plans`. That table is the SUPERSEDED plan generation: the live engine is
// `employee_plan_headers` / `_items` / `_decisions`, and `weekly_plans` holds ZERO rows in
// production (verified 2026-08-13 by real count(*), not by planner stats — n_live_tup is stale in
// this database and reports populated tables as empty).
//
// So the card was not merely stale, it was structurally pinned to 0: every portal manager saw
// "0 plans awaiting approval" no matter how many were queued, while the sidebar badge — which
// calls countPlanAwaiting() — showed the real number. Two counts of one thing, one of them
// always wrong.
//
// The fix routes the card through the same countPlanAwaiting() the badge uses, so the two cannot
// diverge again. These assertions pin that: a reader must not reintroduce a second plan count,
// and must not point this file back at the dead table.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

export function runPortalHomePlanCountCanonicalTests() {
  const snapshot = readFileSync("src/lib/employee-portal/home-snapshot.ts", "utf8");

  // 1. HEADLINE: the superseded table must not be queried here at all. `weekly_plans` survives
  //    elsewhere in the repo as a PERMISSION RESOURCE KEY (assertPermission(access,
  //    "weekly_plans", "read")), which is legitimate and unrelated — so this asserts on the
  //    table-read form specifically, not on the bare word.
  assert.ok(
    !/\.from\(\s*["'`]weekly_plans["'`]\s*\)/.test(snapshot),
    "home-snapshot.ts must not read the superseded, empty `weekly_plans` table — the live plan engine is employee_plan_*, and querying weekly_plans pins the manager's home count to 0",
  );
  assert.ok(
    !/\.from\(\s*["'`]weekly_plan_days["'`]\s*\)/.test(snapshot),
    "home-snapshot.ts must not read `weekly_plan_days` either — same superseded generation, also zero rows",
  );

  // 2. It must use the canonical responder count, not a hand-rolled replacement query against
  //    employee_plan_headers. Re-querying the new table directly would fix the number today but
  //    recreate the same divergence the moment the responder chain (manager step vs CEO step)
  //    changes in one place and not the other.
  assert.match(
    snapshot,
    /import \{ countPlanAwaiting \} from "@\/lib\/approvals-hub\/service"/,
    "home-snapshot.ts must import countPlanAwaiting from the approvals-hub service — that is the one implementation the sidebar badge also uses",
  );
  assert.match(
    snapshot,
    /countPlanAwaiting\(access\)/,
    "the manager plan count must be produced by countPlanAwaiting(access), so the home card and /api/approvals/plan/pending-count can never disagree",
  );
  assert.ok(
    !/\.from\(\s*["'`]employee_plan_headers["'`]\s*\)/.test(snapshot),
    "home-snapshot.ts must not hand-roll its own employee_plan_headers count — reuse countPlanAwaiting instead, or the responder logic forks again",
  );

  // 3. The canonical implementation must still be real and still read the live table. Without
  //    this, assertion 2 could pass against a countPlanAwaiting() that had itself been repointed
  //    at the dead table, and the whole test would be green while the bug was back.
  const approvalsHub = readFileSync("src/lib/approvals-hub/service.ts", "utf8");
  assert.match(
    approvalsHub,
    /export async function countPlanAwaiting\(/,
    "approvals-hub/service.ts must still export countPlanAwaiting — home-snapshot.ts and the plan badge both depend on it",
  );
  assert.match(
    approvalsHub,
    /\.from\("employee_plan_headers"\)/,
    "the canonical plan count must read employee_plan_headers (the live plan engine); if this moves, home-snapshot.ts follows it automatically rather than forking",
  );
  assert.ok(
    !/\.from\(\s*["'`]weekly_plans["'`]\s*\)/.test(approvalsHub),
    "approvals-hub/service.ts must not fall back to the superseded weekly_plans table",
  );
}
