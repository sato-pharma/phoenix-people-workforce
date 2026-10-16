import assert from "node:assert/strict";

import { AM_CALL_RATE_TARGET, PM_CALL_RATE_TARGET } from "../src/lib/crm/call-rate.ts";
import { DEFAULT_REP_KPI_STANDARDS } from "../src/lib/crm/rep-kpi-reports.ts";
import { coverageTier, gradeTarget, sharePercent, summarizeCoverage, summarizeReadiness } from "../src/lib/phoenix-crm/coverage.ts";
import {
  cleanText,
  deviceClockSkewMinutes,
  DROP_REASONS,
  gradeFromReference,
  parseCapturedFix,
  parseDropDraft,
  parseGrade,
  parseListType,
  parseNewCustomer,
  parsePlaceDraft,
  parseVisitDraft,
  VISIT_COMMENT_REQUIRED,
} from "../src/lib/phoenix-crm/entry-rules.ts";
import { checkDaySpread, checkVisitLocation, distanceMeters, formatDistance, isUsableFix } from "../src/lib/phoenix-crm/geo.ts";
import {
  describeDayWindows,
  exceptionLabel,
  isPlanEditable,
  parsePlanItems,
  PLAN_EXCEPTION_TYPES,
  planStatusLabel,
  resolvePlanItems,
  type PlanItemDraft,
  type PlanRuleCustomer,
} from "../src/lib/phoenix-crm/plan-rules.ts";
import {
  coverageCell,
  daysInPeriod,
  groupCoverageByTerritory,
  groupManagerVisits,
  groupPlanByTerritory,
  groupVisitsByRep,
  planKeptPercent,
  resolveReportMonth,
  resolveReportPeriod,
} from "../src/lib/phoenix-crm/report-rules.ts";
import {
  buildOrgIndex,
  isTerritoryReviewer,
  managerChain,
  managersInScope,
  resolveVisitParticipants,
  territoriesBelow,
  territoriesInScope,
  territoryName,
  territoryReviewer,
  type OrgIndex,
  type OrgSeat,
} from "../src/lib/phoenix-crm/scope.ts";
import { normalizeArea, suggestForDay, type PlannerCustomer, type PlannerPlace } from "../src/lib/phoenix-crm/suggestions.ts";
import {
  clockValue,
  formatClockMinute,
  formatTimingWindow,
  parseClockMinute,
  parseTimings,
  receivingDaysLabel,
  resolveEndMinute,
  windowsForWeekday,
  type TimingDraft,
} from "../src/lib/phoenix-crm/timings.ts";
import { PHOENIX_CRM_DEFAULT_SETTINGS, type PhoenixCrmTiming } from "../src/lib/phoenix-crm/types.ts";

/**
 * Phoenix CRM's rules, with no I/O (the owner, 2026-09-16, and the question round the same day).
 *
 *   - A customer is real only with a live photo, the location captured on the spot and at least one
 *     timing: the days they receive and the hours on each day, which can differ by day. Ramadan has its
 *     own timings.
 *   - A plan day holds at most 15 doctors (PM) and 5 accounts (AM), apart, and never added together.
 *     Thursday is a morning (accounts only), Friday is no day. A customer placed on a day they do not
 *     receive needs a reason; the planner asks, it does not block.
 *   - Suggestions: receives that day, then uncovered (not visited this month, then behind the grade),
 *     then same brick, same zone, then the time fits.
 *   - A far visit still saves, flagged; far beats a weak fix. Far-apart plan days are highlighted only.
 *   - Reports keep AM and PM apart everywhere; frequency counts customers EXACTLY on their grade.
 *   - Scope runs downward only. The reviewer is the nearest occupied manager seat above the territory,
 *     never the territory's own rep and never the CEO. A double visit is the rep with a manager of the
 *     territory; a chain visit adds one above that manager.
 */

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function valueOf<T>(result: Result<T>): T {
  if (!result.ok) assert.fail(`expected a value, got the refusal: ${result.error}`);
  return result.value;
}

function refusalOf<T>(result: Result<T>): string {
  if (result.ok) assert.fail(`expected a refusal, got: ${JSON.stringify(result.value)}`);
  return result.error;
}

function timing(weekday: number, start: string, end = "", season = "normal"): TimingDraft {
  return { weekday, start, end, season };
}

function timings(...drafts: TimingDraft[]): PhoenixCrmTiming[] {
  const parsed = parseTimings(drafts);
  if (!parsed.ok) assert.fail(`the test's own timings did not parse: ${parsed.error}`);
  return parsed.timings;
}

function timingRefusal(raw: unknown): string {
  const parsed = parseTimings(raw);
  if (parsed.ok) assert.fail(`expected the timings to be refused: ${JSON.stringify(parsed.timings)}`);
  return parsed.error;
}

const uuid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;

function runDefaultsTests() {
  assert.deepEqual(
    PHOENIX_CRM_DEFAULT_SETTINGS.gradeTargets.PM,
    DEFAULT_REP_KPI_STANDARDS.PM.frequencyNorms,
    "a doctor's monthly visits by grade are the company's standard (PM A 3 · B 2 · C 1) — copied into types.ts, so the two must stay equal",
  );
  assert.deepEqual(
    PHOENIX_CRM_DEFAULT_SETTINGS.gradeTargets.AM,
    DEFAULT_REP_KPI_STANDARDS.AM.frequencyNorms,
    "an account's monthly visits by grade are the company's standard (AM A 1, B and C unscored)",
  );
  assert.equal(PHOENIX_CRM_DEFAULT_SETTINGS.pmDailyCap, 15, "the owner's daily maximum of doctors on a plan day");
  assert.equal(PHOENIX_CRM_DEFAULT_SETTINGS.amDailyCap, 5, "the owner's daily maximum of accounts on a plan day");
  assert.equal(
    PHOENIX_CRM_DEFAULT_SETTINGS.callRateAmTarget,
    AM_CALL_RATE_TARGET,
    "the monthly plan's AM call-rate target is the company's 2 — copied into types.ts, so the two must stay equal",
  );
  assert.equal(
    PHOENIX_CRM_DEFAULT_SETTINGS.callRatePmTarget,
    PM_CALL_RATE_TARGET,
    "the monthly plan's PM call-rate target is the company's 10",
  );
}

function runTimingTests() {
  assert.equal(parseClockMinute("18:30"), 1110);
  assert.equal(parseClockMinute(" 8:05 "), 485);
  assert.equal(parseClockMinute("24:00"), null);
  assert.equal(parseClockMinute("12:60"), null);
  assert.equal(parseClockMinute("6pm"), null);
  assert.equal(clockValue(1110), "18:30");
  assert.equal(clockValue(1500), "01:00", "a past-midnight end folds back onto the clock");
  assert.equal(formatClockMinute(0), "12:00 AM");
  assert.equal(formatClockMinute(720), "12:00 PM");
  assert.equal(formatClockMinute(1110), "6:30 PM");
  assert.equal(formatClockMinute(1500), "1:00 AM");
  assert.equal(formatTimingWindow({ startMinute: 1080, endMinute: null }), "from 6:00 PM", "the owner's sheet gives a start time only");
  assert.equal(formatTimingWindow({ startMinute: 1080, endMinute: 1200 }), "6:00 PM – 8:00 PM");
  assert.equal(resolveEndMinute(1320, 60), 1500, "10:00 PM to 1:00 AM runs into the next morning");
  assert.equal(resolveEndMinute(1080, 1200), 1200);
  assert.equal(resolveEndMinute(1080, null), null);

  // What makes a customer real: at least one normal timing.
  assert.equal(timingRefusal("Saturday 6"), "Add the days and hours this customer receives visits.");
  assert.equal(timingRefusal([]), "Add at least one day and time this customer receives visits.");
  assert.equal(
    timingRefusal([timing(6, "21:00", "", "ramadan")]),
    "Add at least one day and time this customer receives visits.",
    "Ramadan timings alone do not make a customer: the other eleven months need a time",
  );
  assert.equal(timingRefusal([{ weekday: 7, start: "10:00" }]), "A timing has no day. Choose the day again.");
  for (const missingDay of [null, "", " ", false, undefined]) {
    assert.equal(
      timingRefusal([{ weekday: missingDay, start: "10:00" }]),
      "A timing has no day. Choose the day again.",
      `a timing whose day is ${JSON.stringify(missingDay)} is refused, never read as Sunday`,
    );
  }
  assert.equal(timingRefusal([{ weekday: 6, start: "" }]), "Saturday has no start time.");
  assert.equal(timingRefusal([timing(6, "18:00", "25:00")]), "Saturday has an end time that is not a time.");
  assert.equal(
    timingRefusal([timing(6, "08:00", "07:00")]),
    "Saturday 8:00 AM to 7:00 AM is longer than a clinic day. Check the times.",
    "an end before the start is the next morning, and past 6:00 AM it is a typing slip",
  );
  assert.equal(timingRefusal([timing(6, "06:00", "23:00")]), "Saturday 6:00 AM to 11:00 PM is longer than a clinic day. Check the times.");
  assert.equal(timingRefusal([timing(6, "18:00", "20:00"), timing(6, "18:00")]), "Saturday has the same time twice.");
  assert.equal(
    timingRefusal([timing(6, "18:00", "20:00"), timing(6, "19:00")]),
    "Saturday has two times that overlap (6:00 PM – 8:00 PM and from 7:00 PM).",
  );
  assert.equal(
    timingRefusal([timing(6, "18:00"), timing(6, "18:59")]),
    "Saturday has two times that overlap (from 6:00 PM and from 6:59 PM).",
    "a start-only window counts as an hour when checking overlaps",
  );
  assert.equal(
    timingRefusal([timing(6, "08:00"), timing(6, "10:00"), timing(6, "12:00"), timing(6, "14:00"), timing(6, "16:00")]),
    "Saturday has more than 4 times. Keep the real ones.",
  );
  assert.equal(timings(timing(6, "08:00"), timing(6, "10:00"), timing(6, "12:00"), timing(6, "14:00")).length, 4);
  assert.equal(timings(timing(6, "18:00"), timing(6, "19:00")).length, 2, "back-to-back start times do not overlap");
  assert.equal(timings(timing(6, "18:00"), timing(6, "18:00", "", "ramadan")).length, 2, "the same hour in Ramadan is a different timing");

  assert.deepEqual(timings(timing(1, "22:00", "01:00")), [{ weekday: 1, startMinute: 1320, endMinute: 1500, season: "normal" }]);
  assert.deepEqual(timings({ weekday: "6", start: "18:00", season: "summer" }), [{ weekday: 6, startMinute: 1080, endMinute: null, season: "normal" }]);
  assert.deepEqual(
    timings(timing(0, "18:00"), timing(1, "10:00", "", "ramadan"), timing(6, "19:00"), timing(6, "09:00", "10:30")),
    [
      { weekday: 6, startMinute: 540, endMinute: 630, season: "normal" },
      { weekday: 6, startMinute: 1140, endMinute: null, season: "normal" },
      { weekday: 0, startMinute: 1080, endMinute: null, season: "normal" },
      { weekday: 1, startMinute: 600, endMinute: null, season: "ramadan" },
    ],
    "normal timings first, the week read Saturday first, each day by its start",
  );

  // Ramadan reads the special timings; a customer with none falls back to the normal ones, flagged.
  const withRamadan = timings(timing(6, "18:00", "20:00"), timing(1, "17:00"), timing(6, "21:00", "", "ramadan"));
  assert.deepEqual(windowsForWeekday(withRamadan, 6, false), {
    windows: [{ weekday: 6, startMinute: 1080, endMinute: 1200, season: "normal" }],
    noRamadanTime: false,
  });
  assert.deepEqual(windowsForWeekday(withRamadan, 6, true), {
    windows: [{ weekday: 6, startMinute: 1260, endMinute: null, season: "ramadan" }],
    noRamadanTime: false,
  });
  assert.deepEqual(windowsForWeekday(withRamadan, 1, true), { windows: [], noRamadanTime: false }, "in Ramadan a customer with Ramadan timings receives only on those days");
  const normalOnly = timings(timing(6, "18:00", "20:00"));
  assert.deepEqual(windowsForWeekday(normalOnly, 6, true), { windows: normalOnly, noRamadanTime: true });

  const week = timings(timing(2, "18:00"), timing(6, "18:00"), timing(1, "18:00"), timing(0, "10:00", "", "ramadan"));
  assert.equal(receivingDaysLabel(week), "Sat, Mon, Tue");
  assert.equal(receivingDaysLabel(week, "ramadan"), "Sun");
}

