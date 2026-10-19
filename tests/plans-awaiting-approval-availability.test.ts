import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolvePlansAwaitingApproval } from "../src/lib/employee-portal/home-snapshot.ts";
import { countPlanAwaiting, planSourcesUnavailableNotice } from "../src/lib/approvals-hub/service.ts";
import { stripComments } from "./support/comment-strip.ts";
import type { AccessContext } from "../src/lib/auth/permissions.ts";

// The employee-portal home snapshot used to fold a FAILED plans-awaiting-approval lookup into the
// same shape a genuine zero produces: `plansAwaitingManagerApproval: null`, with no signal that the
// zero downstream dashboards then compute (`plansAwaitingManagerApproval ?? 0`) came from a broken
// query rather than an empty inbox. A manager was told "0 plans awaiting your approval" — a
// positive claim, not a neutral one — or, on dashboards gated purely on `totalPending > 0`, shown
// nothing at all. resolvePlansAwaitingApproval() turns the settled promise result into both the
// count AND a `plansCountAvailable` flag the dashboards must check before trusting that count,
// mirroring the existing `pendingCountsAvailable` mechanism for vacation/excuse counts.
//
// The FIRST version of this fix only hardened the `PromiseSettledResult` REJECTED branch below —
// but countPlanAwaiting() (approvals-hub/service.ts) never rejects: its own try/catch used to
// swallow a genuine query failure into a bare `0` and resolve successfully. So the rejected branch
// could never fire in production, and the actual failure path — the one home-snapshot.ts's
// managerPlanCountPromise really takes — still rendered "0 plans awaiting your approval" on a
// broken query. countPlanAwaiting now returns `{ count, available }`, so a source failure is
// expressible without rejecting. The tests below cover both: the outer safety net (a rejected
// PromiseSettledResult) and the real path (a genuine exception inside
// getPlanApprovalsForResponder, surfacing through countPlanAwaiting's own catch).
export async function runPlansAwaitingApprovalAvailabilityTests() {
  // OUTER SAFETY NET: a rejected settled result must report itself as unavailable, and must never
  // resolve to a number — reverting resolvePlansAwaitingApproval to the old behaviour (treat every
  // settled result as available, defaulting the count to null/0 on rejection) fails this first.
  const rejected = resolvePlansAwaitingApproval(
    { status: "rejected", reason: new Error("countPlanAwaiting boom") },
    { hrId: "b-10", role: "District Manager" },
  );
  assert.equal(
    rejected.plansCountAvailable,
    false,
    "a rejected plans lookup must report plansCountAvailable: false — a manager cannot tell a failed query from an empty inbox by the count alone",
  );
  assert.equal(
    rejected.plansAwaitingManagerApproval,
    null,
    "a rejected plans lookup must never resolve to a numeric count — a bare 0 reads as a positive claim that nothing is awaiting approval",
  );

  // A genuine zero (the query ran fine and found nothing) must stay a real, available zero — the
  // fix must not turn every zero into "unavailable".
  const genuineZero = resolvePlansAwaitingApproval(
    { status: "fulfilled", value: { count: 0, available: true } },
    { hrId: "b-10", role: "District Manager" },
  );
  assert.equal(
    genuineZero.plansCountAvailable,
    true,
    "a fulfilled, available lookup is available even when the count it found is genuinely zero",
  );
  assert.equal(genuineZero.plansAwaitingManagerApproval, 0, "a genuine zero must still read as 0, not be swallowed into null");

  // A real, positive count still comes through unchanged.
  const real = resolvePlansAwaitingApproval(
    { status: "fulfilled", value: { count: 4, available: true } },
    { hrId: "b-10", role: "National Sales Manager" },
  );
  assert.equal(real.plansCountAvailable, true, "a fulfilled, available lookup with a real count is available");
  assert.equal(real.plansAwaitingManagerApproval, 4, "the real count must pass through unchanged");

  // A fulfilled result whose OWN payload says the lookup failed (countPlanAwaiting reached its own
  // catch but resolved rather than rejected) must read exactly like the rejected case above — this
  // is the branch that did not exist before this fix, and its absence is the whole bug.
  const fulfilledButUnavailable = resolvePlansAwaitingApproval(
    { status: "fulfilled", value: { count: 0, available: false } },
    { hrId: "b-10", role: "District Manager" },
  );
  assert.equal(
    fulfilledButUnavailable.plansCountAvailable,
    false,
    "a fulfilled result carrying available: false must still report plansCountAvailable: false — this is the false-zero path the PR set out to close",
  );
  assert.equal(
    fulfilledButUnavailable.plansAwaitingManagerApproval,
    null,
    "a fulfilled-but-unavailable result must never resolve to a numeric count, even though the settled promise itself did not reject",
  );

  // getPortalHomeSnapshot resolves the underlying promise to null for anyone the plans card does
  // not apply to (medical reps, or a caller with no hrId — see the `!isMr && hrId` gate). That is a
  // real "not applicable", not a failure, so it must stay available with a null count.
  const notApplicable = resolvePlansAwaitingApproval(
    { status: "fulfilled", value: null },
    { hrId: "", role: "Medical Rep" },
  );
  assert.equal(notApplicable.plansCountAvailable, true, "a resolved-to-null (not-a-manager) result is available, not a failure");
  assert.equal(notApplicable.plansAwaitingManagerApproval, null, "a non-manager caller has no plan count to show");

  // ── HEADLINE: THE REAL PRODUCTION PATH, not a fabricated PromiseSettledResult ────────────────
  //
  // Force getPlanApprovalsForResponder to genuinely throw by handing it an `access` whose `hrId` is
  // the wrong TYPE (a number). The very first line of getPlanApprovalsForResponder is
  // `access.hrId?.trim()`, which throws for any non-string truthy value — a real, uncaught
  // exception from real production code, before any network call, not a mock standing in for one.
  // `role`/`scope` stay valid strings so countPlanAwaiting's own catch-block logging (which reads
  // access.hrId/role/scope) does not itself throw a second, different error.
  const brokenAccess = {
    hrId: 12345 as unknown as string,
    role: "District Manager",
    scope: "team",
    source: "session",
  } as AccessContext;

  const realFailure = await countPlanAwaiting(brokenAccess);
  assert.equal(
    realFailure.available,
    false,
    "countPlanAwaiting must report available: false when getPlanApprovalsForResponder genuinely throws, not swallow it into a bare 0",
  );
  assert.equal(realFailure.count, 0, "the count on a genuinely failed lookup is a placeholder, never a claim of a real number");

  // Thread that real result through the exact chain getPortalHomeSnapshot uses
  // (Promise.allSettled around the wrapped countPlanAwaiting call) and confirm the DASHBOARD-FACING
  // value — the one portal-command-center.tsx, rm-command-center.tsx and
  // marketing-manager-command-center.tsx actually render — reports unavailable rather than 0.
  const [settledRealFailure] = await Promise.allSettled([countPlanAwaiting(brokenAccess)]);
  const dashboardFacing = resolvePlansAwaitingApproval(settledRealFailure, { hrId: "d-1", role: "District Manager" });
  assert.equal(
    dashboardFacing.plansCountAvailable,
    false,
    "a genuine countPlanAwaiting failure must reach the dashboard as plansCountAvailable: false — this is the exact false-zero this PR fixes",
  );
  assert.equal(
    dashboardFacing.plansAwaitingManagerApproval,
    null,
    "a genuine countPlanAwaiting failure must never resolve to a numeric plan count on the dashboard",
  );
  await runPlanSourceUnavailableTests();
}

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
}

