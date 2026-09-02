import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  FIELD_WORKWEEK,
  HEAD_OFFICE_WORKWEEK,
  planPeriodMove,
  shiftIsoDate,
} from "../src/lib/weekly-planning/plan-v1.ts";

// Built for a real incident (2026-08-28). A District Manager was returned on week 2026-W34, built a
// correct 11-row field plan two hours later, and submitted it against 2026-W35 by mistake. The
// wrong week stayed approved and the right week stayed blocked by the active-period unique index,
// so the only remedy was a hand-written production database change. moveWeeklyPlanToPeriod is the
// supported repair for that.
//
// The arithmetic is exercised for real (plan-v1 is pure, no Supabase client). The authorization
// gate and the write atomicity are source-pinned against a SLICE of the function, because reaching
// them needs a database — and because a pin that searches a whole file passes on a string that
// belongs to some other function entirely.

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function utcWeekday(iso: string) {
  return WEEKDAY_NAMES[new Date(`${iso}T00:00:00Z`).getUTCDay()];
}

export function runWeeklyPlanMovePeriodTests() {
  // ---- The real case: the W35 plan back onto W34 --------------------------------------------
  const move = planPeriodMove("weekly", "2026-08-29", "2026-08-24", FIELD_WORKWEEK);
  assert.equal(move.target.periodStartDate, "2026-08-22", "the destination week must start Sat 22 Aug");
  assert.equal(move.target.periodEndDate, "2026-08-27", "a Field Force week runs Saturday to Thursday");
  assert.equal(move.target.periodKey, "2026-W34", "the destination period key must be 2026-W34");
  assert.equal(move.dayDelta, -7, "moving a plan one week earlier is a -7 day shift");

  // ---- Every item keeps its weekday ----------------------------------------------------------
  // This is the whole point of ONE shared delta. Re-deriving each item's date independently, or
  // moving the header alone, is what leaves a plan whose rows sit outside their own period.
  const originalItemDates = [
    "2026-08-29",
    "2026-08-29",
    "2026-08-30",
    "2026-08-30",
    "2026-08-31",
    "2026-08-31",
    "2026-09-01",
    "2026-09-01",
    "2026-09-02",
    "2026-09-02",
    "2026-09-03",
  ];
  assert.equal(originalItemDates.length, 11, "the incident plan carried 11 rows");
  for (const original of originalItemDates) {
    const moved = shiftIsoDate(original, move.dayDelta);
    assert.equal(
      utcWeekday(moved),
      utcWeekday(original),
      `${original} must keep its weekday when the plan moves (landed on ${moved})`,
    );
    assert.ok(
      moved >= move.target.periodStartDate && moved <= move.target.periodEndDate,
      `${original} must land inside the destination week (landed on ${moved})`,
    );
  }

  // ---- Any anchor inside the destination week is the same answer -----------------------------
  // The admin hands over whatever date was picked, so every working day of the target week must
  // resolve to the same period. A control that only worked on the week's first day would be a trap.
  for (const anchor of ["2026-08-22", "2026-08-23", "2026-08-25", "2026-08-27"]) {
    const fromAnchor = planPeriodMove("weekly", "2026-08-29", anchor, FIELD_WORKWEEK);
    assert.equal(
      fromAnchor.target.periodStartDate,
      "2026-08-22",
      `anchor ${anchor} must resolve to the week starting 2026-08-22`,
    );
    assert.equal(fromAnchor.dayDelta, -7, `anchor ${anchor} must give the same -7 day shift`);
  }

  // ---- The owner's workweek decides the boundaries, not the raw date -------------------------
  // Head Office runs Sunday to Thursday, so the SAME anchor is a different week for a different
  // employee. Computing the destination from the raw date instead of the owner's workweek would
  // silently re-date a Head Office plan onto a Saturday that person never works.
  const headOffice = planPeriodMove("weekly", "2026-08-30", "2026-08-24", HEAD_OFFICE_WORKWEEK);
  assert.equal(headOffice.target.periodStartDate, "2026-08-23", "a Head Office week starts on Sunday");
  assert.equal(headOffice.target.periodEndDate, "2026-08-27", "a Head Office week ends on Thursday");
  assert.notEqual(
    headOffice.target.periodStartDate,
    move.target.periodStartDate,
    "Head Office and Field Force must not resolve one anchor date to the same week",
  );

  // ---- Moving forward works too, and is exactly inverse ---------------------------------------
  const forward = planPeriodMove("weekly", "2026-08-22", "2026-08-31", FIELD_WORKWEEK);
  assert.equal(forward.dayDelta, 7, "moving a plan one week later is a +7 day shift");
  assert.equal(shiftIsoDate(shiftIsoDate("2026-08-22", 7), -7), "2026-08-22", "the shift must be reversible");

  // ---- Calendar edges ------------------------------------------------------------------------
  assert.equal(shiftIsoDate("2026-09-01", -7), "2026-08-25", "the shift must cross a month boundary");
  assert.equal(shiftIsoDate("2026-01-01", -1), "2025-12-31", "the shift must cross a year boundary");
  assert.equal(shiftIsoDate("2026-02-28", 1), "2026-03-01", "2026 is not a leap year");

  // ---- The service gate ----------------------------------------------------------------------
  const service = readFileSync("src/lib/weekly-planning/service.ts", "utf8");
  const fnStart = service.indexOf("export async function moveWeeklyPlanToPeriod");
  assert.ok(fnStart >= 0, "moveWeeklyPlanToPeriod must exist - this test slices it by marker");
  // End the slice at THIS function's own closing brace, not at the next export. Ending it at the
  // next export silently included everything in between, so adding one non-exported helper after
  // this function (autoAcknowledgeFinalApprovedPlan, 2026-09-02) widened the window over a
  // neighbour's body and the forbidden-string loop below failed on code moveWeeklyPlanToPeriod
  // does not contain. Nothing inside the function is indented to column 0, so "\n}\n" is its end.
  const fnEnd = service.indexOf("\n}\n", fnStart);
  assert.ok(fnEnd > fnStart, "moveWeeklyPlanToPeriod must be a closed function - this test slices it by its own closing brace");
  const fn = service.slice(fnStart, fnEnd);

  // The forbidden-string loop below is a NEGATIVE check: it passes vacuously on a window that is
  // empty or truncated. Anchor on the function's first and last real statements so a slice that
  // silently collapses fails loudly here instead of certifying nothing.
  assert.ok(
    fn.includes("export async function moveWeeklyPlanToPeriod(") && fn.includes("return mapPlan(await loadPlanRow(plan.id));"),
    "the slice must span the whole function, first statement to last - a truncated window would make every check below pass on nothing",
  );

  assert.ok(
    fn.includes('await assertPermission(access, "weekly_plans", "approve");'),
    "moving a plan must require the weekly_plans approve grant",
  );
  assert.ok(
    fn.includes("if (!isHrReviewer(access, null)) {"),
    "moving a plan must ALSO require HR/Super Admin - the approve grant alone is not enough",
  );
  assert.ok(
    fn.includes("await assertNoActivePlanForSamePeriod("),
    "moving a plan must refuse a destination period that already holds a live plan",
  );
  assert.ok(
    fn.includes("await writeAuditLog({"),
    "moving a plan must leave an audit row naming the period it came from and went to",
  );
  assert.ok(
    fn.includes("resolvePlanWorkweek({"),
    "the destination must be computed from the owner's workweek, not from the raw anchor date",
  );

  // Re-dating is NOT deciding. Nothing here may touch the workflow state, the revision, or the
  // decision trail: a plan that was approved stays approved, on its new week.
  for (const forbidden of ["status:", "revision:", "rpcDecidePlan"]) {
    assert.ok(
      !fn.includes(forbidden),
      `moveWeeklyPlanToPeriod must not write ${forbidden} - it re-dates a plan, it never decides one`,
    );
  }

  // ---- Write atomicity -----------------------------------------------------------------------
  assert.ok(
    fn.includes('.upsert(shifted, { onConflict: "id" });'),
    "items must move in ONE upsert - a per-row update loop can half-apply and split a plan across two weeks",
  );
  assert.ok(
    fn.includes("} catch (itemsError) {"),
    "a failed item shift must be caught so the header can be put back",
  );
  assert.ok(
    fn.includes("period_key: previous.periodKey,"),
    "a failed item shift must revert the header to the period it came from",
  );

  // ---- Only a live plan can be moved ----------------------------------------------------------
  const statusesStart = service.indexOf("const MOVABLE_PLAN_STATUSES");
  assert.ok(statusesStart >= 0, "MOVABLE_PLAN_STATUSES must exist - this test slices it by marker");
  const statuses = service.slice(statusesStart, service.indexOf("];", statusesStart));
  for (const closed of ["cancelled", "manager_rejected", "ceo_rejected"]) {
    assert.ok(
      !statuses.includes(`"${closed}"`),
      `a ${closed} plan must not be movable - it sits OUTSIDE employee_plan_headers_active_period_uidx, so nothing would stop it landing on a week that already has a real plan`,
    );
  }
  assert.ok(
    statuses.includes('"final_approved"'),
    "an approved plan must be movable - that is the case this was built for",
  );

  // ---- The route -------------------------------------------------------------------------------
  const route = readFileSync("app/api/weekly-plans/[id]/move-period/route.ts", "utf8");
  assert.ok(route.includes("assertSameOriginMutation(request)"), "the move route must carry the CSRF guard");
  assert.ok(route.includes("moveWeeklyPlanToPeriod(access,"), "the move route must delegate to the service");
  assert.ok(
    !route.includes("assertPermission"),
    "the route must not re-implement the gate - authorization is the service's job, and two copies drift",
  );

  // ---- No button the server rejects -----------------------------------------------------------
  // The workspace flag must carry BOTH halves of the server gate. canAcknowledgeHr alone is only
  // the HR half, so an HR reviewer without the approve grant would be shown the control and then
  // get a 403 from it.
  assert.ok(
    service.includes(
      'const canMovePlanPeriod = canAcknowledgeHr && (await canAccess(access, "weekly_plans", "approve"));',
    ),
    "canMovePlanPeriod must be HR/Super-Admin AND the approve grant - the same two halves the service asserts",
  );
  const workspaceUi = readFileSync("src/components/employee-portal/plans-workspace.tsx", "utf8");
  assert.ok(
    workspaceUi.includes("{plan && workspace.canMovePlanPeriod ? ("),
    "the move control must render on canMovePlanPeriod, not on a flag that is only half the gate",
  );
}
