import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  DAY_KINDS,
  EXCEPTION_KINDS,
  LIST_GRACE_DAYS,
  ON_LEAVE_LABEL,
  RATE_WINDOW_WORKING_DAYS,
  buildExceptions,
  isWorkingDay,
  judgeTerritory,
  lastFinishedWorkingDay,
  type ExceptionRules,
  type TerritoryFacts,
} from "../src/lib/phoenix-crm/exceptions.ts";

/**
 * Phoenix CRM — B2: the exceptions board.
 *
 * Owner, 2026-09-26. A District Manager opening the Team tab sees every seat he holds, in rows of the
 * same shape whether the week went perfectly or not — so the seven that need him look exactly like
 * the sixty-one that do not.
 *
 * ## 🔴 The rule this file exists to pin: A CLEAN TERRITORY IS ABSENT
 *
 * Not a green row, not a tick, not a row filtered out by a default the next person will remove.
 * `judgeTerritory` returns null and `buildExceptions` drops it. It is the entire feature and it is
 * silent when broken: a board that grew an "ok" row would render, deploy, and simply be the Team tab
 * again — sixty-eight rows to read to find eight.
 *
 * ## And ONE kind per territory
 *
 * The kinds are not independent: a vacant seat has nobody to plan, nobody to visit and nobody to fall
 * below a rate. Reporting five kinds against it would bury the one that matters, so the ladder stops
 * at the first hit.
 */

const RULES: ExceptionRules = { callRateAmTarget: 2, callRatePmTarget: 10, cairoToday: "2026-09-26" };

/** A territory with nothing whatever wrong — every case below is this, with one thing changed. */
function clean(overrides: Partial<TerritoryFacts> = {}): TerritoryFacts {
  return {
    seatId: "SEAT-1",
    territoryName: "Cairo 1",
    lineName: "Pedia",
    repName: "Ahmed Samir",
    hasRep: true,
    lineOpenedOn: "2026-01-01",
    readiness: { total: 12, validated: 12, dropped: 0, dropPending: 0, ready: true },
    planStatus: "submitted",
    planReturnedDay: null,
    planItems: 20,
    windowWorkingDays: 6,
    windowAmVisits: 18,
    windowPmVisits: 72,
    lastWorkingDayVisits: 9,
    // No leave is the default, so every case written before 2026-10-03 keeps asking exactly what it
    // asked — leave only ever makes the board say LESS, so a silent default of "away" would quietly
    // excuse the defects these cases exist to catch.
    leaveFullDaysInWindow: 0,
    leaveOnLastWorkingDay: false,
    leaveCoversWholeWeek: false,
    ...overrides,
  };
}

