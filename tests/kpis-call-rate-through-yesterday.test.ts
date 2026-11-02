import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  computePhoenixRepKpis,
  type PhoenixKpiWindow,
  type PhoenixPanelContact,
  type PhoenixPlanEntry,
  type PhoenixVisit,
} from "../src/lib/crm/phoenix-kpi-rules.ts";
import { buildRepKpiReports, type KpiVisitInput } from "../src/lib/crm/rep-kpi-reports.ts";
import { CALL_RATE_THROUGH_YESTERDAY, repsPlansRange } from "../src/lib/crm/reps-plans.ts";

// OWNER'S RULING C1 ON THE KPIs BOARD, 2026-09-21 — "apply C1 to the KPIs board too", the same
// morning Reps List began scoring through yesterday (reps-list-through-yesterday.test.ts).
//
// THE CALL RATE ONLY. Every call rate on the board — the legacy report, the Phoenix lanes, and the
// two KPI reports — stops at YESTERDAY, its calls and its working days together. Coverage and
// frequency keep counting today's visits: neither divides by days, so a doctor reached this morning
// is simply a doctor reached, and dropping him until midnight would only make the board wrong.
//
// September 2026: the 1st is a Tuesday and the 21st a Monday. Sat–Wed are working days, so 1–20 Sep
// holds 14 of them and 1–21 Sep holds 15.

const TODAY = "2026-09-21";
const MONTH = { start: "2026-09-01", end: "2026-09-30" };

function visit(contact: number, day: string, extra: Partial<PhoenixVisit> = {}): PhoenixVisit {
  return {
    contact_crm_id: contact,
    visit_date: day,
    visit_type: 0,
    visit_type_description: null,
    comment: null,
    ampm: null,
    speciality: null,
    hasCheckin: true,
    ...extra,
  };
}

const PANEL: PhoenixPanelContact[] = [
  { contactCrmId: 1, listType: "PM", grade: "C" },
  { contactCrmId: 2, listType: "PM", grade: "C" },
  { contactCrmId: 3, listType: "PM", grade: "C" },
];

const PLAN: PhoenixPlanEntry[] = [1, 2, 3].map((contact) => ({
  contactCrmId: contact,
  planDate: "2026-09-21",
  grade: "C",
  speciality: null,
}));

// Yesterday: 28 PM calls on doctor 1, a campaign call (doctor 99 is on no list) and a regular visit
// with no GPS check-in. Today: 5 PM calls on doctor 2 — the only doctor-2 visits of the month — and
// one of each of the other two.
const VISITS: PhoenixVisit[] = [
  ...Array.from({ length: 28 }, () => visit(1, "2026-09-20")),
  visit(99, "2026-09-20"),
  visit(3, "2026-09-20", { hasCheckin: false }),
  ...Array.from({ length: 5 }, () => visit(2, TODAY)),
  visit(99, TODAY),
  visit(3, TODAY, { hasCheckin: false }),
];

function phoenix(window: PhoenixKpiWindow, today = TODAY) {
  return computePhoenixRepKpis({ window, month: MONTH, today, panel: PANEL, planEntries: PLAN, visits: VISITS });
}

function reportVisits(): KpiVisitInput[] {
  return [
    ...Array.from({ length: 28 }, () => ({ contactCrmId: 1, visitDateIso: "2026-09-20" })),
    ...Array.from({ length: 5 }, () => ({ contactCrmId: 2, visitDateIso: TODAY })),
  ];
}

