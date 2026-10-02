/**
 * Phoenix CRM — how a manager reviews a SENT week, with no I/O (owner, 2026-10-02).
 *
 * On 1 October district managers approved 13 weeks of 51–94 customers each in a median of two minutes.
 * The review became steps (plan-review-steps.tsx): the week and its coverage, its days, each day's AM
 * then PM, and the decision — approve, return the week, or return ONE day. Three rules live here, pure,
 * so the server and the screen share them and the tests can walk them:
 *
 *   1. COVERAGE ON THE REVIEW — VALIDATED customers only (owner, 2026-10-02: every customer carried over
 *      from iReports360 is still pending, so this starts mostly empty and says so in words). Per list —
 *      AM and PM apart, never added together — and per grade (A, B, C): how many of the month's target
 *      visits the month's sent and approved days, plus the week under review, cover; and who is left
 *      out of the month so far. A customer's target is `tallyDoctorMonth`'s, which reads coverage.ts
 *      `gradeTarget` — the ONE target rule. Nothing here carries a second copy of it.
 *   2. WHAT CHANGED — every send keeps what was sent on its own 'submitted' event (migration
 *      20261002120049). A week that comes back for review after a return or an acknowledged edit is
 *      compared with the version sent before it, day by day: customers added and removed, other
 *      activities added and removed.
 *   3. THE DAYS A REVIEWER MAY RETURN ONE BY ONE — a working day of the week that has not passed, so the
 *      rep can still change it (`phoenix_crm_plan_transition` refuses any other: day_not_returnable).
 *
 * Nothing here reads a visit, a location or any integrity signal: a review judges the PLAN, and the
 * rep's honesty is never on this screen (Golden rule #1).
 */