const WEEK = "2026-10-03"; // Saturday 3 October 2026; Thursday is 8 October, Friday 9 October.
const DOCTOR = uuid("aaaaaaaa", 1);
const DOCTOR_PLACE = uuid("bbbbbbbb", 1);
const ACCOUNT = uuid("aaaaaaaa", 2);
const ACCOUNT_PLACE = uuid("bbbbbbbb", 2);

function planCustomers(): Map<string, PlanRuleCustomer> {
  return new Map<string, PlanRuleCustomer>([
    [
      DOCTOR,
      {
        customerId: DOCTOR,
        name: "Dr Mona Adel",
        listType: "PM",
        pending: false,
        places: [{ placeId: DOCTOR_PLACE, timings: timings(timing(6, "18:00", "20:00"), timing(1, "17:00"), timing(0, "21:00", "", "ramadan")) }],
      },
    ],
    [
      ACCOUNT,
      {
        customerId: ACCOUNT,
        name: "Al Shorouk Hospital",
        listType: "AM",
        pending: false,
        places: [{ placeId: ACCOUNT_PLACE, timings: timings(timing(6, "10:00"), timing(4, "09:00")) }],
      },
    ],
  ]);
}

function item(planDate: string, customerId: string, placeId: string, exceptionType: PlanItemDraft["exceptionType"] = null, exceptionNote: string | null = null): PlanItemDraft {
  return { planDate, customerId, placeId, exceptionType, exceptionNote };
}

function resolvePlan(items: PlanItemDraft[], customers = planCustomers(), options: { ramadan?: boolean; pmDailyCap?: number; amDailyCap?: number } = {}) {
  return resolvePlanItems({
    weekStart: WEEK,
    items,
    customers,
    settings: {
      pmDailyCap: options.pmDailyCap ?? PHOENIX_CRM_DEFAULT_SETTINGS.pmDailyCap,
      amDailyCap: options.amDailyCap ?? PHOENIX_CRM_DEFAULT_SETTINGS.amDailyCap,
      sharedPlaceDailyCap: PHOENIX_CRM_DEFAULT_SETTINGS.sharedPlaceDailyCap,
    },
    isRamadan: () => options.ramadan ?? false,
  });
}

