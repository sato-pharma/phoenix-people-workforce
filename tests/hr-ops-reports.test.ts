import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

import { attendanceManagementPageItems, getNavigationSections } from "../src/config/system-navigation.ts";
import { resolveActivityModule } from "../src/lib/activity/modules.ts";
import { buildPermissionLookup, permissionMatrix, type NavigationMode, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import { sumDetectedDeductionDayWeights } from "../src/lib/field-workforce-compliance/weekend-policy.ts";
import {
  buildFieldLines,
  cairoClockTime,
  countOwnVisits,
  MANAGER_OWN_VISITS_COUNT_IN_OWN_ROW,
  type CountedVisit,
  type FieldLinesInput,
} from "../src/lib/hr-ops-reports/field-section.ts";
import { judgeOfficeDay, type OfficeDayInput } from "../src/lib/hr-ops-reports/office-section.ts";
import { dailyPeriod, parsePeriodKey, periodTitle, scheduledPeriods, weeklyPeriod } from "../src/lib/hr-ops-reports/periods.ts";
import { buildQueue } from "../src/lib/hr-ops-reports/queue.ts";
import {
  bridgeStatusForDecision,
  decisionIsOpen,
  defaultDecisionDays,
  MAX_DAYS,
  reportProgress,
  validateDecision,
  validateReview,
} from "../src/lib/hr-ops-reports/rules.ts";
import { findMoneyKeys, viewLine, viewReportWithLines } from "../src/lib/hr-ops-reports/serialize.ts";
import {
  HR_OPS_BRIDGE_STATUSES,
  HR_OPS_DECISIONS,
  HR_OPS_LINE_COLUMNS,
  HR_OPS_REPORT_COLUMNS,
  HR_OPS_REPORT_KINDS,
  HR_OPS_REPORT_STATUSES,
  HR_OPS_REVIEW_ACTIONS,
  HR_OPS_SECTIONS,
  HrOpsReportsError,
  type HrOpsReportLineRow,
  type HrOpsReportRow,
} from "../src/lib/hr-ops-reports/types.ts";
import { getSections } from "../src/lib/navigation/active-path.ts";
import { resolveNotificationPolicy } from "../src/lib/notifications/policy.ts";
import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";

/**
 * THE HR DAILY & WEEKLY REPORTS (owner, 2026-10-20, building the HR Operations Specialist seat).
 *
 * A daily and a weekly report of the head office's fingerprint days and the field force's visits.
 * She answers every flagged row — confirm, reject or recommend days, with a reason — and submits; the
 * Super Admin decides each row, and a decided day travels into the weekly attendance review
 * (src/lib/hr-ops-reports/bridge.ts, pinned by tests/hr-ops-reports-bridge.test.ts). Days only: her
 * payload never carries an amount.
 *
 * What this file pins, each a way the module could quietly go wrong:
 *   1. the periods — field Saturday to Thursday, head office Sunday to Thursday, no Friday report;
 *   2. the office judgment — a day nobody can judge honestly is never flagged;
 *   3. the manager's own visits — they count in HIS row only, behind one named switch;
 *   4. her review and his decision — every refusal is a sentence, and a decided day the weekly
 *      review already holds is locked, even when its last carry failed;
 *   5. the migration and the code agree on every literal;
 *   6. the routes, the registry, the grants, the notification policy, the activity label and the rail;
 *   7. no payload she receives names money;
 *   8. the cron builds the reports AFTER the weekly-review sync, retries the decided days AFTER the
 *      build, and never fails the digest run.
 */

const ROOT = process.cwd();
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");
const code = (relative: string) => stripComments(read(relative));

const MIGRATION = "supabase/migrations/20261020065354_hr_ops_reports.sql";
const REPORT_ID = "11111111-1111-4111-8111-111111111111";
const LINE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LINE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LINE_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LINE_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function refusal(run: () => unknown, pattern: RegExp, what: string) {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof HrOpsReportsError, `${what}: expected an HrOpsReportsError, got ${String(error)}`);
    assert.match(error.message, pattern, `${what}: the refusal must say why in words`);
    return true;
  });
}

function reportRow(overrides: Partial<HrOpsReportRow> = {}): HrOpsReportRow {
  return {
    build_warnings: [],
    built_at: "2026-10-20T06:00:00.000Z",
    created_at: "2026-10-20T06:00:00.000Z",
    decided_at: null,
    decided_by_hr_id: null,
    field_from: "2026-10-19",
    field_to: "2026-10-19",
    id: REPORT_ID,
    kind: "daily",
    line_count: 4,
    office_from: "2026-10-19",
    office_to: "2026-10-19",
    period_key: "daily:2026-10-19",
    rebuilt_at: null,
    status: "in_review",
    submitted_at: null,
    submitted_by_hr_id: null,
    updated_at: "2026-10-20T06:00:00.000Z",
    ...overrides,
  };
}

