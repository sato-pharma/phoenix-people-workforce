import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { mapAttendanceRowToPrivateCalendarItem, type PrivateCalendarItem } from "../src/lib/private-calendar/logic.ts";
import {
  buildDayPlanActual,
  DAY_PLAN_ACTUAL_NOTHING_RECORDED,
  planActivityOf,
  samePersonName,
  type DayPlanActualRow,
} from "../src/lib/private-calendar/plan-actual.ts";
import {
  mapManagerHalfDayToPrivateCalendarItem,
  mapPlanRowToPrivateCalendarItem,
  planActivityTypeOf,
  planHalfOfTimes,
} from "../src/lib/private-calendar/plan-items.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * One person's day in the private calendar is ONE Plan | Actual table (owner, 2026-10-29, on Ahmed Sharaf's October:
 * "put in a table, put each point beside the point"). Before, 28 Oct read two APPROVED PLAN cards "With Hassan
 * Mohamed" beside a double visit with Hassan Mohamed, and 27 Oct an attendance card beside two Office plan cards, and
 * the reader paired them by eye.
 *
 *   1. each planned half-day is one row with what was recorded for it and a ✓ or ✗, read from STRUCTURED fields — the
 *      plan's `planActivity`, the visit tile — never a title;
 *   2. a plan that names who to go with matches only a visit made with that person;
 *   3. what was recorded that no plan asked for gets its own "Not on the plan" row, never a ✗;
 *   4. both plan sources (the weekly plan and a manager's Phoenix CRM week) carry `planActivity`;
 *   5. the table fits its box (table-fixed + colgroup, cards when narrow), square, plain ink, and replaces the plan
 *      cards in the one-person view only.
 */

const DATE = "2026-10-28";

function halfDayRow(overrides: Record<string, unknown> = {}) {
  return {
    activityLabel: null,
    activityType: null,
    areaName: "Maadi",
    customerCount: 6,
    date: DATE,
    decidedByHrId: "B-10",
    firstApproverHrId: null,
    half: "AM",
    isTest: false,
    kind: "with_rep",
    legacyType: "Field",
    managerHrId: "B-155",
    managerSeatId: null,
    note: null,
    plannerKind: "district_manager",
    planId: "plan-1",
    repHrId: "B-301",
    repSeatId: "seat-301",
    seniorHrId: null,
    slotId: "slot-am",
    status: "approved",
    weekStart: "2026-10-25",
    ...overrides,
  } as unknown as Parameters<typeof mapManagerHalfDayToPrivateCalendarItem>[0];
}

function withRepHalf(half: "AM" | "PM", rep = "Hassan Mohamed"): PrivateCalendarItem {
  return mapManagerHalfDayToPrivateCalendarItem(halfDayRow({ half, slotId: `slot-${half}` }), { approver: "Anwar Gaweesh", rep });
}

function weeklyPlanItem(activityType: string, start: string | null, end: string | null, extra: Record<string, string | null> = {}): PrivateCalendarItem {
  return mapPlanRowToPrivateCalendarItem(
    { employee_hr_id: "B-155", employee_name: "Ahmed Sharaf", manager_name: "Anwar Gaweesh", period_key: "2026-W44", status: "hr_acknowledged" },
    {
      activity_date: DATE,
      activity_title: activityType,
      activity_type: activityType,
      area: null,
      double_visit_medical_rep_name: null,
      end_time: end,
      id: `item-${activityType}-${start ?? "day"}`,
      location_text: null,
      notes: null,
      objective: null,
      start_time: start,
      ...extra,
    },
  );
}

function doubleVisit(withName: string, counts: { am: number; pm: number; pharmacies: number }, id = "double-visit-b155-2026-10-28"): PrivateCalendarItem {
  return {
    activityKind: "double_regular",
    approvalImpact: null,
    chipLines: [],
    description: null,
    detailLines: [],
    employeeDepartmentName: null,
    employeeHrId: "B-155",
    employeeJobTitle: null,
    employeeLineName: null,
    employeeName: "Ahmed Sharaf",
    endDate: DATE,
    exceptionFlags: [],
    id,
    managerName: null,
    severity: "success",
    source: "double_visit",
    sourceLabel: "Double visits",
    sourceRecordId: null,
    sourceSystem: "Double Visit Analytics",
    sourceTable: null,
    startDate: DATE,
    status: "performed",
    tileWith: [withName],
    time: null,
    title: "Double visit",
    visitCounts: counts,
  };
}

function attendance(firstPunch: string, lastPunch: string, status = "Present"): PrivateCalendarItem {
  return mapAttendanceRowToPrivateCalendarItem({
    actualFirstPunch: firstPunch,
    actualLastPunch: lastPunch,
    dateIso: DATE,
    deductionDays: "0",
    earlyLeaveMinutes: "",
    employeeHrId: "B-155",
    employeeName: "Ahmed Sharaf",
    lateMinutes: "",
    recommendedAction: "",
    scheduledEnd: "5:00 PM",
    scheduledStart: "9:00 AM",
    status,
    timeLong: "",
  });
}

function recorded(activityKind: PrivateCalendarItem["activityKind"], chipLines: string[], id: string): PrivateCalendarItem {
  return { ...doubleVisit("nobody", { am: 0, pm: 0, pharmacies: 0 }, id), activityKind, chipLines, tileWith: undefined, title: chipLines[0] ?? id, visitCounts: undefined };
}

const view = (rows: DayPlanActualRow[]) => rows.map((row) => `${row.half} | ${row.plan?.label ?? "—"} | ${row.actual.join(" + ")} | ${row.match}${row.note ? ` (${row.note})` : ""}`);

export function runPrivateCalendarPlanActualTests(): void {
  // ── 4 · Both plan sources carry the structured activity ──────────────────────────────────────────────────────────
  assert.equal(planActivityTypeOf("Field"), "visit");
  assert.equal(planActivityTypeOf("Double Visit"), "visit");
  assert.equal(planActivityTypeOf(" office "), "office");
  for (const leave of ["Vacation", "Excuse", "National Vacation"]) assert.equal(planActivityTypeOf(leave), "leave", leave);
  assert.equal(planActivityTypeOf("Travel"), "travel");
  assert.equal(planActivityTypeOf("Training"), "other", "a training is proven by a CRM activity, a correction or a punch");
  assert.equal(planActivityTypeOf(null), "other");

  assert.equal(planHalfOfTimes("09:00:00", "13:00:00"), "AM", "a morning that ends at one o'clock is the AM half");
  assert.equal(planHalfOfTimes("13:00", "17:00"), "PM");
  assert.equal(planHalfOfTimes("14:00", null), "PM");
  assert.equal(planHalfOfTimes("09:00", "17:00"), "Full day");
  assert.equal(planHalfOfTimes(null, null), "Full day", "a plan with no times is the whole day");

  const am = withRepHalf("AM");
  assert.deepEqual(am.planActivity, {
    half: "AM",
    label: "With Hassan Mohamed",
    place: null,
    signedOffBy: "Anwar Gaweesh",
    type: "visit",
    withName: "Hassan Mohamed",
  }, "a manager's half-day with a rep is a visit, with that rep, in its own half");
  const admin = mapManagerHalfDayToPrivateCalendarItem(halfDayRow({ activityLabel: "Training", kind: "admin", legacyType: "Training", repHrId: null }), { approver: "Anwar Gaweesh", rep: null });
  assert.equal(admin.planActivity?.type, "other");
  assert.equal(admin.planActivity?.withName, null, "an Admin half-day names nobody to go with");

  const weekly = weeklyPlanItem("Double Visit", "09:00", "13:00", { area: "Nasr City", double_visit_medical_rep_name: "Hana Abdelaziz" });
  assert.equal(weekly.planActivity?.type, "visit");
  assert.equal(weekly.planActivity?.half, "AM");
  assert.equal(weekly.planActivity?.withName, "Hana Abdelaziz", "the weekly plan's double-visit rep is the one to go with");
  assert.equal(weekly.planActivity?.place, "Nasr City");
  assert.equal(weekly.planActivity?.signedOffBy, "Anwar Gaweesh");

  const legacy = { ...weeklyPlanItem("Meeting", null, null), planActivity: undefined };
  assert.deepEqual(planActivityOf(legacy), { half: "Full day", label: "Meeting", place: null, signedOffBy: null, type: "other", withName: null }, "an item built before the field existed reads as a whole-day other");

  // ── 2 · The same person under two spellings ──────────────────────────────────────────────────────────────────────
  assert.equal(samePersonName("Hana Abdelaziz", "Hana Abdelaziz Samir Abdelaziz"), true, "Phoenix's short name and the visit mirror's full name are one person");
  assert.equal(samePersonName("hana  abdelaziz", "Hana Abdelaziz"), true);
  assert.equal(samePersonName("Hana Mohamed", "Hana Abdelaziz"), false);
  assert.equal(samePersonName("Abdelaziz", "Hana Abdelaziz"), false, "a surname alone is not the start of the name");
  assert.equal(samePersonName("", "Hana Abdelaziz"), false);

  // ── 1 · 28 Oct: AM and PM "With Hassan Mohamed" against a double visit with him, AM 1 · PM 6 ─────────────────────
  const oct28 = buildDayPlanActual([withRepHalf("AM"), withRepHalf("PM")], [doubleVisit("Hassan Mohamed Ali", { am: 1, pm: 6, pharmacies: 0 })]);
  assert.deepEqual(view(oct28), [
    "AM | With Hassan Mohamed | Double visit with Hassan Mohamed Ali · AM 1 | match",
    "PM | With Hassan Mohamed | Double visit with Hassan Mohamed Ali · PM 6 · PH 0 | match",
  ], "each planned half sits beside its share of the visit, ✓, and the visit is not repeated as an unplanned row");

  // A visit with somebody else is a ✗ that says who it was not with — and still shows what was done.
  const otherRep = buildDayPlanActual([withRepHalf("AM")], [doubleVisit("Mina Farouk", { am: 2, pm: 0, pharmacies: 0 })]);
  assert.deepEqual(view(otherRep), ["AM | With Hassan Mohamed | Double visit with Mina Farouk · AM 2 | miss (Not with Hassan Mohamed)"]);

  // A planned AM, then six PM visits the plan never reached: the PM share is its own "Not on the plan" row.
  const amOnly = buildDayPlanActual([withRepHalf("AM")], [doubleVisit("Hassan Mohamed", { am: 1, pm: 6, pharmacies: 0 })]);
  assert.deepEqual(view(amOnly), [
    "AM | With Hassan Mohamed | Double visit with Hassan Mohamed · AM 1 | match",
    "PM | — | Double visit with Hassan Mohamed · PM 6 · PH 0 | unplanned",
  ]);

  // A planned visit half with no visit in it is a ✗ "Nothing recorded".
  const noVisit = buildDayPlanActual([withRepHalf("PM")], [doubleVisit("Hassan Mohamed", { am: 3, pm: 0, pharmacies: 0 })]);
  assert.deepEqual(view(noVisit), [
    "Full day | — | Double visit with Hassan Mohamed · AM 3 · PM 0 · PH 0 | unplanned",
    `PM | With Hassan Mohamed |  | miss (${DAY_PLAN_ACTUAL_NOTHING_RECORDED})`,
  ], "a visit entry no plan reached is shown whole, first; the planned PM with nothing in it is a ✗");

  // ── 27 Oct: AM and PM Office against the attendance ─────────────────────────────────────────────────────────────
  const officeAm = weeklyPlanItem("Office", "09:00", "13:00");
  const officePm = weeklyPlanItem("Office", "13:00", "17:00");
  const punched = attendance("9:03 AM", "5:04 PM");
  const oct27 = buildDayPlanActual([officeAm, officePm], [punched]);
  assert.equal(oct27.length, 2, "both Office halves claim the one attendance entry, so it is not repeated as unplanned");
  for (const row of oct27) {
    assert.equal(row.match, "match", `${row.half} Office is ✓ against an office punch`);
    assert.match(row.actual[0] ?? "", /^Office · .+ · 9:03 AM – 5:04 PM$/, "the Actual cell says the attendance in the tile's own words");
  }
  const noPunch = buildDayPlanActual([officeAm], [attendance("", "", "Absent")]);
  assert.equal(noPunch[0]?.match, "miss");
  assert.equal(noPunch[0]?.note, "No office punch", "an attendance row without a punch does not prove an Office half");

  // ── The other kinds, each by its own record ─────────────────────────────────────────────────────────────────────
  const leave = buildDayPlanActual([weeklyPlanItem("Vacation", null, null)], [recorded("vacation", ["Annual leave"], "vac-1")]);
  assert.deepEqual(view(leave), ["Full day | Vacation | Annual leave | match"]);
  const travel = buildDayPlanActual([weeklyPlanItem("Travel", null, null)], []);
  assert.deepEqual(view(travel), [`Full day | Travel |  | miss (${DAY_PLAN_ACTUAL_NOTHING_RECORDED})`]);
  const trip = buildDayPlanActual([weeklyPlanItem("Travel", null, null)], [recorded("outstation", ["Trip to Sohag"], "trip-1")]);
  assert.equal(trip[0]?.match, "match", "a Travel plan is proven by an outstation trip");
  const training = buildDayPlanActual([weeklyPlanItem("Training", null, null)], [punched]);
  assert.equal(training[0]?.match, "match", "a training held in the building leaves an office punch and nothing else");
  const correction = buildDayPlanActual([weeklyPlanItem("Training", null, null)], [recorded("correction", ["Physical Training", "✓ Verified"], "corr-1"), punched]);
  assert.equal(view(correction)[0], "Full day | Training | Physical Training · ✓ Verified | match", "a verified correction proves a Training");
  assert.equal(correction.length, 2);
  assert.equal(correction[1]?.match, "unplanned", "the punch beside it is not claimed by the Training as well");
  assert.match(correction[1]?.actual[0] ?? "", /^Office · /);

  // ── 3 · Unplanned rows, and the order: Full day, AM, PM; planned first inside a half ───────────────────────────
  const mixed = buildDayPlanActual(
    [withRepHalf("PM"), withRepHalf("AM")],
    [doubleVisit("Hassan Mohamed", { am: 1, pm: 2, pharmacies: 1 }), recorded("excuse", ["Excuse · AM"], "exc-1"), punched],
  );
  assert.deepEqual(mixed.map((row) => `${row.half}:${row.match}`), ["Full day:unplanned", "Full day:unplanned", "AM:match", "PM:match"]);
  assert.ok(mixed.filter((row) => row.match === "unplanned").every((row) => row.plan === null && row.note === null), "Not on the plan is neutral, never a ✗ with a reason");
  assert.equal(buildDayPlanActual([withRepHalf("AM")], [withRepHalf("PM")]).length, 1, "a plan entry is never an actual");

  // ── 5 · The table: fits its box, square, plain ink; one-person view only ────────────────────────────────────────
  const table = stripComments(readFileSync(new URL("../src/components/employee-portal/private-calendar-plan-actual.tsx", import.meta.url), "utf8"));
  assert.match(table, /data-testid="private-calendar-plan-actual"/);
  assert.match(table, /<table className="w-full table-fixed/, "the table is fixed to its box");
  assert.match(table, /<colgroup>/, "and gives its columns their widths");
  assert.match(table, /@container/, "it switches to cards on its OWN width, so it never scrolls sideways in a narrow panel");
  assert.doesNotMatch(table, /overflow-x-auto|min-w-\[/, "never a horizontal scroll");
  assert.doesNotMatch(table, /\brounded/, "square edges");
  assert.doesNotMatch(table, /\bshadow/, "no hand-rolled shadow: a card takes the portal's own depth token, as every card on the page does");
  const markBlock = table.slice(table.indexOf("const MARK_CLASS"), table.indexOf("function markText"));
  assert.ok(markBlock.length > 0, "the marks keep their own class map");
  assert.doesNotMatch(markBlock, /\bbg-/, "✓ and ✗ are plain ink, never a filled badge");
  assert.match(table, /"✓ As planned"/);

  const page = stripComments(readFileSync(new URL("../src/components/employee-portal/private-calendar.tsx", import.meta.url), "utf8"));
  assert.match(page, /<DayPlanActualTable rows=\{dayPlanActualRows\} \/>/, "the one-person day panel draws the table");
  assert.match(page, /if \(viewMode === "team"\) return \[\];/, "the team view keeps its plan cards: one table would pair one person's plan with another's record");
  assert.match(
    page,
    /dayPlanActualRows\.length > 0 \? timelineItems\.filter\(isRecordedEntry\) : timelineItems/,
    "once the table holds the plan, the plan's own cards are not drawn under it as well",
  );
}