function runPlanRuleTests() {
  assert.deepEqual(
    PLAN_EXCEPTION_TYPES.map((type) => type.key),
    ["another_place", "by_appointment", "timings_changed", "other"],
  );
  assert.equal(exceptionLabel("by_appointment"), "By appointment");
  assert.equal(exceptionLabel("holiday"), null);
  assert.equal(exceptionLabel(null), null);
  assert.equal(planStatusLabel(null), "Not started");
  assert.equal(planStatusLabel("submitted"), "Waiting for review");
  assert.equal(planStatusLabel("returned"), "Returned for changes");
  assert.equal(isPlanEditable("draft"), true);
  assert.equal(isPlanEditable("returned"), true);
  assert.equal(isPlanEditable("submitted"), false, "a sent plan is taken back before it changes");
  assert.equal(isPlanEditable("approved"), false);

  // ── What the planner sends ──────────────────────────────────────────────────────────────────────
  assert.equal(refusalOf(parsePlanItems("plan")), "The plan has no list of customers. Reload the planner.");
  assert.equal(
    refusalOf(parsePlanItems(Array.from({ length: 401 }, () => ({ planDate: WEEK, customerId: DOCTOR, placeId: DOCTOR_PLACE })))),
    "The plan holds more customers than a week can. Reload the planner.",
  );
  assert.equal(refusalOf(parsePlanItems([{ planDate: "3 Oct", customerId: DOCTOR, placeId: DOCTOR_PLACE }])), "A planned customer has no day. Reload the planner.");
  assert.equal(refusalOf(parsePlanItems([{ planDate: WEEK, customerId: "dr-mona", placeId: DOCTOR_PLACE }])), "A planned customer is missing. Reload the planner.");
  assert.equal(
    refusalOf(parsePlanItems([{ planDate: WEEK, customerId: DOCTOR, placeId: DOCTOR_PLACE, exceptionType: "holiday" }])),
    "A planned customer has an exception reason the planner does not know. Reload the planner.",
  );
  assert.equal(
    refusalOf(parsePlanItems([{ planDate: WEEK, customerId: DOCTOR, placeId: DOCTOR_PLACE, exceptionType: "other", exceptionNote: "x".repeat(301) }])),
    "An exception note is longer than 300 characters.",
  );
  assert.deepEqual(
    valueOf(
      parsePlanItems([
        { planDate: WEEK, customerId: DOCTOR.toUpperCase(), placeId: DOCTOR_PLACE.toUpperCase(), exceptionType: "other", exceptionNote: "  at the hospital  " },
        { planDate: WEEK, customerId: DOCTOR, placeId: ACCOUNT_PLACE },
        { planDate: "2026-10-05", customerId: DOCTOR, placeId: DOCTOR_PLACE, exceptionType: "", exceptionNote: "" },
      ]),
    ),
    [
      item(WEEK, DOCTOR, DOCTOR_PLACE, "other", "at the hospital"),
      item("2026-10-05", DOCTOR, DOCTOR_PLACE),
    ],
    "a customer twice on one day collapses to the first; ids are compared lower case",
  );

  // ── The week, the list and the timings ──────────────────────────────────────────────────────────
  const kept = valueOf(resolvePlan([item(WEEK, DOCTOR, DOCTOR_PLACE, "by_appointment", "sent twice"), item("2026-10-08", ACCOUNT, ACCOUNT_PLACE)]));
  // `sharedPlaceId` is null on both: each of these two has his own clinic. It is carried on the
  // resolved item so the SEND can re-count a venue's day without re-reading the places (2026-10-09).
  assert.deepEqual(kept, [
    { ...item(WEEK, DOCTOR, DOCTOR_PLACE), listType: "PM", receives: true, sharedPlaceId: null, startMinute: 1080 },
    { ...item("2026-10-08", ACCOUNT, ACCOUNT_PLACE), listType: "AM", receives: true, sharedPlaceId: null, startMinute: 540 },
  ], "a customer placed on a day they receive carries no exception, whatever the planner sent");

  assert.equal(refusalOf(resolvePlan([item("2026-10-09", DOCTOR, DOCTOR_PLACE)])), "2026-10-09 is not a working day of this plan's week.", "Friday is never a plan day");
  assert.equal(refusalOf(resolvePlan([item("2026-10-10", DOCTOR, DOCTOR_PLACE)])), "2026-10-10 is not a working day of this plan's week.");
  // Owner, 2026-09-22: validation is no longer the price of planning. What is refused here is a
  // customer who is not on the rep's list AT ALL — one carried over from iReports360 and not yet
  // validated plans exactly like any other, and is covered by the pending suite.
  assert.equal(
    refusalOf(resolvePlan([item(WEEK, uuid("cccccccc", 9), DOCTOR_PLACE)])),
    "A planned customer is no longer on your list. Reload the planner.",
    "a customer who is not on the list at all cannot be planned",
  );
  assert.equal(
    refusalOf(resolvePlan([item(WEEK, DOCTOR, ACCOUNT_PLACE)])),
    "Dr Mona Adel's place was changed. Reload the planner and place this customer again.",
  );
  assert.equal(
    refusalOf(resolvePlan([item("2026-10-08", DOCTOR, DOCTOR_PLACE, "another_place")])),
    "Thursday 8 Oct is a morning: it holds AM only, so Dr Mona Adel cannot go there.",
    "no exception reason puts a PM customer on Thursday",
  );
  // NEVER BLOCKED BY HOURS (owner, 2026-09-30: "does not receive on Wednesday — never block, because the
  // rep didn't add his time"). A day his saved hours do not cover is placed and asks nothing.
  assert.deepEqual(
    valueOf(resolvePlan([item("2026-10-04", DOCTOR, DOCTOR_PLACE)])),
    [{ ...item("2026-10-04", DOCTOR, DOCTOR_PLACE), listType: "PM", receives: false, sharedPlaceId: null, startMinute: null }],
    "a day his saved hours do not cover is accepted with no reason",
  );
  assert.deepEqual(
    valueOf(resolvePlan([item("2026-10-04", DOCTOR, DOCTOR_PLACE, "other")])),
    [{ ...item("2026-10-04", DOCTOR, DOCTOR_PLACE), listType: "PM", receives: false, sharedPlaceId: null, startMinute: null }],
    "an Other with no note keeps the customer and drops the empty reason",
  );
  assert.deepEqual(
    valueOf(resolvePlan([item("2026-10-04", DOCTOR, DOCTOR_PLACE, "another_place")])),
    [{ ...item("2026-10-04", DOCTOR, DOCTOR_PLACE, "another_place"), listType: "PM", receives: false, sharedPlaceId: null, startMinute: null }],
    "a reason an older caller still sends is kept",
  );
  assert.deepEqual(
    valueOf(resolvePlan([item("2026-10-04", DOCTOR, DOCTOR_PLACE)], planCustomers(), { ramadan: true })),
    [{ ...item("2026-10-04", DOCTOR, DOCTOR_PLACE), listType: "PM", receives: true, sharedPlaceId: null, startMinute: 1260 }],
    "in Ramadan the special visit time decides who receives",
  );
  assert.deepEqual(
    valueOf(resolvePlan([item(WEEK, DOCTOR, DOCTOR_PLACE)], planCustomers(), { ramadan: true })),
    [{ ...item(WEEK, DOCTOR, DOCTOR_PLACE), listType: "PM", receives: false, sharedPlaceId: null, startMinute: null }],
    "and a Ramadan day with no Ramadan hours saved is accepted just the same",
  );

  // ── The daily maximums: 15 doctors and 5 accounts, apart ────────────────────────────────────────
  const crowd = planCustomers();
  const doctors: PlanItemDraft[] = [];
  const accounts: PlanItemDraft[] = [];
  for (let n = 1; n <= 16; n += 1) {
    const customerId = uuid("dddddddd", n);
    const placeId = uuid("eeeeeeee", n);
    crowd.set(customerId, { customerId, name: `Doctor ${n}`, listType: "PM", pending: false, places: [{ placeId, timings: timings(timing(6, "18:00")) }] });
    doctors.push(item(WEEK, customerId, placeId));
  }
  for (let n = 1; n <= 6; n += 1) {
    const customerId = uuid("ffffffff", n);
    const placeId = uuid("abababab", n);
    crowd.set(customerId, { customerId, name: `Account ${n}`, listType: "AM", pending: false, places: [{ placeId, timings: timings(timing(6, "10:00")) }] });
    accounts.push(item(WEEK, customerId, placeId));
  }
  assert.equal(refusalOf(resolvePlan(doctors, crowd)), "Saturday 3 Oct has 16 PM. A day holds 15 PM at most.", "a plan day cannot take a 16th PM customer");
  assert.equal(refusalOf(resolvePlan(accounts, crowd)), "Saturday 3 Oct has 6 AM. A day holds 5 AM at most.", "a plan day cannot take a 6th AM customer");
  assert.equal(
    valueOf(resolvePlan([...doctors.slice(0, 15), ...accounts.slice(0, 5)], crowd)).length,
    20,
    "15 doctors and 5 accounts fit one day: the two maximums are apart and never added together",
  );
  assert.equal(
    refusalOf(resolvePlan(doctors.slice(0, 3), crowd, { pmDailyCap: 2 })),
    "Saturday 3 Oct has 3 PM. A day holds 2 PM at most.",
    "the maximum is the Super Admin's setting, not a number in the code",
  );
  const monday = doctors.slice(0, 15).map((entry) => ({ ...entry, planDate: "2026-10-05", exceptionType: "by_appointment" as const }));
  assert.equal(valueOf(resolvePlan([...doctors.slice(0, 15), ...monday], crowd)).length, 30, "the maximum is per day");

  const reviewTimings = timings(timing(6, "18:00", "20:00"), timing(6, "21:00"));
  assert.equal(describeDayWindows(reviewTimings, WEEK, false), "6:00 PM – 8:00 PM, from 9:00 PM");
  assert.equal(describeDayWindows(reviewTimings, "2026-10-04", false), "Does not receive this day");
  assert.equal(describeDayWindows(reviewTimings, WEEK, true), "6:00 PM – 8:00 PM, from 9:00 PM (no Ramadan time)");
}

function runCoverageTests() {
  const settings = PHOENIX_CRM_DEFAULT_SETTINGS;
  assert.equal(gradeTarget(settings, "PM", "A"), 3);
  assert.equal(gradeTarget(settings, "AM", "B"), null, "an AM grade B account has no monthly number");
  assert.equal(gradeTarget(settings, "PM", null), null);

  assert.equal(coverageTier(0, 3), 0, "not visited this month plans first");
  assert.equal(coverageTier(1, 3), 1, "behind its grade plans next");
  assert.equal(coverageTier(3, 3), 2);
  assert.equal(coverageTier(4, 3), 2);
  assert.equal(coverageTier(1, null), 2, "a customer with no number is covered once visited");
  assert.equal(coverageTier(0, null), 0);

  assert.equal(sharePercent(1, 3), 33.3);
  assert.equal(sharePercent(2, 3), 66.7);
  assert.equal(sharePercent(0, 0), null, "nothing to divide by is no figure, never 0%");

  const customers = [
    { listType: "PM" as const, grade: "A" as const, visits: 3 },
    { listType: "PM" as const, grade: "A" as const, visits: 4 },
    { listType: "PM" as const, grade: "B" as const, visits: 1 },
    { listType: "PM" as const, grade: "C" as const, visits: 0 },
    { listType: "PM" as const, grade: null, visits: 2 },
    { listType: "AM" as const, grade: "A" as const, visits: 1 },
    { listType: "AM" as const, grade: "B" as const, visits: 2 },
  ];
  assert.deepEqual(
    summarizeCoverage(customers, "PM", settings),
    { customers: 5, covered: 4, coveragePct: 80, withTarget: 4, onTarget: 1, under: 2, over: 1, frequencyPct: 25, visits: 10 },
    "over-visiting is a deviation beside under, never on target",
  );
  assert.deepEqual(
    summarizeCoverage(customers, "AM", settings),
    { customers: 2, covered: 2, coveragePct: 100, withTarget: 1, onTarget: 1, under: 0, over: 0, frequencyPct: 100, visits: 3 },
    "accounts are summed on their own, never with doctors",
  );

  assert.deepEqual(summarizeReadiness([]), { total: 0, validated: 0, dropped: 0, dropPending: 0, open: 0, ready: true }, "a territory with no reference list is ready at once");
  assert.equal(summarizeReadiness(["validated", "dropped"]).ready, true);
  assert.equal(summarizeReadiness(["validated", "drop_pending"]).ready, false, "a drop is done only once the district manager approves it");
  assert.equal(summarizeReadiness(["validated", "open"]).ready, false);
}