function lineRow(overrides: Partial<HrOpsReportLineRow> = {}): HrOpsReportLineRow {
  return {
    area_name: null,
    bridge_message: null,
    bridge_ref: null,
    bridge_status: "not_decided",
    bridged_at: null,
    carried_from_line_id: null,
    created_at: "2026-10-20T06:00:00.000Z",
    decided_at: null,
    decided_by_hr_id: null,
    decided_days: null,
    decision: null,
    employee_name: "Test Person",
    flags: [],
    hr_id: "HO-9301",
    hr_key: "ho-9301",
    id: LINE_A,
    job_title: "Accountant",
    line_name: "Finance",
    manager_name: null,
    metrics: { kind: "office", notes: [], status: "Complete" },
    recommended_days: null,
    report_id: REPORT_ID,
    review_action: null,
    review_comment: null,
    review_reason: null,
    reviewed_at: null,
    reviewed_by_hr_id: null,
    section: "office",
    suggested_days: null,
    updated_at: "2026-10-20T06:00:00.000Z",
    work_date: "2026-10-19",
    ...overrides,
  } as HrOpsReportLineRow;
}

// ── 1. Periods ──────────────────────────────────────────────────────────────────────────────────
function testPeriods() {
  // 2026-10-16 is a Friday, 17 a Saturday, 18 a Sunday, 19 a Monday, 22 a Thursday.
  assert.equal(dailyPeriod("2026-10-16"), null, "there is no Friday report — nobody works");

  const saturday = dailyPeriod("2026-10-17");
  assert.ok(saturday);
  assert.equal(saturday.fieldFrom, "2026-10-17", "a Saturday daily carries the field section");
  assert.equal(saturday.officeFrom, null, "head office does not work Saturdays");
  assert.equal(saturday.officeTo, null);

  const monday = dailyPeriod("2026-10-19");
  assert.ok(monday);
  assert.deepEqual(
    [monday.periodKey, monday.officeFrom, monday.officeTo, monday.fieldFrom, monday.fieldTo],
    ["daily:2026-10-19", "2026-10-19", "2026-10-19", "2026-10-19", "2026-10-19"],
  );

  const week = weeklyPeriod("2026-10-20");
  assert.ok(week);
  assert.deepEqual(
    [week.periodKey, week.fieldFrom, week.fieldTo, week.officeFrom, week.officeTo],
    ["weekly:2026-10-17", "2026-10-17", "2026-10-22", "2026-10-18", "2026-10-22"],
    "the week: field Saturday to Thursday, head office Sunday to Thursday",
  );
  for (const day of ["2026-10-17", "2026-10-18", "2026-10-21", "2026-10-22", "2026-10-23"]) {
    assert.equal(weeklyPeriod(day)?.periodKey, "weekly:2026-10-17", `${day} names the same weekly report`);
  }

  assert.deepEqual(scheduledPeriods("2026-10-17").map((period) => period.periodKey), [], "Saturday's run: yesterday was a Friday");
  assert.deepEqual(scheduledPeriods("2026-10-20").map((period) => period.periodKey), ["daily:2026-10-19"]);
  assert.deepEqual(
    scheduledPeriods("2026-10-18").map((period) => period.periodKey),
    ["daily:2026-10-17", "weekly:2026-10-10"],
    "Sunday's run builds Saturday's daily and the week that ended on Thursday — never the week that has just begun",
  );
  assert.equal(weeklyPeriod("2026-10-10")?.fieldTo, "2026-10-15");
  assert.deepEqual(scheduledPeriods("not-a-day"), []);

  assert.deepEqual(parsePeriodKey("weekly:2026-10-10"), { anchor: "2026-10-10", kind: "weekly" });
  assert.equal(parsePeriodKey("monthly:2026-10-01"), null);
  assert.equal(parsePeriodKey("daily:2026-02-30"), null, "an impossible date is not a period");

  assert.equal(
    periodTitle({ anchor: "2026-10-10", fieldTo: "2026-10-15", kind: "weekly", officeTo: "2026-10-15" }),
    "Weekly report · 10 Oct to 15 Oct 2026",
  );
  const daily = periodTitle({ anchor: "2026-10-19", kind: "daily" });
  assert.ok(daily.startsWith("Daily report · ") && daily.includes("19 October 2026"), daily);
}

// ── 2. The office judgment ──────────────────────────────────────────────────────────────────────
function officeDay(overrides: Partial<OfficeDayInput> = {}): OfficeDayInput {
  return {
    anyLeave: false,
    approvedExcuse: false,
    crmDetail: null,
    crmFieldVisit: false,
    crmLeave: false,
    dateIso: "2026-10-19",
    deviceOutage: false,
    employee: { department: "Finance", employeeName: "Test Person", hrId: "HO-9301", jobTitle: "Accountant" },
    exception: null,
    fullDayLeave: false,
    holidayCalendarReachable: true,
    holidayName: null,
    isFuture: false,
    isHoliday: false,
    isWeeklyOff: false,
    planSaysOffice: null,
    policy: null,
    punch: null,
    trip: null,
    unreadableCovers: [],
    ...overrides,
  };
}

function punch(overrides: Record<string, unknown> = {}): NonNullable<OfficeDayInput["punch"]> {
  return {
    actualFirstPunch: "09:20",
    actualLastPunch: "17:05",
    deductionDays: "",
    earlyLeaveMinutes: "0",
    hasException: false,
    lateMinutes: "0",
    recommendedAction: "",
    scheduledEnd: "17:00",
    scheduledStart: "09:00",
    status: "Complete",
    timeLong: "7:45",
    ...overrides,
  } as NonNullable<OfficeDayInput["punch"]>;
}

