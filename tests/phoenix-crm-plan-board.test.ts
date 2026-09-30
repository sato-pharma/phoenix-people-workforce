import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { addDaysIso } from "../src/lib/crm/dates.ts";
import {
  fieldWeeksOfMonth,
  monthlyPlanDueOn,
  plannableMonths,
  plannableWeeks,
  weekdayOfIsoDay,
  weeklyPlanDueOn,
  weekNumberInMonth,
} from "../src/lib/phoenix-crm/calendar.ts";
import {
  buildDayCopyPlacements,
  buildMonthCopyPlacements,
  buildWeekCopyPlacements,
  dayCopySources,
  type CopySourcePlacement,
  type CopyWeek,
} from "../src/lib/phoenix-crm/plan-copy.ts";
import {
  buildWeekSavePayload,
  copyWeekOf,
  discardWeekDraft,
  draftFits,
  firstWeekToPlan,
  holdSettled,
  indexCustomers,
  isWeekDirty,
  markWeekSaved,
  matchesSavedWeek,
  placeCustomer,
  PLANNED_ACTIVITY_NOTE_MAX,
  rebaseDraft,
  sameWeekdayIn,
  sameWeekNumberIn,
  savedWeekActivities,
  savedWeekItems,
  setCustomerReason,
  setPlannedActivity,
  startDraft,
  summarizeCopy,
  takeOffCustomer,
  weekFixes,
  weekProblems,
  weekScope,
  weekToPlanMove,
  dayFullness,
  type DraftDay,
  type DraftWeek,
  type WeekDraft,
} from "../src/lib/phoenix-crm/plan-week-draft.ts";
import type { PlannerCustomer } from "../src/lib/phoenix-crm/suggestions.ts";
import type { PhoenixCrmListType, PhoenixCrmTiming } from "../src/lib/phoenix-crm/types.ts";

/**
 * Phoenix CRM — the plan board (owner, 2026-09-29): the month on top as Week 1..N, a week's days, a
 * day's customers ticked by brick with its other activity on top, and three copies.
 *
 * What this pins, and why each one exists:
 *
 *   (a) THE HORIZON. A month is due the last Thursday of the month before, and until 2026-09-29 only
 *       the next three weeks could be saved — so on October's due date (24 September) only two of
 *       October's five weeks were plannable and "Copy last month" failed on the rest. Every month of
 *       2026–2028 must be wholly plannable ON its own due date.
 *   (b) A week sent on its own is due the Thursday before it — two days before its Saturday.
 *   (c) "Week 1, Week 2…" is the field-week's place in the month its Saturday falls in.
 *   (d) The copies: Week N / weekday onto Week N / weekday (never "every Saturday"), weekday onto
 *       weekday, and a day from one or two weeks back; each keeps the caps, the editable days and the
 *       customers already placed.
 *   (e) The week's draft: what a save sends (the full activity list of the editable days, a customer
 *       who left the list left out, a moved place sent at his place for the day) and when the page
 *       holds unsaved changes.
 *   (f) The screens: nothing approves or sends on its own, and the three retired screens stay gone.
 *   (g) "Discard changes" puts every state of a draft back to what was last saved — it may never take
 *       the unsaved bar away while a tick stays on the day — and a week held through a save whose answer
 *       was lost drops that hold once the reload shows the save landed.
 */

const CAPS = { amDailyCap: 5, pmDailyCap: 15 };

function timing(weekday: number, startMinute: number, endMinute: number | null = null): PhoenixCrmTiming {
  return { weekday, startMinute, endMinute, season: "normal" };
}

function customer(
  customerId: string,
  listType: PhoenixCrmListType,
  places: Array<{ placeId: string; timings: PhoenixCrmTiming[]; brick?: string | null }>,
  pending = false,
): PlannerCustomer {
  return {
    customerId,
    name: customerId,
    listType,
    grade: null,
    speciality: null,
    visitsThisMonth: 0,
    pending,
    places: places.map((place) => ({
      placeId: place.placeId,
      label: null,
      address: null,
      lat: 0,
      lon: 0,
      brick: place.brick ?? null,
      zone: null,
      timings: place.timings,
    })),
  };
}

const EVERY_FIELD_DAY = [6, 0, 1, 2, 3, 4];

/** A customer who receives on every field day, in the morning. */
function everyDay(customerId: string, listType: PhoenixCrmListType): PlannerCustomer {
  return customer(customerId, listType, [{ placeId: `${customerId}-place`, timings: EVERY_FIELD_DAY.map((weekday) => timing(weekday, 600, 720)) }]);
}

function copyDay(date: string, listTypes: PhoenixCrmListType[], editable: boolean, items: Array<{ customerId: string; listType: PhoenixCrmListType }> = []) {
  return { date, listTypes, editable, items };
}

function copyWeek(weekStart: string, editable = true): CopyWeek {
  return {
    weekStart,
    days: [0, 1, 2, 3, 4, 5].map((offset) => {
      const date = addDaysIso(weekStart, offset);
      return copyDay(date, offset === 5 ? ["AM"] : ["AM", "PM"], editable);
    }),
  };
}

function draftDay(date: string, editable: boolean, items: DraftDay["items"] = [], activity: DraftDay["activity"] = null): DraftDay {
  return { date, listTypes: weekdayOfIsoDay(date) === 4 ? ["AM"] : ["AM", "PM"], ramadan: false, editable, activity, items };
}

function monthStartsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [year, month] = from.split("-").map(Number);
  const [toYear, toMonth] = to.split("-").map(Number);
  while (year < toYear || (year === toYear && month <= toMonth)) {
    out.push(`${year}-${String(month).padStart(2, "0")}-01`);
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

export function runPhoenixCrmPlanBoardTests(): void {
  // ── (a) Every month is wholly plannable on its own due date ─────────────────────────────────────
  {
    const months = monthStartsBetween("2026-01", "2028-12");
    assert.equal(months.length, 36, "the walk covers every month of 2026, 2027 and 2028");
    for (const monthStart of months) {
      const due = monthlyPlanDueOn(monthStart);
      const plannable = new Set(plannableWeeks(due));
      for (const week of fieldWeeksOfMonth(monthStart)) {
        assert.ok(
          plannable.has(week),
          `${monthStart.slice(0, 7)} is due ${due}, and on that day its week of ${week} must already be plannable — or the rep cannot plan the month he is asked for`,
        );
      }
      assert.ok(plannableMonths(due).includes(monthStart), `${monthStart.slice(0, 7)} is offered as a month on its own due date`);
    }
    // The clash this fixes, by name: October 2026 was due Thursday 24 September.
    assert.equal(monthlyPlanDueOn("2026-10-01"), "2026-09-24");
    assert.deepEqual(
      plannableWeeks("2026-09-24").filter((week) => week >= "2026-10-01"),
      ["2026-10-03", "2026-10-10", "2026-10-17", "2026-10-24", "2026-10-31"],
      "on 24 September all five of October's weeks can be saved",
    );
  }

  // ── (b) A week alone is due the Thursday before it ──────────────────────────────────────────────
  {
    for (let saturday = "2026-01-03"; saturday <= "2028-12-30"; saturday = addDaysIso(saturday, 7)) {
      const due = weeklyPlanDueOn(saturday);
      assert.equal(due, addDaysIso(saturday, -2), `the week of ${saturday} is due two days before its Saturday`);
      assert.equal(weekdayOfIsoDay(due), 4, `the week of ${saturday} is due on a Thursday`);
    }
    assert.equal(weeklyPlanDueOn("2026-10-10"), "2026-10-08");
  }

  // ── (c) Week N of the month its Saturday falls in ───────────────────────────────────────────────
  {
    assert.equal(weekNumberInMonth("2026-10-03"), 1, "3 October 2026 is October's first Saturday");
    assert.equal(weekNumberInMonth("2026-10-31"), 5, "31 October is its fifth, though its week runs into November");
    assert.equal(weekNumberInMonth("2026-09-26"), 4, "26 September is September's fourth — its Thursday is 1 October");
    assert.equal(weekNumberInMonth("2026-09-05"), 1);
    assert.equal(weekNumberInMonth("2027-01-02"), 1, "2 January 2027 starts January's first week");
  }

  // ── (d) The copies ──────────────────────────────────────────────────────────────────────────────
  {
    const customers = [everyDay("pm-a", "PM"), everyDay("pm-b", "PM"), everyDay("am-a", "AM")];
    const october = fieldWeeksOfMonth("2026-10-01").map((week) => copyWeek(week));

    // Copy last month: pm-a was planned ONCE, on September's Week 2 Saturday (12 September).
    const month = buildMonthCopyPlacements(
      [
        { planDate: "2026-09-12", customerId: "pm-a" },
        { planDate: "2026-09-07", customerId: "am-a" }, // Week 1 Monday
      ],
      customers,
      october,
      CAPS,
    );
    const placedMonth = [...month.values()].flat().map((item) => `${item.planDate}|${item.customerId}`).sort();
    assert.deepEqual(
      placedMonth,
      ["2026-10-05|am-a", "2026-10-10|pm-a"],
      "Week 2's Saturday lands on Week 2's Saturday only — never on every Saturday — and Week 1's Monday on Week 1's Monday",
    );
    assert.equal(month.has("2026-10-31"), false, "October's fifth week has no September Week 5 to copy, and nothing is invented for it");

    // Copy last week: each day onto the same weekday.
    const week = buildWeekCopyPlacements(
      [
        { planDate: "2026-09-27", customerId: "pm-a" }, // Sunday
        { planDate: "2026-10-01", customerId: "am-a" }, // Thursday
      ],
      customers,
      copyWeek("2026-10-03"),
      CAPS,
    );
    assert.deepEqual(
      week.map((item) => `${item.planDate}|${item.customerId}`),
      ["2026-10-04|pm-a", "2026-10-08|am-a"],
      "Sunday onto Sunday, Thursday onto Thursday",
    );

    // Copy a day: the cap, the editable day, the customers already on it, and the day's list types.
    const fourAm = ["am-1", "am-2", "am-3", "am-4"].map((customerId) => ({ customerId, listType: "AM" as PhoenixCrmListType }));
    const withAm = [...customers, everyDay("am-5", "AM"), everyDay("am-6", "AM")];
    assert.deepEqual(
      buildDayCopyPlacements(["am-5", "am-6", "pm-a"], withAm, copyDay("2026-10-10", ["AM", "PM"], true, fourAm), CAPS).map((item) => item.customerId),
      ["am-5", "pm-a"],
      "a day holding 4 AM of 5 takes one more AM, and the PM beside it",
    );
    assert.deepEqual(buildDayCopyPlacements(["pm-a"], customers, copyDay("2026-10-03", ["AM", "PM"], false), CAPS), [], "a day that has passed takes nothing");
    assert.deepEqual(
      buildDayCopyPlacements(["pm-a"], customers, copyDay("2026-10-10", ["AM", "PM"], true, [{ customerId: "pm-a", listType: "PM" }]), CAPS),
      [],
      "a customer already on the day is never doubled",
    );
    assert.deepEqual(
      buildDayCopyPlacements(["pm-a", "am-a"], customers, copyDay("2026-10-08", ["AM"], true), CAPS).map((item) => item.customerId),
      ["am-a"],
      "a Thursday morning takes AM only",
    );
    assert.deepEqual(dayCopySources("2026-10-10"), ["2026-10-03", "2026-09-26"], "a day copies from the same weekday one and two weeks back");
    assert.deepEqual(dayCopySources("2026-11-05"), ["2026-10-29", "2026-10-22"]);
  }

  // ── (e) The week's draft ────────────────────────────────────────────────────────────────────────
  {
    // Week of Saturday 3 October 2026, seen on Sunday the 4th: Saturday has passed.
    const pmSat = customer("pm-sat", "PM", [{ placeId: "p-sat", timings: [timing(6, 1080, 1200), timing(1, 1080, 1200)], brick: "D14" }]);
    const pmOff = customer("pm-off", "PM", [{ placeId: "p-off", timings: [timing(2, 1080, 1200)] }]);
    const twoPlaces = customer("two-places", "PM", [
      { placeId: "tp-a", timings: [timing(0, 1080, 1200)] },
      { placeId: "tp-b", timings: [timing(6, 1080, 1200)] },
    ]);
    const pending = customer("pending", "PM", [], true);
    const ams = ["am-1", "am-2", "am-3", "am-4", "am-5", "am-6"].map((id) => everyDay(id, "AM"));
    const customers = [pmSat, pmOff, twoPlaces, pending, ...ams];
    const byId = indexCustomers(customers);

    const item = (customerId: string, placeId: string | null, listType: PhoenixCrmListType = "PM") => ({
      customerId,
      placeId,
      listType,
      name: customerId,
      exceptionType: null,
      exceptionNote: null,
    });
    const week: DraftWeek = {
      weekStart: "2026-10-03",
      plan: { planId: "plan-1", version: 3 },
      days: [
        draftDay("2026-10-03", false, [item("pm-sat", "p-sat")], { activityType: "meeting", halfDay: false, note: null }),
        draftDay("2026-10-04", true, [item("two-places", "tp-removed")]),
        draftDay("2026-10-05", true, [item("pm-sat", "p-sat")]),
        draftDay("2026-10-06", true, [item("left-the-list", "p-left")]),
        draftDay("2026-10-07", true, [], { activityType: "training", halfDay: true, note: "  bring the slides  " }),
        draftDay("2026-10-08", true),
      ],
    };
    const scope = weekScope("seat-1", true, week.weekStart);

    assert.deepEqual(
      savedWeekItems(week).map((entry) => entry.planDate),
      ["2026-10-04", "2026-10-05", "2026-10-06"],
      "a draft starts from the days that can still change — the passed Saturday is left as saved",
    );
    assert.deepEqual(savedWeekActivities(week).map((entry) => entry.planDate), ["2026-10-07"], "and so do its activities");
    assert.equal(weekFixes(week, savedWeekItems(week), byId), 2, "one customer left the list and one planned place is no longer his");

    const untouched = buildWeekSavePayload({ seatId: "seat-1", test: true, week, draft: null, customers });
    assert.equal(untouched.expectedVersion, 3, "the save goes over the version on screen");
    assert.deepEqual(
      untouched.items.map((entry) => `${entry.planDate}|${entry.customerId}|${entry.placeId}`),
      ["2026-10-04|two-places|tp-a", "2026-10-05|pm-sat|p-sat"],
      "the customer who left the list comes off, and the moved one is sent at his place that receives on the day",
    );
    assert.deepEqual(
      untouched.activities,
      [{ planDate: "2026-10-07", activityType: "training", halfDay: true, note: "bring the slides" }],
      "the activities of the editable days go with every save, trimmed — never the passed day's",
    );

    let draft = startDraft(scope, week);
    assert.equal(draftFits(draft, scope, week), true);
    assert.equal(isWeekDirty(draft, week), false, "a draft nobody changed is not unsaved work");

    const ticked = placeCustomer(draft.items, { planDate: "2026-10-06", customerId: "pm-off", placeId: "p-off", exceptionType: null, exceptionNote: null });
    assert.equal(isWeekDirty({ ...draft, items: ticked }, week), true, "a tick is a change");
    assert.equal(
      isWeekDirty({ ...draft, items: takeOffCustomer(ticked, "2026-10-06", "pm-off") }, week),
      false,
      "and unticking it again leaves nothing to save",
    );
    assert.equal(isWeekDirty({ ...draft, items: [...draft.items].reverse() }, week), false, "the order the ticks were made in is not a change");

    // The activity rides on the same draft: one a day, and taking one off is a change too.
    const withSalesDay = setPlannedActivity(draft.activities, "2026-10-04", { activityType: "sales_day", halfDay: false, note: null });
    draft = { ...draft, activities: withSalesDay };
    assert.equal(isWeekDirty(draft, week), true, "planning an activity is unsaved work");
    const both = buildWeekSavePayload({ seatId: "seat-1", test: true, week, draft, customers });
    assert.deepEqual(
      both.activities.map((entry) => `${entry.planDate}|${entry.activityType}`),
      ["2026-10-04|sales_day", "2026-10-07|training"],
      "the FULL activity list of the editable days is sent, in day order",
    );
    const onPassedDay = { ...draft, activities: setPlannedActivity(draft.activities, "2026-10-03", { activityType: "travel", halfDay: false, note: null }) };
    assert.equal(
      buildWeekSavePayload({ seatId: "seat-1", test: true, week, draft: onPassedDay, customers }).activities.some((entry) => entry.planDate === "2026-10-03"),
      false,
      "a day that has passed keeps what was saved — the save never sends an activity for it",
    );
    const withoutTraining = { ...draft, activities: setPlannedActivity(draft.activities, "2026-10-07", null) };
    assert.deepEqual(
      buildWeekSavePayload({ seatId: "seat-1", test: true, week, draft: withoutTraining, customers }).activities.map((entry) => entry.planDate),
      ["2026-10-04"],
      "an activity taken off is simply missing from the full list — that is how the save removes it",
    );
    assert.equal(
      setPlannedActivity(draft.activities, "2026-10-04", { activityType: "meeting", halfDay: true, note: null }).filter((entry) => entry.planDate === "2026-10-04").length,
      1,
      "a day holds one activity: a new one replaces it",
    );

    // What the server would refuse, named before the save leaves the page — and a day his saved hours
    // do not cover is NOT one of them (owner, 2026-09-30: "never block, because the rep didn't add his time").
    const offDay = placeCustomer(draft.items, { planDate: "2026-10-04", customerId: "pm-sat", placeId: "p-sat", exceptionType: null, exceptionNote: null });
    assert.deepEqual(weekProblems(week, offDay, byId, CAPS), [], "a customer on a day his hours do not cover is placed and asks nothing");
    const otherNoNote = setCustomerReason(offDay, "2026-10-04", "pm-sat", "other", "  ");
    assert.deepEqual(weekProblems(week, otherNoNote, byId, CAPS), [], "an Other with no note blocks nothing either");
    const withReason = setCustomerReason(offDay, "2026-10-04", "pm-sat", "by_appointment", null);
    const sentWithReason = buildWeekSavePayload({ seatId: "seat-1", test: true, week, draft: { ...draft, items: withReason }, customers });
    assert.equal(
      sentWithReason.items.find((entry) => entry.planDate === "2026-10-04" && entry.customerId === "pm-sat")?.exceptionType,
      "by_appointment",
      "a reason an older draft still carries goes with the save",
    );
    const staleReason = setCustomerReason(draft.items, "2026-10-05", "pm-sat", "other", "old note");
    assert.equal(
      buildWeekSavePayload({ seatId: "seat-1", test: true, week, draft: { ...draft, items: staleReason }, customers }).items.find(
        (entry) => entry.planDate === "2026-10-05",
      )?.exceptionType,
      null,
      "a customer who receives that day carries no reason",
    );
    const thursdayPm = placeCustomer(draft.items, { planDate: "2026-10-08", customerId: "pm-off", placeId: "p-off", exceptionType: "other", exceptionNote: "x" });
    assert.equal(weekProblems(week, thursdayPm, byId, CAPS)[0]?.kind, "morning", "a Thursday is a morning for AM only");
    let sixAm = draft.items;
    for (const am of ams) sixAm = placeCustomer(sixAm, { planDate: "2026-10-07", customerId: am.customerId, placeId: am.places[0].placeId, exceptionType: null, exceptionNote: null });
    assert.deepEqual(
      weekProblems(week, sixAm, byId, CAPS).map((problem) => (problem.kind === "cap" ? `${problem.listType}:${problem.count}/${problem.cap}` : problem.kind)),
      ["AM:6/5"],
      "a sixth AM on a day holding five is refused before it is sent",
    );
    const pendingPlaced = placeCustomer(draft.items, { planDate: "2026-10-05", customerId: "pending", placeId: null, exceptionType: null, exceptionNote: null });
    assert.deepEqual(weekProblems(week, pendingPlaced, byId, CAPS), [], "a customer not validated yet is planned with no place");

    // A save stands the draft over the version it made; a version it does not know sets it aside.
    const saved = markWeekSaved(scope, week, { planId: "plan-1", version: 4 }, both.items, both.activities);
    const reloaded: DraftWeek = { ...week, plan: { planId: "plan-1", version: 4 } };
    assert.equal(draftFits(saved, scope, week), true, "before the reload lands, the draft still stands over the version on screen");
    assert.equal(draftFits(saved, scope, reloaded), true, "and after it, over the version its own save made");
    assert.equal(isWeekDirty(saved, reloaded), false, "a saved draft holds nothing unsaved");
    const elsewhere: DraftWeek = { ...week, plan: { planId: "plan-1", version: 5 } };
    assert.equal(draftFits(saved, scope, elsewhere), false, "a week saved on another screen is a version the draft does not know");
    const kept = rebaseDraft(saved, elsewhere);
    assert.equal(draftFits(kept, scope, elsewhere), true, "keeping the ticks stands them over the newer version");
    assert.equal(
      buildWeekSavePayload({ seatId: "seat-1", test: true, week: elsewhere, draft: kept, customers }).expectedVersion,
      5,
      "and the next save goes over it",
    );
    assert.equal(draftFits(saved, weekScope("seat-2", true, week.weekStart), reloaded), false, "a draft never crosses territories");

    // The copies read the draft, and place a customer on his day whatever hours are saved for it — a
    // time the rep did not enter never keeps him off (owner, 2026-09-30).
    const target = sameWeekdayIn(week);
    const source: CopySourcePlacement[] = [
      { planDate: "2026-09-27", customerId: "pm-sat" }, // Sunday: pm-sat has no Sunday hours saved
      { planDate: "2026-09-28", customerId: "pm-off" }, // Monday: pm-off has Tuesday hours only
      { planDate: "2026-09-29", customerId: "pm-off" }, // Tuesday: he receives
      { planDate: "2026-09-29", customerId: "gone-now" }, // no longer on the list
    ];
    const COPIED_EXPECTED = ["2026-10-04|pm-sat", "2026-10-05|pm-off", "2026-10-06|pm-off"];
    const targetWeek = copyWeekOf(week, draft.items, byId);
    const placed = buildWeekCopyPlacements(source, customers, targetWeek, CAPS);
    assert.deepEqual(
      placed.map((entry) => `${entry.planDate}|${entry.customerId}`).sort(),
      COPIED_EXPECTED,
      "everyone still on the list lands on his weekday, hours or not",
    );
    const onDay = new Map(targetWeek.days.map((entry) => [entry.date, new Set(entry.items.map((row) => row.customerId))]));
    assert.deepEqual(
      summarizeCopy({ source, targetDayOf: target, byId, alreadyOn: (date) => onDay.get(date) ?? new Set<string>(), placed }),
      { placed: COPIED_EXPECTED.length, full: 0, noPlace: 0, notOnList: 1 },
      "a copy reports what it placed and why the rest could not be — never 'not receiving'",
    );
    const monthTarget = sameWeekNumberIn([week]);
    assert.equal(monthTarget({ planDate: "2026-09-07", customerId: "pm-sat" })?.date, "2026-10-05", "September Week 1 Monday lands on October Week 1 Monday");
    assert.equal(monthTarget({ planDate: "2026-09-14", customerId: "pm-sat" }), null, "Week 2 lands nowhere when Week 2 is not a target");

    // Which week "+ Make weekly plan" opens.
    assert.equal(
      firstWeekToPlan([
        { weekStart: "a", open: false, status: null },
        { weekStart: "b", open: true, status: "submitted" },
        { weekStart: "c", open: true, status: "returned" },
      ])?.weekStart,
      "c",
      "the first week still open and not sent — a returned week is waiting to be sent again",
    );
    assert.equal(
      firstWeekToPlan([
        { weekStart: "a", open: false, status: null },
        { weekStart: "b", open: true, status: "approved" },
      ])?.weekStart,
      "b",
      "else the first open week",
    );

    // Found on the walk of 2026-09-30: on 30 September every September week was past or sent, and the
    // button opened the sent Week 4 instead of the week of 3 October. It moves on to the next month.
    const lateSeptember = [
      { weekStart: "2026-09-05", open: false, status: null },
      { weekStart: "2026-09-26", open: true, status: "submitted" },
    ];
    const months = [{ monthStart: "2026-09-01" }, { monthStart: "2026-10-01" }];
    assert.deepEqual(
      weekToPlanMove({ weeks: lateSeptember, monthStart: "2026-09-01", months, mayChangeMonth: true }),
      { kind: "month", monthStart: "2026-10-01" },
      "a month with no week left to plan hands over to the next month",
    );
    assert.deepEqual(
      weekToPlanMove({ weeks: lateSeptember, monthStart: "2026-09-01", months, mayChangeMonth: false }),
      { kind: "week", week: lateSeptember[1] },
      "unsaved ticks here, or a move already made: never switch month again, open the first open week",
    );
    assert.deepEqual(
      weekToPlanMove({ weeks: [{ weekStart: "2026-10-03", open: true, status: null }], monthStart: "2026-10-01", months, mayChangeMonth: false }),
      { kind: "week", week: { weekStart: "2026-10-03", open: true, status: null } },
      "in the next month it opens the first week still to plan",
    );
    assert.deepEqual(
      weekToPlanMove({ weeks: lateSeptember, monthStart: "2026-10-01", months, mayChangeMonth: true }),
      { kind: "week", week: lateSeptember[1] },
      "no later month to go to: the first open week here",
    );
    const board = readFileSync("src/components/phoenix-crm/plan-board.tsx", "utf8");
    assert.match(
      board,
      /mayChangeMonth: weekSearch\.movedTo === null && !anyDirty/,
      "the board moves month only once, and never over unsaved ticks",
    );

    // The note limit is the table's own.
    const server = readFileSync("src/lib/phoenix-crm/server/plan-activities.ts", "utf8");
    assert.match(server, new RegExp(`export const PLAN_ACTIVITY_NOTE_MAX = ${PLANNED_ACTIVITY_NOTE_MAX};`), "the draft's note limit is the server's");
  }

  // ── (f) The screens ─────────────────────────────────────────────────────────────────────────────
  {
    for (const retired of ["plan-tab.tsx", "month-screen.tsx", "plan-history-reference.tsx"]) {
      assert.equal(existsSync(`src/components/phoenix-crm/${retired}`), false, `${retired} was replaced by the plan board and stays deleted`);
    }

    const board = stripComments(readFileSync("src/components/phoenix-crm/plan-board.tsx", "utf8"));
    const decision = stripComments(readFileSync("src/components/phoenix-crm/plan-decision.tsx", "utf8"));
    const screens = ["plan-board.tsx", "plan-week-panel.tsx", "plan-day-panel.tsx", "plan-decision.tsx", "plan-copy-menu.tsx"].map((name) => ({
      name,
      source: stripComments(readFileSync(`src/components/phoenix-crm/${name}`, "utf8")),
    }));

    // Nothing posts from an effect: every send, take-back and decision is a press of a button.
    for (const { name, source } of screens) {
      let from = source.indexOf("useEffect(");
      while (from >= 0) {
        const end = source.indexOf("}, [", from);
        const body = source.slice(from, end < 0 ? source.length : end);
        assert.doesNotMatch(body, /crmPost|\/api\/|decide|onSend|onDecide/, `${name} must never send, approve or return a plan from an effect`);
        from = source.indexOf("useEffect(", from + 1);
      }
    }

    // The board never names an approval itself: the action arrives from the Approve button.
    assert.doesNotMatch(board, /["'`]approve["'`]/, "plan-board.tsx never names an approval — only the decision block's own button does");
    assert.equal((board.match(/"\/api\/phoenix-crm\/plans\/decide"/g) ?? []).length, 1, "one place posts a week's decision");
    assert.equal((board.match(/"\/api\/phoenix-crm\/monthly-plans\/reviews"/g) ?? []).length, 1, "one place posts the month's decision");
    assert.equal((board.match(/\bdecideWeek\(/g) ?? []).length, 2, "decideWeek is declared, and called from one place");
    assert.match(board, /onDecide=\{\(action, note\) => decideWeek\(selected, action, note\)\}/, "that one place is the week's decision block");
    assert.equal((board.match(/\bdecideMonth\b/g) ?? []).length, 2, "decideMonth is declared, and handed to one decision block");
    assert.match(board, /onDecide=\{decideMonth\}/);
    assert.match(decision, /onClick=\{\(\) => void decide\("approve"\)\}/, "Approve is a button press");
    assert.match(decision, /if \(action === "return" && !trimmed\)/, "and a return needs a note before it is sent");

    // A late plan is accepted and stamped — the board shows the stamp and never gates a send on the date.
    assert.match(board, /Sent late/);
    assert.doesNotMatch(board, /overdue\s*\?\s*null|disabled=\{[^}]*overdue/, "being late never hides or disables Send");

    // AM and PM apart, never added together, on the month's meters and call rate.
    assert.doesNotMatch(board, /callRate\.(amPerDay|amPlacements)\s*\+\s*view\.callRate\./, "the call rate is never summed across AM and PM");
    for (const label of ['label="AM covered"', 'label="PM covered"', 'label="AM per day"', 'label="PM per day"']) {
      assert.ok(board.includes(label), `the month shows ${label}`);
    }
  }

  // ── A FULL LIST GOES EMERALD, AND TICKING NUMBERS THE ROW (owner, 2026-09-30) ────────────────────
  // "when the AM is full or PM or full day with light green highlight" — his first wording was answered
  // with flat washes and he refused them ("what you did is awful"), then asked for it "artistic with
  // magic touches". So it is the module's own vocabulary: the square meter fills orange and turns
  // EMERALD at the cap, a full list's figure goes emerald where it stands, and a day whose every list
  // is full lights a 3px emerald rail with the colour blooming off it. Never a flat fill, never a word
  // on a row, and never a refusal — a full list simply has no room left to tick.
  {
    const caps = { amDailyCap: 5, pmDailyCap: 15 };

    // A list is full at its cap, and past it — a copy can legitimately overfill a day.
    assert.deepEqual(dayFullness({ AM: 5, PM: 15 }, caps, ["AM", "PM"]), { AM: true, PM: true, day: true });
    assert.deepEqual(dayFullness({ AM: 6, PM: 15 }, caps, ["AM", "PM"]), { AM: true, PM: true, day: true });
    assert.deepEqual(dayFullness({ AM: 4, PM: 15 }, caps, ["AM", "PM"]), { AM: false, PM: true, day: false });
    assert.deepEqual(dayFullness({ AM: 5, PM: 14 }, caps, ["AM", "PM"]), { AM: true, PM: false, day: false });
    assert.deepEqual(dayFullness({ AM: 0, PM: 0 }, caps, ["AM", "PM"]), { AM: false, PM: false, day: false });

    // A Thursday holds AM only, so a full AM fills the DAY — the rail must light on the day he
    // actually finished, not only on a day that happens to carry both lists.
    assert.deepEqual(dayFullness({ AM: 5, PM: 0 }, caps, ["AM"]), { AM: true, PM: false, day: true });
    assert.deepEqual(dayFullness({ AM: 4, PM: 99 }, caps, ["AM"]), { AM: false, PM: false, day: false });

    // A day that holds no list at all is not "full" — it is closed, and green would read as finished.
    assert.deepEqual(dayFullness({ AM: 0, PM: 0 }, caps, []), { AM: false, PM: false, day: false });
    // A cap of zero is not a cap met: nothing can be ticked there, so it never reads as done.
    assert.deepEqual(dayFullness({ AM: 0, PM: 0 }, { amDailyCap: 0, pmDailyCap: 0 }, ["AM", "PM"]), { AM: false, PM: false, day: false });

    const ui = stripComments(readFileSync("src/components/phoenix-crm/ui.tsx", "utf8"));
    const week = stripComments(readFileSync("src/components/phoenix-crm/plan-week-panel.tsx", "utf8"));
    const day = stripComments(readFileSync("src/components/phoenix-crm/plan-day-panel.tsx", "utf8"));

    // The meter: orange as it fills, emerald at the cap, square like everything else.
    assert.match(ui, /full \? "bg-emerald-600" : "bg-orange-500"/, "the meter turns emerald only at the cap");
    assert.match(ui, /className="h-1\.5 min-w-0 border border-slate-200 bg-slate-100"/, "a 1.5 rule, square-edged");
    assert.match(ui, /role="progressbar"/, "and it is a progressbar to a screen reader");

    // The day button: an emerald rail with the colour fading off it, never a flat wash — and the
    // orange of the day he is standing on still wins.
    assert.match(ui, /option\.tone === "good" &&/);
    assert.match(ui, /border-l-\[3px\] border-l-emerald-500/, "a 3px rail");
    assert.match(ui, /selected \? "bg-orange-50" : "bg-gradient-to-r from-emerald-50 via-emerald-50\/40 to-white"/, "a gradient off the rail, and orange still wins where he stands");
    assert.doesNotMatch(ui, /tone === "good"[\s\S]{0,200}?bg-emerald-50"/, "never a flat emerald fill");

    assert.match(week, /tone: full\.day \? \("good" as const\) : undefined,/, "a full day lights its button");
    assert.match(week, /full\[listType\] \? "font-black text-emerald-700" : undefined/, "and the full list's own figure goes emerald");
    assert.match(day, /full\.day \? "border-l-emerald-500 bg-gradient-to-r from-emerald-50 via-emerald-50\/30 to-transparent" : "border-l-orange-500"/, "the open day's rail too");
    assert.ok(day.includes("<CrmFillBar"), "each list carries its meter");

    // Nothing says "full" in words on a row — he had that removed the same day.
    assert.doesNotMatch(day, /Day full|List full/, 'no "Day full" word anywhere');
    // And a full list is never refused: fullness is colour only, never a disable or an error.
    assert.doesNotMatch(day, /full\.(AM|PM|day)[^\n]*\?\?[^\n]*disabled|disabled=\{full\./, "a full list is coloured, never disabled");

    // ── The tick numbers: "1 am 1 pm 2 pm 3 pm" (his own words) ──
    // Each list counted on its own, in the order he ticked, so the day reads as a sequence. AM and PM
    // are counted APART here as everywhere — the chip says which list the number belongs to.
    assert.match(day, /const seen: Record<PhoenixCrmListType, number> = \{ AM: 0, PM: 0 \};/, "one counter per list, never one shared");
    assert.match(day, /seen\[row\.listType\] \+= 1;/);
    assert.match(day, /order\.set\(row\.customerId, seen\[row\.listType\]\);/);
    assert.match(day, /const onTheDay = drafted\.filter\(\(row\) => !row\.gone\);/, "a row taken off the day is not numbered, so the rest renumber with no gap");
    assert.match(day, /position: placed \? \(order\.get\(customer\.customerId\) \?\? null\) : null,/, "and an unticked row carries no number at all");
    assert.match(day, /\{position\} \{listType\}/, 'the chip reads "3 PM", never a bare number');
    const chipAt = day.indexOf("function OrderChip(");
    assert.ok(chipAt >= 0, "the chip is one component");
    const chip = day.slice(chipAt, day.indexOf("\n}", chipAt));
    assert.match(chip, /if \(position === null\) return null;/, "nothing is drawn before he ticks");
    assert.ok(chip.includes("shrink-0"), "the chip never squeezes the name into a wrap");
    // Both the phone card and the desktop row carry it — one surface with numbers and one without
    // would read as two different days.
    assert.equal(
      (day.match(/<OrderChip listType=\{row\.listType\} position=\{row\.position\} \/>/g) ?? []).length,
      2,
      "the phone card and the desktop row both number the tick",
    );
  }

  // ── (g) Discard, and a hold that answers itself ─────────────────────────────────────────────────
  {
    // Found on the owner's walk of 2026-09-30, on the week of Saturday 26 September seen on Wednesday
    // the 30th: "Discard changes" took the unsaved bar away and left the ticked customer on the screen,
    // reading "AM · 2 of 5 placed". Nothing had reached the database, so the rep was left looking at a
    // plan he had just discarded — and his next Save would have written it.
    //
    // The invariant, over EVERY state a draft can be in: a discard may never clear the unsaved flag
    // while a tick stays on the day. `dirty === false` with a tick still placed IS the defect, so both
    // halves are asserted together on each one.
    const customers = [everyDay("am-1", "AM"), everyDay("am-2", "AM"), everyDay("pm-1", "PM")];
    const byId = indexCustomers(customers);
    const saved = (customerId: string, listType: PhoenixCrmListType) => ({
      customerId,
      placeId: `${customerId}-place`,
      listType,
      name: customerId,
      exceptionType: null,
      exceptionNote: null,
    });
    const WEDNESDAY = "2026-09-30";
    const THURSDAY = "2026-10-01";
    const ON_THE_WEDNESDAY = [saved("am-1", "AM"), saved("pm-1", "PM")];

    /** The week as the board holds it: 1 AM and 1 PM saved on the Wednesday, at `version`. */
    function weekAt(version: number, onWednesday = ON_THE_WEDNESDAY): DraftWeek {
      return {
        weekStart: "2026-09-26",
        plan: { planId: "plan-1", version },
        days: [draftDay("2026-09-26", false), draftDay("2026-09-29", false), draftDay(WEDNESDAY, true, onWednesday), draftDay(THURSDAY, true)],
      };
    }
    const scope = weekScope("SEAT-AIF-REP-D13", true, "2026-09-26");
    const tick = (planDate: string, customerId: string) => ({
      planDate,
      customerId,
      placeId: `${customerId}-place`,
      exceptionType: null,
      exceptionNote: null,
    });

    /** plan-board.tsx's own `states` entry for one editable week. */
    function boardState(week: DraftWeek, draft: WeekDraft | null, held: "changed" | "unchecked" | null) {
      const fits = draftFits(draft, scope, week);
      const heldOver = !fits && draft !== null && held !== null && !matchesSavedWeek(draft, week);
      const shown = fits || heldOver ? draft : null;
      const dirty = heldOver || (fits && isWeekDirty(shown, week));
      return { items: shown ? shown.items : savedWeekItems(week), dirty, hold: heldOver ? "changed" : dirty && held === "unchecked" ? "unchecked" : null };
    }
    const amPlacedOn = (items: ReadonlyArray<{ planDate: string; customerId: string }>, date: string) =>
      items
        .filter((entry) => entry.planDate === date && byId.get(entry.customerId)?.listType === "AM")
        .map((entry) => entry.customerId)
        .sort();

    // The seven states a week's draft can be in when "Discard changes" is pressed. `back` is what the
    // Wednesday's AM list must read afterwards — always the last save, never the discarded tick.
    const loaded = weekAt(5);
    const fresh = { ...startDraft(scope, loaded), items: placeCustomer(startDraft(scope, loaded).items, tick(WEDNESDAY, "am-2")) };
    const landedWeek = weekAt(6, [...ON_THE_WEDNESDAY, saved("am-2", "AM")]);
    const afterSave = markWeekSaved(scope, loaded, { planId: "plan-1", version: 6 }, fresh.items, fresh.activities);
    const cases = [
      { name: "a fresh draft, nothing saved this session", week: loaded, draft: fresh, back: ["am-1"] },
      {
        name: "saved as version 6, then ticked again on the Thursday",
        week: landedWeek,
        draft: { ...afterSave, items: placeCustomer(afterSave.items, tick(THURSDAY, "am-2")) },
        back: ["am-1", "am-2"],
      },
      { name: "held through a save that could not be confirmed and did not land", week: loaded, draft: fresh, back: ["am-1"] },
      { name: "held through a version conflict, the week now at version 7", week: weekAt(7), draft: fresh, back: ["am-1"] },
      { name: '"Keep mine" rebased onto version 7', week: weekAt(7), draft: rebaseDraft(fresh, weekAt(7)), back: ["am-1"] },
      { name: "saved as version 6, then version 7 arrived from another screen", week: weekAt(7), draft: afterSave, back: ["am-1"] },
      { name: "saved as version 6, the reload not back yet", week: loaded, draft: afterSave, back: ["am-1", "am-2"] },
    ];

    for (const entry of cases) {
      const after = boardState(entry.week, discardWeekDraft(entry.draft, entry.week), null);
      assert.deepEqual(
        amPlacedOn(after.items, WEDNESDAY),
        entry.back,
        `discarding ${entry.name} must put the Wednesday's AM list back to the last save — a tick left on the day is a plan the rep discarded and would save again`,
      );
      assert.equal(
        after.dirty,
        false,
        `discarding ${entry.name} must leave nothing unsaved: an unsaved bar that goes while the tick stays is exactly how the defect looked`,
      );
    }

    // The reported repro, before the press: the tick is on the day and the bar is up.
    const beforeDiscard = boardState(loaded, fresh, null);
    assert.deepEqual(amPlacedOn(beforeDiscard.items, WEDNESDAY), ["am-1", "am-2"], "the tick is on the day, so the heading reads 2 AM placed");
    assert.equal(beforeDiscard.dirty, true, "and the unsaved bar is up");

    // ── A hold that answered itself ───────────────────────────────────────────────────────────────
    // A save whose answer was lost keeps the ticks and reloads the week. When the reload says exactly
    // what the draft says, that save LANDED: nothing is asked of the rep, and nothing may be kept. The
    // draft stands over version 5, which no longer exists, so keeping it turns his NEXT tick into "this
    // week changed since you started" — raised against his own save — and `readyToSave` then refuses.
    assert.equal(holdSettled(fresh, landedWeek, true), true, "the week now says what the draft says: the save that could not be confirmed did land");
    assert.equal(holdSettled(fresh, loaded, true), false, "while the week still reads version 5 the save did not land, and the ticks stay held");
    assert.equal(holdSettled(fresh, landedWeek, false), false, "a week that was never held has nothing to settle");

    const settledNow = boardState(landedWeek, fresh, "unchecked");
    assert.deepEqual(amPlacedOn(settledNow.items, WEDNESDAY), ["am-1", "am-2"], "the landed save is on the screen");
    assert.equal(settledNow.dirty, false, "with nothing unsaved and no banner — which is why nothing else will ever drop that hold");

    // One more tick, the way `change()` takes it: over the stale draft the hold kept alive, then over the
    // week on screen once the settled hold is dropped.
    const stale = { ...fresh, items: placeCustomer(fresh.items, tick(THURSDAY, "pm-1")) };
    assert.equal(
      boardState(landedWeek, stale, "unchecked").hold,
      "changed",
      "kept alive, the stale draft makes one ordinary tick read as a week changed elsewhere — what dropping the settled hold prevents",
    );
    const cleared = { ...startDraft(scope, landedWeek), items: placeCustomer(startDraft(scope, landedWeek).items, tick(THURSDAY, "pm-1")) };
    const afterClear = boardState(landedWeek, cleared, null);
    assert.equal(afterClear.hold, null, "once the settled hold is dropped, the same tick is an ordinary unsaved change");
    assert.equal(afterClear.dirty, true, "and it is offered for saving rather than refused");

    // The board reverts through the one tested function, and drops a hold that settled by itself.
    const source = stripComments(readFileSync("src/components/phoenix-crm/plan-board.tsx", "utf8"));
    assert.match(source, /const back = discardWeekDraft\(draft, state\.week\);/, "discardAll reverts through discardWeekDraft, never its own copy of the algebra");
    assert.doesNotMatch(source, /items: draft\.saved\.items/, "and keeps no inline copy that a test would not reach");
    assert.match(source, /settled: holdSettled\(raw, week, flag !== null\)/, "every week says whether its hold has answered itself");
    assert.match(source, /states\.filter\(\(state\) => state\.settled\)/, "and the board drops the draft and the hold of each one that has");
  }

  console.log("phoenix-crm plan board: OK");
}