function runGeoTests() {
  assert.equal(isUsableFix(30.0444, 31.2357), true, "Cairo");
  assert.equal(isUsableFix("30.0444", "31.2357"), true);
  assert.equal(isUsableFix(21.5, 24), true, "the company's Egypt bounds are inclusive");
  assert.equal(isUsableFix(0, 0), false, "a handset that lost its lock is no location");
  assert.equal(isUsableFix(null, 31.2), false);
  assert.equal(isUsableFix("", 31.2), false);
  assert.equal(isUsableFix(Number.NaN, 31.2), false);
  assert.equal(isUsableFix(32.5, 31.2), false);

  const clinic = { lat: 30.0444, lon: 31.2357 };
  const kmNorth = { lat: 30.0544, lon: 31.2357 };
  const hundredMetres = { lat: 30.0454, lon: 31.2357 };
  assert.equal(distanceMeters(clinic, clinic), 0);
  assert.ok(Math.abs(distanceMeters(clinic, kmNorth) - 1112) <= 3, "a hundredth of a degree north is about 1.1 km");
  assert.equal(distanceMeters(clinic, kmNorth), distanceMeters(kmNorth, clinic));

  const places = [{ id: "clinic", ...clinic }];
  const check = (fix: { lat: number; lon: number }, accuracyMeters: number | null, placeList = places) =>
    checkVisitLocation({ fix: { ...fix, accuracyMeters }, places: placeList, farMeters: 300, weakGpsMeters: 100 });
  assert.deepEqual(check(clinic, 20), { placeId: "clinic", distanceMeters: 0, flag: "ok" });
  assert.equal(check(kmNorth, 20).flag, "far", "a visit beyond the distance setting is flagged (and still saved by the service)");
  assert.equal(check(kmNorth, 500).flag, "far", "far beats weak: that is what the manager must look at");
  assert.equal(check(hundredMetres, 150).flag, "weak_gps");
  assert.equal(check(hundredMetres, null).flag, "ok", "an unknown accuracy is not called weak");
  assert.equal(check(clinic, 20, [{ id: "far", lat: 30.1444, lon: 31.2357 }, { id: "near", ...clinic }]).placeId, "near", "the nearest place is the one checked");
  assert.deepEqual(check(clinic, 150, []), { placeId: null, distanceMeters: null, flag: "weak_gps" });
  assert.deepEqual(check(clinic, 20, []), { placeId: null, distanceMeters: null, flag: "ok" });

  assert.deepEqual(checkDaySpread([], 10), { spanKm: 0, spread: false, isolatedIds: [], nearestKmById: {} });
  assert.deepEqual(checkDaySpread([{ id: "a1", lat: 30, lon: 31.2 }], 10), { spanKm: 0, spread: false, isolatedIds: [], nearestKmById: {} });
  const a1 = { id: "a1", lat: 30.0, lon: 31.2 };
  const a2 = { id: "a2", lat: 30.001, lon: 31.2 };
  const b1 = { id: "b1", lat: 30.2, lon: 31.2 };
  const b2 = { id: "b2", lat: 30.201, lon: 31.2 };
  const clusters = checkDaySpread([a1, a2, b1, b2], 10);
  assert.equal(clusters.spread, true, "a day spanning two far-apart areas is highlighted");
  assert.deepEqual(clusters.isolatedIds, [], "two clusters flag the day, not their members");
  assert.ok(Math.abs(clusters.spanKm - 22.35) <= 0.1, `the span is the farthest pair, in km (${clusters.spanKm})`);
  assert.deepEqual(checkDaySpread([a1, a2, b1], 10).isolatedIds, ["b1"], "one outlier flags itself");
  assert.equal(checkDaySpread([a1, a2], 10).spread, false);
  assert.ok(Math.abs(checkDaySpread([a1, a2], 10).nearestKmById.a1 - 0.111) <= 0.002);

  assert.equal(formatDistance(850), "850 m");
  assert.equal(formatDistance(3240), "3.2 km");
  assert.equal(formatDistance(null), "no location");
}

