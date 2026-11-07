/**
 * Phoenix CRM — "Suggest this day" and "Suggest the week" on the plan board, with no I/O.
 *
 * Owner, 2026-09-30: "the best-appearing and easiest CRM, yet controlled". The rep builds his plan by
 * ticking customers into days; this does the first pass for him, and then gets out of the way. It is a
 * DRAFT exactly like a copy (plan-copy-menu.tsx hands its placements to the same `onPlace`): nothing is
 * saved or sent until he presses Save or Send himself, and every placement is one he can untick.
 *
 * Who goes on a day, in this order:
 *
 *   1. Customers who RECEIVE on that weekday at one of their places — on a Ramadan day, their Ramadan
 *      hours when the place has them (customerOnDay / windowsForWeekday already read it that way). A
 *      suggestion never asks a reason, so a validated customer who does not receive that day is left for
 *      the rep to place himself, exactly as a copy leaves him.
 *   2. Only customers still BELOW their grade's number this month, furthest below first. Placing a
 *      customer over his grade is a deviation (coverage.ts: over-visiting is never a bonus), so the rep
 *      may tick one over himself — the system never proposes it.
 *   3. Customers not already planned elsewhere this week come first. One already on the week is offered
 *      again only while his month still needs it, and never faster than the weeks left can spread him:
 *      a grade-A PM customer (3 a month) with four weeks to go is placed once this week, not three times.
 *   4. One AREA at a time: the brick already on the day first (he started it), then the brick with the
 *      most candidates, so the day is driven as one cluster before it moves to the next.
 *   5. AM up to the day's AM TARGET and PM up to its PM target, apart — never one shared number (the
 *      call-rate golden rule), never past the day's cap, and a Thursday morning takes AM only. The cap
 *      stays the rep's own limit when he ticks by hand; a suggestion stops at the target, so the month is
 *      spread over its days instead of spent in the first few (browser walk, 2026-09-30: filling a
 *      Saturday to the 5 AM / 15 PM cap would have used a whole AM list in five days).
 *   6. Last, customers with no days and hours yet (not validated) fill the room still left. Nothing is
 *      known against them, so they are planned as they are — the owner's 2026-09-22 ruling — but after
 *      everyone the day is known to suit. Among them, the ones iReports360 usually saw on that weekday
 *      come first, then the ones it knows nothing about, then the ones it usually saw on other days
 *      (owner, 2026-10-02; plan-insight.ts `usualDayRank`) — an ORDER only: nobody is left out for it.
 *
 * And ahead of all of it (owner, 2026-10-02): a customer whose LATEST visit left a next step due inside
 * this week, and who is not on the week yet, goes first — the earliest due first. Every rule above still
 * holds for him: the day's caps, his own list, a day he receives, and never over his grade.
 *
 * A day with a whole-day other activity (a meeting, a conference, training…) takes no visits; a half
 * day leaves half the day's room. A day that has passed takes nothing.
 */

import { weekdayOfIsoDay } from "@/lib/phoenix-crm/calendar";
import { gradeTarget } from "@/lib/phoenix-crm/coverage";
import { followUpInWeek, usualDayRank } from "@/lib/phoenix-crm/plan-insight";
import type { PlanItemDraft } from "@/lib/phoenix-crm/plan-rules";
import {
  customerOnDay,
  dayCounts,
  indexCustomers,
  resolveDayRows,
  type DailyCaps,
  type DraftDay,
  type DraftWeek,
} from "@/lib/phoenix-crm/plan-week-draft";
import { normalizeArea, type PlannerCustomer } from "@/lib/phoenix-crm/suggestions";
import type { PhoenixCrmDoctorListType, PhoenixCrmGrade, PhoenixCrmSettings } from "@/lib/phoenix-crm/types";

export type GradeTargets = PhoenixCrmSettings["gradeTargets"];

/** The rep's call-rate target per working day, AM and PM apart (the Settings' call-rate targets). */
export type DayTargets = { am: number; pm: number };

/** A day's other activity as the suggestion reads it: only whether it takes the whole day (`activityOn` folds a day's several). */
export type SuggestActivity = { planDate: string; halfDay: boolean };

