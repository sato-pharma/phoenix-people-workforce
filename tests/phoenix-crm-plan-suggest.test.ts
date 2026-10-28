import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  daySuggestBlock,
  monthPlacements,
  suggestDay,
  suggestWeek,
  suggestionCaps,
  weekSuggestBlock,
  type SuggestInput,
  type SuggestResult,
} from "../src/lib/phoenix-crm/plan-suggest.ts";
import type { DraftDay, DraftWeek } from "../src/lib/phoenix-crm/plan-week-draft.ts";
import type { PlanItemDraft } from "../src/lib/phoenix-crm/plan-rules.ts";
import type { PlannerCustomer } from "../src/lib/phoenix-crm/suggestions.ts";
import type { PhoenixCrmGrade, PhoenixCrmDoctorListType, PhoenixCrmTiming } from "../src/lib/phoenix-crm/types.ts";

/**
 * Phoenix CRM — "Suggest this day" and "Suggest the week" on the plan board (owner, 2026-09-30:
 * "the best-appearing and easiest CRM, yet controlled").
 *
 * What this pins, and why each one exists:
 *
 *   (a) Only customers who RECEIVE on that weekday are placed first — a suggestion never asks a reason,
 *       so a validated customer who is off that day is left for the rep, exactly as a copy leaves him —
 *       and on a Ramadan day their Ramadan hours decide it when the place has them.
 *   (b) Customers with no days and hours yet (not validated) only fill the room that is LEFT.
 *   (c) Below-target customers beat on-target ones, furthest below first — and one already at his grade
 *       is never suggested at all: over the grade is a deviation (coverage.ts), never a bonus.
 *   (d) One brick is filled before the next: the day's own brick, then the brick with the most
 *       candidates, so the day is one area.
 *   (e) AM and PM have their own caps, never one shared number; a Thursday takes AM only; a half-day
 *       activity leaves half the room and a whole-day one leaves none.
 *   (f) Nobody is placed twice on a day.
 *   (g) The week never repeats a customer beyond his need, and spreads him over the weeks left.
 *   (h) A day or week that cannot be changed gets nothing.
 *   (i) The screens: both buttons exist, and both go through the board's one way into the draft — the
 *       same `onCopied` → `addCopies` the three copies use — so nothing is saved or sent by a suggestion.
 */

const CAPS = { amDailyCap: 5, pmDailyCap: 15 };
const TARGETS = { PM: { A: 3, B: 2, C: 1 }, AM: { A: 1, B: null, C: null } } as const;
const WEEK_START = "2026-10-10"; // Saturday
const SAT = "2026-10-10";
const SUN = "2026-10-11";
const MON = "2026-10-12";
const THU = "2026-10-15";
const FIELD_DAYS = [6, 0, 1, 2, 3, 4];

function timing(weekday: number, startMinute = 1080, season: "normal" | "ramadan" = "normal"): PhoenixCrmTiming {
  return { weekday, startMinute, endMinute: startMinute + 120, season };
}

function customer(
  customerId: string,
  listType: PhoenixCrmDoctorListType,
  options: {
    grade?: PhoenixCrmGrade | null;
    brick?: string | null;
    weekdays?: number[];
    ramadanWeekdays?: number[];
    pending?: boolean;
    places?: Array<{ placeId: string; brick: string | null; weekdays: number[] }>;
  } = {},
): PlannerCustomer {
  const places = options.pending
    ? []
    : (options.places ?? [
        {
          placeId: `${customerId}-place`,
          brick: options.brick === undefined ? "D1" : options.brick,
          weekdays: options.weekdays ?? FIELD_DAYS,
        },
      ]).map((place, index) => ({
        placeId: place.placeId,
        label: null,
        address: null,
        lat: 0,
        lon: 0,
        brick: place.brick,
        zone: null,
        timings: [
          ...place.weekdays.map((weekday) => timing(weekday)),
          ...(index === 0 ? (options.ramadanWeekdays ?? []).map((weekday) => timing(weekday, 1200, "ramadan")) : []),
        ],
      }));
  return {
    customerId,
    name: customerId,
    listType,
    grade: options.grade === undefined ? "C" : options.grade,
    speciality: null,
    visitsThisMonth: 0,
    pending: options.pending ?? false,
    places,
  };
}