function runEntryRuleTests() {
  assert.deepEqual(DROP_REASONS.map((reason) => reason.key), ["moved", "retired", "closed", "not_target", "duplicate", "other"]);
  assert.equal(parseGrade(" b "), "B");
  assert.equal(parseGrade("A+"), null);
  assert.equal(parseGrade("D"), null);
  assert.equal(gradeFromReference("A+"), "A", "iReports360's one A+ doctor reads as A");
  assert.equal(gradeFromReference("c"), "C");
  assert.equal(gradeFromReference("X"), null, "an unknown vendor grade is left blank, never guessed");
  assert.equal(parseListType("pm"), "PM");
  assert.equal(parseListType("Pharmacy"), null, "pharmacies are not in Step 1");
  assert.equal(cleanText("  Dr   Mona  Adel ", 120), "Dr Mona Adel");
  assert.equal(cleanText("   ", 10), null);
  assert.equal(cleanText("abcdef", 3), "abc");

  const LOCATION = "Your location was not captured. Allow location for your browser and capture it again at the clinic.";
  assert.equal(refusalOf(parseCapturedFix({ lat: 0, lon: 0 })), LOCATION);
  assert.equal(refusalOf(parseCapturedFix({})), LOCATION);
  assert.deepEqual(valueOf(parseCapturedFix({ lat: "30.05", lon: "31.23", accuracyMeters: 12.345, deviceCapturedAt: "2026-10-03T15:00:00Z" })), {
    lat: 30.05,
    lon: 31.23,
    accuracyMeters: 12.3,
    deviceCapturedAt: "2026-10-03T15:00:00Z",
    // Absent from this payload, so it parses to "not asked" — never to false. An older build that
    // never sends the field must not read as a device proven clean.
    deviceMocked: null,
    // When the phone TOOK the reading, absent here and therefore NOT MEASURED. Its own assertions
    // are below; it is in this shape so a build that stopped carrying it would show up here too.
    fixTakenAt: null,
    // The browser's own location reader (2026-10-16): absent here, so NOT ASKED — never "its own".
    readerReplaced: null,
    readerFindings: [],
    // The shutter fix, added 2026-09-29. Absent here for the same reason and with the same
    // meaning: NOT MEASURED. An older build, the web, or a handset whose shutter read nothing all
    // send no shutter keys, and none of them is refused for it. Never defaulted to lat/lon.
    photoAccuracyMeters: null,
    photoCapturedAt: null,
    photoLat: null,
    photoLon: null,
  });
  // And the positive case, pinned where the parse is canonically tested.
  assert.deepEqual(
    valueOf(
      parseCapturedFix({
        lat: "30.05",
        lon: "31.23",
        accuracyMeters: 12.345,
        deviceCapturedAt: "2026-10-03T15:00:00Z",
        shutterLat: "30.0501",
        shutterLon: "31.2299",
        shutterAccuracyMeters: 18.77,
        shutterCapturedAt: "2026-10-03T15:00:21Z",
      }),
    ),
    {
      lat: 30.05,
      lon: 31.23,
      accuracyMeters: 12.3,
      deviceCapturedAt: "2026-10-03T15:00:00Z",
      deviceMocked: null,
      fixTakenAt: null,
      readerReplaced: null,
      readerFindings: [],
      photoAccuracyMeters: 18.8,
      photoCapturedAt: "2026-10-03T15:00:21Z",
      photoLat: 30.0501,
      photoLon: 31.2299,
    },
    "the shutter fix parses on its own keys, rounded like the pin and never taken from it",
  );
  // 🔴 WHEN THE PHONE TOOK THE POSITION, which the one-tap visit read and threw away until 2026-10-12.
  // It is the phone's own clock at the reading, kept beside the phone's clock at the TAP, so the two
  // measure the reading's age with no clock skew in the answer — the server's receipt (`captured_at`)
  // cannot, and module memory forbids reading that as a position in time at all.
  assert.equal(
    valueOf(parseCapturedFix({ lat: 30.05, lon: 31.23, fixTakenAt: "2026-10-12T15:00:09Z" })).fixTakenAt,
    "2026-10-12T15:00:09Z",
    "the fix's own time travels with the fix",
  );
  for (const junk of ["this morning", "", 1760000000000, null, undefined, {}]) {
    assert.equal(
      valueOf(parseCapturedFix({ lat: 30.05, lon: 31.23, fixTakenAt: junk })).fixTakenAt,
      null,
      `a fix time of ${JSON.stringify(junk) ?? String(junk)} is NOT MEASURED, never a refusal and never the tap`,
    );
  }
  // HALF A PAIR IS NO PAIR: a latitude with no longitude contributes no coordinate at all, rather
  // than a lopsided fix that would later measure a distance from nowhere.
  const halfPair = valueOf(parseCapturedFix({ lat: 30.05, lon: 31.23, shutterLat: 30.0501 }));
  assert.equal(halfPair.photoLat, null, "a shutter latitude with no longitude is not a fix");
  assert.equal(halfPair.photoLon, null, "and neither half is stored");
  for (const accuracyMeters of [-5, "abc", null, undefined]) {
    assert.equal(valueOf(parseCapturedFix({ lat: 30.05, lon: 31.23, accuracyMeters })).accuracyMeters, null, `accuracy ${String(accuracyMeters)} is unknown`);
  }
  assert.equal(valueOf(parseCapturedFix({ lat: 30.05, lon: 31.23, deviceCapturedAt: "yesterday" })).deviceCapturedAt, null);

  // Validation: a live photo, the location on the spot, and at least one timing — in that order.
  const PHOTO = "Take a live photo of the clinic sign or door.";
  assert.equal(refusalOf(parsePlaceDraft({})), PHOTO);
  assert.equal(refusalOf(parsePlaceDraft({ photoPath: "seat/photo.jpg" })), LOCATION);
  assert.equal(refusalOf(parsePlaceDraft({ photoPath: "seat/photo.jpg", lat: 30.05, lon: 31.23 })), "Add the days and hours this customer receives visits.");
  // The place's NAME is the rep's; WHERE it is never was. Owner, 2026-09-23: "the capture location
  // is never editable and its separated when captured to brick area region clean addresss and raw
  // location" — so the address, the part of town and the brick are resolved on the server from the
  // captured coordinates and are not on this type at all. A phone still sending the old keys is
  // IGNORED rather than refused, so one holding the previous bundle keeps validating; the deepEqual
  // below is what proves the ignoring, since a leaked key would show up as an extra property.
  assert.deepEqual(
    valueOf(parsePlaceDraft({ photoPath: " seat/photo.jpg ", lat: 30.05, lon: 31.23, accuracyMeters: 9, label: "  Clinic   2 ", address: " 5 Faisal St ", brick: " Faisal ", zone: "Haram", timings: [timing(6, "18:00")] })),
    {
      lat: 30.05,
      lon: 31.23,
      accuracyMeters: 9,
      deviceCapturedAt: null,
      // The phone reports Android's mock-provider flag alongside the fix; this payload carries none,
      // so it reads "could not ask" rather than "clean". It is part of the captured fix, not of the
      // draft's editable fields — the rep still names only the place.
      deviceMocked: null,
      // Also from the shared reader, and also unstored for a place: only a VISIT's provenance row
      // carries the fix time, because only a visit is one tap taken in the moment.
      fixTakenAt: null,
      // The reader answer rides the same shared parser and IS judged for a place (judgeCaptureForPlace).
      readerReplaced: null,
      readerFindings: [],
      // Parsed by the SHARED captured-fix reader, so a place carries these too. Nothing stores
      // them yet: the 2026-09-29 migration added photo_* to phoenix_crm_visits only, and a place
      // is captured once rather than visited, so there is no pin-versus-shutter question to ask
      // of it. They are here because the parser is one function, not because a place uses them -
      // and this deepEqual is what would catch it if a future change started storing them by
      // accident.
      photoAccuracyMeters: null,
      photoCapturedAt: null,
      photoLat: null,
      photoLon: null,
      label: "Clinic 2",
      photoPath: "seat/photo.jpg",
      // When Capture location took ITS reading (2026-10-08): read only for the capture-trust check,
      // never stored. This payload sends none, so the gap reads as unmeasured.
      pinCapturedAt: null,
      timings: [{ weekday: 6, startMinute: 1080, endMinute: null, season: "normal" }],
    },
  );

  assert.equal(refusalOf(parseNewCustomer({})), "Choose AM or PM.");
  assert.equal(refusalOf(parseNewCustomer({ listType: "pm", name: " Al " })), "Write the customer's full name.");
  assert.equal(
    refusalOf(parseNewCustomer({ listType: "pm", name: "Dr Mona Adel" })),
    "Propose a grade (A, B or C). Your district manager and SFE approve it.",
    "a new customer's grade is the rep's proposal, decided by the district manager",
  );
  assert.deepEqual(valueOf(parseNewCustomer({ listType: "am", name: "  Al   Shorouk Hospital ", proposedGrade: "a", speciality: " " })), {
    listType: "AM",
    name: "Al Shorouk Hospital",
    speciality: null,
    proposedGrade: "A",
  });

  assert.equal(refusalOf(parseDropDraft({ reason: "gone" })), "Choose why this customer should leave your list.", "a drop always carries a reason");
  assert.equal(refusalOf(parseDropDraft({ reason: "other", note: "  " })), "Write why this customer should leave your list.");
  assert.deepEqual(valueOf(parseDropDraft({ reason: "moved", note: " " })), { reason: "moved", note: null });

  // A visit: the customer, who was on it, the products, the pharmacy feedback, the comment, a live
  // photo and the location.
  const visit = { customerId: DOCTOR.toUpperCase(), kind: "single", products: ["Lacto Advanced"], pharmacyName: "El Ezaby", comment: "Discussed the new dose.", photoPath: "seat/visit.jpg", lat: 30.05, lon: 31.23, accuracyMeters: 12 };
  assert.equal(refusalOf(parseVisitDraft({ ...visit, customerId: "dr-mona" })), "Choose the customer you visited.");
  assert.equal(refusalOf(parseVisitDraft({ ...visit, kind: "triple" })), "Choose who was on the visit.");
  assert.equal(refusalOf(parseVisitDraft({ ...visit, kind: "double" })), "Choose the district manager who was on the visit.");
  assert.equal(refusalOf(parseVisitDraft({ ...visit, kind: "chain", managerHrId: "T-3" })), "Choose the senior manager who was on the visit.");
  assert.equal(refusalOf(parseVisitDraft({ ...visit, products: [] })), "Choose the products you discussed.");
  assert.equal(refusalOf(parseVisitDraft({ ...visit, products: ["", "  "] })), "Choose the products you discussed.");
  assert.equal(refusalOf(parseVisitDraft({ ...visit, products: Array.from({ length: 13 }, (_, n) => `Product ${n}`) })), "Choose at most 12 products.");
  // Owner, 2026-09-29: the pharmacy stock check is OPTIONAL — the box stays, a visit is never blocked on it.
  assert.equal(valueOf(parseVisitDraft({ ...visit, pharmacyName: "  " })).pharmacyName, null, "a blank pharmacy is no pharmacy, never a refusal");
  assert.equal(valueOf(parseVisitDraft({ ...visit, pharmacyName: undefined })).pharmacyName, null);
  assert.equal(refusalOf(parseVisitDraft({ ...visit, comment: "x".repeat(1001) })), "The comment is longer than 1000 characters.");
  // Required since 2026-09-30 (owner: "visit comment is required") — empty, blank or missing is refused.
  for (const comment of ["", "   ", undefined, null]) {
    assert.equal(refusalOf(parseVisitDraft({ ...visit, comment })), VISIT_COMMENT_REQUIRED, `a visit with comment ${JSON.stringify(comment)} is refused`);
  }
  // …and "Log visit" is one tap with NO photo; a caller that still sends one keeps its path.
  assert.equal(valueOf(parseVisitDraft({ ...visit, photoPath: " " })).photoPath, null, "a visit needs no photo since 2026-09-29");
  assert.equal(valueOf(parseVisitDraft(visit)).photoPath, "seat/visit.jpg", "a caller one release behind is served as before");
  assert.equal(
    refusalOf(parseVisitDraft({ ...visit, lat: 0, lon: 0 })),
    "Turn on location for your browser, then tap Log visit again.",
    "every visit still carries its location — read silently, and a missing one is said plainly as his own step",
  );
  assert.notEqual(PHOTO, LOCATION, "the validation screen keeps its own two sentences");

  const single = valueOf(parseVisitDraft({ ...visit, kind: undefined, managerHrId: "T-3", seniorHrId: "T-2", products: ["Lacto Advanced", " Lacto   Advanced ", "Royanoxicam"], pharmacyName: "  Seif  Pharmacy ", comment: "  good  " }));
  assert.equal(single.kind, "single");
  assert.equal(single.customerId, DOCTOR, "ids are stored lower case");
  assert.equal(single.managerHrId, null, "a single visit names no manager, whatever the phone sent");
  assert.equal(single.seniorHrId, null);
  assert.deepEqual(single.products, ["Lacto Advanced", "Royanoxicam"]);
  assert.equal(single.pharmacyName, "Seif Pharmacy", "the pharmacy name is collapsed and trimmed");
  assert.deepEqual(single.productAvailability, {}, "no stock answers when the phone sent none");
  assert.equal(single.comment, "good");

  // The pharmacy stock: only "has"/"missing" answers on a named product survive; the rest is dropped,
  // never refused, so a stray key never blocks the visit. The line check happens on the server.
  const stock = valueOf(parseVisitDraft({ ...visit, productAvailability: { "Lacto Advanced": "has", Royanoxicam: "missing", Guesswork: "maybe", "  ": "has" } }));
  assert.deepEqual(stock.productAvailability, { "Lacto Advanced": "has", Royanoxicam: "missing" });
  assert.deepEqual(valueOf(parseVisitDraft({ ...visit, productAvailability: "nope" })).productAvailability, {}, "a non-object availability is dropped");
  assert.deepEqual(valueOf(parseVisitDraft({ ...visit, productAvailability: ["has"] })).productAvailability, {}, "an array availability is dropped");
  const double = valueOf(parseVisitDraft({ ...visit, kind: "double", managerHrId: "T-3", seniorHrId: "T-2" }));
  assert.deepEqual([double.managerHrId, double.seniorHrId], ["T-3", null], "a double visit is the rep and one manager");
  const chain = valueOf(parseVisitDraft({ ...visit, kind: "chain", managerHrId: "T-3", seniorHrId: "T-2" }));
  assert.deepEqual([chain.managerHrId, chain.seniorHrId], ["T-3", "T-2"]);
  assert.equal(chain.comment, "Discussed the new dose.", "the comment is kept as written");

  assert.equal(deviceClockSkewMinutes("2026-10-03T12:20:00Z", new Date("2026-10-03T12:00:00Z")), 20);
  assert.equal(deviceClockSkewMinutes(null, new Date()), null);
  assert.equal(deviceClockSkewMinutes("later", new Date()), null);
}

function place(
  placeId: string,
  weekTimings: PhoenixCrmTiming[],
  where: { brick?: string | null; zone?: string | null; lat?: number; lon?: number; address?: string | null } = {},
): PlannerPlace {
  return { placeId, label: null, address: where.address ?? null, lat: where.lat ?? 30.02, lon: where.lon ?? 31.16, brick: where.brick ?? null, zone: where.zone ?? null, timings: weekTimings };
}

function customer(name: string, places: PlannerPlace[], grade: PlannerCustomer["grade"] = null, visitsThisMonth = 0): PlannerCustomer {
  return { customerId: `customer-${name}`, name, listType: "PM", grade, pending: false, speciality: null, visitsThisMonth, places };
}

function suggestNames(customers: PlannerCustomer[], placed: PlannerCustomer[]) {
  return suggestForDay({
    weekday: 6,
    ramadan: false,
    customers: [...customers, ...placed],
    placed: placed.map((entry) => ({ customerId: entry.customerId, placeId: entry.places[0].placeId })),
    settings: PHOENIX_CRM_DEFAULT_SETTINGS,
  });
}