import { sharePercent } from "@/lib/phoenix-crm/coverage";
import { dayActivityRank, isDayActivity, type PhoenixCrmDayActivity } from "@/lib/phoenix-crm/day-activities";
import { tallyDoctorMonth } from "@/lib/phoenix-crm/monthly-plan-rules";
import { doctorListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { isPlanDaySent } from "@/lib/phoenix-crm/plan-rules";
import type { PhoenixCrmGrade, PhoenixCrmListType, PhoenixCrmPlanStatus, PhoenixCrmSettings } from "@/lib/phoenix-crm/types";

// ── 1. Coverage on the review ───────────────────────────────────────────────────────────────────

export const REVIEW_GRADES: readonly PhoenixCrmGrade[] = ["A", "B", "C"];
const REVIEW_LISTS: readonly PhoenixCrmListType[] = ["AM", "PM"];

/** A week of the month as the board holds it — the part a review counts. */
export type ReviewWeek = {
  weekStart: string;
  /** The week a month OPENS with and does not own (monthly-plans.ts): it counts in the month before. */
  leading: boolean;
  status: PhoenixCrmPlanStatus | null;
  /** The STANDING one-day return (monthly-plans.ts reads it through `standingReturnedDay`); else null. */
  returnedDay: string | null;
  days: ReadonlyArray<{ date: string; items: ReadonlyArray<{ customerId: string }> }>;
};

/** A customer on the territory's list, as the planner carries him. */
export type ReviewCustomer = {
  customerId: string;
  name: string;
  listType: PhoenixCrmListType;
  grade: PhoenixCrmGrade | null;
  /** Carried over from iReports360 and not validated yet: outside the review's coverage. */
  pending: boolean;
};

export type ReviewGradeRow = {
  grade: PhoenixCrmGrade;
  /** Validated customers of this list and grade. */
  customers: number;
  /** Their month's target visits — each one's grade number, added up; null when the grade has no number. */
  targetVisits: number | null;
  /** The target visits the sent weeks cover. A customer planned over his number covers his own, never another's. */
  coveredVisits: number;
  /** Every placement of these customers, over their number included. */
  placedVisits: number;
  /** Covered ÷ target, 0–100 with one decimal; null with no target to divide by. */
  coveragePct: number | null;
  /** Not placed on any sent day of the month. */
  leftOut: number;
};

export type ReviewLeftOut = { customerId: string; name: string; grade: PhoenixCrmGrade | null };

export type ReviewListCoverage = {
  listType: PhoenixCrmListType;
  /** Validated customers on this list. */
  validated: number;
  /** A, B and C, always all three, in that order. */
  grades: ReviewGradeRow[];
  /** Validated customers with no grade: no target to cover, still named when left out. */
  ungraded: number;
  /** Validated customers placed on no sent day of the month, grade A first, then by name. */
  leftOut: ReviewLeftOut[];
};

export type ReviewCoverage = {
  /** Validated customers on both lists — zero while nobody on the list has been validated at the door. */
  validated: number;
  lists: Record<PhoenixCrmListType, ReviewListCoverage>;
};

/**
 * The placements a review counts, per customer: every day of the month's own weeks that has gone for
 * review (sent or approved), plus the week under review. A draft or a week returned whole is still the
 * rep's to change, so it does not count yet — and the week a month opens with belongs to the month
 * before. A week returned for ONE day still counts on its other days, which stand as sent (owner,
 * 2026-10-02, "Still planned"); its returned day waits for the rep to send the week again. Asked day by
 * day through plan-rules.ts `isPlanDaySent` — the rule a visit's own save follows.
 */
export function reviewPlacements(weeks: ReadonlyArray<ReviewWeek>, reviewedWeekStart: string): Map<string, number> {
  const placements = new Map<string, number>();
  for (const week of weeks) {
    if (week.leading) continue;
    const underReview = week.weekStart === reviewedWeekStart;
    for (const day of week.days) {
      if (!underReview && !isPlanDaySent({ status: week.status, returnedDay: week.returnedDay, date: day.date })) continue;
      for (const item of day.items) placements.set(item.customerId, (placements.get(item.customerId) ?? 0) + 1);
    }
  }
  return placements;
}

const GRADE_ORDER: Record<PhoenixCrmGrade, number> = { A: 0, B: 1, C: 2 };

/** One list at a time — AM and PM are never added together. Validated customers only. */
export function summarizeReviewCoverage(input: {
  customers: ReadonlyArray<ReviewCustomer>;
  placements: ReadonlyMap<string, number>;
  settings: Pick<PhoenixCrmSettings, "gradeTargets">;
}): ReviewCoverage {
  const lists = {} as Record<PhoenixCrmListType, ReviewListCoverage>;
  let validated = 0;
  for (const listType of REVIEW_LISTS) {
    const rows = new Map<PhoenixCrmGrade, ReviewGradeRow & { hasTarget: boolean }>(
      REVIEW_GRADES.map((grade) => [
        grade,
        { grade, customers: 0, targetVisits: null, coveredVisits: 0, placedVisits: 0, coveragePct: null, leftOut: 0, hasTarget: false },
      ]),
    );
    const leftOut: ReviewLeftOut[] = [];
    let listValidated = 0;
    let ungraded = 0;
    for (const customer of input.customers) {
      if (customer.pending || customer.listType !== listType) continue;
      listValidated += 1;
      const placed = input.placements.get(customer.customerId) ?? 0;
      if (placed === 0) leftOut.push({ customerId: customer.customerId, name: customer.name, grade: customer.grade });
      if (!customer.grade) {
        ungraded += 1;
        continue;
      }
      // The ONE target rule: the grade's monthly number, read through tallyDoctorMonth.
      const tally = tallyDoctorMonth({ customerId: customer.customerId, listType, grade: customer.grade, placed }, input.settings);
      const row = rows.get(customer.grade);
      if (!row) continue;
      row.customers += 1;
      row.placedVisits += placed;
      if (placed === 0) row.leftOut += 1;
      if (tally.required !== null) {
        row.hasTarget = true;
        row.targetVisits = (row.targetVisits ?? 0) + tally.required;
        row.coveredVisits += Math.min(placed, tally.required);
      }
    }
    leftOut.sort(
      (left, right) =>
        (left.grade ? GRADE_ORDER[left.grade] : 3) - (right.grade ? GRADE_ORDER[right.grade] : 3) || left.name.localeCompare(right.name),
    );
    lists[listType] = {
      listType,
      validated: listValidated,
      grades: REVIEW_GRADES.map((grade) => {
        const { hasTarget, ...row } = rows.get(grade) as ReviewGradeRow & { hasTarget: boolean };
        return { ...row, targetVisits: hasTarget ? row.targetVisits : null, coveragePct: hasTarget ? sharePercent(row.coveredVisits, row.targetVisits ?? 0) : null };
      }),
      ungraded,
      leftOut,
    };
    validated += listValidated;
  }
  return { validated, lists };
}

/**
 * The coverage a review shows for one week, or null when that week is not one of the month's own — the
 * week a month opens with is counted on the board of the month it belongs to, never mixed into this one.
 */
export function planReviewCoverage(input: {
  weeks: ReadonlyArray<ReviewWeek>;
  reviewedWeekStart: string;
  customers: ReadonlyArray<ReviewCustomer>;
  settings: Pick<PhoenixCrmSettings, "gradeTargets">;
}): ReviewCoverage | null {
  const reviewed = input.weeks.find((week) => week.weekStart === input.reviewedWeekStart);
  if (!reviewed || reviewed.leading) return null;
  return summarizeReviewCoverage({
    customers: input.customers,
    placements: reviewPlacements(input.weeks, input.reviewedWeekStart),
    settings: input.settings,
  });
}

// ── 2. What changed since the last send ─────────────────────────────────────────────────────────

/** One customer as a send kept him: the day, the list, and his name as it stood. */
export type SentItem = { planDate: string; customerId: string; listType: PhoenixCrmListType; name: string | null };

export type SentActivity = { planDate: string; activityType: PhoenixCrmDayActivity; halfDay: boolean };

/** What one send kept on its 'submitted' event. */
export type SentSnapshot = { items: SentItem[]; activities: SentActivity[] };

function record(raw: unknown): Record<string, unknown> {
  return (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
}

/**
 * The snapshot a send kept, or null for a send that kept none — every send before 2 October 2026, and
 * a week sent with its month (the month's cascade writes its own events). Null is "not known", never
 * "empty": an empty week cannot be sent, so an empty list can only mean the snapshot is missing.
 */
export function parseSentSnapshot(details: unknown): SentSnapshot | null {
  const body = record(details);
  if (!Array.isArray(body.items) || !Array.isArray(body.activities)) return null;
  const items: SentItem[] = [];
  for (const raw of body.items) {
    const entry = record(raw);
    const planDate = typeof entry.plan_date === "string" ? entry.plan_date : null;
    const customerId = typeof entry.customer_id === "string" ? entry.customer_id.toLowerCase() : null;
    if (!planDate || !customerId) continue;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    // A pharmacy is never planned (owner, 2026-10-02), so a row naming one is not a plan item.
    const listType = doctorListType(entry.list_type);
    if (listType === null) continue;
    items.push({ planDate, customerId, listType, name: name || null });
  }
  const activities: SentActivity[] = [];
  for (const raw of body.activities) {
    const entry = record(raw);
    const planDate = typeof entry.plan_date === "string" ? entry.plan_date : null;
    if (!planDate || !isDayActivity(entry.activity_type)) continue;
    activities.push({ planDate, activityType: entry.activity_type, halfDay: entry.half_day === true });
  }
  return { items, activities };
}

/** One day that changed between two sends. A day nothing changed on is not listed. */
export type SentDayChange = {
  date: string;
  added: SentItem[];
  removed: SentItem[];
  activitiesAdded: SentActivity[];
  activitiesRemoved: SentActivity[];
};

function byListThenName(left: SentItem, right: SentItem): number {
  return left.listType.localeCompare(right.listType) || (left.name ?? "").localeCompare(right.name ?? "") || left.customerId.localeCompare(right.customerId);
}

function byKind(left: SentActivity, right: SentActivity): number {
  return dayActivityRank(left.activityType) - dayActivityRank(right.activityType) || Number(left.halfDay) - Number(right.halfDay);
}

/**
 * Day by day, what the later send holds that the earlier one did not, and the reverse. A customer is
 * the same customer on the same day whatever his place; an activity that went from a whole day to half
 * of one reads as the one taken off and the other put on, which is exactly what happened to the day.
 */
export function diffSentSnapshots(previous: SentSnapshot, current: SentSnapshot): SentDayChange[] {
  const itemKey = (item: SentItem) => `${item.planDate}|${item.customerId}`;
  const activityKey = (activity: SentActivity) => `${activity.planDate}|${activity.activityType}|${activity.halfDay ? "half" : "whole"}`;
  const before = new Map(previous.items.map((item) => [itemKey(item), item]));
  const after = new Map(current.items.map((item) => [itemKey(item), item]));
  const activitiesBefore = new Map(previous.activities.map((activity) => [activityKey(activity), activity]));
  const activitiesAfter = new Map(current.activities.map((activity) => [activityKey(activity), activity]));

  const days = new Map<string, SentDayChange>();
  const dayOf = (date: string): SentDayChange => {
    const existing = days.get(date);
    if (existing) return existing;
    const created: SentDayChange = { date, added: [], removed: [], activitiesAdded: [], activitiesRemoved: [] };
    days.set(date, created);
    return created;
  };
  for (const [key, item] of after) if (!before.has(key)) dayOf(item.planDate).added.push(item);
  for (const [key, item] of before) if (!after.has(key)) dayOf(item.planDate).removed.push(item);
  for (const [key, activity] of activitiesAfter) if (!activitiesBefore.has(key)) dayOf(activity.planDate).activitiesAdded.push(activity);
  for (const [key, activity] of activitiesBefore) if (!activitiesAfter.has(key)) dayOf(activity.planDate).activitiesRemoved.push(activity);

  return [...days.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((day) => ({
      ...day,
      added: day.added.sort(byListThenName),
      removed: day.removed.sort(byListThenName),
      activitiesAdded: day.activitiesAdded.sort(byKind),
      activitiesRemoved: day.activitiesRemoved.sort(byKind),
    }));
}

/** One 'submitted' event of a week: when it was sent, and what it kept. */
export type SentEvent = { sentAt: string | null; details: unknown };

/**
 * What a reviewer is shown about a week's sends:
 *   - first    — sent once: there is nothing earlier to compare it with;
 *   - unknown  — sent before, but one of the two sends kept no snapshot (sent before 2 October 2026);
 *   - compared — the days that changed since the send before, possibly none.
 */
export type PlanSentChanges =
  | { kind: "first" }
  | { kind: "unknown"; previousSentAt: string | null }
  | { kind: "compared"; previousSentAt: string | null; days: SentDayChange[] };

/** `sends` newest first. Null when the week has never been sent. */
export function sentChangesOf(sends: ReadonlyArray<SentEvent>): PlanSentChanges | null {
  if (sends.length === 0) return null;
  if (sends.length === 1) return { kind: "first" };
  const current = parseSentSnapshot(sends[0].details);
  const previous = parseSentSnapshot(sends[1].details);
  if (!current || !previous) return { kind: "unknown", previousSentAt: sends[1].sentAt };
  return { kind: "compared", previousSentAt: sends[1].sentAt, days: diffSentSnapshots(previous, current) };
}

/** The days a later send changed, for marking them on the day chooser. */
export function changedDaysOf(changes: PlanSentChanges | null): Set<string> {
  return new Set(changes?.kind === "compared" ? changes.days.map((day) => day.date) : []);
}

// ── 3. The days a reviewer may return one by one ───────────────────────────────────────────────

/**
 * A working day of the week that has not passed (owner, 2026-10-02: "Only that day" reopens — so the
 * rep must still be able to change it). A public holiday holds nothing, so it is never offered.
 */
export function returnableDays<T extends { date: string; listTypes: ReadonlyArray<PhoenixCrmListType> }>(days: ReadonlyArray<T>, cairoToday: string): T[] {
  return days.filter((day) => day.date >= cairoToday && day.listTypes.length > 0);
}