function testOfficeJudgment() {
  const missing = judgeOfficeDay(officeDay());
  assert.ok(missing);
  assert.deepEqual(missing.flags, ["no_punch"], "a working day with no punch and nothing covering it is flagged");
  assert.equal(missing.suggestedDays, null, "the policy offers no figure for a missing day — her recommendation supplies it");
  assert.equal(missing.metrics.kind, "office");
  assert.ok(missing.metrics.notes.some((note) => /No attendance policy/.test(note)), "a person with no policy is said so");

  assert.equal(judgeOfficeDay(officeDay({ isWeeklyOff: true })), null, "a weekly off with no punch is not a row");
  assert.equal(judgeOfficeDay(officeDay({ isFuture: true })), null, "a day not yet over is not a row");

  const noCalendar = judgeOfficeDay(officeDay({ holidayCalendarReachable: false }));
  assert.ok(noCalendar);
  assert.deepEqual(noCalendar.flags, [], "an unreadable holiday calendar never turns a day into a no-punch flag");
  assert.ok(noCalendar.metrics.notes.some((note) => /holiday calendar could not be read/.test(note)));

  const unreadable = judgeOfficeDay(officeDay({ unreadableCovers: ["approved leave"] }));
  assert.ok(unreadable);
  assert.deepEqual(unreadable.flags, [], "an unreadable cover source never turns a day into a no-punch flag");
  assert.ok(unreadable.metrics.notes.some((note) => /approved leave could not be read/.test(note)));

  for (const [label, covered] of [
    ["a full-day leave", officeDay({ anyLeave: true, fullDayLeave: true })],
    ["an approved excuse", officeDay({ approvedExcuse: true })],
    ["a CRM field visit", officeDay({ crmFieldVisit: true })],
    ["a device outage", officeDay({ deviceOutage: true })],
    ["a business trip", officeDay({ trip: "Outstation trip to Aswan (approved)" })],
    ["an approved exception", officeDay({ exception: { reason: "Hospital visit", status: "approved" } })],
  ] as const) {
    const line = judgeOfficeDay(covered);
    assert.ok(line, `${label}: the day is still shown`);
    assert.deepEqual(line.flags, [], `${label} covers the day — no flag`);
    assert.ok(line.metrics.notes.length > 0, `${label}: the line says what covered the day`);
  }

  const single = judgeOfficeDay(officeDay({ punch: punch({ deductionDays: "0.5", lateMinutes: "20", status: "Single punch" }) }));
  assert.ok(single);
  assert.deepEqual(single.flags, ["single_punch", "late"], "lateness is its own flag beside the single punch");
  assert.equal(single.suggestedDays, 0.5, "a flagged punched day carries the policy's figure, in days");

  const clean = judgeOfficeDay(officeDay({ punch: punch({ deductionDays: "0.25" }) }));
  assert.ok(clean);
  assert.deepEqual(clean.flags, [], "a complete day is clean");
  assert.equal(clean.suggestedDays, null, "a clean line carries no suggested days, whatever the policy column holds");

  const holidayPunch = judgeOfficeDay(officeDay({ holidayName: "Armed Forces Day", isHoliday: true, punch: punch() }));
  assert.ok(holidayPunch, "a punch on a holiday is shown");
  assert.deepEqual(holidayPunch.flags, [], "and never judged");
}

// ── 3. A manager's own visits count in his own row only ─────────────────────────────────────────
const MANAGER = "DM-9101";
const REP = "MR-9202";

function fieldInput(visits: readonly CountedVisit[], overrides: Partial<FieldLinesInput> = {}): FieldLinesInput {
  return {
    calendar: {
      judged: true,
      people: [{ judgedDates: ["2026-10-19"], key: REP, notSeenDates: [] }],
    } as unknown as FieldLinesInput["calendar"],
    directory: new Map([
      [MANAGER, { areaName: "Cairo", jobTitle: "District Manager", lineName: "CNS", managerName: null, name: "Test Manager" }],
      [REP, { areaName: "Cairo", jobTitle: "Medical Rep", lineName: "CNS", managerName: "Test Manager", name: "Test Rep" }],
    ]),
    end: "2026-10-19",
    people: [{ employmentActive: true, hireDate: "2024-01-01", key: REP, lastWorkingDate: null, name: "Test Rep", spans: [] }],
    productManagerKeys: new Set(),
    seen: new Map(),
    start: "2026-10-19",
    today: "2026-10-20",
    visits,
    ...overrides,
  };
}

