import assert from "node:assert/strict";

import {
  computeCallRate,
  countCallRateWorkingDays,
  expandHolidayDates,
  isCallRateWorkingDay,
  type RepCallRate,
  type VisitForCallRate,
} from "../src/lib/crm/call-rate.ts";
import { joinKpiRows, kpiMonthOptions } from "../src/lib/crm/kpis-board.ts";
import { KPI_TABS, resolveKpiTab } from "../src/lib/crm/kpis-tabs.ts";
import type { RepDoctorListRepRow } from "../src/lib/crm/rep-doctor-lists.ts";

/**
 * KPIs board — the three things that would each be wrong in a way nobody could see.
 *
 * The board is an assembly of measures that already shipped and are already tested
 * (tests/crm-call-rate.test.ts, tests/rep-doctor-lists.test.ts). What is NEW on 2026-09-02 is:
 *
 *   1. the holiday-aware denominator — the owner's rule, "if we have a national vacation in this
 *      week, then the week will be four";
 *   2. the join, which keys on the CRM agent id rather than the hr id; and
 *   3. the scope filter that runs after that join.
 *
 * Each of those fails silently if it is wrong. A denominator one day too big makes EVERY rep read
 * low by the same amount, which looks like a bad month rather than a bug. A join on the wrong key
 * drops a quarter of the reps in some months and none in others. And a scope filter that fails
 * OPEN shows a District Manager somebody else's reps — the one failure here that nobody reports.
 */

// ── 1. The holiday denominator ────────────────────────────────────────────────────────────────

export function runKpiCallRateHolidayTests() {
  // The owner's own example, in his words: a normal week is five (Sat–Wed; Thursday is a working
  // day but AM-only, so it is not counted), and "if we have a national vacation in this week, then
  // the week will be four".
  //
  // 2026-09-05 is a Saturday, so this window is exactly one of his weeks.
  const weekFrom = "2026-09-05";
  const weekTo = "2026-09-11";
  assert.equal(countCallRateWorkingDays(weekFrom, weekTo), 5, "a plain rep week is Sat-Wed — five days");
  assert.equal(
    countCallRateWorkingDays(weekFrom, weekTo, new Set(["2026-09-07"])),
    4,
    "the owner's rule: one national holiday inside the week makes the week four, not five",
  );

  // A holiday landing on a day already OUTSIDE the denominator changes nothing. Thursday and Friday
  // are not counted in the first place, so subtracting them would take the week to three and
  // inflate every rep's rate — the exact mirror of the bug this rule exists to fix.
  assert.equal(
    countCallRateWorkingDays(weekFrom, weekTo, new Set(["2026-09-10", "2026-09-11"])),
    5,
    "a holiday on a Thursday or Friday must not be subtracted — those days were never in the denominator",
  );

  // The same rule at the level of one day, which is what the per-day split asks.
  assert.equal(isCallRateWorkingDay("2026-09-07"), true, "Monday is a working day");
  assert.equal(
    isCallRateWorkingDay("2026-09-07", new Set(["2026-09-07"])),
    false,
    "a Monday that is a national holiday is not a working day",
  );
  assert.equal(isCallRateWorkingDay("2026-09-10"), false, "Thursday is AM-only and never counted");

  // ── expandHolidayDates: a multi-day holiday is a RANGE, not one date ─────────────────────────
  // Eid runs four or five days. Reading only startDate would leave the rest in the denominator and
  // understate every rep across the biggest holiday of the year.
  assert.deepEqual(
    [...expandHolidayDates([{ endDate: "2026-09-09", startDate: "2026-09-06" }])].sort(),
    ["2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09"],
    "a multi-day holiday must expand to every day it covers, both endpoints included",
  );
  assert.deepEqual(
    [...expandHolidayDates([{ endDate: null, startDate: "2026-09-07" }])],
    ["2026-09-07"],
    "a single-day holiday has no end date and is still one day",
  );
  // A REVERSED range collapses to its start day. The calendar still said that day is a holiday, so
  // dropping it would put a real holiday back in the denominator; what must never happen is the
  // loop running backwards or spanning the range the wrong way round. A malformed START, by
  // contrast, names no day at all and is skipped whole — guessing one would silently shrink the
  // denominator and inflate every rep on the board.
  assert.deepEqual(
    [
      ...expandHolidayDates([
        { endDate: "2026-09-06", startDate: "2026-09-09" },
        { startDate: "not-a-date" },
      ]),
    ],
    ["2026-09-09"],
    "a reversed range keeps its start day and nothing else; a malformed start contributes nothing",
  );

  // ── The report reports what it removed ───────────────────────────────────────────────────────
  // "23 working days, 2 holidays" is answerable; a bare 21 is not, and an unexplained denominator
  // is what a manager escalates as a broken board.
  const visits: VisitForCallRate[] = [
    {
      agent_crm_id: 11,
      agent_hr_id: "A-12",
      agent_name: "Rep One",
      ampm: "PM",
      comment: null,
      contact_crm_id: 900,
      crm_save_date: null,
      visit_date: "2026-09-06",
      visit_type: 0,
      visit_type_description: "Regular",
    },
  ];
  const withHoliday = computeCallRate(visits, [], {
    dateFrom: weekFrom,
    dateTo: weekTo,
    holidays: new Set(["2026-09-07"]),
  });
  assert.equal(withHoliday.workingDays, 4, "the report's denominator carries the holiday rule");
  assert.equal(withHoliday.holidayDays, 1, "and says how many days it removed, so the number is explainable");

  // holidayDays is the DIFFERENCE between the two counts, never the size of the caller's set. That
  // set covers whole months, so it holds Thursdays, Fridays and days outside the window — counting
  // it would report holidays that were never in the denominator to begin with.
  const wideSet = computeCallRate(visits, [], {
    dateFrom: weekFrom,
    dateTo: weekTo,
    holidays: new Set(["2026-09-07", "2026-09-10", "2026-09-11", "2026-10-01"]),
  });
  assert.equal(wideSet.holidayDays, 1, "holidayDays counts days actually removed, not entries in the set");
  assert.equal(wideSet.workingDays, 4, "and the denominator ignores the ones that were never in it");
}