function runSuggestionTests() {
  assert.equal(normalizeArea("  Haram   Faisal "), "haram faisal");
  assert.equal(normalizeArea(""), null);
  assert.equal(normalizeArea(null), null);

  // The rep sees each place's street address while he builds his plan (owner, 2026-09-25).
  const addressed = suggestForDay({
    weekday: 6,
    ramadan: false,
    customers: [customer("Addressed", [place("addr", timings(timing(6, "18:00")), { brick: "Faisal", address: "5 Faisal St, Giza" })])],
    placed: [],
    settings: PHOENIX_CRM_DEFAULT_SETTINGS,
  });
  assert.equal(addressed[0]?.address, "5 Faisal St, Giza", "a suggestion carries its place's clean street address");

  const anchor = customer("Placed", [place("placed", timings(timing(6, "18:30", "19:30")), { brick: "Faisal", zone: "Haram-Faisal" })], "B");
  const order = suggestNames(
    [
      customer("Elsewhere", [place("elsewhere", timings(timing(0, "18:00")))], "A", 0),
      customer("OnGrade", [place("on-grade", timings(timing(6, "17:00")), { brick: "Haram" })], "C", 1),
      customer("Behind", [place("behind", timings(timing(6, "19:00")), { brick: "Haram", zone: "Haram-Faisal" })], "A", 1),
      customer("Uncovered", [place("uncovered", timings(timing(6, "18:00")), { brick: "Dokki", zone: "Giza", lat: 30.04, lon: 31.21 })], "A", 0),
      customer("NoPlace", [], "A", 0),
    ],
    [anchor],
  );
  assert.deepEqual(
    order.map((row) => row.name),
    ["Uncovered", "Behind", "OnGrade", "Elsewhere", "Placed"],
    "receives that day first, then not visited this month, then behind its grade; a customer with no place is never offered; the ones already placed go last",
  );
  const [uncovered, behind, onGrade, elsewhere, placed] = order;
  assert.deepEqual([uncovered.tier, behind.tier, onGrade.tier], [0, 1, 2]);
  assert.equal(behind.target, 3);
  assert.equal(behind.sameZone, true, "zones compare as the rep typed them, case and spaces aside");
  assert.equal(behind.sameBrick, false);
  assert.equal(behind.fitsTime, true);
  assert.equal(elsewhere.receives, false, "a customer who does not receive that day can still be offered, last among the open ones");
  assert.equal(elsewhere.fitsTime, false);
  assert.equal(placed.alreadyOnDay, true);
  assert.equal(placed.nearestPlacedKm, null, "a place is never measured against itself");
  assert.equal(
    uncovered.nearestPlacedKm,
    Math.round((distanceMeters({ lat: 30.04, lon: 31.21 }, anchor.places[0]) / 1000) * 10) / 10,
    "the distance to the nearest customer already placed that day, in km to one decimal",
  );
  assert.ok(uncovered.nearestPlacedKm !== null && Math.abs(uncovered.nearestPlacedKm - 5.3) <= 0.1, `about 5.3 km apart (${uncovered.nearestPlacedKm})`);

  const same = (name: string, where: { brick?: string; zone?: string }, windows: PhoenixCrmTiming[]) => customer(name, [place(name, windows, where)]);
  const late = timings(timing(6, "20:00"));
  assert.deepEqual(
    suggestNames(
      [
        same("Morning", { brick: "Dokki", zone: "Giza" }, timings(timing(6, "08:00", "09:00"))),
        same("FitsTime", { brick: "Dokki", zone: "Giza" }, timings(timing(6, "19:30"))),
        same("SameZone", { brick: "Haram", zone: "HARAM-FAISAL" }, late),
        same("SameBrick", { brick: " faisal ", zone: "Other" }, late),
      ],
      [customer("Anchor", [place("anchor", timings(timing(6, "18:00", "19:00")), { brick: "Faisal", zone: "Haram-Faisal" })])],
    ).map((row) => row.name),
    ["SameBrick", "SameZone", "FitsTime", "Morning", "Anchor"],
    "among equally uncovered customers: same brick, then same zone, then a time that fits the day",
  );

  assert.deepEqual(
    suggestNames(
      [customer("Far", [place("far", late, { lat: 30.05, lon: 31.2 })]), customer("Near", [place("near", late, { lat: 30.001, lon: 31.2 })])],
      [customer("Anchor", [place("anchor", timings(timing(6, "19:00")), { lat: 30.0, lon: 31.2 })])],
    ).map((row) => row.name),
    ["Near", "Far", "Anchor"],
    "then the nearest to the customers already placed",
  );
  assert.deepEqual(
    suggestNames([customer("Beta", [place("b", late)]), customer("Late", [place("l", timings(timing(6, "21:00")))]), customer("Alpha", [place("a", late)])], []).map((row) => row.name),
    ["Alpha", "Beta", "Late"],
    "then the earliest window, then the name",
  );

  const twoClinics = suggestNames(
    [
      customer("TwoClinics", [place("clinic-x", timings(timing(6, "18:00"))), place("clinic-y", timings(timing(6, "20:00")))]),
      customer("NotToday", [place("sunday", timings(timing(0, "18:00"))), place("monday", timings(timing(1, "18:00")))]),
    ],
    [],
  );
  assert.deepEqual(
    twoClinics.map((row) => `${row.name}@${row.placeId}`),
    ["TwoClinics@clinic-x", "TwoClinics@clinic-y", "NotToday@sunday"],
    "one row for each place that receives that day; a customer who receives nowhere that day gets one row",
  );
}