export type SuggestInput = {
  week: DraftWeek;
  /** The week's draft: the placements of the days the rep may still change. */
  items: ReadonlyArray<PlanItemDraft>;
  /** The week's drafted other activities. */
  activities: ReadonlyArray<SuggestActivity>;
  customers: ReadonlyArray<PlannerCustomer>;
  caps: DailyCaps;
  /** Fill each day to these, never past `caps`. Absent: fill to the caps. */
  dayTargets?: DayTargets;
  gradeTargets: GradeTargets;
  /**
   * Each customer's placements across the whole month, the unsaved draft included (monthPlacements) —
   * the month's saved tallies alone would re-suggest a customer he ticked a minute ago.
   */
  placedThisMonth: ReadonlyMap<string, number>;
  /** The month's weeks still open to planning, this one included. Spreads a customer's visits. At least 1. */
  weeksLeft?: number;
};

/** Why a day, or the whole week, cannot take a suggestion. */
export type SuggestBlock = "passed" | "activity" | "full";

export type SuggestSummary = {
  am: number;
  pm: number;
  /** Distinct bricks the placements sit in; a customer with no brick is not one. */
  bricks: number;
  /** Those bricks' names, each as first spelt, in the order placed: what the report names. */
  brickNames: string[];
  /** Placed with no days and hours yet (not validated). */
  noHours: number;
  /** Days that took at least one placement. */
  days: number;
  /** Why nothing was placed; null when something was. */
  why: SuggestBlock | "nobody" | null;
  /** A day that is already full: what it holds, AM and PM, so the report can say so. Null otherwise. */
  held: { am: number; pm: number } | null;
};

export type SuggestResult = { placements: PlanItemDraft[]; summary: SuggestSummary };

const NO_BRICK = "__no_brick__";
const GRADE_ORDER: Record<PhoenixCrmGrade, number> = { A: 0, B: 1, C: 2 };

// ── The month so far ────────────────────────────────────────────────────────────────────────────

/**
 * Each customer's placements across the month's weeks: the draft for the days the rep may still change
 * (null when the week is not his to change), and what was saved for every other day.
 */
export function monthPlacements(
  weeks: ReadonlyArray<{ week: DraftWeek; items: ReadonlyArray<PlanItemDraft> | null }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (customerId: string) => counts.set(customerId, (counts.get(customerId) ?? 0) + 1);
  for (const { week, items } of weeks) {
    const drafted = new Set(items ? week.days.filter((day) => day.editable).map((day) => day.date) : []);
    for (const day of week.days) {
      if (drafted.has(day.date)) continue;
      for (const item of day.items) add(item.customerId);
    }
    for (const item of items ?? []) if (drafted.has(item.planDate)) add(item.customerId);
  }
  return counts;
}

/** Visits still owed this month. A customer with no grade number owes one until he is placed once. */
function needOf(customer: PlannerCustomer, placed: number, gradeTargets: GradeTargets): number {
  // A customer not validated yet has no grade norm (he is left out of the meters), so he is owed once.
  const required = customer.pending ? null : gradeTarget({ gradeTargets }, customer.listType, customer.grade);
  if (required === null) return placed > 0 ? 0 : 1;
  return required - placed;
}

/** Who is on the week, and how often: the draft's days, and the saved ones that have passed. */
function weekCounts(week: DraftWeek, items: ReadonlyArray<PlanItemDraft>): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (customerId: string) => counts.set(customerId, (counts.get(customerId) ?? 0) + 1);
  const editable = new Set(week.days.filter((day) => day.editable).map((day) => day.date));
  for (const day of week.days) if (!day.editable) for (const item of day.items) add(item.customerId);
  for (const item of items) if (editable.has(item.planDate)) add(item.customerId);
  return counts;
}

// ── One day ─────────────────────────────────────────────────────────────────────────────────────

/** The most a suggestion puts on a day: the daily target, AM and PM apart, never past the day's cap. */
export function suggestionCaps(caps: DailyCaps, targets: DayTargets | undefined): DailyCaps {
  if (!targets) return caps;
  const fit = (cap: number, target: number) => (target > 0 ? Math.min(cap, Math.ceil(target)) : cap);
  return { amDailyCap: fit(caps.amDailyCap, targets.am), pmDailyCap: fit(caps.pmDailyCap, targets.pm) };
}

/** What each list may still take on the day: the cap (halved by a half-day activity) less who is on it. */
function roomOf(
  day: DraftDay,
  items: ReadonlyArray<PlanItemDraft>,
  activity: SuggestActivity | null,
  byId: ReadonlyMap<string, PlannerCustomer>,
  caps: DailyCaps,
): Record<PhoenixCrmDoctorListType, number> {
  const counts = dayCounts(resolveDayRows(day, items, byId));
  const share = (cap: number) => (activity?.halfDay ? Math.floor(cap / 2) : cap);
  const capOf = (listType: PhoenixCrmDoctorListType) =>
    day.listTypes.includes(listType) ? share(listType === "AM" ? caps.amDailyCap : caps.pmDailyCap) : 0;
  return { AM: Math.max(0, capOf("AM") - counts.AM), PM: Math.max(0, capOf("PM") - counts.PM) };
}

