import assert from "node:assert/strict";

import { computeCallRate, countCallRateWorkingDays, type VisitForCallRate } from "../src/lib/crm/call-rate.ts";
import { buildRepsPlansBoard, repsPlansRange, repsPlansWeeks } from "../src/lib/crm/reps-plans.ts";

/**
 * THE PERIOD IS THE DENOMINATOR.
 *
 * Owner, 2026-08-28: *"you are hard coding the PM equal of ten and the AM of two. You must consider
 * the timing. If this is the plan of the first week, then you must calculate the call rate on the
 * first week only, not all the month. And if you are calculating two weeks, then the two weeks."*
 *
 * The 2 and the 10 are PER WORKING DAY and always were — the arithmetic was never wrong. What was
 * wrong is that the window could only ever be a whole month, so a week's work was divided by a
 * month's days and every rep read as failing by a factor of four. These tests pin the fix from both
 * ends: the window is selectable, and the rate a given day's work produces does NOT move when the
 * window around it changes.
 *
 * August 2026 is used throughout because it opens on a Saturday, which makes every week block start
 * on a working day and the counts checkable by hand.
 */

/** One AM and five PM calls on a day, all campaign — no check-ins needed to make the point. */
function callsOn(day: string, am: number, pm: number): VisitForCallRate[] {
  const rows: VisitForCallRate[] = [];
  for (let index = 0; index < am + pm; index += 1) {
    rows.push({
      agent_crm_id: 7,
      agent_hr_id: "hr-7",
      agent_name: "Test Rep",
      ampm: index < am ? "AM" : "PM",
      contact_crm_id: null,
      crm_save_date: null,
      visit_date: day,
      visit_type: -8,
      visit_type_description: "Campaign",
      comment: "campaign call",
    });
  }
  return rows;
}