function runReportRuleTests() {
  assert.equal(daysInPeriod("2026-10-01", "2026-10-31"), 31);
  assert.equal(daysInPeriod("2026-10-03", "2026-10-03"), 1);
  const today = "2026-10-17";
  assert.deepEqual(valueOf(resolveReportPeriod({ from: "", to: null, cairoToday: today })), { from: "2026-10-01", to: today }, "the 1st of the month to today");
  assert.deepEqual(valueOf(resolveReportPeriod({ from: "2026-10-05", to: "2026-11-30", cairoToday: today })), { from: "2026-10-05", to: today }, "never past today");
  assert.deepEqual(valueOf(resolveReportPeriod({ from: undefined, to: "2026-09-20", cairoToday: today })), { from: "2026-09-01", to: "2026-09-20" });
  assert.deepEqual(valueOf(resolveReportPeriod({ from: "2026-09-16", to: "2026-10-16", cairoToday: today })), { from: "2026-09-16", to: "2026-10-16" });
  assert.equal(refusalOf(resolveReportPeriod({ from: "2026-09-15", to: "2026-10-16", cairoToday: today })), "Choose at most 31 days.");
  assert.equal(refusalOf(resolveReportPeriod({ from: "2026-10-10", to: "2026-10-09", cairoToday: today })), "The first day is after the last day.");
  assert.equal(refusalOf(resolveReportPeriod({ from: "", to: "17/10/2026", cairoToday: today })), "Choose a valid last day.");
  assert.equal(refusalOf(resolveReportPeriod({ from: "2026-02-30", to: "", cairoToday: today })), "Choose a valid first day.");

  assert.deepEqual(valueOf(resolveReportMonth({ month: "", cairoToday: today })), { month: "2026-10", monthStart: "2026-10-01", monthEnd: "2026-10-31", inProgress: true });
  assert.deepEqual(valueOf(resolveReportMonth({ month: "2026-09", cairoToday: today })), { month: "2026-09", monthStart: "2026-09-01", monthEnd: "2026-09-30", inProgress: false });
  assert.equal(refusalOf(resolveReportMonth({ month: "2026-11", cairoToday: today })), "That month has not started yet.");
  assert.equal(refusalOf(resolveReportMonth({ month: "2026-13", cairoToday: today })), "Choose a valid month.");

  // ── Visits per rep per day: AM and PM apart ─────────────────────────────────────────────────────
  const visits = groupVisitsByRep([
    { seat_id: "R1", rep_hr_id: "T-101", visit_date: "2026-10-04", list_type: "AM", visits: 2, double_visits: 1, chain_visits: 0, far_visits: 0, test_visits: 0 },
    { seat_id: "R1", rep_hr_id: "T-101", visit_date: "2026-10-04", list_type: "PM", visits: 9, double_visits: 0, chain_visits: 1, far_visits: 2, test_visits: 0 },
    { seat_id: "R1", rep_hr_id: "T-101", visit_date: "2026-10-03", list_type: "PM", visits: "8" },
    { seat_id: "R1", rep_hr_id: "T-101", visit_date: "2026-10-05", list_type: "PM", visits: 0, test_visits: 3 },
    { seat_id: "R1", rep_hr_id: null, visit_date: "2026-10-04", list_type: "PM", visits: 1 },
    { seat_id: null, rep_hr_id: "T-101", visit_date: "2026-10-04", list_type: "PM", visits: 50 },
    { seat_id: "R2", rep_hr_id: "T-102", visit_date: "2026-10-04", list_type: "PM", visits: -4, double_visits: "many" },
  ]);
  assert.deepEqual(Object.keys(visits.totals), ["AM", "PM"], "there is no combined AM and PM total");
  assert.deepEqual(visits.totals.AM, { visits: 2, doubleVisits: 1, chainVisits: 0, farVisits: 0, testVisits: 0, unplannedWaiting: 0 });
  assert.deepEqual(visits.totals.PM, { visits: 18, doubleVisits: 0, chainVisits: 1, farVisits: 2, testVisits: 3, unplannedWaiting: 0 });
  assert.deepEqual(visits.groups.map((group) => [group.seatId, group.repHrId, group.visitDays]), [["R1", "T-101", 2], ["R1", null, 1], ["R2", "T-102", 0]]);
  const rep = visits.groups[0];
  assert.deepEqual(rep.days.map((day) => day.date), ["2026-10-03", "2026-10-04", "2026-10-05"], "days in date order");
  assert.deepEqual([rep.days[1].am.visits, rep.days[1].pm.visits], [2, 9]);
  assert.equal(rep.pm.visits, 17);
  assert.equal(visits.groups[2].pm.visits, 0, "a figure that is not a positive count reads 0");

  // ── Plan against actual ─────────────────────────────────────────────────────────────────────────
  const plan = groupPlanByTerritory([
    { seat_id: "R1", day: "2026-10-04", list_type: "PM", planned: 12, visited_planned: 9, missed: 3, unplanned: 2 },
    { seat_id: "R1", day: "2026-10-03", list_type: "PM", planned: 10, visited_planned: 10, missed: 0, unplanned: 0 },
    { seat_id: "R1", day: "2026-10-04", list_type: "AM", planned: 3, visited_planned: 3, missed: 0, unplanned: 1 },
    { seat_id: "R2", day: "2026-10-04", list_type: "PM", planned: 0, visited_planned: 0, missed: 0, unplanned: 4 },
  ]);
  assert.deepEqual(plan.groups[0].days.map((day) => day.date), ["2026-10-03", "2026-10-04"]);
  assert.deepEqual(plan.groups[0].pm, { planned: 22, visitedPlanned: 19, plannedWaiting: 0, missed: 3, onLeave: 0, unplanned: 2, unplannedWaiting: 0, unplannedRefused: 0 });
  assert.deepEqual(plan.groups[0].am, { planned: 3, visitedPlanned: 3, plannedWaiting: 0, missed: 0, onLeave: 0, unplanned: 1, unplannedWaiting: 0, unplannedRefused: 0 });
  assert.deepEqual(plan.totals.PM, { planned: 22, visitedPlanned: 19, plannedWaiting: 0, missed: 3, onLeave: 0, unplanned: 6, unplannedWaiting: 0, unplannedRefused: 0 });
  assert.equal(planKeptPercent(plan.groups[0].pm), 86.4);
  assert.equal(planKeptPercent(plan.groups[1].pm), null, "no plan is no figure, never 0%");

  // ── Coverage and frequency ──────────────────────────────────────────────────────────────────────
  const coverage = groupCoverageByTerritory([
    { seat_id: "R1", list_type: "PM", customers: 100, covered: 80, with_target: 90, on_target: 45, under: 30, over: 15, visits: 210 },
    { seat_id: "R1", list_type: "AM", customers: 12, covered: 12, with_target: 10, on_target: 10, under: 0, over: 0, visits: 14 },
  ]);
  assert.deepEqual(coverageCell(coverage.groups[0].pm), { customers: 100, covered: 80, withTarget: 90, onTarget: 45, under: 30, over: 15, visits: 210, coveragePct: 80, frequencyPct: 50 });
  assert.equal(coverageCell(coverage.totals.AM).frequencyPct, 100);

  // ── Double and chain visits per manager ─────────────────────────────────────────────────────────
  const managers = groupManagerVisits([
    { hr_id: "T-3", role_on_visit: "manager", visit_date: "2026-10-05", seat_id: "R1", rep_hr_id: "T-101", double_visits: 1, chain_visits: 0, am_visits: 0, pm_visits: 1 },
    { hr_id: "T-3", role_on_visit: "manager", visit_date: "2026-10-04", seat_id: "R2", rep_hr_id: "T-102", double_visits: 0, chain_visits: 1, am_visits: 1, pm_visits: 0 },
    { hr_id: "T-3", role_on_visit: "manager", visit_date: "2026-10-04", seat_id: "R1", rep_hr_id: "T-101", double_visits: 1, chain_visits: 0, am_visits: 0, pm_visits: 1 },
    { hr_id: "T-2", role_on_visit: "senior", visit_date: "2026-10-04", seat_id: "R2", rep_hr_id: "T-102", double_visits: 0, chain_visits: 1, am_visits: 1, pm_visits: 0 },
    { hr_id: null, role_on_visit: "manager", visit_date: "2026-10-04", seat_id: "R1", rep_hr_id: "T-101", double_visits: 5 },
    // The line's PRODUCT manager, in his own column (owner, 2026-10-07): the rep ticked ONE person
    // under "Double visit" and it was him, so the row carries `product_manager_visits` and NOT
    // `double_visits` — the figure district managers are judged on must not move.
    { hr_id: "T-9", role_on_visit: "product_manager", visit_date: "2026-10-06", seat_id: "R1", rep_hr_id: "T-101", double_visits: 0, chain_visits: 0, product_manager_visits: 3, am_visits: 1, pm_visits: 2 },
    { hr_id: "T-9", role_on_visit: "product_manager", visit_date: "2026-10-06", seat_id: "R2", rep_hr_id: "T-103", double_visits: 0, chain_visits: 2, product_manager_visits: 0, am_visits: 0, pm_visits: 2 },
  ]);
  assert.deepEqual([...managers.keys()], ["T-3", "T-2", "T-9"]);
  const district = managers.get("T-3");
  assert.ok(district);
  assert.deepEqual(district.entries.map((entry) => `${entry.date} ${entry.seatId}`), ["2026-10-04 R1", "2026-10-04 R2", "2026-10-05 R1"]);
  assert.deepEqual(district.summary, { doubleVisits: 2, chainVisits: 1, seniorChainVisits: 0, productManagerVisits: 0, productManagerChainVisits: 0, amVisits: 1, pmVisits: 2, daysOut: 2, reps: 2 });
  assert.deepEqual(managers.get("T-2")?.summary, { doubleVisits: 0, chainVisits: 0, seniorChainVisits: 1, productManagerVisits: 0, productManagerChainVisits: 0, amVisits: 1, pmVisits: 0, daysOut: 1, reps: 1 }, "a senior manager's chain visits are counted apart from the manager's");
  const productManager = managers.get("T-9");
  assert.ok(productManager, "a product manager the rep ticked is a row of his own — before 2026-10-07 he was in no row at all");
  assert.deepEqual(
    productManager.summary,
    { doubleVisits: 0, chainVisits: 0, seniorChainVisits: 0, productManagerVisits: 3, productManagerChainVisits: 2, amVisits: 1, pmVisits: 4, daysOut: 1, reps: 2 },
    "a product manager's visits are counted apart: never in doubleVisits, and never read as a senior manager's chain",
  );
  assert.deepEqual(productManager.entries.map((entry) => entry.roleOnVisit), ["product_manager", "product_manager"]);
}

function seat(seatId: string, tier: string, occupantHrId: string | null, path: string[], areaName: string | null = null): OrgSeat {
  return {
    seatId,
    parentSeatId: path.length > 1 ? path[path.length - 2] : null,
    tier,
    path,
    occupantHrId,
    lineCode: "PD",
    lineName: "Pedia",
    areaName,
    regionName: null,
    seatLabel: null,
  };
}

function organogram(): OrgIndex {
  const line = ["CEO", "NSM1", "RSM1"];
  return buildOrgIndex([
    seat("CEO", "CEO", "T-1", ["CEO"]),
    seat("NSM1", "NSM", "T-2", ["CEO", "NSM1"]),
    seat("RSM1", "RSM", null, line),
    seat("DM1", "DM", "T-3", [...line, "DM1"]),
    seat("R1", "REP", "t-101", [...line, "DM1", "R1"]),
    seat("R2", "REP", "T-102", [...line, "DM1", "R2"]),
    seat("R7", "REP", null, [...line, "DM1", "R7"]),
    seat("DM2", "DM", null, [...line, "DM2"]),
    seat("R3", "REP", "T-103", [...line, "DM2", "R3"]),
    // An acting district manager keeps a rep seat under their own acting seat.
    seat("ADM3", "ACTING_DM", "T-104", [...line, "ADM3"]),
    seat("R4", "REP", "T-104", [...line, "ADM3", "R4"]),
    seat("R5", "REP", "T-105", [...line, "ADM3", "R5"]),
    // A territory with only the CEO above it.
    seat("R6", "REP", "T-106", ["CEO", "R6"]),
  ]);
}