// ── 2. The join and the scope filter ──────────────────────────────────────────────────────────

function callRate(agentCrmId: number | null, agentHrId: string | null, agentName: string): RepCallRate {
  const slice = (verified: number, target: number) => ({
    attainmentPct: Math.round((verified / 5 / target) * 100),
    campaign: 0,
    target,
    total: verified,
    totalRate: verified / 5,
    unverified: 0,
    verified,
    verifiedRate: verified / 5,
  });
  return {
    agentCrmId,
    agentHrId,
    agentName,
    am: slice(4, 2),
    campaignOnlyDays: 0,
    campaignOverLimitDays: [],
    campaignShare: 0,
    pm: slice(20, 10),
    unspecified: 0,
    workingDays: 5,
  };
}

function docList(agentCrmId: number, agentHrId: string | null, repName: string): RepDoctorListRepRow {
  return {
    actualCalls: 30,
    agentCrmId,
    agentHrId,
    campaignCalls: 0,
    coveragePct: 70,
    frequencyPct: 39,
    gradeA: 0,
    gradeB: 0,
    gradeC: 0,
    hasMeasurablePlan: true,
    missedDoctors: 30,
    notDueDoctors: 0,
    offPlanDoctors: 0,
    onPlanDoctors: 39,
    overDoctors: 5,
    plannedAccounts: 0,
    plannedCalls: 100,
    plannedCallsToDate: 100,
    plannedDoctors: 100,
    coverageDueDoctors: 100,
    plannedUnclassified: 0,
    repKey: String(agentCrmId),
    repName,
    underDoctors: 26,
    underPlannedVsGrade: 0,
    unverifiedCalls: 0,
    visitedDoctors: 70,
  };
}

