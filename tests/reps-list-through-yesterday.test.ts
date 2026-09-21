import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { computeCallRate, countCallRateWorkingDays, type VisitForCallRate } from "../src/lib/crm/call-rate.ts";
import { buildRepsPlansBoard, CALL_RATE_THROUGH_YESTERDAY, repsPlansRange, repsPlansWeeks } from "../src/lib/crm/reps-plans.ts";

// OWNER'S RULING C1, 2026-09-21 — "fix Reps List with B2, C1 and D2": Reps List scores through
// YESTERDAY.
//
// Counting today from midnight divided every rep by a working day he had not worked yet: at 06:33 on
// 21 Sep there were 0 visits logged for the day against 561 the day before, so every rate on the
// board read about 7% low until the field force caught up. Today's calls and today's working day now
// leave the window TOGETHER, and come back once the day is over.
//
// B2 and D2 in the same message keep what the board already does — the whole month's days for a
// leaver or a new hire, and a resigned rep hidden once HR marks him — so neither changes any code.
//
// The ruling named Reps List; the KPIs board took it for its call rate the same morning (pinned in
// kpis-call-rate-through-yesterday.test.ts). The DEFAULT — what the KPIs board's coverage and
// frequency still read — runs through today; section 1 pins that it did not move.
//
// September 2026: the 1st is a Tuesday and the 21st a Monday. Sat–Wed are working days, so 1–20 Sep
// holds 14 of them and 1–21 Sep holds 15.

const TODAY = "2026-09-21";

function visit(day: string, index: number): VisitForCallRate {
  return {
    agent_crm_id: 7,
    agent_hr_id: "AI-0007",
    agent_name: "Test Rep",
    ampm: "PM",
    comment: null,
    contact_crm_id: 700 + index,
    crm_save_date: `${day}T11:00:00`,
    speciality: null,
    visit_date: day,
    visit_type: 0,
    visit_type_description: "Regular Visit",
  };
}