function runScopeTests() {
  const org = organogram();
  const ids = (seats: OrgSeat[]) => seats.map((entry) => entry.seatId);
  const chainOf = (index: OrgIndex, seatId: string) => managerChain(index, seatId).map((member) => [member.hrId, member.seat.seatId, member.position]);

  assert.deepEqual(ids(org.territories), ["R1", "R2", "R3", "R4", "R5", "R6", "R7"]);
  assert.equal(org.seats.get("R1")?.occupantHrId, "T-101", "stored HR ids are upper case");
  assert.deepEqual(ids(territoriesBelow(org, ["DM1"])), ["R1", "R2", "R7"], "a vacant territory is still the district's");
  assert.deepEqual(ids(territoriesBelow(org, [])), []);

  // Scope runs downward only.
  assert.deepEqual(ids(territoriesInScope(org, "T-3", "tree")), ["R1", "R2", "R7"]);
  assert.deepEqual(ids(territoriesInScope(org, "t-101", "tree")), ["R1"], "a rep reads their own territory");
  assert.deepEqual(ids(territoriesInScope(org, "T-104", "tree")), ["R4", "R5"], "an acting district manager reads their own territory and the ones beneath the acting seat");
  assert.deepEqual(ids(territoriesInScope(org, "T-2", "tree")), ["R1", "R2", "R3", "R4", "R5", "R7"]);
  assert.deepEqual(ids(territoriesInScope(org, "T-1", "tree")), [], "the CEO is not a district: the company view is the explicit \"all\"");
  assert.equal(territoriesInScope(org, null, "all").length, 7);
  assert.deepEqual(ids(territoriesInScope(org, "T-999", "tree")), []);

  // The reviewer: nearest occupied manager seat above, never the territory's own rep, never the CEO.
  assert.deepEqual(chainOf(org, "R1"), [["T-3", "DM1", 0], ["T-2", "NSM1", 1]], "a vacant regional seat is passed over, and the chain stops below the CEO");
  assert.deepEqual(chainOf(org, "R4"), [["T-2", "NSM1", 0]], "the acting seat held by the territory's own rep is skipped");
  assert.deepEqual(chainOf(org, "R6"), []);
  assert.deepEqual(chainOf(org, "NOPE"), []);
  assert.equal(territoryReviewer(org, "R1")?.hrId, "T-3");
  assert.equal(territoryReviewer(org, "R7")?.hrId, "T-3", "a territory with no rep still has its reviewer");
  assert.equal(territoryReviewer(org, "R3")?.hrId, "T-2", "a vacant district passes to the manager above");
  assert.equal(territoryReviewer(org, "R4")?.hrId, "T-2", "an acting district manager never reviews their own territory");
  assert.equal(territoryReviewer(org, "R5")?.hrId, "T-104");
  assert.equal(territoryReviewer(org, "R6"), null, "the CEO is never a reviewer");
  assert.equal(isTerritoryReviewer(org, "R1", "t-3"), true);
  assert.equal(isTerritoryReviewer(org, "R1", "T-2"), false, "the manager above the reviewer does not review");
  assert.equal(isTerritoryReviewer(org, "R6", "T-1"), false);

  const twoSeats = buildOrgIndex([
    seat("CEO", "CEO", "T-1", ["CEO"]),
    seat("NSMx", "NSM", "T-20", ["CEO", "NSMx"]),
    seat("RSMx", "RSM", "T-21", ["CEO", "NSMx", "RSMx"]),
    seat("DMx", "DM", "T-21", ["CEO", "NSMx", "RSMx", "DMx"]),
    seat("Rx", "REP", "T-120", ["CEO", "NSMx", "RSMx", "DMx", "Rx"]),
  ]);
  assert.deepEqual(chainOf(twoSeats, "Rx"), [["T-21", "DMx", 0], ["T-20", "NSMx", 1]], "a person on two seats of the chain appears once, at the nearest");

  // The manager report never reaches upward.
  const people = (members: ReturnType<typeof managersInScope>) => members.map((member) => member.hrId);
  assert.deepEqual(people(managersInScope(org, "T-2", "tree")), ["T-2", "T-104", "T-3"]);
  assert.deepEqual(people(managersInScope(org, "T-3", "tree")), ["T-3"], "a district manager's report never shows their own manager");
  assert.deepEqual(people(managersInScope(org, "T-101", "tree")), [], "a rep has no manager report");
  assert.deepEqual(people(managersInScope(org, null, "all")), ["T-2", "T-104", "T-3"], "the company view lists every manager and never the CEO");
  const upward = buildOrgIndex([
    seat("CEO", "CEO", "T-1", ["CEO"]),
    seat("RSMa", "RSM", "T-60", ["CEO", "RSMa"]),
    seat("DMa", "DM", "T-50", ["CEO", "RSMa", "DMa"]),
    seat("DMb", "ACTING_DM", "T-60", ["CEO", "RSMa", "DMa", "DMb"]),
  ]);
  assert.deepEqual(people(managersInScope(upward, "T-50", "tree")), ["T-50"], "a manager above you stays out even when they also sit on a seat beneath you");

  // Who was on a visit.
  const onR1 = { index: org, territorySeatId: "R1", managerHrId: null, seniorHrId: null } as const;
  const people3 = (result: ReturnType<typeof resolveVisitParticipants>) => {
    const value = valueOf(result);
    return [value.repHrId, value.managerHrId, value.seniorHrId];
  };
  const CHOOSE_MANAGER = "Choose the manager who was on the visit from your territory's managers.";
  const CHOOSE_SENIOR = "Choose the senior manager who was on the visit: a manager above the one you chose.";
  assert.deepEqual(people3(resolveVisitParticipants({ ...onR1, actorHrId: "T-101", enteredAs: "rep", kind: "single" })), ["T-101", null, null]);
  assert.deepEqual(people3(resolveVisitParticipants({ ...onR1, actorHrId: "T-101", enteredAs: "rep", kind: "double", managerHrId: "t-3" })), ["T-101", "T-3", null]);
  assert.deepEqual(
    people3(resolveVisitParticipants({ ...onR1, actorHrId: "T-101", enteredAs: "rep", kind: "double", managerHrId: "T-2" })),
    ["T-101", "T-2", null],
    "any manager of the territory's chain can be the manager on a double visit",
  );
  assert.equal(refusalOf(resolveVisitParticipants({ ...onR1, actorHrId: "T-101", enteredAs: "rep", kind: "double", managerHrId: "T-999" })), CHOOSE_MANAGER);
  assert.equal(refusalOf(resolveVisitParticipants({ ...onR1, actorHrId: "T-101", enteredAs: "rep", kind: "double" })), CHOOSE_MANAGER);
  assert.equal(refusalOf(resolveVisitParticipants({ ...onR1, actorHrId: "T-104", enteredAs: "rep", territorySeatId: "R4", kind: "double", managerHrId: "T-104" })), CHOOSE_MANAGER, "nobody is their own manager on a visit");
  assert.deepEqual(people3(resolveVisitParticipants({ ...onR1, actorHrId: "T-101", enteredAs: "rep", kind: "chain", managerHrId: "T-3", seniorHrId: "T-2" })), ["T-101", "T-3", "T-2"]);
  assert.equal(refusalOf(resolveVisitParticipants({ ...onR1, actorHrId: "T-101", enteredAs: "rep", kind: "chain", managerHrId: "T-2", seniorHrId: "T-3" })), CHOOSE_SENIOR, "the senior manager sits above the manager");
  assert.equal(refusalOf(resolveVisitParticipants({ ...onR1, actorHrId: "T-101", enteredAs: "rep", kind: "chain", managerHrId: "T-3", seniorHrId: "T-3" })), CHOOSE_SENIOR);
  assert.equal(refusalOf(resolveVisitParticipants({ ...onR1, actorHrId: "T-101", enteredAs: "rep", kind: "chain", managerHrId: "T-3" })), CHOOSE_SENIOR);

  assert.deepEqual(people3(resolveVisitParticipants({ ...onR1, actorHrId: "T-3", enteredAs: "manager", kind: "single" })), [null, "T-3", null], "a manager's own single visit has no rep");
  assert.deepEqual(
    people3(resolveVisitParticipants({ ...onR1, actorHrId: "T-3", enteredAs: "manager", kind: "double", managerHrId: "T-2" })),
    ["T-101", "T-3", null],
    "a manager who enters the visit is the manager on it, whatever the phone sent",
  );
  assert.deepEqual(people3(resolveVisitParticipants({ ...onR1, actorHrId: "T-3", enteredAs: "manager", kind: "chain", seniorHrId: "T-2" })), ["T-101", "T-3", "T-2"]);
  assert.equal(refusalOf(resolveVisitParticipants({ ...onR1, actorHrId: "T-2", enteredAs: "manager", kind: "chain", seniorHrId: "T-3" })), CHOOSE_SENIOR);
  assert.equal(refusalOf(resolveVisitParticipants({ ...onR1, actorHrId: "T-104", enteredAs: "manager", kind: "single" })), "You are not a manager of this territory.", "a manager of another district cannot enter a visit here");
  assert.equal(
    refusalOf(resolveVisitParticipants({ ...onR1, actorHrId: "T-104", enteredAs: "manager", territorySeatId: "R4", kind: "single" })),
    "You are not a manager of this territory.",
    "an acting district manager is the rep of their own territory, not its manager",
  );
  assert.equal(
    refusalOf(resolveVisitParticipants({ ...onR1, actorHrId: "T-3", enteredAs: "manager", territorySeatId: "R7", kind: "double" })),
    "This territory has no rep, so the visit can only be entered as your own single visit.",
  );
  assert.deepEqual(people3(resolveVisitParticipants({ ...onR1, actorHrId: "T-3", enteredAs: "manager", territorySeatId: "R7", kind: "single" })), [null, "T-3", null]);
  assert.equal(refusalOf(resolveVisitParticipants({ ...onR1, actorHrId: "T-101", enteredAs: "rep", territorySeatId: "NOPE", kind: "single" })), "This territory is no longer in the organogram. Reload the page.");
  assert.equal(refusalOf(resolveVisitParticipants({ ...onR1, actorHrId: "  ", enteredAs: "rep", kind: "single" })), "Your HR record could not be read. Sign in again.");

  assert.equal(territoryName({ seatId: "R1", areaName: "Alex East", regionName: "Alex", lineName: "Anti Infective", seatLabel: null }), "Alex East · Anti Infective");
  assert.equal(territoryName({ seatId: "R1", areaName: null, regionName: "Delta (1)", lineName: null, seatLabel: "AB5" }), "Delta (1)");
  assert.equal(territoryName({ seatId: "R1", areaName: null, regionName: null, lineName: null, seatLabel: null }), "Territory", "a territory is never named by its seat code");
}

export function runPhoenixCrmRulesTests() {
  runDefaultsTests();
  runTimingTests();
  runPlanRuleTests();
  runCoverageTests();
  runGeoTests();
  runEntryRuleTests();
  runSuggestionTests();
  runReportRuleTests();
  runScopeTests();
}