export function runPhoenixCrmExceptionsTests(): void {
  // ── 🔴 A clean territory is ABSENT ────────────────────────────────────────────────────────────
  {
    assert.equal(judgeTerritory(clean(), RULES), null, "a territory with nothing wrong produces no row at all");

    const board = buildExceptions([clean(), clean({ seatId: "SEAT-2", territoryName: "Giza 1" })], RULES);
    assert.deepEqual(board.rows, [], "and none of them reaches the board");
    assert.equal(board.summary.territories, 2, "the count of territories is still honest");
    assert.equal(board.summary.needingAttention, 0);
    assert.deepEqual(board.summary.byKind, [], "a chip reading zero is the same noise as a green row");

    // There is no "ok", "clean" or "fine" kind, and adding one is the failure this guards.
    for (const key of EXCEPTION_KINDS.map((entry) => entry.key)) {
      assert.doesNotMatch(key, /^(ok|clean|fine|good|healthy)$/, `${key} is not a problem`);
    }
  }

  // ── ONE kind per territory, worst first ───────────────────────────────────────────────────────
  {
    // Everything is wrong at once. A vacant seat reports ONLY that it is vacant.
    const nobody = clean({
      hasRep: false,
      repName: null,
      readiness: { total: 12, validated: 0, dropped: 0, dropPending: 0, ready: false },
      planStatus: null,
      planItems: 0,
      windowAmVisits: 0,
      windowPmVisits: 0,
      lastWorkingDayVisits: 0,
    });
    const row = judgeTerritory(nobody, RULES);
    assert.equal(row?.kind, "vacant", "a vacant seat is not also blamed for having no plan");
    assert.equal(row?.repName, null);

    const ranked = buildExceptions(
      [
        clean({ seatId: "S-rate", territoryName: "Zzz", windowPmVisits: 6 }),
        clean({ seatId: "S-vacant", territoryName: "Aaa", hasRep: false, repName: null }),
        clean({ seatId: "S-plan", territoryName: "Mmm", planStatus: null, planItems: 0 }),
      ],
      RULES,
    );
    assert.deepEqual(
      ranked.rows.map((entry) => entry.kind),
      ["vacant", "plan_missing", "below_pm_rate"],
      "worst first, whatever order they arrive in",
    );
    // Within one kind the order is the territory's own name, so the list does not reshuffle under a
    // manager reading down it because a visit landed between two refreshes.
    const sameKind = buildExceptions(
      [clean({ seatId: "b", territoryName: "Beni Suef", hasRep: false }), clean({ seatId: "a", territoryName: "Alexandria", hasRep: false })],
      RULES,
    );
    assert.deepEqual(sameKind.rows.map((entry) => entry.territoryName), ["Alexandria", "Beni Suef"]);
  }

  // ── "Never started" is not "behind" ───────────────────────────────────────────────────────────
  {
    const untouched = judgeTerritory(clean({ readiness: { total: 12, validated: 0, dropped: 0, dropPending: 0, ready: false } }), RULES);
    assert.equal(untouched?.kind, "never_opened");
    assert.equal(untouched?.detail, "12 carried over, none touched");

    // One drop REQUESTED is a rep who has started. He is behind, not absent, and the two must not
    // read the same — telling a working rep he has never started is the fastest way to lose him.
    const started = judgeTerritory(clean({ readiness: { total: 12, validated: 0, dropped: 0, dropPending: 1, ready: false } }), RULES);
    assert.notEqual(started?.kind, "never_opened");

    // A territory with no carried-over list at all cannot be behind on one.
    assert.equal(judgeTerritory(clean({ readiness: { total: 0, validated: 0, dropped: 0, dropPending: 0, ready: true } }), RULES), null);
    assert.equal(judgeTerritory(clean({ readiness: null }), RULES), null, "and neither can one whose readiness could not be measured");
  }

  // ── The 30-day grace, and what happens without a date ─────────────────────────────────────────
  {
    const behind = { total: 12, validated: 3, dropped: 0, dropPending: 0, ready: false };
    assert.equal(LIST_GRACE_DAYS, 30);
    // 2026-09-26 minus 30 days is 2026-08-27: exactly at the grace is still inside it.
    assert.equal(judgeTerritory(clean({ readiness: behind, lineOpenedOn: "2026-08-27" }), RULES), null, "exactly 30 days is still grace");
    const late = judgeTerritory(clean({ readiness: behind, lineOpenedOn: "2026-08-26" }), RULES);
    assert.equal(late?.kind, "list_not_ready");
    assert.equal(late?.detail, "3 of 12 done, 31 days open");

    // 🔴 An undated line keeps the grace forever. The board would otherwise accuse a rep on the
    // strength of a date nobody set, and it cannot say how long he has had — so it says nothing.
    assert.equal(judgeTerritory(clean({ readiness: behind, lineOpenedOn: null }), RULES), null, "no opening date, no accusation");
  }

  // ── A plan header with no customers in it is not a plan ───────────────────────────────────────
  {
    assert.equal(judgeTerritory(clean({ planStatus: null, planItems: 0 }), RULES)?.kind, "plan_missing");
    assert.equal(judgeTerritory(clean({ planStatus: "draft", planItems: 0 }), RULES)?.kind, "plan_missing", "an empty header is not a plan");
    assert.equal(judgeTerritory(clean({ planStatus: "draft" }), RULES)?.detail, "Still a draft");
    assert.equal(judgeTerritory(clean({ planStatus: "returned" }), RULES)?.detail, "Returned, not sent again");
    // Sent is sent: a plan the manager has not decided yet is not the rep's problem.
    assert.equal(judgeTerritory(clean({ planStatus: "submitted" }), RULES), null);
    assert.equal(judgeTerritory(clean({ planStatus: "approved" }), RULES), null);

    // 🔴 A WEEK RETURNED FOR ONE DAY IS STILL SENT ON EVERY OTHER DAY (owner, 2026-10-02, "Still
    //    planned"), so it is NOT "Plan not sent". The board read the week's bare `returned` status
    //    and listed such a territory as unsent — while the database was stamping that same rep's
    //    visits on its other days as PLANNED. One screen contradicting the stamp on his own work.
    assert.equal(
      judgeTerritory(clean({ planStatus: "returned", planReturnedDay: "2026-09-28" }), RULES),
      null,
      "one day back with the rep is not a week that was never sent",
    );
    assert.equal(
      judgeTerritory(clean({ planStatus: "returned", planReturnedDay: null }), RULES)?.kind,
      "plan_unsent",
      "a week returned WHOLE is still unsent — that half is unchanged",
    );
  }

  // ── 🔴 AM and PM are judged APART and never averaged ──────────────────────────────────────────
  {
    assert.equal(RATE_WINDOW_WORKING_DAYS, 6);
    // 72 PM over 6 days is 12 a day against 10 — on target — while AM is 18/6 = 3 against 2. Fine.
    assert.equal(judgeTerritory(clean(), RULES), null);

    // PM short, AM fine. Averaging the two would hide it: (72 + 18) / 6 = 15 "a day" reads healthy.
    const pmShort = judgeTerritory(clean({ windowPmVisits: 54 }), RULES);
    assert.equal(pmShort?.kind, "below_pm_rate");
    assert.equal(pmShort?.detail, "9.0 a day against 10");

    // AM short, PM fine.
    const amShort = judgeTerritory(clean({ windowAmVisits: 6 }), RULES);
    assert.equal(amShort?.kind, "below_am_rate");
    assert.equal(amShort?.detail, "1.0 a day against 2");

    // Both short reads as the PM one — the bigger half of the day leads, and only ONE row is ever
    // shown per territory. Never a combined figure anywhere.
    assert.equal(judgeTerritory(clean({ windowAmVisits: 6, windowPmVisits: 6 }), RULES)?.kind, "below_pm_rate");

    // A window with no finished working days in it cannot accuse anybody.
    assert.equal(judgeTerritory(clean({ windowWorkingDays: 0, windowAmVisits: 0, windowPmVisits: 0 }), RULES), null);

    // 🔴 AND THE DENOMINATOR IS WORKING DAYS, WHICH IS WHY THURSDAY HAD TO GO. A rep who made
    //    exactly 10 PM calls on each of Saturday to Wednesday has a PERFECT week. Counting Friday
    //    out but Thursday in made that week six days — 50 / 6 = 8.3 — and listed him "Below the PM
    //    call rate". The owner excluded Thursday outright on 2026-09-05.
    const perfectWeek = clean({ windowWorkingDays: 5, windowAmVisits: 10, windowPmVisits: 50 });
    assert.equal(judgeTerritory(perfectWeek, RULES), null, "10 PM on each of five working days is on target, not under it");
    assert.equal(
      judgeTerritory({ ...perfectWeek, windowWorkingDays: 6 }, RULES)?.detail,
      "8.3 a day against 10",
      "and the old six-day window is exactly the figure that accused him",
    );
  }

  // ── The day kind speaks only about a day that has ENDED ───────────────────────────────────────
  {
    assert.deepEqual(DAY_KINDS, ["no_visit"], "one day kind, and the rest are week or list kinds");
    assert.equal(judgeTerritory(clean({ lastWorkingDayVisits: 0 }), RULES)?.kind, "no_visit");
    assert.equal(judgeTerritory(clean({ lastWorkingDayVisits: 1 }), RULES), null, "one visit is enough — this kind asks nothing about the rate");
    // 🔴 NULL IS NOT A ZERO. No finished working day means there is nothing to judge — a fallback
    //    to today would have the board say "no visit" about a day the rep is still working.
    assert.equal(judgeTerritory(clean({ lastWorkingDayVisits: null }), RULES), null, "no day to ask about is not a day with no visit");

    // 🔴 A WORKING DAY IS SATURDAY TO WEDNESDAY, HOLIDAYS OUT — the owner's own call-rate rule
    //    (`isCallRateWorkingDay`), and this board had its own weaker one: it excluded FRIDAY ALONE.
    //    Getting it wrong is silent and company-wide, so the real dates are named.
    assert.equal(isWorkingDay("2026-09-23"), true, "Wednesday closes the working week");
    assert.equal(isWorkingDay("2026-09-24"), false, "🔴 THURSDAY IS NOT A WORKING DAY (owner, 2026-09-05) — it used to read true");
    assert.equal(isWorkingDay("2026-09-25"), false, "Friday is the weekend");
    assert.equal(isWorkingDay("2026-09-26"), true, "Saturday opens it");
    assert.equal(isWorkingDay("2026-09-27"), true, "and Sunday is an ordinary one");
    // A national holiday inside Saturday-to-Wednesday comes out too (owner, 2026-09-02).
    assert.equal(isWorkingDay("2026-09-27", new Set(["2026-09-27"])), false, "a Sat-Wed holiday is not a working day either");
    // Thursday 8 October 2026 is Armed Forces Day, moved — and a Thursday, so doubly not one.
    assert.equal(isWorkingDay("2026-10-08"), false, "8 October 2026 is a Thursday AND a public holiday");

    // 🔴 Never today, whatever day today is — the rep has hours left to work it, and a board that
    // says "no visit" about a morning is a board a manager learns to ignore. This replaces the
    // plan's blunter "a Friday suppresses the day kinds", which only caught one day in seven.
    assert.equal(lastFinishedWorkingDay("2026-09-26"), "2026-09-23", "from a Saturday, Friday AND Thursday are skipped");
    assert.equal(lastFinishedWorkingDay("2026-09-25"), "2026-09-23", "from a Friday, Wednesday — never the Thursday between");
    assert.equal(lastFinishedWorkingDay("2026-09-24"), "2026-09-23", "from a Thursday, the Wednesday before");
    assert.equal(lastFinishedWorkingDay("2026-09-28"), "2026-09-27", "and from a Monday, simply the day before");
    for (const day of ["2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"]) {
      const found = lastFinishedWorkingDay(day);
      assert.notEqual(found, day, `${day}: today is never the day it reports on`);
      assert.equal(isWorkingDay(found as string), true, `${day}: and it always lands on a working day`);
    }
    // With the holidays taken out it still lands on a real working day — Thursday 8 October is a
    // holiday, 9 October a Friday, so a Saturday-10th board speaks about Wednesday the 7th.
    const eidWeek = new Set(["2026-10-08"]);
    assert.equal(lastFinishedWorkingDay("2026-10-10", eidWeek), "2026-10-07", "a holiday Thursday is stepped over, not judged");
    // 🔴 And a run with no working day in it answers NULL rather than a date it had to invent.
    const everyDayOff = new Set(
      Array.from({ length: 40 }, (_, index) => {
        const date = new Date("2026-10-10T00:00:00Z");
        date.setUTCDate(date.getUTCDate() - index);
        return date.toISOString().slice(0, 10);
      }),
    );
    assert.equal(lastFinishedWorkingDay("2026-10-10", everyDayOff), null, "nothing to report on is null, never a fallback to today");
  }

  // ── The service: four reads, the countable view, and nothing of the integrity evidence ────────
  {
    const service = stripComments(readFileSync(new URL("../src/lib/phoenix-crm/server/exceptions.ts", import.meta.url), "utf8"));

    // 🔴 An off-plan visit counts in NOTHING until it is approved (owner, 2026-09-26). A board that
    // read the base table would quietly tell a manager a rep is fine on a day whose visits may yet
    // be refused.
    assert.ok(service.includes('from("phoenix_crm_countable_visits")'), "visits are read through the countable view");
    assert.equal(service.includes('from("phoenix_crm_visits")'), false, "never the base table");

    // The board is about work not done. The integrity evidence is the Super Admin's and the SFE's,
    // it is silent by the owner's rule, and nothing here may reach it.
    assert.equal(/location[-_]?integrity/i.test(service), false, "the exceptions board reads no integrity evidence");

    // Every read is over ALL the seats at once. One-per-territory is 420 round trips for the SFE.
    // Since 2026-10-16 the plan items are COUNTED in the database rather than carried here row by row
    // to be counted — a company's week was ten thousand rows for one number per plan.
    assert.equal(
      (service.match(/getSupabaseAdmin\(\)/g) ?? []).length,
      3,
      "three direct queries — plans, visits, and the visit days of the few territories whose last working day is empty — plus the readiness and item-count functions, and none of them per territory",
    );
    // The third (owner, 14 Nov 2026, "Add days in a row") is asked only for the territories that already
    // have a no-visit row coming, never for the whole board.
    assert.ok(service.includes("const visitDays = await loadVisitDays(streakSeats, isTest,"), "the run's visit days are read for the empty-day territories alone");
    assert.ok(service.includes('callPhoenixCrm<unknown>("phoenix_crm_plan_item_counts", { p_plan_ids: part })'), "the items are counted per plan, in the database");
    assert.equal(service.includes('from("phoenix_crm_plan_items")'), false, "and never read row by row to be counted here");
    assert.ok(service.includes("loadReadiness(seatIds)"), "readiness is asked for every seat in one call");
    assert.ok(service.includes(": sharedReadiness(seatIds),"), "shared with the adoption report when the pack opens both at once");
    assert.ok(service.includes("fetchAllRowsKeyset"), "and each one pages, like every other read in the module");
    // The visits keep the walk's own rows and order, read in groups four at a time.
    assert.ok(service.includes("readSeatGroups(seatIds, 150, (part) =>"), "the visits are read over groups of territories, not one walk per batch");

    // The item count is what the old loop counted: every item of every one of these plans, nothing else.
    {
      const sql = readFileSync(new URL("../supabase/migrations/20261016180300_phoenix_crm_report_count_reads.sql", import.meta.url), "utf8").replace(/--.*$/gm, "");
      const start = sql.indexOf("create or replace function public.phoenix_crm_plan_item_counts(");
      assert.notEqual(start, -1, "the item-count function is defined");
      const body = sql.slice(start, sql.indexOf("\n$$;", start));
      assert.match(body, /from public\.phoenix_crm_plan_items i\s+where i\.plan_id = any\(p_plan_ids\)\s+group by i\.plan_id/, "every item of the asked plans, one row per plan");
      assert.doesNotMatch(body, /\band\b/i, "with no other condition — the old loop counted every item row");
    }

    // The gate is the shared predicate, not a role list, and the service refuses as well as the chip.
    assert.ok(service.includes("if (!readsTeamReports(viewer)) throw forbiddenError("), "the service is the boundary, not the chip");

    // 🔴 THE HOLIDAYS COME FROM THE CALL RATE'S OWN READER AND ARE READ FIRST, because they decide
    //    which days the window is made of. Without them a public holiday stays in the denominator
    //    and every rep's rate reads LOW for a reason nobody performed.
    assert.ok(service.includes("loadCallRateHolidays("), "the board reads the call rate's own holiday lookup");
    assert.ok(service.includes("lastFinishedWorkingDay(input.cairoToday, holidays.dates)"), "and the day it judges is a working day");
    assert.ok(service.includes("windowDays(lastDay, input.windowWorkingDays, holidays.dates)"), "as is every day of the window");
    // 🔴 A FAILED DATA SOURCE MUST NEVER READ AS A REAL ANSWER. The lookup never throws — it
    //    reports `complete: false` — so an unreachable calendar has to be SAID or it is invisible.
    assert.ok(service.includes("holidaysUnread: !holidays.complete"), "an unread calendar is carried onto the view");
    const tab = stripComments(readFileSync(new URL("../src/components/phoenix-crm/reports-tab.tsx", import.meta.url), "utf8"));
    assert.ok(tab.includes("report.holidaysUnread"), "and the screen says so beside the rates");
    const workbook = stripComments(readFileSync(new URL("../src/lib/phoenix-crm/server/reports-workbook.ts", import.meta.url), "utf8"));
    assert.ok(workbook.includes("view.holidaysUnread"), "and so does the workbook, which leaves the building without the screen");

    // 🔴 THE PLAN'S DAY STATUS COMES FROM THE MODULE'S ONE READER, never `returned_day` raw: a week
    //    whose edit request was acknowledged after the return is open to the rep again, and
    //    `loadPlanDayFacts` is the only thing that knows that.
    assert.ok(service.includes("loadPlanDayFacts(planRows, isTest)"), "the standing one-day return is read, not inferred");
    assert.ok(service.includes("PLAN_DAY_COLUMNS"), "through the shared column list");

    const access = stripComments(readFileSync(new URL("../src/lib/phoenix-crm/server/access.ts", import.meta.url), "utf8"));
    assert.ok(access.includes("export function readsTeamReports("), "one predicate, in access.ts");
    const reports = stripComments(readFileSync(new URL("../src/lib/phoenix-crm/server/reports.ts", import.meta.url), "utf8"));
    // NOT that one since 2026-10-02: the owner took the CEO and the regional managers off the
    // place-vs-actual report and left this board as it was, so the report has its own predicate.
    assert.ok(reports.includes("const canReadLocationReport = readsPlaceVsActual;"), "the place-vs-actual report has its own predicate");
    assert.equal(
      /function canReadLocationReport\(viewer/.test(reports),
      false,
      "the second copy is gone — two copies of who counts as a manager is how they drift",
    );
  }

  // ── The screen: it acts on nothing, and a clean scope reads as GOOD ───────────────────────────
  {
    const tab = stripComments(readFileSync(new URL("../src/components/phoenix-crm/reports-tab.tsx", import.meta.url), "utf8"));
    const start = tab.indexOf("function ExceptionsSection(");
    assert.notEqual(start, -1, "the section is still there");
    // 🔴 The end anchor must be CODE, not a comment. `stripComments` blanks comments in place, so
    // `indexOf("// ── The tab ─")` finds nothing, returns -1, and `slice(start, -1)` silently hands
    // back the whole rest of the file — every assertion below then reads the OTHER five sections and
    // fails on their buttons. It did exactly that on the first run.
    //
    // 🔴 It must also be a declaration that CANNOT LEAVE THIS FILE. The anchor was `const
    // SECTION_TITLES`, which moved to `src/lib/phoenix-crm/report-guide.ts` on 2026-10-03 under the
    // domain-first rule and took the end of the slice with it; the assertion below is what caught
    // that. `BRICK_STATUS` is the next top-level declaration after the section — tighter than the old
    // anchor, which reached past four other sections before stopping.
    const end = tab.indexOf("const BRICK_STATUS", start);
    assert.ok(end > start, "the section ends at the next top-level declaration in the tab");
    const body = tab.slice(start, end);

    assert.ok(body.includes('title="Nothing needs you"'), "an empty board says so in plain words — that is the GOOD outcome");
    // Nothing on it acts. A board that can approve is a board people click through without reading.
    for (const acting of ["crmPost", "onApprove", "<CrmButton", "Approve", "Return"]) {
      assert.equal(body.includes(acting), false, `the board must not ${acting} — every decision belongs to the Team tab`);
    }
    // Golden Rule #1's blind half: this is a manager's screen, but the module's words are the same
    // everywhere, and a rate is a fact about work, never a verdict about honesty.
    assert.doesNotMatch(body, /\b(fraud|cheat|integrity|suspicious)\b/i, "a manager's board is still not an accusation");
  }

  // ── 🔴 APPROVED LEAVE IS NOT AN EXCEPTION ─────────────────────────────────────────────────────
  //
  // Found by the owner on Delta (1)'s go-live morning, 2026-10-03: the board listed a rep as missing
  // her plan while she was on sick leave. His ruling was "Show 'On leave', not an exception". Before
  // this, neither `exceptions.ts` nor its server half contained the word leave at all — the plan
  // report already honoured it ("on leave: never missed"), so the two disagreed about the same rep.
  {
    const awayAllWeek = clean({ leaveCoversWholeWeek: true, planStatus: null, planItems: 0, lastWorkingDayVisits: 0 });

    // The headline: a week signed off in full is NOT "no plan this week". There was no week to plan.
    assert.equal(
      judgeTerritory(awayAllWeek, RULES),
      null,
      "a rep on approved leave all week must raise NO exception — chasing a plan from someone signed off is the defect",
    );

    const board = buildExceptions([awayAllWeek, clean({ seatId: "SEAT-2", territoryName: "Cairo 2", lastWorkingDayVisits: 0 })], RULES);
    assert.equal(board.rows.length, 1, "the territory that is genuinely behind still raises its row");
    assert.equal(board.rows[0]?.kind, "no_visit");
    assert.equal(board.summary.needingAttention, 1, "needingAttention is what the 06:55 digest sends — an on-leave rep must not be in it");

    // Visible, though: an uncovered territory is worth seeing even when nobody owes a chase.
    assert.equal(board.onLeave.length, 1, "it must still appear, or one blind spot is traded for another");
    assert.equal(board.onLeave[0]?.label, ON_LEAVE_LABEL);
    assert.equal(board.onLeave[0]?.territoryName, "Cairo 1");
    assert.equal(board.summary.onLeave, 1);
    assert.equal(board.summary.territories, 2, "both territories are still counted — leave does not shrink the scope");

    // A FULL day of leave answers "anything?" for that day; a half day does not, because the rep
    // worked the other half and `ApprovedLeaveDay` does not record which half it was.
    assert.equal(judgeTerritory(clean({ lastWorkingDayVisits: 0, leaveOnLastWorkingDay: true }), RULES), null,
      "a full day of approved leave on the last working day owes no visit");
    assert.equal(judgeTerritory(clean({ lastWorkingDayVisits: 0, leaveOnLastWorkingDay: false }), RULES)?.kind, "no_visit",
      "a half day still owed the other half, so a day with no visit at all is still a day with no visit");

    // 🔴 THE DENOMINATOR. Six working days, two of them approved leave, is a FOUR-day week for that
    // rep — the same correction the Thursday fix made, arriving through leave instead of the calendar.
    const twoDaysOff = { windowWorkingDays: 6, windowPmVisits: 40, windowAmVisits: 8, lastWorkingDayVisits: 4 };
    assert.equal(
      judgeTerritory(clean({ ...twoDaysOff, leaveFullDaysInWindow: 0 }), RULES)?.kind,
      "below_pm_rate",
      "40 PM calls over six days is 6.7 against 10 — below, when no leave is known",
    );
    assert.equal(
      judgeTerritory(clean({ ...twoDaysOff, leaveFullDaysInWindow: 2 }), RULES),
      null,
      "the same 40 calls over the FOUR days he actually owed is 10.0 — on target, and reporting him as below is the bug",
    );

    // Part-week leave excuses nothing but the days themselves.
    assert.equal(
      judgeTerritory(clean({ leaveFullDaysInWindow: 2, planStatus: "draft" }), RULES)?.kind,
      "plan_unsent",
      "two days off does not excuse the plan for the other three",
    );

    // Leave never rescues a seat with nobody in it, and never outranks a vacancy.
    assert.equal(judgeTerritory(clean({ hasRep: false, leaveCoversWholeWeek: true }), RULES)?.kind, "vacant",
      "an empty seat is still an empty seat — there is nobody to be on leave");
  }

  console.log("phoenix-crm exceptions: OK");
}
