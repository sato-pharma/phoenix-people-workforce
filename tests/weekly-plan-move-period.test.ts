import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  FIELD_WORKWEEK,
  HEAD_OFFICE_WORKWEEK,
  movedPlanItemDate,
  planMoveRefusal,
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

  // ---- A MONTHLY plan keeps each item on the same day of the month -----------------------------
  runMonthlyMoveTests(fn);
}

// ONE fixed day count is right for a week (every week is seven days, so each item keeps its weekday)
// and wrong for a month: months differ in length, so the delta put Jan 29-31 into March when a plan
// moved to February, Oct 31 on Dec 1 when it moved to November, and Mar 31 on Mar 3 when it moved to
// February - the header said the new month while rows sat outside it. A monthly item now lands on
// the SAME day of the destination month, and the whole move is refused (never clamped, never
// dropped) when a day does not exist there.
function monthlyMove(fromMonthStart: string, toMonthStart: string) {
  const move = planPeriodMove("monthly", fromMonthStart, toMonthStart, HEAD_OFFICE_WORKWEEK);
  const place = (activityDate: string) =>
    movedPlanItemDate({
      activityDate,
      dayDelta: move.dayDelta,
      planKind: "monthly",
      targetPeriodStartDate: move.target.periodStartDate,
    });
  const refusal = (itemDates: string[]) =>
    planMoveRefusal({ dayDelta: move.dayDelta, itemDates, planKind: "monthly", target: move.target });
  return { move, place, refusal };
}