export function runKpisCallRateThroughYesterdayTests() {
  const month = repsPlansRange("2026-09", TODAY, undefined);
  const callMonth = repsPlansRange("2026-09", TODAY, undefined, CALL_RATE_THROUGH_YESTERDAY);
  assert.equal(month.dateTo, TODAY, "coverage's window still runs through today");
  assert.equal(callMonth.dateTo, "2026-09-20", "the call rate's window stops at yesterday");
  assert.equal(callMonth.windowEnd, month.windowEnd, "one period — only the last day scored differs");

  // ── 1. The Phoenix rules: the call rate stops at yesterday, coverage does not ──────────────────
  {
    const through = { dateFrom: month.dateFrom, dateTo: month.dateTo, windowEnd: month.windowEnd };
    const kpis = phoenix({ ...through, callRateTo: callMonth.dateTo });
    assert.equal(kpis.workingDays, 14, "the call rate divides by the 14 working days that are over");
    assert.equal(kpis.pm.visits, 28, "and counts only their calls — today's 5 are not in the numerator");
    assert.equal(kpis.pm.rate, 2, "28 calls over 14 days; with today's day and calls in, 2.2");
    assert.equal(kpis.campaignVisits, 1, "the campaign line stops at yesterday with the rate beside it");
    assert.equal(kpis.regularNoCheckin, 1, "and so does the no-check-in line");
    assert.equal(kpis.coverage.planned, 3);
    assert.equal(kpis.coverage.visited, 2, "doctor 2, seen only TODAY, is already covered");

    // The same inputs with no call-rate end: exactly what the board read before the ruling.
    const before = phoenix(through);
    assert.equal(before.workingDays, 15, "left out, the call rate runs to dateTo as it always did");
    assert.equal(before.pm.visits, 33);
    assert.equal(before.campaignVisits, 2);
    assert.equal(before.regularNoCheckin, 2);
    assert.deepEqual(kpis.coverage, before.coverage, "coverage does not move — the ruling is the call rate's");
    assert.deepEqual(kpis.frequency, before.frequency, "and neither does frequency");
  }

  // ── 2. A period that opened today: an empty rate, never a red 0.00 ────────────────────────────
  {
    const week4 = repsPlansRange("2026-09", "2026-09-22", "w4");
    const callWeek4 = repsPlansRange("2026-09", "2026-09-22", "w4", CALL_RATE_THROUGH_YESTERDAY);
    assert.ok(callWeek4.dateTo < callWeek4.dateFrom, "22–28 Sep on the 22nd: nothing in it is over yet");
    assert.equal(callWeek4.todayLeftOut, true, "and the range says so, so the screen can");
    const kpis = computePhoenixRepKpis({
      window: { dateFrom: week4.dateFrom, dateTo: week4.dateTo, windowEnd: week4.windowEnd, callRateTo: callWeek4.dateTo },
      month: MONTH,
      today: "2026-09-22",
      panel: PANEL,
      planEntries: [{ contactCrmId: 1, planDate: "2026-09-22", grade: "C", speciality: null }],
      visits: [visit(1, "2026-09-22"), visit(1, "2026-09-22")],
    });
    assert.equal(kpis.workingDays, 0, "no working day of the week is over");
    assert.equal(kpis.pm.visits, 0);
    assert.equal(kpis.pm.rate, null, "so there is no rate — not 0.00, which reads as failure");
    assert.equal(kpis.coverage.visited, 1, "while this morning's doctor already counts as covered");
  }

  // ── 3. The two KPI reports: the same split ────────────────────────────────────────────────────
  {
    const build = (callRateTo?: string) =>
      buildRepKpiReports({
        repHrId: "AI-0007",
        repName: "Test Rep",
        month: "2026-09",
        workingDays: 14,
        callRateTo,
        panel: [
          { contactCrmId: 1, listType: "PM", grade: "C" },
          { contactCrmId: 2, listType: "PM", grade: "C" },
        ],
        visits: reportVisits(),
      });
    const report = build("2026-09-20");
    assert.equal(report.ampm.pm.callRate.visits, 28, "the report's call rate stops at yesterday");
    assert.equal(report.ampm.pm.callRate.perWorkingDay, 2, "over the same 14 working days as the board");
    assert.equal(report.ampm.pm.coverage.visited, 2, "its coverage still counts doctor 2, seen today");
    const before = build();
    assert.equal(before.ampm.pm.callRate.visits, 33, "left out, every visit counts toward the rate");
    assert.deepEqual(report.ampm.pm.coverage, before.ampm.pm.coverage, "coverage is the same either way");
    assert.deepEqual(report.ampm.pm.frequency, before.ampm.pm.frequency, "and so is frequency");
  }

  // ── 4. The board asks for it everywhere a rate is read, and the screen says it ────────────────
  {
    const board = readFileSync("src/lib/crm/kpis-board.ts", "utf8");
    assert.ok(
      board.includes("repsPlansRange(input.month, input.todayIso, input.period, CALL_RATE_THROUGH_YESTERDAY)"),
      "the board builds a through-yesterday call-rate window",
    );
    // The scope's reps may ride along (2026-10-01, crm/kpi-board-agents.ts); the window may not move.
    assert.ok(
      /loadCallRateReport\(\{\s*dateFrom: callRange\.dateFrom,\s*dateTo: callRange\.dateTo(?:,\s*reuseRecentWindow: true)?(?:,\s*startedWindows: startedRead)?(?:,\s*\.\.\.\(agents \? \{ agents \} : \{\}\))?,?\s*\}\)/.test(board),
      "the call-rate report — every row's rate and working days — reads it",
    );
    assert.equal(
      board.split("callRateTo: callRange.dateTo").length - 1,
      2,
      "the Phoenix rules AND the two KPI reports stop their call rate at yesterday",
    );
    assert.ok(board.includes("range: callRange,"), "the board's range is the call-rate window the footer prints");
    assert.ok(
      board.includes("window: { from: range.dateFrom, to: range.windowEnd }"),
      "coverage's doctor lists keep the whole window, as before",
    );

    const view = readFileSync("src/components/crm/kpis-board-view.tsx", "utf8");
    assert.ok(
      view.includes('board.range.todayLeftOut ? " — today is not scored until it is over" : ""'),
      "the footer says why the call rate ends a day before coverage",
    );
    assert.ok(view.includes("began today, and today is not scored until it is over"), "and why a new period has no rate");
    assert.ok(
      view.includes("if (board.range.todayLeftOut && board.workingDays === 0) {"),
      "a period with no working day over yet gets no verdict on its coverage",
    );
  }
}