/**
 * A day's other activities read as ONE, the way the suggestion needs them. A day may hold several (one of
 * each kind, 2026-09-30): it is taken whole when ANY of them takes the whole day, and it is a half day
 * only when every one of them is — a half-day meeting beside a whole-day conference is still a day with
 * no room for visits. Null when the day holds none.
 */
export function activityOn(activities: ReadonlyArray<SuggestActivity>, date: string): SuggestActivity | null {
  const onDay = activities.filter((activity) => activity.planDate === date);
  if (onDay.length === 0) return null;
  return { planDate: date, halfDay: onDay.every((activity) => activity.halfDay) };
}

/** Why the day cannot take a suggestion, or null when it can. */
export function daySuggestBlock(input: {
  day: DraftDay;
  items: ReadonlyArray<PlanItemDraft>;
  activity: SuggestActivity | null;
  customers: ReadonlyArray<PlannerCustomer>;
  caps: DailyCaps;
  dayTargets?: DayTargets;
}): SuggestBlock | null {
  if (!input.day.editable) return "passed";
  if (input.activity && !input.activity.halfDay) return "activity";
  const room = roomOf(input.day, input.items, input.activity, indexCustomers(input.customers), suggestionCaps(input.caps, input.dayTargets));
  return room.AM + room.PM > 0 ? null : "full";
}

/** Why no day of the week can take a suggestion, or null when one can. */
export function weekSuggestBlock(input: Omit<SuggestInput, "gradeTargets" | "placedThisMonth" | "weeksLeft">): SuggestBlock | null {
  const blocks = input.week.days.map((day) =>
    daySuggestBlock({
      day,
      items: input.items,
      activity: activityOn(input.activities, day.date),
      customers: input.customers,
      caps: input.caps,
      dayTargets: input.dayTargets,
    }),
  );
  if (blocks.some((block) => block === null)) return null;
  const open = blocks.filter((block) => block !== "passed");
  if (open.length === 0) return "passed";
  // A day given over to another activity has no room for visits either, so a mix of the two is "full".
  return open.every((block) => block === "activity") ? "activity" : "full";
}

type Candidate = {
  customer: PlannerCustomer;
  placeId: string | null;
  brick: string;
  need: number;
  /** 0 fresh and receiving · 1 again this week, receiving · 2 fresh, no hours yet · 3 again, no hours yet. */
  band: 0 | 1 | 2 | 3;
  startMinute: number;
  /** His latest visit's next step falls due this week and he is not on the week yet: he goes first. */
  followUpOn: string | null;
  /** With no hours yet: 0 iReports360 usually saw him on this weekday · 1 nothing known · 2 other days. */
  usual: 0 | 1 | 2;
};

/** A follow-up due this week before everyone else, the earliest due first; the rest keep their order. */
function compareFollowUps(left: Candidate, right: Candidate): number {
  if (left.followUpOn !== null && right.followUpOn !== null) return left.followUpOn.localeCompare(right.followUpOn);
  return Number(right.followUpOn !== null) - Number(left.followUpOn !== null);
}

/**
 * The brick a customer is planned in: his place's, or iReports360's (the sales master's) while he is not
 * validated yet. 🔴 Reading only the place's brick left every customer not validated yet with none, so
 * Suggest filled their days by the alphabet across the whole territory (owner walk, 2026-10-28).
 */
function rawBrickOf(customer: PlannerCustomer, place: { brick: string | null } | null | undefined): string | null {
  const brick = place ? place.brick : (customer.reference?.brick ?? null);
  return brick && brick.trim() !== "" ? brick.trim() : null;
}

/** The same brick as one key, however it is spelt. */
function brickOf(customer: PlannerCustomer, place: { brick: string | null } | null | undefined): string | null {
  return normalizeArea(rawBrickOf(customer, place));
}

function compareWithinBrick(left: Candidate, right: Candidate): number {
  return (
    right.need - left.need ||
    (left.customer.grade ? GRADE_ORDER[left.customer.grade] : 9) - (right.customer.grade ? GRADE_ORDER[right.customer.grade] : 9) ||
    left.startMinute - right.startMinute ||
    // The one gone longest unseen first, never seen at all before him; the name only breaks a true tie.
    (left.customer.insight?.lastSeenOn ?? "").localeCompare(right.customer.insight?.lastSeenOn ?? "") ||
    left.customer.name.localeCompare(right.customer.name) ||
    left.customer.customerId.localeCompare(right.customer.customerId)
  );
}