function runMonthlyMoveTests(moveFunctionSource: string) {
  // January -> February 2026: the 15th moves, the 29th-31st have no place.
  const janToFeb = monthlyMove("2026-01-01", "2026-02-10");
  assert.equal(janToFeb.move.target.periodStartDate, "2026-02-01");
  assert.equal(janToFeb.move.target.periodEndDate, "2026-02-28");
  assert.equal(janToFeb.place("2026-01-15"), "2026-02-15", "Jan 15 lands on Feb 15");
  assert.equal(janToFeb.refusal(["2026-01-01", "2026-01-15", "2026-01-28"]), null, "days 1-28 all exist in February");
  assert.equal(janToFeb.place("2026-01-31"), null, "February has no 31st");
  const janRefusal = janToFeb.refusal(["2026-01-31"]);
  assert.ok(janRefusal !== null, "Jan 31 -> February is refused");
  assert.match(janRefusal, /February 2026/, "the message names the destination month");
  assert.match(janRefusal, /31 January 2026/, "and the date the person has to change");
  assert.match(janRefusal, /Change that day in the plan first/, "and says what to do about it");
  // The old whole-plan delta (+31 days) is what pushed these into March.
  assert.equal(shiftIsoDate("2026-01-31", janToFeb.move.dayDelta), "2026-03-03", "the fixed delta misplaced Jan 31 in March");

  // The whole move is refused, naming every offending date once and none of the others.
  const mixed = janToFeb.refusal(["2026-01-05", "2026-01-29", "2026-01-30", "2026-01-31", "2026-01-31"]);
  assert.ok(mixed !== null);
  assert.match(mixed, /29 January 2026, 30 January 2026, 31 January 2026/);
  assert.doesNotMatch(mixed, /5 January/, "a day that does move is not listed");
  assert.match(mixed, /Change those days in the plan first/);
  assert.equal((mixed.match(/31 January 2026/g) ?? []).length, 1, "a date held twice is named once");

  // October -> November: days 1-30 move, the 31st has no place (the fixed delta put it on Dec 1).
  const octToNov = monthlyMove("2026-10-01", "2026-11-01");
  for (let day = 1; day <= 30; day += 1) {
    const from = `2026-10-${String(day).padStart(2, "0")}`;
    assert.equal(octToNov.place(from), `2026-11-${String(day).padStart(2, "0")}`, `${from} keeps its day of the month`);
  }
  assert.equal(octToNov.refusal(Array.from({ length: 30 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`)), null);
  assert.ok(octToNov.refusal(["2026-10-31"]) !== null, "Oct 31 -> November is refused");
  assert.equal(shiftIsoDate("2026-10-31", octToNov.move.dayDelta), "2026-12-01", "the fixed delta put Oct 31 on Dec 1");

  // November -> October: every November day exists in October.
  const novToOct = monthlyMove("2026-11-01", "2026-10-15");
  assert.equal(
    novToOct.refusal(Array.from({ length: 30 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`)),
    null,
  );
  assert.equal(novToOct.place("2026-11-30"), "2026-10-30");

  // March 31 -> April is refused; March 30 -> April 30 is fine; March 31 -> February is refused
  // (the fixed delta put it on Mar 3).
  const marToApr = monthlyMove("2026-03-01", "2026-04-01");
  assert.ok(marToApr.refusal(["2026-03-31"]) !== null, "Mar 31 -> April is refused");
  assert.equal(marToApr.place("2026-03-30"), "2026-04-30");
  const marToFeb = monthlyMove("2026-03-01", "2026-02-01");
  assert.ok(marToFeb.refusal(["2026-03-31"]) !== null, "Mar 31 -> February is refused");
  assert.equal(shiftIsoDate("2026-03-31", marToFeb.move.dayDelta), "2026-03-03", "the fixed delta put Mar 31 on Mar 3");

  // Leap years: Feb 29 exists in 2028 only.
  const janToLeapFeb = monthlyMove("2028-01-01", "2028-02-01");
  assert.equal(janToLeapFeb.place("2028-01-29"), "2028-02-29", "February 2028 has a 29th");
  assert.ok(janToLeapFeb.refusal(["2028-01-30"]) !== null);
  const febToMar = monthlyMove("2028-02-01", "2028-03-01");
  assert.equal(febToMar.place("2028-02-29"), "2028-03-29");
  const febToJan2027 = monthlyMove("2027-01-01", "2027-02-01");
  assert.ok(febToJan2027.refusal(["2027-01-29"]) !== null, "February 2027 has no 29th");

  // Exhaustive over three years: a monthly item either lands on the SAME day inside the destination
  // month, or the move is refused - it can never land anywhere else.
  for (const year of [2026, 2027, 2028]) {
    for (let fromMonth = 1; fromMonth <= 12; fromMonth += 1) {
      for (let toMonth = 1; toMonth <= 12; toMonth += 1) {
        if (toMonth === fromMonth) continue;
        const fromStart = `${year}-${String(fromMonth).padStart(2, "0")}-01`;
        const toStart = `${year}-${String(toMonth).padStart(2, "0")}-01`;
        const { move, place, refusal } = monthlyMove(fromStart, toStart);
        const fromDays = new Date(Date.UTC(year, fromMonth, 0)).getUTCDate();
        for (let day = 1; day <= fromDays; day += 1) {
          const from = `${year}-${String(fromMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const to = place(from);
          if (to === null) {
            assert.ok(refusal([from]) !== null, `${from} -> ${toStart.slice(0, 7)}: no place must mean the move is refused`);
            continue;
          }
          assert.equal(refusal([from]), null, `${from} -> ${toStart.slice(0, 7)}: a placeable day must not refuse the move`);
          assert.ok(
            to >= move.target.periodStartDate && to <= move.target.periodEndDate,
            `${from} must land inside ${toStart.slice(0, 7)} (landed on ${to})`,
          );
          assert.equal(to.slice(8), from.slice(8), `${from} must keep its day of the month (landed on ${to})`);
        }
      }
    }
  }

  // WEEKLY is unchanged: one delta, weekday preserved, never refused.
  const weekly = planPeriodMove("weekly", "2026-08-29", "2026-08-24", FIELD_WORKWEEK);
  for (const original of ["2026-08-29", "2026-08-30", "2026-09-03"]) {
    assert.equal(
      movedPlanItemDate({ activityDate: original, dayDelta: weekly.dayDelta, planKind: "weekly", targetPeriodStartDate: weekly.target.periodStartDate }),
      shiftIsoDate(original, weekly.dayDelta),
      `${original}: a weekly item still moves by the plan's one day delta`,
    );
  }
  assert.equal(
    planMoveRefusal({ dayDelta: weekly.dayDelta, itemDates: ["2026-08-29", "2026-08-31"], planKind: "weekly", target: weekly.target }),
    null,
    "a weekly plan always has a place for every item",
  );

  // The service reads the items and refuses BEFORE the header moves, so a refused move writes nothing.
  const refusalAt = moveFunctionSource.indexOf("planMoveRefusal(");
  const headerWriteAt = moveFunctionSource.indexOf('.from("employee_plan_headers")');
  assert.ok(refusalAt >= 0, "moveWeeklyPlanToPeriod must ask planMoveRefusal");
  assert.ok(headerWriteAt > refusalAt, "the refusal must come before the header is re-dated, or a refused move would leave a half-written plan");
  assert.ok(
    moveFunctionSource.includes("throw new Error(refusal)"),
    "a refused move must surface its message to the caller",
  );
  assert.ok(
    moveFunctionSource.includes("movedPlanItemDate({"),
    "items must be re-dated through movedPlanItemDate, not the plan's fixed day delta",
  );
}