export function runKpisBoardJoinTests() {
  // ── The join key is the CRM agent id, NOT the hr id ──────────────────────────────────────────
  // The plan mirror leaves agent_hr_id null on a large and VARYING share of rows — 791 of 18,645
  // August rows, but 5,795 of 20,778 May rows. An hr-id join would therefore drop a quarter of one
  // month's reps and none of another's, and the board would simply be short of people with no error
  // anywhere. Here the call-rate side knows the hr id and the plan side does not; still ONE rep.
  const joined = joinKpiRows({
    callRates: [callRate(11, "A-12", "Rep One")],
    docLists: [docList(11, null, "Rep One")],
    scope: { basis: "company", kind: "company", label: "Whole company" },
    workingDays: 5,
  });
  assert.equal(joined.length, 1, "one rep on both sides must join to ONE row, on the CRM agent id");
  assert.equal(joined[0].pmVerified, 20, "the call-rate half survived the join");
  assert.equal(joined[0].coveragePct, 70, "and so did the plan half");
  assert.equal(
    joined[0].agentHrId,
    "a-12",
    "the hr id is carried from whichever side has it — scope is enforced on it",
  );

  // A rep present on only ONE side is KEPT. A rep with a plan and no visits at all is the single
  // most important row on this board; dropping him would make the worst case invisible.
  const oneSided = joinKpiRows({
    callRates: [callRate(11, "a-12", "Rep One")],
    docLists: [docList(22, "b-34", "Rep Two")],
    scope: { basis: "company", kind: "company", label: "Whole company" },
    workingDays: 5,
  });
  assert.deepEqual(
    oneSided.map((row) => row.repName),
    ["Rep One", "Rep Two"],
    "a rep on only one source is kept — visits with no plan, and a plan with no visits, are both real",
  );
  assert.equal(
    oneSided[1].hasCallRate,
    false,
    "and the row says which half is missing rather than printing a zero rate",
  );

  // ── Scope: hr ids are MIXED CASE in production ───────────────────────────────────────────────
  // A case-sensitive comparison does not error, it silently returns nobody — and an empty board
  // reads as "your reps did nothing", not as a bug.
  assert.equal(
    joinKpiRows({
      callRates: [callRate(11, "A-12", "Rep One")],
      docLists: [],
      scope: { agentHrIds: ["a-12"], basis: "team", kind: "agents", label: "Your team" },
      workingDays: 5,
    }).length,
    1,
    "hr ids must be compared lower-cased on BOTH sides — production ids are mixed case",
  );

  // ── Scope FAILS CLOSED on an unresolved identity ─────────────────────────────────────────────
  // The two mistakes do not cost the same. Hiding a rep from his own manager is a visible gap he
  // will report; showing him another manager's rep is a confidentiality breach nobody notices.
  assert.deepEqual(
    joinKpiRows({
      callRates: [callRate(99, null, "Unknown Rep")],
      docLists: [],
      scope: { agentHrIds: ["a-12"], basis: "team", kind: "agents", label: "Your team" },
      workingDays: 5,
    }),
    [],
    "a rep whose hr id did not resolve must be HIDDEN from a scoped viewer, never shown",
  );

  // ...but company scope still keeps him: a Super Admin seeing a rep whose identity did not resolve
  // is how that data fault gets noticed at all.
  assert.equal(
    joinKpiRows({
      callRates: [callRate(99, null, "Unknown Rep")],
      docLists: [],
      scope: { basis: "company", kind: "company", label: "Whole company" },
      workingDays: 5,
    }).length,
    1,
    "company scope keeps an unresolved rep — hiding him from Super Admin would hide the data fault too",
  );

  // A viewer with no scope at all sees nothing, whatever the sources hold.
  assert.deepEqual(
    joinKpiRows({
      callRates: [callRate(11, "a-12", "Rep One")],
      docLists: [docList(11, "a-12", "Rep One")],
      scope: { kind: "none", reason: "You have no reps in reach." },
      workingDays: 5,
    }),
    [],
    "scope `none` returns nothing — the page renders its reason instead of an empty table",
  );
}

// ── 3. The tab in the URL ─────────────────────────────────────────────────────────────────────

export function runKpiTabTests() {
  // The whole selection rides in the URL so that every change re-runs the server gate. An
  // unrecognised tab must therefore widen to the summary rather than rendering nothing — a typo'd
  // or truncated link is a blank page otherwise.
  assert.equal(resolveKpiTab(undefined), "summary", "no tab in the URL means the first tab");
  assert.equal(resolveKpiTab("frequency"), "frequency", "a real tab is honoured");
  assert.equal(
    resolveKpiTab("  Frequency "),
    "frequency",
    "case and surrounding space are forgiven — a hand-typed or copied link must not land on a blank page",
  );
  assert.equal(resolveKpiTab("../../etc"), "summary", "and an unrecognised value can never render a fourth thing");
  assert.equal(resolveKpiTab(""), "summary", "an empty tab parameter is the same as no tab at all");
  assert.deepEqual(
    [...KPI_TABS],
    ["summary", "call-rate", "coverage", "frequency"],
    "the owner named these four, in this order: summary, call rate, coverage, frequency",
  );

  // The month picker is string arithmetic on the date, never Date parsing: a `new Date(todayIso)`
  // is UTC midnight and lands in the PREVIOUS month for a Cairo caller just after midnight, which
  // is precisely when this app is used.
  assert.deepEqual(
    kpiMonthOptions("2026-01-01", 3).map((option) => option.value),
    ["2026-01", "2025-12", "2025-11"],
    "the month list walks backwards across a year boundary without touching Date",
  );
}