function emptyResult(why: SuggestSummary["why"], held: SuggestSummary["held"] = null): SuggestResult {
  return { placements: [], summary: { am: 0, pm: 0, bricks: 0, brickNames: [], noHours: 0, days: 0, why, held } };
}

/** The customers suggested for ONE day of the week, and how it went. */
export function suggestDay(input: SuggestInput & { date: string }): SuggestResult {
  const day = input.week.days.find((entry) => entry.date === input.date);
  if (!day) return emptyResult("passed");
  const activity = activityOn(input.activities, day.date);
  const block = daySuggestBlock({ day, items: input.items, activity, customers: input.customers, caps: input.caps, dayTargets: input.dayTargets });
  if (block) {
    // A full day says what it already holds, so a press that placed nobody reads as the day's share
    // being met rather than as a button that did nothing (the role walk, 2026-10-28).
    const counts = block === "full" ? dayCounts(resolveDayRows(day, input.items, indexCustomers(input.customers))) : null;
    return emptyResult(block, counts ? { am: counts.AM, pm: counts.PM } : null);
  }

  const byId = indexCustomers(input.customers);
  const room = roomOf(day, input.items, activity, byId, suggestionCaps(input.caps, input.dayTargets));
  const rows = resolveDayRows(day, input.items, byId).filter((row) => !row.gone);
  const onDay = new Set(rows.map((row) => row.customerId));
  const onWeek = weekCounts(input.week, input.items);
  const weeksLeft = Math.max(1, Math.floor(input.weeksLeft ?? 1));
  const weekday = weekdayOfIsoDay(day.date);

  // The bricks he has already started the day in: the day stays in them first.
  const dayBricks = new Set<string>();
  for (const row of rows) {
    if (!row.customer) continue;
    const brick = brickOf(row.customer, row.customer.places.find((entry) => entry.placeId === row.placeId) ?? null);
    if (brick) dayBricks.add(brick);
  }

  const candidates: Candidate[] = [];
  for (const customer of input.customers) {
    // A doctor waiting for his full name is never planned (owner, 2026-11-07, pm-name-rules.ts).
    if (customer.needsFullName) continue;
    if (onDay.has(customer.customerId) || !day.listTypes.includes(customer.listType) || room[customer.listType] <= 0) continue;
    const fit = customerOnDay(customer, day.date, day.ramadan);
    // No place left, or a validated customer who does not receive that day: a suggestion never asks a reason.
    if (!fit || !fit.receives) continue;
    const need = needOf(customer, input.placedThisMonth.get(customer.customerId) ?? 0, input.gradeTargets);
    if (need <= 0) continue;
    const already = onWeek.get(customer.customerId) ?? 0;
    // Spread over the weeks left: the month's need at the start of this week, shared across them.
    if (already > 0 && already >= Math.ceil((need + already) / weeksLeft)) continue;
    const noHours = customer.pending;
    candidates.push({
      customer,
      placeId: fit.placeId,
      brick: brickOf(customer, fit.place) ?? NO_BRICK,
      need,
      band: noHours ? (already > 0 ? 3 : 2) : already > 0 ? 1 : 0,
      startMinute: fit.windows[0]?.startMinute ?? 9999,
      // Once he is on the week the follow-up is planned, so the week's own spreading decides the rest.
      followUpOn: already > 0 ? null : followUpInWeek(customer, input.week.weekStart),
      usual: usualDayRank(customer, weekday),
    });
  }

  // One area at a time: the day's own bricks, then the brick with the most fresh candidates, then the most
  // candidates at all, then the most owed. Customers with no brick come after every brick.
  const brickRank = rankBricks(candidates.filter((candidate) => candidate.band < 2), dayBricks);
  // With no hours yet the same, by iReports360's brick: the day's bricks and the ones the receiving
  // customers fill first, then the brick where iReports360 most often saw them on this weekday.
  const pendingRank = rankBricks(
    candidates.filter((candidate) => candidate.band >= 2),
    new Set([...dayBricks, ...[...brickRank.keys()].filter((key) => key !== NO_BRICK)]),
  );

  // A follow-up due this week first; then the bands and, inside each, one brick at a time. With no hours
  // yet, iReports360's usual days for this weekday go first inside the brick.
  const ordered = [...candidates].sort(
    (left, right) =>
      compareFollowUps(left, right) ||
      left.band - right.band ||
      (left.band < 2
        ? (brickRank.get(left.brick) ?? 0) - (brickRank.get(right.brick) ?? 0)
        : (pendingRank.get(left.brick) ?? 0) - (pendingRank.get(right.brick) ?? 0) || left.usual - right.usual) ||
      compareWithinBrick(left, right),
  );

  const remaining = { ...room };
  const placements: PlanItemDraft[] = [];
  for (const candidate of ordered) {
    const listType = candidate.customer.listType;
    if (remaining[listType] <= 0) continue;
    remaining[listType] -= 1;
    placements.push({ planDate: day.date, customerId: candidate.customer.customerId, placeId: candidate.placeId, exceptionType: null, exceptionNote: null });
  }
  const summary = summarize(placements, byId);
  return { placements, summary: { ...summary, why: placements.length > 0 ? null : "nobody" } };
}