export function runRepsListThroughYesterdayTests() {
  // ── 1. The default — the KPIs board's coverage window — still runs through today ─────────────
  {
    const kpis = repsPlansRange("2026-09", TODAY, undefined);
    assert.equal(kpis.dateTo, TODAY, "without the option a live month still stops at today, as it always did");
    assert.equal(kpis.todayLeftOut, false);
    assert.equal(countCallRateWorkingDays(kpis.dateFrom, kpis.dateTo), 15);
    assert.equal(repsPlansWeeks("2026-09", TODAY)[2].workingDays, 5, "15–21 Sep through today: Tue Wed Sat Sun Mon");
  }

  // ── 2. Reps List stops a running window at yesterday ──────────────────────────────────────────
  {
    const month = repsPlansRange("2026-09", TODAY, undefined, CALL_RATE_THROUGH_YESTERDAY);
    assert.equal(month.dateFrom, "2026-09-01");
    assert.equal(month.dateTo, "2026-09-20", "the month to date runs through YESTERDAY — today is not over");
    assert.equal(month.todayLeftOut, true, "and the range says it left today out, so the screen can say so");
    assert.equal(month.isCurrentMonth, true, "it is still this month — only the last day scored moved");
    assert.equal(countCallRateWorkingDays(month.dateFrom, month.dateTo), 14, "14 working days, not 15");

    // A week still running, on its own last day.
    const week3 = repsPlansRange("2026-09", TODAY, "w3", CALL_RATE_THROUGH_YESTERDAY);
    assert.equal(week3.windowEnd, "2026-09-21", "15–21 Sep ends today");
    assert.equal(week3.dateTo, "2026-09-20", "and is scored through yesterday even on its final day");
    assert.equal(week3.todayLeftOut, true);
    assert.equal(
      repsPlansWeeks("2026-09", TODAY, CALL_RATE_THROUGH_YESTERDAY)[2].workingDays,
      4,
      "the week picker counts the days the rate divides by: Tue 15, Wed 16, Sat 19, Sun 20",
    );

    // An explicit range reaching today is capped the same way.
    const range = repsPlansRange("2026-09", TODAY, "2026-09-14..2026-09-21", CALL_RATE_THROUGH_YESTERDAY);
    assert.equal(range.dateTo, "2026-09-20");
  }

  // ── 3. A window that opened TODAY scores empty, never a red 0.00 ──────────────────────────────
  {
    const week4 = repsPlansRange("2026-09", "2026-09-22", "w4", CALL_RATE_THROUGH_YESTERDAY);
    assert.equal(week4.notStarted, false, "22–28 Sep HAS started on the 22nd — it is not a future week");
    assert.ok(week4.dateFrom > week4.dateTo, "but nothing in it is over yet, so the window is empty");
    assert.equal(countCallRateWorkingDays(week4.dateFrom, week4.dateTo), 0);
    assert.equal(week4.todayLeftOut, true);

    const october = repsPlansRange("2026-10", "2026-10-01", undefined, CALL_RATE_THROUGH_YESTERDAY);
    assert.equal(october.dateTo, "2026-09-30", "on the 1st the month to date is empty until the day is over");
    assert.equal(countCallRateWorkingDays(october.dateFrom, october.dateTo), 0);

    const board = buildRepsPlansBoard(computeCallRate([], [], { dateFrom: october.dateFrom, dateTo: october.dateTo }), {
      isCurrentMonth: october.isCurrentMonth,
      month: "2026-10",
      range: october,
      weekOptions: repsPlansWeeks("2026-10", "2026-10-01", CALL_RATE_THROUGH_YESTERDAY),
    });
    assert.equal(board.workingDays, 0);
    assert.equal(board.totals.pm.verifiedRate, null, "no day is over, so no rate — not 0.00, which reads as failure");
    assert.equal(board.todayLeftOut, true);
  }

  // ── 4. Windows today is not inside are untouched ──────────────────────────────────────────────
  {
    const august = repsPlansRange("2026-08", TODAY, undefined, CALL_RATE_THROUGH_YESTERDAY);
    assert.equal(august.dateTo, "2026-08-31", "a finished month is scored whole");
    assert.equal(august.todayLeftOut, false, "and there is no today in it to leave out");
    const week1 = repsPlansRange("2026-09", TODAY, "w1", CALL_RATE_THROUGH_YESTERDAY);
    assert.equal(week1.dateTo, "2026-09-07", "a finished week is scored to its own end");
    assert.equal(week1.todayLeftOut, false);
    const future = repsPlansRange("2026-09", "2026-09-10", "w4", CALL_RATE_THROUGH_YESTERDAY);
    assert.equal(future.notStarted, true, "a week that has not begun is still 'not started'");
    assert.equal(future.todayLeftOut, false);
    const december = repsPlansRange("2026-12", TODAY, undefined, CALL_RATE_THROUGH_YESTERDAY);
    assert.equal(december.dateTo, "2026-12-31", "a future month is still scored whole, as it always was");
  }

  // ── 5. The rate: yesterday's work over the days that are over ─────────────────────────────────
  {
    const month = repsPlansRange("2026-09", TODAY, undefined, CALL_RATE_THROUGH_YESTERDAY);
    // 28 PM calls up to yesterday. The fetch is bounded by the range, so today's calls never arrive.
    const visits = Array.from({ length: 28 }, (_, index) => visit("2026-09-20", index));
    const board = buildRepsPlansBoard(computeCallRate(visits, [], { dateFrom: month.dateFrom, dateTo: month.dateTo }), {
      isCurrentMonth: true,
      month: "2026-09",
      range: month,
      weekOptions: repsPlansWeeks("2026-09", TODAY, CALL_RATE_THROUGH_YESTERDAY),
    });
    assert.equal(board.workingDays, 14);
    assert.equal(board.reps[0].pm.reportedRate, 2, "28 calls over 14 days that are over — with today in, 1.87");
    assert.equal(board.cappedAtToday, true, "the month is not over, and the board knows it");
    assert.equal(board.todayLeftOut, true);
  }

  // ── 6. Reps List asks for it, in both places, and the screens say it ──────────────────────────
  {
    const loader = readFileSync("src/lib/crm/reps-list-call-rate.ts", "utf8");
    assert.ok(
      loader.includes("repsPlansRange(month, today, params?.period, CALL_RATE_THROUGH_YESTERDAY)"),
      "the Call rate tab scores through yesterday",
    );
    assert.ok(loader.includes("repsPlansWeeks(month, today, CALL_RATE_THROUGH_YESTERDAY)"), "and its week picker counts the same days");
    const drilldown = readFileSync("src/components/crm/rep-visits-page.tsx", "utf8");
    assert.ok(
      drilldown.includes("repsPlansRange(month, today, query?.period, CALL_RATE_THROUGH_YESTERDAY)"),
      "the rep page opened from a row is measured over the same days as the row",
    );
    assert.ok(drilldown.includes("board.todayLeftOut ?"), "and says why today's calls are not listed yet");
    const boardView = readFileSync("src/components/crm/reps-plans-board.tsx", "utf8");
    assert.ok(boardView.includes("today is not scored until it is over"), "the board's caption says today is left out");
    assert.ok(boardView.includes("began today — nothing is scored until today is over"), "and why a new window is empty");
  }
}