function day(date: string, editable = true, options: { ramadan?: boolean } = {}): DraftDay {
  const thursday = date === THU;
  return {
    date,
    listTypes: thursday ? ["AM"] : ["AM", "PM"],
    ramadan: options.ramadan ?? false,
    editable,
    activities: [],
    starts: { startAmMinute: null, startPmMinute: null },
    items: [],
  };
}

function week(options: { passed?: string[]; ramadan?: boolean; saved?: Record<string, string[]> } = {}): DraftWeek {
  const dates = [0, 1, 2, 3, 4, 5].map((offset) => `2026-10-${String(10 + offset).padStart(2, "0")}`);
  return {
    weekStart: WEEK_START,
    plan: null,
    days: dates.map((date) => {
      const built = day(date, !(options.passed ?? []).includes(date), { ramadan: options.ramadan });
      const saved = options.saved?.[date] ?? [];
      return {
        ...built,
        items: saved.map((customerId) => ({ customerId, placeId: `${customerId}-place`, listType: "PM" as const, name: customerId, exceptionType: null, exceptionNote: null })),
      };
    }),
  };
}

function placed(date: string, customerId: string, placeId: string | null = `${customerId}-place`): PlanItemDraft {
  return { planDate: date, customerId, placeId, exceptionType: null, exceptionNote: null };
}

function input(customers: PlannerCustomer[], overrides: Partial<SuggestInput> = {}): SuggestInput {
  return {
    week: week(),
    items: [],
    activities: [],
    customers,
    caps: CAPS,
    gradeTargets: TARGETS as unknown as SuggestInput["gradeTargets"],
    placedThisMonth: new Map(),
    weeksLeft: 1,
    ...overrides,
  };
}

function ids(result: SuggestResult): string[] {
  return result.placements.map((placement) => placement.customerId);
}

function countOf(result: SuggestResult, customerId: string): number {
  return result.placements.filter((placement) => placement.customerId === customerId).length;
}