/**
 * The bricks in the order a day fills them: the ones already started (`first`), then the most fresh
 * candidates, the most usually seen on this weekday, the most candidates, the most owed. No brick is last.
 */
function rankBricks(candidates: ReadonlyArray<Candidate>, first: ReadonlySet<string>): Map<string, number> {
  const bricks = new Map<string, { fresh: number; usual: number; all: number; need: number }>();
  for (const candidate of candidates) {
    const entry = bricks.get(candidate.brick) ?? { fresh: 0, usual: 0, all: 0, need: 0 };
    if (candidate.band === 0 || candidate.band === 2) entry.fresh += 1;
    if (candidate.usual === 0) entry.usual += 1;
    entry.all += 1;
    entry.need += candidate.need;
    bricks.set(candidate.brick, entry);
  }
  const order = [...bricks.entries()]
    .sort(
      ([leftKey, left], [rightKey, right]) =>
        Number(leftKey === NO_BRICK) - Number(rightKey === NO_BRICK) ||
        Number(first.has(rightKey)) - Number(first.has(leftKey)) ||
        right.fresh - left.fresh ||
        right.usual - left.usual ||
        right.all - left.all ||
        right.need - left.need ||
        leftKey.localeCompare(rightKey),
    )
    .map(([key]) => key);
  return new Map(order.map((key, index) => [key, index]));
}

// ── The week ────────────────────────────────────────────────────────────────────────────────────

/**
 * suggestDay over every day of the week the rep may still change, Saturday first. Each day sees the
 * ones before it: who is on the week, and how many the month still owes.
 */
export function suggestWeek(input: SuggestInput): SuggestResult {
  const block = weekSuggestBlock(input);
  if (block) return emptyResult(block);
  const items = [...input.items];
  const placedThisMonth = new Map(input.placedThisMonth);
  const placements: PlanItemDraft[] = [];
  for (const day of input.week.days) {
    if (!day.editable) continue;
    const result = suggestDay({ ...input, items, placedThisMonth, date: day.date });
    for (const placement of result.placements) {
      items.push(placement);
      placements.push(placement);
      placedThisMonth.set(placement.customerId, (placedThisMonth.get(placement.customerId) ?? 0) + 1);
    }
  }
  const summary = summarize(placements, indexCustomers(input.customers));
  return { placements, summary: { ...summary, why: placements.length > 0 ? null : "nobody" } };
}

function summarize(placements: ReadonlyArray<PlanItemDraft>, byId: ReadonlyMap<string, PlannerCustomer>): Omit<SuggestSummary, "why"> {
  let am = 0;
  let pm = 0;
  let noHours = 0;
  const bricks = new Set<string>();
  const brickNames = new Map<string, string>();
  for (const placement of placements) {
    const customer = byId.get(placement.customerId);
    if (!customer) continue;
    if (customer.listType === "AM") am += 1;
    else pm += 1;
    if (placement.placeId === null) noHours += 1;
    // 🔴 iReports360's brick counts too: "across 1 brick" was said of 57 visits in 7 (owner walk, 2026-10-28).
    const place = customer.places.find((entry) => entry.placeId === placement.placeId) ?? null;
    const brick = brickOf(customer, place);
    if (brick) {
      bricks.add(brick);
      if (!brickNames.has(brick)) brickNames.set(brick, rawBrickOf(customer, place) ?? brick);
    }
  }
  return {
    am,
    pm,
    bricks: bricks.size,
    brickNames: [...brickNames.values()],
    noHours,
    days: new Set(placements.map((placement) => placement.planDate)).size,
    held: null,
  };
}