export function runCrmRepsPlansPeriodTests() {
  // ── The weeks a month is offered in ───────────────────────────────────────────────────────────
  {
    const weeks = repsPlansWeeks("2026-08", "2026-08-28");
    assert.equal(weeks.length, 5, "31 days is five blocks — four whole weeks and a three-day tail");
    assert.deepEqual(
      weeks.map((week) => [week.from, week.to]),
      [
        ["2026-08-01", "2026-08-07"],
        ["2026-08-08", "2026-08-14"],
        ["2026-08-15", "2026-08-21"],
        ["2026-08-22", "2026-08-28"],
        ["2026-08-29", "2026-08-31"],
      ],
      "day blocks, not Saturday-anchored calendar weeks — 'the first week' means the first seven days",
    );
    assert.ok(weeks[0].label.includes("1–7 Aug"), "every label carries its real dates, so no convention has to be guessed");

    // A 7-day block starting Saturday holds exactly five Sat–Wed days. The tail holds fewer, and
    // that difference is the entire reason the denominator has to follow the window.
    assert.equal(weeks[0].workingDays, 5, "1–7 Aug is Sat Sun Mon Tue Wed + Thu Fri = 5 counted days");
    // Each week reports the days ELAPSED inside it, not the days it will eventually hold — that is
    // the number the rate actually divides by today, and it is what the picker prints.
    assert.equal(weeks[4].workingDays, 0, "29–31 Aug has not begun on the 28th, so nothing is scorable in it yet");
    assert.equal(weeks[4].started, false);
    const finished = repsPlansWeeks("2026-08", "2026-09-15");
    assert.equal(finished[4].workingDays, 3, "once the month is over the tail is Sat 29, Sun 30, Mon 31 = 3 days");
    assert.equal(finished[3].workingDays, 5, "and a whole 7-day block always holds five Sat–Wed days");

    // A week that has not begun is offered but MARKED — never silently scored as a zero.
    const midMonth = repsPlansWeeks("2026-08", "2026-08-10");
    assert.equal(midMonth[0].started, true);
    assert.equal(midMonth[3].started, false, "22–28 Aug has not started on the 10th");
    assert.equal(midMonth[3].workingDays, 0, "and it therefore has no days to divide by");
  }

  // ── The window bounds the fetch, and stops at today ───────────────────────────────────────────
  {
    const wholeMonth = repsPlansRange("2026-08", "2026-08-28", undefined);
    assert.equal(wholeMonth.periodKey, "month");
    assert.equal(wholeMonth.isWholeMonth, true);
    assert.equal(wholeMonth.dateFrom, "2026-08-01");
    assert.equal(wholeMonth.dateTo, "2026-08-28", "a live month still stops at today — it always did");

    const week1 = repsPlansRange("2026-08", "2026-08-28", "w1");
    assert.equal(week1.dateFrom, "2026-08-01");
    assert.equal(week1.dateTo, "2026-08-07", "week 1 is week 1, not the month it sits in");
    assert.equal(week1.isWholeMonth, false);
    assert.equal(week1.cappedAtToday ?? false, false);

    // A week still running is capped at today, so the rate is not divided by days nobody has worked.
    const running = repsPlansRange("2026-08", "2026-08-25", "w4");
    assert.equal(running.dateFrom, "2026-08-22");
    assert.equal(running.dateTo, "2026-08-25");
    assert.equal(running.windowEnd, "2026-08-28", "the window's own end is kept so the screen can say it was capped");

    // A week that has not begun scores NOTHING. dateFrom > dateTo is the shape
    // countCallRateWorkingDays answers 0 for, so every rate comes back null rather than 0.00.
    const future = repsPlansRange("2026-08", "2026-08-10", "w4");
    assert.equal(future.notStarted, true);
    assert.ok(future.dateFrom > future.dateTo, "an unstarted window must be empty, not one day long");
    assert.equal(countCallRateWorkingDays(future.dateFrom, future.dateTo), 0);

    // Two weeks — his own second example — as an explicit range.
    const twoWeeks = repsPlansRange("2026-08", "2026-08-28", "2026-08-01..2026-08-14");
    assert.equal(twoWeeks.dateFrom, "2026-08-01");
    assert.equal(twoWeeks.dateTo, "2026-08-14");
    assert.equal(countCallRateWorkingDays(twoWeeks.dateFrom, twoWeeks.dateTo), 10, "two whole weeks are ten Sat–Wed days");

    // Anything unreadable falls back to the whole month rather than throwing or scoring a nonsense
    // window — a hand-edited or bookmarked URL must never produce a number nobody can explain.
    for (const bad of [
      "",
      "w9",
      "week1",
      "2026-08-14..2026-08-01",
      "nonsense",
      "..",
      // Digit-shaped but not a real day. This one CRASHED the page before the calendar check: the
      // regex accepts it, and `new Date("2026-13-01T00:00:00Z").toISOString()` throws RangeError.
      "2026-13-01..2026-13-05",
      "2026-02-30..2026-03-05",
    ]) {
      assert.equal(repsPlansRange("2026-08", "2026-08-28", bad).periodKey, "month", `"${bad}" must fall back`);
    }
  }

  // ── THE HEADLINE: the same day's work scores the same rate in any window containing it ────────
  {
    // Five working days of identical effort — 2 AM and 10 PM every day, i.e. exactly on target.
    const perfectWeek = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05"].flatMap((day) =>
      callsOn(day, 2, 10),
    );

    const week1 = repsPlansRange("2026-08", "2026-08-28", "w1");
    const scoredOverWeek = computeCallRate(perfectWeek, [], { dateFrom: week1.dateFrom, dateTo: week1.dateTo });
    assert.equal(scoredOverWeek.workingDays, 5, "week 1 divides by its own five days");
    assert.equal(scoredOverWeek.reps[0].am.totalRate, 2, "2 AM a day over 5 days is a rate of 2 — on target");
    assert.equal(scoredOverWeek.reps[0].pm.totalRate, 10, "and 10 PM a day is a rate of 10");

    const month = repsPlansRange("2026-08", "2026-08-28", undefined);
    const scoredOverMonth = computeCallRate(perfectWeek, [], { dateFrom: month.dateFrom, dateTo: month.dateTo });
    assert.equal(scoredOverMonth.workingDays, 20, "August to the 28th is twenty Sat–Wed days");
    assert.equal(scoredOverMonth.reps[0].am.totalRate, 0.5, "the SAME week over a month reads a quarter of the rate");

    // This is the defect in one line: identical work, four-fold different verdict, and until the
    // period could be chosen the second number was the ONLY one the board could ever show.
    assert.ok(
      scoredOverWeek.reps[0].pm.totalRate! > scoredOverMonth.reps[0].pm.totalRate! * 3.9,
      "a week's work read over a month understates the rep by roughly four times",
    );
  }

  // ── And the board carries the window through, so the caption cannot drift from the numbers ────
  {
    const week2 = repsPlansRange("2026-08", "2026-08-28", "w2");
    const report = computeCallRate(callsOn("2026-08-10", 2, 10), [], {
      dateFrom: week2.dateFrom,
      dateTo: week2.dateTo,
    });
    const board = buildRepsPlansBoard(report, {
      isCurrentMonth: week2.isCurrentMonth,
      month: "2026-08",
      range: week2,
      weekOptions: repsPlansWeeks("2026-08", "2026-08-28"),
    });

    assert.equal(board.periodKey, "w2");
    assert.ok(board.periodLabel.includes("8–14 Aug"), "the board prints the window it was measured over");
    assert.equal(board.isWholeMonth, false);
    assert.equal(board.workingDays, 5, "and the working days shown are the WEEK's, not the month's");
    assert.equal(board.weekOptions.length, 5, "the picker is offered every week of the month");
    // One perfect day inside a five-day week is a fifth of the standard — the honest answer, and one
    // no reader can reach if the denominator silently says twenty.
    assert.equal(board.reps[0].pm.reportedRate, 2, "10 PM calls over the week's 5 days");

    // A board built with NO range is the whole month — the behaviour before the picker existed, so
    // an older caller cannot silently acquire a window it never asked for.
    const legacy = buildRepsPlansBoard(report, { isCurrentMonth: true, month: "2026-08" });
    assert.equal(legacy.periodKey, "month");
    assert.equal(legacy.isWholeMonth, true);
    assert.equal(legacy.notStarted, false);
    assert.deepEqual(legacy.weekOptions, []);
  }

  // ── A window that has not started shows "—", never a zero against a target of 2 ───────────────
  {
    const future = repsPlansRange("2026-08", "2026-08-10", "w4");
    const report = computeCallRate([], [], { dateFrom: future.dateFrom, dateTo: future.dateTo });
    const board = buildRepsPlansBoard(report, {
      isCurrentMonth: true,
      month: "2026-08",
      range: future,
      weekOptions: repsPlansWeeks("2026-08", "2026-08-10"),
    });
    assert.equal(board.notStarted, true);
    assert.equal(board.workingDays, 0);
    assert.equal(board.totals.am.verifiedRate, null, "no working days means no rate — not 0.00, which reads as failure");
    assert.equal(board.totals.pm.attainmentPct, null);
  }
}