function testManagerOwnVisits() {
  assert.equal(MANAGER_OWN_VISITS_COUNT_IN_OWN_ROW, true, "the owner's choice, 2026-10-20: \"Show the 6 visits\"");

  const ownRows = [
    { bucket: "AM", date: "2026-10-19", loggedAt: "2026-10-19T06:40:00.000Z", managerHrId: MANAGER },
    { bucket: "AM", date: "2026-10-19", loggedAt: "2026-10-19T07:10:00.000Z", managerHrId: MANAGER },
    { bucket: "PM", date: "2026-10-19", loggedAt: "2026-10-19T12:00:00.000Z", managerHrId: MANAGER },
    { bucket: "PM", date: "2026-10-19", loggedAt: "2026-10-19T12:30:00.000Z", managerHrId: MANAGER },
    { bucket: "PM", date: "2026-10-19", loggedAt: "2026-10-19T13:15:00.000Z", managerHrId: MANAGER },
    { bucket: "Pharmacy", date: "2026-10-19", loggedAt: "2026-10-19T14:00:00.000Z", managerHrId: MANAGER },
    // Earlier in the month: in his month to date, outside the report's day.
    { bucket: "AM", date: "2026-10-05", loggedAt: "2026-10-05T07:00:00.000Z", managerHrId: MANAGER },
  ];
  const own = countOwnVisits(ownRows);
  assert.ok(own.every((visit) => visit.own && visit.creditKeys.length === 1 && visit.creditKeys[0] === MANAGER), "an own visit credits its manager alone");

  const repVisits: CountedVisit[] = [
    { bucket: "AM", creditKeys: [REP], date: "2026-10-19", own: false, time: "10:00" },
    { bucket: "AM", creditKeys: [REP], date: "2026-10-19", own: false, time: "11:00" },
  ];

  const on = buildFieldLines(fieldInput([...own, ...repVisits]));
  const managerLine = on.find((line) => line.hrId === MANAGER);
  const repLine = on.find((line) => line.hrId === REP);
  assert.ok(managerLine, "the manager has a row on the day of his own visits");
  assert.ok(repLine);
  assert.equal(managerLine.metrics.kind, "field");
  assert.equal(repLine.metrics.kind, "field");
  if (managerLine.metrics.kind !== "field" || repLine.metrics.kind !== "field") return;

  assert.deepEqual(
    [managerLine.metrics.am, managerLine.metrics.pm, managerLine.metrics.pharmacies, managerLine.metrics.total, managerLine.metrics.ownVisits],
    [2, 3, 1, 6, 6],
    "his six own visits fill his own AM / PM / Pharmacies and total",
  );
  assert.equal(managerLine.metrics.monthToDate, 7, "and his month to date");
  assert.equal(managerLine.metrics.firstVisit, cairoClockTime("2026-10-19T06:40:00.000Z"), "his first visit time, on the Cairo clock");
  assert.equal(managerLine.metrics.lastVisit, cairoClockTime("2026-10-19T14:00:00.000Z"), "his last visit time, on the Cairo clock");
  assert.ok(managerLine.metrics.notes.some((note) => /6 of the manager's own single visits/.test(note)), "the row says the six are his own");
  assert.deepEqual(managerLine.flags, [], "a manager is never flagged here for a day spent on his own visits");
  assert.equal(on.filter((line) => line.hrId === MANAGER).length, 1, "the earlier own visit makes no row outside the report's day");

  assert.deepEqual(
    [repLine.metrics.am, repLine.metrics.pm, repLine.metrics.pharmacies, repLine.metrics.total, repLine.metrics.ownVisits, repLine.metrics.monthToDate],
    [2, 0, 0, 2, 0, 2],
    "the rep's row holds the rep's own two visits and none of the manager's",
  );

  const off = buildFieldLines(fieldInput([...own, ...repVisits], { managerOwnVisitsCountInOwnRow: false }));
  assert.equal(off.find((line) => line.hrId === MANAGER), undefined, "switched off, his own visits make no row");
  const repOff = off.find((line) => line.hrId === REP);
  assert.ok(repOff && repOff.metrics.kind === "field");
  if (repOff.metrics.kind === "field") assert.equal(repOff.metrics.total, 2, "and the rep's row is unchanged either way");

  // Whatever a caller hands in, an own visit credits ONE person: the first key, its manager.
  const smuggled = buildFieldLines(fieldInput([
    ...repVisits,
    { bucket: "PM", creditKeys: [MANAGER, REP], date: "2026-10-19", own: true, time: "12:00" },
  ]));
  const repSmuggled = smuggled.find((line) => line.hrId === REP);
  assert.ok(repSmuggled && repSmuggled.metrics.kind === "field");
  if (repSmuggled.metrics.kind === "field") {
    assert.equal(repSmuggled.metrics.total, 2, "an own visit is never credited to a rep's row");
    assert.equal(repSmuggled.metrics.ownVisits, 0);
  }

  // A not-seen finished day is the one field flag, weighed by the field-workforce rule.
  const absentInput = fieldInput([], {
    calendar: { judged: true, people: [{ judgedDates: ["2026-10-19"], key: REP, notSeenDates: ["2026-10-19"] }] } as unknown as FieldLinesInput["calendar"],
  });
  const absent = buildFieldLines(absentInput).find((line) => line.hrId === REP);
  assert.ok(absent);
  assert.deepEqual(absent.flags, ["no_field_activity"]);
  assert.equal(absent.suggestedDays, sumDetectedDeductionDayWeights(["2026-10-19"]));
  const notOver = buildFieldLines({ ...absentInput, today: "2026-10-19" }).find((line) => line.hrId === REP);
  assert.deepEqual(notOver?.flags, [], "a day not yet over is never flagged");
  const notJudged = buildFieldLines({
    ...absentInput,
    calendar: { judged: false, people: [{ judgedDates: ["2026-10-19"], key: REP, notSeenDates: ["2026-10-19"] }] } as unknown as FieldLinesInput["calendar"],
  }).find((line) => line.hrId === REP);
  assert.deepEqual(notJudged?.flags, [], "when the absence check could not read a source, nobody is flagged");
  assert.ok(notJudged?.metrics.notes.some((note) => /Not judged/.test(note)), "and the line says why");
}

// ── 4. Her review and his decision ──────────────────────────────────────────────────────────────
function testReviewAndDecision() {
  refusal(() => validateReview({ action: "confirm", lineId: "nope" }), /Choose a row/, "a review with no row");
  assert.deepEqual(validateReview({ action: "confirm", lineId: LINE_A }), {
    action: "confirm",
    comment: null,
    lineId: LINE_A,
    reason: null,
    recommendedDays: null,
  }, "a confirm needs no reason");
  refusal(() => validateReview({ action: "reject", lineId: LINE_A }), /Say why you are rejecting/, "a reject with no reason");
  assert.equal(validateReview({ action: "reject", lineId: LINE_A, reason: "Was at the Alexandria office", recommendedDays: 2 }).recommendedDays, null, "a reject carries no days");
  refusal(() => validateReview({ action: "recommend_edit", lineId: LINE_A, reason: "Half a day" }), /Recommend the number of days/, "an edit with no days");
  refusal(() => validateReview({ action: "recommend_edit", lineId: LINE_A }), /Say why you recommend/, "an edit with no reason");
  assert.equal(validateReview({ action: "recommend_edit", lineId: LINE_A, reason: "Half a day", recommendedDays: "0.5" }).recommendedDays, 0.5);
  refusal(() => validateReview({ action: "recommend_edit", lineId: LINE_A, reason: "x", recommendedDays: MAX_DAYS + 1 }), /cannot be more than/, "more days than a month");
  refusal(() => validateReview({ action: "recommend_edit", lineId: LINE_A, reason: "x", recommendedDays: -1 }), /zero or more/, "negative days");
  refusal(() => validateReview({ action: "approve", lineId: LINE_A }), /Confirm, Reject or Recommend/, "a decision word is not a review");
  refusal(() => validateReview({ action: "reject", lineId: LINE_A, reason: "x".repeat(501) }), /under 500/, "a reason past its cap");
  assert.equal(validateReview({ action: null, lineId: LINE_A }).action, null, "a null action withdraws her review");

  refusal(() => validateDecision({ decision: "approved", lineId: LINE_A }), /how many days stand/, "an approval with no days");
  assert.deepEqual(validateDecision({ days: "1", decision: "approved", lineId: LINE_A }), { days: 1, decision: "approved", lineId: LINE_A });
  assert.deepEqual(validateDecision({ days: 3, decision: "rejected", lineId: LINE_A }), { days: null, decision: "rejected", lineId: LINE_A }, "a rejection carries no days");
  refusal(() => validateDecision({ decision: "confirm", lineId: LINE_A }), /Approve or Reject/, "a review word is not a decision");

  assert.equal(defaultDecisionDays({ recommended_days: null, review_action: "reject", suggested_days: "1" }), 0, "her reject starts his approval at zero");
  assert.equal(defaultDecisionDays({ recommended_days: "0.5000", review_action: "recommend_edit", suggested_days: "1" }), 0.5, "her recommendation, when she made one");
  assert.equal(defaultDecisionDays({ recommended_days: null, review_action: "confirm", suggested_days: "1.0000" }), 1, "else the policy's figure");
  assert.equal(defaultDecisionDays({ recommended_days: null, review_action: null, suggested_days: null }), null);

  assert.equal(bridgeStatusForDecision("approved", 1), "waiting", "an approved day with days waits to reach the weekly review");
  assert.equal(bridgeStatusForDecision("approved", 0), "not_needed");
  assert.equal(bridgeStatusForDecision("rejected", null), "not_needed");

  // A decided row may change only while nothing downstream holds it.
  assert.equal(decisionIsOpen({ bridge_ref: null, bridge_status: "not_decided", decision: null }), true);
  assert.equal(decisionIsOpen({ bridge_ref: null, bridge_status: "waiting", decision: "approved" }), true);
  assert.equal(decisionIsOpen({ bridge_ref: null, bridge_status: "failed", decision: "approved" }), true, "a failed carry with no day in the review can still change");
  assert.equal(decisionIsOpen({ bridge_ref: null, bridge_status: "bridged", decision: "approved" }), false);
  assert.equal(decisionIsOpen({ bridge_ref: null, bridge_status: "week_released", decision: "approved" }), false);
  assert.equal(
    decisionIsOpen({ bridge_ref: "digest-line-1", bridge_status: "failed", decision: "approved" }),
    false,
    "a FAILED line whose day already sits in the weekly review is locked — a later rejection would orphan that ticked day",
  );
  assert.equal(decisionIsOpen({ bridge_ref: "digest-line-1", bridge_status: "waiting", decision: "approved" }), false);
  assert.equal(
    viewLine(lineRow({ bridge_ref: "digest-line-1", bridge_status: "failed", decided_days: "1", decision: "approved", flags: ["no_punch"] })).bridge.locked,
    true,
    "the screen draws that row locked",
  );

  // The write itself carries the same guard, so a carry racing the click cannot be undone here.
  const decide = code("src/lib/hr-ops-reports/decide.ts");
  assert.match(decide, /decisionIsOpen\(line\)/, "decide.ts asks decisionIsOpen before writing");
  assert.match(decide, /\.is\("bridge_ref", null\)/, "the decision update refuses a row the weekly review already holds");
  assert.match(decide, /\.not\("bridge_status", "in", "\(bridged,week_released\)"\)/, "and a row already carried or released");
  assert.match(decide, /written\.length === 0/, "and a zero-row write is answered in words, never as a success");

  const progress = reportProgress([
    lineRow({ flags: ["no_punch"], id: LINE_A }),
    lineRow({ flags: ["late"], id: LINE_B, review_action: "confirm" }),
    lineRow({ flags: [], id: LINE_C }),
    lineRow({ carried_from_line_id: LINE_A, flags: ["no_punch"], id: LINE_D }),
  ]);
  assert.deepEqual(progress, { carried: 1, decided: 0, flagged: 3, reviewed: 1, toDecide: 2, toReview: 1, total: 4 }, "a carried row is shown, never reviewed or decided twice");
}

// ── 5. The migration and the code agree ─────────────────────────────────────────────────────────
function quotedList(sql: string, pattern: RegExp, what: string): string[] {
  const match = pattern.exec(sql);
  assert.ok(match, `the migration lost its ${what} constraint`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

function testMigrationParity() {
  const sql = stripSqlComments(read(MIGRATION));
  assert.deepEqual(quotedList(sql, /hr_ops_reports_kind_check check \(kind in \(([^)]*)\)\)/, "kind"), [...HR_OPS_REPORT_KINDS]);
  assert.deepEqual(quotedList(sql, /hr_ops_reports_status_check check \(status in \(([^)]*)\)\)/, "status"), [...HR_OPS_REPORT_STATUSES]);
  assert.deepEqual(quotedList(sql, /hr_ops_report_lines_section_check check \(section in \(([^)]*)\)\)/, "section"), [...HR_OPS_SECTIONS]);
  assert.deepEqual(quotedList(sql, /hr_ops_report_lines_review_action_check check \(review_action is null or review_action in \(([^)]*)\)\)/, "review action"), [...HR_OPS_REVIEW_ACTIONS]);
  assert.deepEqual(quotedList(sql, /hr_ops_report_lines_decision_check check \(decision is null or decision in \(([^)]*)\)\)/, "decision"), [...HR_OPS_DECISIONS]);
  assert.deepEqual(quotedList(sql, /hr_ops_report_lines_bridge_status_check check \(\s*bridge_status in \(([^)]*)\)/, "bridge status"), [...HR_OPS_BRIDGE_STATUSES]);

  // Every column the code selects exists, and no column of either table names money.
  const tables = [
    ["hr_ops_reports", HR_OPS_REPORT_COLUMNS],
    ["hr_ops_report_lines", HR_OPS_LINE_COLUMNS],
  ] as const;
  for (const [table, columns] of tables) {
    const body = new RegExp(`create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`).exec(sql)?.[1];
    assert.ok(body, `the migration lost its ${table} table`);
    const defined = new Set([...body.matchAll(/^\s+([a-z_]+)\s+(?:uuid|text|date|jsonb|integer|numeric|timestamptz)/gm)].map((entry) => entry[1]));
    for (const column of columns.split(",")) {
      assert.ok(defined.has(column), `${table}.${column} is selected by the code but not defined by the migration`);
    }
    for (const column of defined) {
      assert.doesNotMatch(column, /amount|salary|price|value|egp|currency|wage|cost|money/i, `${table}.${column} names money — this module is days only`);
    }
  }
}