export function runPhoenixCrmPlanSuggestTests(): void {
  // ── (a) Who receives that weekday ───────────────────────────────────────────────────────────────
  {
    const customers = [customer("pm-mon", "PM", { weekdays: [1] }), customer("pm-sat", "PM", { weekdays: [6] })];
    const saturday = suggestDay({ ...input(customers), date: SAT });
    assert.deepEqual(ids(saturday), ["pm-sat"], "only the customer who receives on Saturday goes on Saturday — the one who receives on Monday is left off it");
    assert.deepEqual(
      saturday.placements[0],
      placed(SAT, "pm-sat"),
      "at the place that receives that day, and with no reason — a suggestion never asks one",
    );
    assert.deepEqual(ids(suggestDay({ ...input(customers), date: MON })), ["pm-mon"], "and on Monday it is the other way round");

    // Two places: the one that receives on the day is the one he is planned at.
    const twoPlaces = customer("two", "PM", {
      places: [
        { placeId: "two-sun", brick: "D1", weekdays: [0] },
        { placeId: "two-sat", brick: "D2", weekdays: [6] },
      ],
    });
    assert.equal(suggestDay({ ...input([twoPlaces]), date: SAT }).placements[0]?.placeId, "two-sat", "a customer with two places is planned at the one that receives that day");

    // Ramadan: his Ramadan hours decide it when the place has them, else his usual hours.
    const ramadanWeek = week({ ramadan: true });
    const ramadan = suggestDay({
      ...input(
        [
          customer("ramadan-mon-only", "PM", { weekdays: [6], ramadanWeekdays: [1] }),
          customer("usual-hours-only", "PM", { weekdays: [6] }),
          customer("ramadan-sat", "PM", { weekdays: [0], ramadanWeekdays: [6] }),
        ],
        { week: ramadanWeek },
      ),
      date: SAT,
    });
    assert.deepEqual(
      ids(ramadan).sort(),
      ["ramadan-sat", "usual-hours-only"],
      "on a Ramadan Saturday: a place with Ramadan hours is read by them (Monday only, so not today), and a place without them by its usual hours",
    );
  }

  // ── (b) No days and hours yet: only the room that is left ───────────────────────────────────────
  {
    // r1 and r2 have no brick either, so they sit in the same "No brick" group as the customer not
    // validated yet — it is the no-hours rule, not the brick order, that keeps him last.
    const customers = [customer("a-not-validated", "PM", { pending: true, grade: "A" }), customer("r1", "PM", { brick: null }), customer("r2", "PM", { brick: null })];
    const tight = suggestDay({ ...input(customers, { caps: { amDailyCap: 5, pmDailyCap: 2 } }), date: SAT });
    assert.deepEqual(ids(tight), ["r1", "r2"], "with room for two, the two who receive that day take it — the customer with no days and hours yet waits");
    assert.equal(tight.summary.noHours, 0);
    const roomy = suggestDay({ ...input(customers, { caps: { amDailyCap: 5, pmDailyCap: 3 } }), date: SAT });
    assert.deepEqual(ids(roomy), ["r1", "r2", "a-not-validated"], "with room left over, he fills it — after everyone the day is known to suit, whatever his name sorts as");
    assert.equal(roomy.placements[2]?.placeId, null, "planned with no place, as a customer not validated yet always is");
    assert.equal(roomy.summary.noHours, 1, "and the notice says how many have no days and hours yet");

    // A customer already on the week and still owed a visit is known to receive that day: he beats one
    // with no days and hours at all.
    const repeat = customer("z-repeat", "PM", { grade: "A" });
    assert.deepEqual(
      ids(
        suggestDay({
          ...input([customer("a-not-validated", "PM", { pending: true }), repeat], {
            caps: { amDailyCap: 5, pmDailyCap: 1 },
            items: [placed(SUN, "z-repeat")],
            placedThisMonth: new Map([["z-repeat", 1]]),
          }),
          date: SAT,
        }),
      ),
      ["z-repeat"],
      "the last place goes to a customer the day is known to suit, even one already on the week, before one with no days and hours",
    );

    // A validated customer whose place has no days and hours at all would need a reason: left for the rep.
    const noHours = customer("validated-no-hours", "PM", { weekdays: [] });
    assert.deepEqual(ids(suggestDay({ ...input([noHours]), date: SAT })), [], "a validated customer who does not receive that day is never suggested — it would need a reason");
  }

  // ── (c) Below the grade beats at the grade, furthest below first ────────────────────────────────
  {
    const atGrade = customer("at-grade-b", "PM", { grade: "B" });
    const behind = customer("behind-c", "PM", { grade: "C" });
    const monthSoFar = new Map([["at-grade-b", 2]]);
    assert.deepEqual(
      ids(suggestDay({ ...input([atGrade, behind], { caps: { amDailyCap: 5, pmDailyCap: 1 }, placedThisMonth: monthSoFar }), date: SAT })),
      ["behind-c"],
      "the one still owed a visit this month takes the last place, not the one already at his grade",
    );
    assert.deepEqual(
      ids(suggestDay({ ...input([atGrade, behind], { placedThisMonth: monthSoFar }), date: SAT })),
      ["behind-c"],
      "and with room to spare, the one at his grade is still never suggested — over the grade is a deviation, the rep's own choice",
    );

    const gradeA = customer("z-grade-a", "PM", { grade: "A" }); // owed 3
    const gradeC = customer("a-grade-c", "PM", { grade: "C" }); // owed 1
    assert.deepEqual(
      ids(suggestDay({ ...input([gradeA, gradeC], { caps: { amDailyCap: 5, pmDailyCap: 1 } }), date: SAT })),
      ["z-grade-a"],
      "the customer FURTHEST below his grade goes first, whatever his name",
    );
    const gradeANearlyDone = customer("a-nearly-done", "PM", { grade: "A" }); // 2 of 3: owed 1
    const gradeB = customer("z-grade-b", "PM", { grade: "B" }); // owed 2
    assert.deepEqual(
      ids(suggestDay({ ...input([gradeANearlyDone, gradeB], { caps: { amDailyCap: 5, pmDailyCap: 1 }, placedThisMonth: new Map([["a-nearly-done", 2]]) }), date: SAT })),
      ["z-grade-b"],
      "it is the visits still OWED that rank, not the grade letter",
    );
  }

  // ── (d) One brick before the next ───────────────────────────────────────────────────────────────
  {
    const small = ["a1", "a2", "a3"].map((id) => customer(id, "PM", { brick: "Dokki" }));
    const big = ["b1", "b2", "b3", "b4", "b5"].map((id) => customer(id, "PM", { brick: "Haram" }));
    const six = suggestDay({ ...input([...small, ...big], { caps: { amDailyCap: 5, pmDailyCap: 6 } }), date: SAT });
    assert.deepEqual(
      ids(six),
      ["b1", "b2", "b3", "b4", "b5", "a1"],
      "the brick with the most candidates is filled first, whole, before the next brick — even though its names sort later",
    );
    assert.equal(six.summary.bricks, 2, "the notice counts the bricks the day now spans");
    const five = suggestDay({ ...input([...small, ...big], { caps: { amDailyCap: 5, pmDailyCap: 5 } }), date: SAT });
    assert.equal(five.summary.bricks, 1, "room for exactly one brick keeps the day in ONE area");

    // He already started the day in Dokki: the day stays there first.
    const started = suggestDay({
      ...input([...small, ...big], { caps: { amDailyCap: 5, pmDailyCap: 3 }, items: [placed(SAT, "a1")] }),
      date: SAT,
    });
    assert.deepEqual(ids(started), ["a2", "a3"], "the brick already on the day is finished first — the rep began the day there");
  }

  // ── (e) AM and PM caps, apart ───────────────────────────────────────────────────────────────────
  {
    const ams = Array.from({ length: 7 }, (_, index) => customer(`am-${index}`, "AM", { grade: "A" }));
    const pms = Array.from({ length: 20 }, (_, index) => customer(`pm-${String(index).padStart(2, "0")}`, "PM"));
    const full = suggestDay({ ...input([...ams, ...pms]), date: SAT });
    assert.deepEqual([full.summary.am, full.summary.pm], [5, 15], "AM up to its cap of 5 and PM up to its cap of 15 — each on its own");

    const fourAm = ["am-0", "am-1", "am-2", "am-3"].map((id) => placed(SAT, id));
    const topUp = suggestDay({ ...input([...ams, ...pms], { items: fourAm }), date: SAT });
    assert.deepEqual([topUp.summary.am, topUp.summary.pm], [1, 15], "a day holding 4 AM takes ONE more AM, and its PM room is untouched by it");

    const thursday = suggestDay({ ...input([...ams, ...pms]), date: THU });
    assert.deepEqual([thursday.summary.am, thursday.summary.pm], [5, 0], "Thursday is a morning: AM only");

    const halfDay = suggestDay({ ...input([...ams, ...pms], { activities: [{ planDate: SAT, halfDay: true }] }), date: SAT });
    assert.deepEqual([halfDay.summary.am, halfDay.summary.pm], [2, 7], "a half-day activity leaves half of each list's room");
    const wholeDay = suggestDay({ ...input([...ams, ...pms], { activities: [{ planDate: SAT, halfDay: false }] }), date: SAT });
    assert.deepEqual([ids(wholeDay), wholeDay.summary.why], [[], "activity"], "a whole-day activity leaves no room for visits");
  }

  // ── (e2) A suggestion fills a day to the rep's TARGET, never past the cap (browser walk, 2026-09-30) ──
  {
    const ams = Array.from({ length: 7 }, (_, index) => customer(`am-${index}`, "AM", { grade: "A" }));
    const pms = Array.from({ length: 20 }, (_, index) => customer(`pm-${String(index).padStart(2, "0")}`, "PM"));
    const TARGET = { am: 2, pm: 10 };
    const day = suggestDay({ ...input([...ams, ...pms], { dayTargets: TARGET }), date: SAT });
    assert.deepEqual(
      [day.summary.am, day.summary.pm],
      [2, 10],
      "2 AM and 10 PM — the day's call-rate targets, apart — not the 5 / 15 a day may hold at most",
    );
    const withTwo = suggestDay({ ...input([...ams, ...pms], { dayTargets: TARGET, items: [placed(SAT, "am-0"), placed(SAT, "am-1")] }), date: SAT });
    assert.deepEqual([withTwo.summary.am, withTwo.summary.pm], [0, 10], "a day already holding its 2 AM takes no more AM, and its PM room is its own");
    assert.equal(
      daySuggestBlock({ day: week().days[0], items: [placed(SAT, "am-0"), placed(SAT, "am-1"), ...pms.slice(0, 10).map((pm) => placed(SAT, pm.customerId))], activity: null, customers: [...ams, ...pms], caps: CAPS, dayTargets: TARGET }),
      "full",
      "a day at its target has nothing left to suggest",
    );
    const spread = suggestWeek({ ...input(ams, { dayTargets: TARGET }) });
    assert.equal(spread.summary.days, 4, "seven AM customers owed once each spread 2 · 2 · 2 · 1 over the week, not 5 · 2");
    assert.deepEqual(suggestionCaps(CAPS, { am: 9, pm: 40 }), CAPS, "a target above the cap never lifts the cap");
    assert.deepEqual(suggestionCaps(CAPS, { am: 0, pm: 0 }), CAPS, "no target set: the cap");
    assert.deepEqual(suggestionCaps(CAPS, undefined), CAPS, "no target given: the cap");
  }

  // ── (f) Nobody twice on a day ───────────────────────────────────────────────────────────────────
  {
    const customers = ["x", "y", "z"].map((id) => customer(id, "PM", { grade: "A" }));
    const result = suggestDay({ ...input(customers, { items: [placed(SAT, "x")] }), date: SAT });
    assert.equal(ids(result).includes("x"), false, "a customer already on the day is never placed on it again");
    const keys = result.placements.map((placement) => `${placement.planDate}|${placement.customerId}`);
    assert.equal(new Set(keys).size, keys.length, "and nobody appears twice in one day's suggestion");
  }

  // ── (g) The week: never beyond the need, spread over the weeks left ─────────────────────────────
  {
    const gradeA = customer("grade-a", "PM", { grade: "A" }); // 3 a month
    const gradeC = customer("grade-c", "PM", { grade: "C" }); // 1 a month
    const amNoNumber = customer("am-grade-b", "AM", { grade: "B" }); // AM B has no number: once
    const customers = [gradeA, gradeC, amNoNumber];

    const lastWeek = suggestWeek(input(customers, { weeksLeft: 1 }));
    assert.equal(countOf(lastWeek, "grade-a"), 3, "the last week of the month places a grade-A customer as often as his grade still needs — 3");
    assert.equal(new Set(lastWeek.placements.filter((placement) => placement.customerId === "grade-a").map((placement) => placement.planDate)).size, 3, "on three different days");
    assert.equal(countOf(lastWeek, "grade-c"), 1, "a grade-C customer once — never beyond his need");
    assert.equal(countOf(lastWeek, "am-grade-b"), 1, "a customer with no grade number once");
    assert.equal(
      countOf(suggestWeek(input(customers, { weeksLeft: 1, placedThisMonth: new Map([["grade-a", 2]]) })), "grade-a"),
      1,
      "two already planned this month: one more, not three",
    );
    assert.equal(countOf(suggestWeek(input(customers, { weeksLeft: 4 })), "grade-a"), 1, "four weeks left: once this week, so the month is spread — not bunched into one week");
    assert.equal(countOf(suggestWeek(input(customers, { weeksLeft: 2 })), "grade-a"), 2, "two weeks left: twice this week, once the next");
    assert.equal(
      suggestWeek(input(customers, { weeksLeft: 1 })).placements.some((placement) => placement.planDate === THU && placement.customerId !== "am-grade-b"),
      false,
      "no PM customer is suggested on the Thursday morning",
    );

    // What the week already holds counts: a customer ticked on Sunday is not suggested again on Saturday.
    const withSunday = suggestWeek(input([gradeC], { items: [placed(SUN, "grade-c")], placedThisMonth: new Map([["grade-c", 1]]) }));
    assert.deepEqual(ids(withSunday), [], "a grade-C customer the rep already ticked this week is at his grade: nothing more");
    const passedSaturday = suggestWeek(input([gradeC], { week: week({ passed: [SAT] }) }));
    assert.deepEqual(
      passedSaturday.placements.map((placement) => placement.planDate),
      [SUN],
      "the week starts on the first day he can still change",
    );

    // Each day of the week sees the days before it.
    const many = Array.from({ length: 40 }, (_, index) => customer(`c-${String(index).padStart(2, "0")}`, "PM"));
    const week40 = suggestWeek(input(many, { weeksLeft: 1 }));
    assert.equal(week40.placements.length, 40, "forty grade-C customers, each owed one visit, are each placed once across the week");
    assert.equal(new Set(ids(week40)).size, 40, "and none twice");
    assert.equal(week40.summary.days, 3, "15 + 15 + 10 over three days — each day filled before the next begins");
  }

  // ── (h) A day or week that cannot be changed gets nothing ───────────────────────────────────────
  {
    const customers = [customer("anyone", "PM", { grade: "A" }), customer("am", "AM", { grade: "A" })];
    const passedWeek = week({ passed: [SAT] });
    const passed = suggestDay({ ...input(customers, { week: passedWeek }), date: SAT });
    assert.deepEqual([ids(passed), passed.summary.why], [[], "passed"], "a day that has passed gets nothing");
    assert.equal(daySuggestBlock({ day: passedWeek.days[0], items: [], activity: null, customers, caps: CAPS }), "passed", "and the button says why");

    const fullDay = suggestDay({
      ...input(customers, { caps: { amDailyCap: 1, pmDailyCap: 1 }, items: [placed(SAT, "anyone"), placed(SAT, "am")] }),
      date: SAT,
    });
    assert.equal(fullDay.summary.why, "full", "a full day gets nothing, and says it is full");

    const allPassed = week({ passed: [SAT, SUN, MON, "2026-10-13", "2026-10-14", THU] });
    const closed = suggestWeek(input(customers, { week: allPassed }));
    assert.deepEqual([ids(closed), closed.summary.why], [[], "passed"], "a week with no day left to change gets nothing");
    assert.equal(weekSuggestBlock({ week: allPassed, items: [], activities: [], customers, caps: CAPS }), "passed");
    assert.equal(weekSuggestBlock({ week: week(), items: [], activities: [], customers, caps: CAPS }), null, "an open week can take a suggestion");

    const allAway = week().days.map((entry) => ({ planDate: entry.date, halfDay: false }));
    assert.equal(weekSuggestBlock({ week: week(), items: [], activities: allAway, customers, caps: CAPS }), "activity", "a week given over to other activities says so");
  }

  // ── The month so far reads the draft ────────────────────────────────────────────────────────────
  {
    // Saturday passed with c1 saved on it; Sunday was saved with c1 and the draft swapped him for c2.
    const drafted = week({ passed: [SAT], saved: { [SAT]: ["c1"], [SUN]: ["c1"] } });
    const counts = monthPlacements([
      { week: drafted, items: [placed(SUN, "c2")] },
      { week: week({ saved: { [MON]: ["c3"] } }), items: null },
    ]);
    assert.deepEqual(
      Object.fromEntries([...counts].sort()),
      { c1: 1, c2: 1, c3: 1 },
      "a passed day counts as saved, a day he can change counts as his draft holds it, and a week he cannot change counts as saved",
    );
  }

  // ── (i) The screens ─────────────────────────────────────────────────────────────────────────────
  {
    const read = (path: string) => stripComments(readFileSync(path, "utf8"));
    const menu = read("src/components/phoenix-crm/plan-copy-menu.tsx");
    const weekPanel = read("src/components/phoenix-crm/plan-week-panel.tsx");
    const dayPanel = read("src/components/phoenix-crm/plan-day-panel.tsx");
    const board = read("src/components/phoenix-crm/plan-board.tsx");

    assert.ok(menu.includes('"Suggest this day"') && menu.includes('"Suggest the week"'), "both buttons exist");
    assert.match(
      menu,
      /onPlace\(new Map\(\[\[input\.week\.weekStart, result\.placements\]\]\)\)/,
      "a suggestion hands its placements to onPlace — the same hand-off a copy uses",
    );
    assert.doesNotMatch(menu, /crmPost|\/api\/phoenix-crm\/plans"/, "the copy and suggestion menu never saves or sends anything itself");

    assert.equal((weekPanel.match(/<PlanSuggestMenu\b/g) ?? []).length, 2, "the week panel places both suggestions");
    assert.match(weekPanel, /scope=\{\{ kind: "week" \}\}/, "one for the week");
    assert.match(weekPanel, /scope=\{\{ kind: "day", date: selectedDay\.date \}\}/, "one for the day on screen");
    assert.equal(
      (weekPanel.match(/onPlace=\{onCopied\}/g) ?? []).length,
      // + last week's plan and the period plan on the rep's step 3 (owner, 2026-10-02).
      6,
      "the four copies and the two suggestions all land through onCopied — one path into the draft",
    );
    assert.match(board, /onCopied=\{addCopies\}/, "and onCopied is the board's addCopies");
    assert.match(
      board,
      /function addCopies\(placements: CopiedPlacements\) \{[\s\S]*?change\(state, \(draft\) => \(\{ items: addCopiedItems\(draft\.items, additions\) \}\)\);/,
      "which only changes the draft — the unsaved-changes bar then appears, and Save and Send stay the rep's own presses",
    );
    assert.match(board, /suggest=\{suggest\}/, "the board hands the week panel the month so far");
    assert.match(board, /view\.viewerIsRep && selected/, "on the rep's own plan only — a manager reading it gets no suggestion");
    assert.match(board, /dayTargets: \{ am: view\.callRate\.amTarget, pm: view\.callRate\.pmTarget \}/, "the board fills a day to the Settings' call-rate targets");
    assert.equal((weekPanel.match(/dayTargets: suggest\.dayTargets/g) ?? []).length, 2, "and the day and week notices judge 'full' against the same targets");
    // Counted from the weeks as the board holds them, unsaved ticks included — and from THIS month's
    // own weeks: since 2026-10-01 the board also shows the week the month opens with and does not own
    // (the previous month's last week), which must not move this month's placed count.
    assert.match(
      board,
      /monthPlacements\(\s*states\.filter\(\(state\) => !state\.week\.leading\)\.map\(/,
      "counted from the weeks as the board holds them, unsaved ticks included",
    );
    assert.match(dayPanel, /\{suggestMenu\}\s*\{copyMenu\}/, "Suggest this day sits beside Copy a day");

    // The phone's month strip: AM and PM apart, the full cards kept from md up.
    // The report says what happened, in his words (the role walk, 2026-10-28).
    assert.match(menu, /\$\{countText\(am\)\} on \$\{weekday\} morning and \$\{countText\(pm\)\} in the afternoon/, "a day reads by its halves");
    assert.match(menu, /title: `\$\{weekday\} already holds \$\{holds\}`/, "a full day says what it holds");
    assert.ok(menu.includes("Suggest fills a day only up to its share of this month's visits."), "and why nothing more went on");
    assert.match(menu, /onto \$\{ontoText\(placed\)\}/, "a copy names the days it filled");
    assert.ok(menu.includes("if (shown.length === 0 && !report) return null;"), "a copy menu with nothing to copy is not shown");
    assert.match(board, /setFillNote\(\{ key, report: suggestReport\(/, "the board keeps the day's fill report");
    assert.match(dayPanel, /\{fillReport \? \(\s*<CrmNote className="mt-3" title=\{fillReport\.title\} tone=\{fillReport\.tone\}>/, "and the day screen shows it");

    assert.match(board, /<div className="grid grid-cols-2 gap-2 md:hidden">/, "a phone reads the month as one two-column strip");
    assert.match(board, /const lists: ReadonlyArray<PhoenixCrmDoctorListType> = \["AM", "PM"\];/, "one column for AM and one for PM — never one added figure");
    assert.match(board, /<div className="hidden md:block">\s*<CrmStatGrid>/, "and the eight full cards stay on a tablet and a desktop");

    // The week and day on screen are marked in their choosers.
    assert.match(board, /<ChoiceLabel chosen=\{state\.week\.weekStart === selected\?\.week\.weekStart\}>/, "the week on screen carries a tick");
    assert.match(weekPanel, /<ChoiceLabel chosen=\{day\.date === selectedDay\.date\}>/, "and so does the day");
  }

  // ── (j) Not validated yet: iReports360's brick keeps the day in one area (owner walk, 2026-10-28) ──
  {
    const pendingIn = (customerId: string, brick: string): PlannerCustomer => ({
      ...customer(customerId, "PM", { pending: true }),
      reference: { brick, area: null, address: null },
    });
    const pendings = [pendingIn("a-dokki", "Dokki"), pendingIn("b-zamalek", "Zamalek"), pendingIn("c-dokki", "Dokki")];
    const two = suggestDay({ ...input(pendings, { caps: { amDailyCap: 5, pmDailyCap: 2 } }), date: SAT });
    assert.deepEqual(ids(two), ["a-dokki", "c-dokki"], "the two in Dokki, never the alphabet across bricks");
    assert.deepEqual([two.summary.bricks, two.summary.brickNames], [1, ["Dokki"]], "and the report counts and names their brick");
    const three = suggestDay({ ...input(pendings, { caps: { amDailyCap: 5, pmDailyCap: 3 } }), date: SAT });
    assert.deepEqual([three.summary.bricks, [...three.summary.brickNames].sort()], [2, ["Dokki", "Zamalek"]], "each brick named once");

    const full = suggestDay({
      ...input([customer("a1", "AM"), customer("p1", "PM"), customer("p2", "PM"), customer("p3", "PM")], {
        dayTargets: { am: 1, pm: 2 },
        items: [placed(SAT, "a1"), placed(SAT, "p1"), placed(SAT, "p2")],
      }),
      date: SAT,
    });
    assert.deepEqual([full.summary.why, full.summary.held], ["full", { am: 1, pm: 2 }], "a full day says what it holds");
  }

  console.log("phoenix-crm plan suggest: OK");
}