/** One top-level function's body: from its declaration to the next top-level `export` or `function`. */
function functionBody(text: string, declaration: string): string {
  const start = text.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} must exist`);
  const rest = text.slice(start + declaration.length);
  const next = rest.search(/\n(export |async function |function )/);
  return next >= 0 ? rest.slice(0, next) : rest;
}

// A PLAN SOURCE THAT COULD NOT BE READ IS NOT AN EMPTY ONE (19 Oct 2026). The Phoenix CRM read of the
// district managers' weeks failed 11 times in 48 hours, each inside an app-wide database timeout
// burst, and the Hub simply dropped those items: the badge counted a confident short number, the page
// said "Nothing waiting on you", and the bell's auto-archive read each of their "please decide"
// notices as decided and archived it for good. The legacy read did the same with an empty return.
async function runPlanSourceUnavailableTests() {
  const hub = source("src/lib/approvals-hub/service.ts");
  const merge = functionBody(hub, "export async function getPlanApprovalsForResponder(");
  assert.match(
    merge,
    /loadManagerPlanQueue\(hrId, Boolean\(access\.testPersona\)\)\.catch\([\s\S]*?unavailable\.push\("phoenix_crm"\);\s*return null;/,
    "a failed Phoenix CRM read must be named in unavailable, not silently dropped",
  );
  assert.match(merge, /if \(error\) \{[\s\S]*?unavailable\.push\("plans"\);/, "a failed legacy plans read must be named in unavailable");
  assert.doesNotMatch(
    merge,
    /return \{ awaiting: \[\], upcoming: \[\] \}/,
    "a failed legacy read must not return an empty list that reads as nothing waiting (and drops the Phoenix CRM weeks beside it)",
  );
  assert.match(merge, /return \{ awaiting, upcoming, unavailable \};/, "the merge must hand unavailable to every caller");

  for (const declaration of ["export async function countPlanAwaiting(", "export async function getPlanAwaitingBadge("]) {
    assert.match(
      functionBody(hub, declaration),
      /available: unavailable\.length === 0/,
      `${declaration} must report a short count as unavailable, never as a confident number`,
    );
  }

  const bell = functionBody(source("src/lib/notifications/in-app.ts"), "async function archiveStaleApprovalNotifications(");
  assert.match(
    bell,
    /const \{ awaiting, unavailable \} = await getPlanApprovalsForResponder\(access\);\s*if \(unavailable\.length === 0\) \{[\s\S]*?stale\.add\(candidate\.id\)/,
    "the bell must archive a plan notice only when every plan source was read; a missing source would archive its notices for good",
  );

  const workspace = source("src/components/approvals-hub/approvals-workspace.tsx");
  assert.match(
    workspace,
    /pendingNotice \? null : \([\s\S]*?Nothing waiting on you right now\./,
    'the page must not say "Nothing waiting on you" while a plan source could not be read',
  );
  assert.match(
    source("src/components/approvals-hub/plan-approvals-body.tsx"),
    /pendingNotice=\{planSourcesUnavailableNotice\(data\.unavailable\)\}/,
    "the plan approvals page must pass the notice to the workspace",
  );

  assert.equal(planSourcesUnavailableNotice([]), null, "both sources read: no notice");
  assert.equal(
    planSourcesUnavailableNotice(["phoenix_crm"]),
    "District managers' Phoenix CRM weeks could not be loaded just now, so any waiting on you are missing from this list. Reload the page to try again.",
  );
  assert.match(planSourcesUnavailableNotice(["plans"]) ?? "", /^Weekly and monthly plans could not be loaded/);
  assert.match(planSourcesUnavailableNotice(["phoenix_crm", "plans"]) ?? "", /^Plans could not be loaded/);
}