// ── 6. Routes, registry, grants, notices, activity, the rail ───────────────────────────────────
function testWiring() {
  const routes = [
    ["app/api/hr-ops-reports/route.ts", "read", false],
    ["app/api/hr-ops-reports/[id]/route.ts", "read", false],
    ["app/api/hr-ops-reports/[id]/review/route.ts", "update", true],
    ["app/api/hr-ops-reports/[id]/submit/route.ts", "update", true],
    ["app/api/hr-ops-reports/[id]/decide/route.ts", "approve", true],
    ["app/api/hr-ops-reports/[id]/priced/route.ts", "approve", false],
    ["app/api/hr-ops-reports/rebuild/route.ts", "approve", true],
  ] as const;
  for (const [file, action, mutation] of routes) {
    const source = code(file);
    assert.match(source, new RegExp(`assertPermission\\(access, "hr_ops_reports", "${action}"\\)`), `${file} asserts hr_ops_reports:${action}`);
    if (mutation) {
      assert.match(source, /assertSameOriginMutation\(request\)/, `${file} refuses a cross-site mutation`);
      assert.match(source, /assertApiRateLimit\(/, `${file} is rate limited`);
      assert.ok(
        source.indexOf("assertPermission(") < source.search(/(reviewLines|submitReport|decideLines|buildHrOpsReport)\(/),
        `${file} asserts the permission before it writes`,
      );
    }
  }
  assert.match(code("app/api/hr-ops-reports/[id]/priced/route.ts"), /isSalaryBlindRole\(access\.role\)/, "the priced read refuses every salary-blind seat, whatever its grant");
  assert.match(code("app/api/hr-ops-reports/[id]/decide/route.ts"), /writeAuditLog\(/, "every decision is audited");

  const registry = [
    ["/api/hr-ops-reports", "GET", "read", false],
    [`/api/hr-ops-reports/${REPORT_ID}`, "GET", "read", false],
    [`/api/hr-ops-reports/${REPORT_ID}/review`, "POST", "update", true],
    [`/api/hr-ops-reports/${REPORT_ID}/submit`, "POST", "update", true],
    [`/api/hr-ops-reports/${REPORT_ID}/decide`, "POST", "approve", true],
    [`/api/hr-ops-reports/${REPORT_ID}/priced`, "GET", "approve", false],
    ["/api/hr-ops-reports/rebuild", "POST", "approve", true],
  ] as const;
  for (const [route, method, action, csrf] of registry) {
    const entry = findAccessRegistryEntry(route, method);
    assert.ok(entry, `${method} ${route} has no access-registry entry`);
    assert.deepEqual(entry.permission, { action, resource: "hr_ops_reports" }, `${method} ${route}`);
    assert.equal(entry.csrf.required, csrf, `${method} ${route}: csrf`);
  }

  // Her review is update; the decision is approve and the Super Admin's alone.
  const reviewer = permissionMatrix["HR Administration"].hr_ops_reports ?? [];
  assert.ok(reviewer.includes("read") && reviewer.includes("update"), "the HR Operations Specialist reads and reviews");
  assert.ok(!reviewer.includes("approve"), "the HR Operations Specialist never decides — not even her own recommendation");
  assert.ok((permissionMatrix["Super Admin"].hr_ops_reports ?? []).includes("approve"), "the Super Admin decides");
  for (const role of Object.keys(permissionMatrix) as PhoenixRole[]) {
    if (role === "Super Admin" || role === "HR Administration") continue;
    assert.deepEqual([...(permissionMatrix[role].hr_ops_reports ?? [])], [], `${role} holds nothing on hr_ops_reports`);
  }

  for (const event of ["report_ready", "report_submitted", "report_decided"]) {
    const policy = resolveNotificationPolicy({ eventType: `hr_ops_reports.${event}`, module: "hr_ops_reports" });
    assert.ok(!policy.channels.includes("email"), `hr_ops_reports.${event} is never an email`);
    assert.ok(policy.channels.includes("in_app"), `hr_ops_reports.${event} reaches the notification center`);
  }
  const notify = code("src/lib/hr-ops-reports/notify.ts");
  assert.doesNotMatch(notify, /"email"/, "the module never asks for the email channel");

  for (const route of ["/hr-reports", "/hr/hr-reports", `/hr/hr-reports?report=${REPORT_ID}`]) {
    assert.equal(resolveActivityModule(route).key, "hr_ops_reports", `${route} reports as its own module`);
  }

  // The rail: her row in /hr, the Super Admin's card in the admin registry, nobody else's.
  const railHrefs = (role: PhoenixRole, mode: NavigationMode) =>
    getSections(getNavigationSections(mode), mode, buildPermissionLookup(permissionMatrix, role), role)
      .flatMap((section) => section.items.map((item) => item.href));
  assert.ok(railHrefs("HR Administration", "hr").includes("/hr/hr-reports"), "the HR Operations Specialist's rail carries Daily & Weekly Reports");
  for (const role of Object.keys(permissionMatrix) as PhoenixRole[]) {
    if (role === "HR Administration") continue;
    assert.ok(!railHrefs(role, "hr").includes("/hr/hr-reports"), `${role} is offered the reviewer's row`);
  }
  const card = attendanceManagementPageItems.find((item) => item.href === "/hr-reports");
  assert.ok(card, "the admin registry lists the page");
  assert.deepEqual(card.permissions, [{ action: "read", resource: "hr_ops_reports" }]);

  // None of the module's screens links to a page fenced off her seat.
  const fenced = /["'`](?:\/hr)?\/(?:attendance|employee-360|admin\/daily-deductions|admin\/deductions|leave-management\/vacation-request|admin\/payslips-center)(?=["'`/?#])/;
  const screens = [
    ...readdirSync(path.join(ROOT, "src/components/hr-ops-reports")).map((file) => `src/components/hr-ops-reports/${file}`),
    ...readdirSync(path.join(ROOT, "app/(admin)/hr-reports")).map((file) => `app/(admin)/hr-reports/${file}`),
  ].filter((file) => statSync(path.join(ROOT, file)).isFile());
  assert.ok(screens.length >= 4, `expected the module's screens, found ${screens.length}`);
  for (const file of screens) {
    assert.doesNotMatch(code(file), fenced, `${file} links to a page fenced off the HR Operations Specialist's seat`);
  }

  // The HR Overview is composed from her functions, never from her seat's name.
  assert.doesNotMatch(code("src/lib/hr/command-center.ts"), /"HR Administration"/, "command-center.ts names a seat");
}

// ── 7. No payload she receives names money ──────────────────────────────────────────────────────
function testNoMoney() {
  const lines = [
    lineRow({
      flags: ["no_punch"],
      id: LINE_A,
      metrics: { amount: 950, basicSalary: 12000, kind: "office", notes: [], status: "No punch" },
      suggested_days: "1.0000",
    }),
    lineRow({
      bridge_status: "waiting",
      decided_days: "0.5000",
      decision: "approved",
      flags: ["no_field_activity"],
      id: LINE_B,
      metrics: { am: 0, deductionValueEgp: 400, kind: "field", notes: [], pm: 0, total: 0 },
      review_action: "recommend_edit",
      review_reason: "Half a day at the warehouse",
      recommended_days: "0.5000",
      section: "field",
    }),
  ];
  const payload = viewReportWithLines(reportRow(), lines);
  assert.deepEqual(findMoneyKeys(payload), [], "a built report payload carries no money — a stored metric outside the allow-list never leaves the server");
  const office = payload.lines.find((line) => line.id === LINE_A);
  assert.ok(office && !("amount" in office.metrics) && !("basicSalary" in office.metrics));
  assert.equal(office.suggestedDays, 1, "days survive");

  const queue = buildQueue([reportRow()], lines);
  assert.deepEqual(findMoneyKeys(queue), [], "the Overview's queue carries no money");

  // The tripwire itself fires.
  assert.deepEqual(findMoneyKeys({ lines: [{ amountEgp: 1, days: 1, payload: {} }] }), ["lines[0].amountEgp"]);
  assert.deepEqual(findMoneyKeys({ salary: 1, totalCost: 2 }), ["salary", "totalCost"]);
}

// ── The queue the Overview and the today panel read ────────────────────────────────────────────
function testQueue() {
  const open = reportRow({ id: REPORT_ID, status: "in_review" });
  const submittedId = "22222222-2222-4222-8222-222222222222";
  const submitted = reportRow({
    field_from: "2026-10-10",
    field_to: "2026-10-15",
    id: submittedId,
    kind: "weekly",
    office_from: "2026-10-11",
    office_to: "2026-10-15",
    period_key: "weekly:2026-10-10",
    status: "submitted",
  });
  const queue = buildQueue([open, submitted], [
    lineRow({ flags: ["no_punch"], id: LINE_A, report_id: REPORT_ID }),
    lineRow({ flags: ["late"], id: LINE_B, report_id: REPORT_ID, review_action: "confirm" }),
    lineRow({ flags: ["no_punch"], id: LINE_C, report_id: submittedId, review_action: "confirm" }),
    lineRow({ flags: ["late"], id: LINE_D, report_id: submittedId, review_action: "reject", review_reason: "On a trip" }),
  ]);
  assert.deepEqual(queue.summary, { inReview: 1, rowsToAnswer: 1, rowsToDecide: 2, submitted: 1 });
  const weekly = queue.reports.find((report) => report.id === submittedId);
  assert.ok(weekly);
  assert.equal(weekly.shortLabel, "Week of 10 Oct");
  assert.equal(weekly.title, "Weekly report · 10 Oct to 15 Oct 2026");
  assert.equal(weekly.periodEnd, "2026-10-15");
}

// ── 8. The cron: after the sync, the build, then the retry — and never a failed digest ─────────
function testCronOrder() {
  const cron = code("app/api/cron/attendance-weekly-digest/route.ts");
  const sync = cron.indexOf("await syncOpenReviewWeeks(");
  assert.ok(sync > 0, "the digest cron still syncs the open review weeks");
  const calls = [...cron.matchAll(/await runHrOpsReportsStep\(todayIso\)/g)].map((match) => match.index ?? -1);
  assert.equal(calls.length, 2, "the reports step runs once in the switched-off branch and once in the live run");
  const disabled = cron.indexOf("if (!settings.enabled)");
  assert.ok(disabled > 0 && calls[0] > disabled && calls[0] < sync, "switched off, the reports still run — they are the HR Operations Specialist's own work");
  assert.ok(calls[1] > sync, "in the live run the reports are built AFTER the weekly-review sync, so a day the sync just added is there for the retry");
  const settle = cron.indexOf("settleOverdueAnswers(", sync);
  assert.ok(settle === -1 || calls[1] < settle, "and before the deadline sweep");

  const step = cron.slice(cron.indexOf("async function runHrOpsReportsStep"), cron.indexOf("export async function GET"));
  assert.match(step, /try \{[\s\S]*runHrOpsReportsSchedule\(\{ todayIso \}\)[\s\S]*\} catch \(error\) \{[\s\S]*logError\(/, "the step is fenced and logs its failure");
  const failed = /const failed = ([^;]*);/.exec(cron)?.[1];
  assert.ok(failed, "the digest's own failure expression");
  assert.doesNotMatch(failed, /hrOps/, "a reports failure never fails the digest run");

  const schedule = code("src/lib/hr-ops-reports/schedule.ts");
  const loop = schedule.indexOf("for (const period of scheduledPeriods(todayIso))");
  const build = schedule.indexOf("await buildHrOpsReport(");
  const retry = schedule.indexOf("await retryWaitingBridges()");
  assert.ok(loop > 0 && build > loop, "the schedule builds each scheduled period");
  assert.ok(retry > build, "and retries the waiting decided days only AFTER the build");
  const retryBlock = schedule.slice(schedule.lastIndexOf("try {", retry), schedule.indexOf("return result;", retry));
  assert.match(retryBlock, /catch \(error\)[\s\S]*result\.failures\.push\(/, "a retry failure is returned, never thrown");
}

export function runHrOpsReportsTests() {
  testPeriods();
  testOfficeJudgment();
  testManagerOwnVisits();
  testReviewAndDecision();
  testMigrationParity();
  testWiring();
  testNoMoney();
  testQueue();
  testCronOrder();
}
