/**
 * Phoenix CRM — the Focus list's rules (owner, 2026-11-28). Pure, so a test holds them without a database.
 *
 * His words: "every medical rep in Phoenix CRM: an empty tab called Focus list … I can go to any doctor from the
 * PM and push him to the focus list … the medical rep must say why … once pushed, it is grouped by grade, grouped
 * by brick … the district manager has focus list tracking: he filters on the medical rep he wants and gets his
 * doctors in the focus list … he can return him to the normal list or keep him … he tracks the frequency of
 * visits … when, where, the last time … a manager can also choose from the rep's list and push him."
 *
 * His answers the same day:
 *   - the REASON is written and REQUIRED; a pick from a short list is OPTIONAL beside it;
 *   - the tracking is a From–To period the manager chooses — counts only, no target and no met/missed verdict;
 *   - the REP OR THE DISTRICT MANAGER may return a customer to the normal list;
 *   - a rep's push WAITS for the district manager's Keep or Return; a manager's own push is kept at once.
 *
 * 🔴 ONLY A PM CUSTOMER IS PUSHED (his "any doctor from the PM"), and he is never taken OFF the territory's list:
 * Focus is a mark on him, so his plans, visits, grade norm and every KPI read exactly as before.
 *
 * 🔴 THE REP'S OWN TAB CARRIES NO VISIT COUNT (Golden rule #1, the BLIND half). The frequency, the weeks and the
 * last visit are the manager's tracking; the rep reads his doctors, the reason and where each one stands.
 */

import { addDaysIso } from "@/lib/crm/dates";
import { fieldWeekStart, isIsoDay } from "@/lib/phoenix-crm/calendar";

export const FOCUS_REASON_PICKS = [
  { value: "high_potential", label: "High potential" },
  { value: "competitor_prescriber", label: "Writes a competitor" },
  { value: "key_opinion_leader", label: "Key opinion leader" },
  { value: "growing_prescriber", label: "Growing prescriber" },
  { value: "new_prescriber", label: "New prescriber" },
  { value: "other", label: "Other" },
] as const;

export type FocusReasonPick = (typeof FOCUS_REASON_PICKS)[number]["value"];

/** The written reason's bounds — the table's own check (20261128135234) holds the same two numbers. */
export const FOCUS_REASON_MIN = 3;
export const FOCUS_REASON_MAX = 500;

/** The widest period the tracking reads: a year and a day, so "this time last year" still fits. */
export const FOCUS_PERIOD_MAX_DAYS = 366;
/** With no period chosen, the tracking opens on the last four field weeks up to today. */
export const FOCUS_DEFAULT_PERIOD_DAYS = 27;

export function isFocusReasonPick(value: unknown): value is FocusReasonPick {
  return typeof value === "string" && FOCUS_REASON_PICKS.some((pick) => pick.value === value);
}

export function focusReasonPickLabel(value: string | null | undefined): string | null {
  return FOCUS_REASON_PICKS.find((pick) => pick.value === value)?.label ?? null;
}

/** The written reason, trimmed, or the sentence saying what is wrong with it. */
export function readFocusReason(raw: unknown): { ok: true; reason: string } | { ok: false; message: string } {
  const reason = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (reason.length < FOCUS_REASON_MIN) return { ok: false, message: "Write why this customer goes on the Focus list." };
  if (reason.length > FOCUS_REASON_MAX) return { ok: false, message: `Keep the reason under ${FOCUS_REASON_MAX} characters.` };
  return { ok: true, reason };
}

/** The pick beside the reason: one of the list, or none. Anything else is no pick, never a refusal. */
export function readFocusReasonPick(raw: unknown): FocusReasonPick | null {
  return isFocusReasonPick(raw) ? raw : null;
}

export type FocusPeriod = { from: string; to: string };

/**
 * The period the tracking reads. A missing or broken end falls back to today, a missing or broken start to four
 * weeks before the end; a start after the end is swapped, and a span over a year is cut to the year ending on `to`.
 * Never a future day: the tracking reads what was done.
 */
export function readFocusPeriod(rawFrom: unknown, rawTo: unknown, today: string): FocusPeriod {
  let to = isIsoDay(rawTo) ? rawTo : today;
  if (to > today) to = today;
  let from = isIsoDay(rawFrom) ? rawFrom : addDaysIso(to, -FOCUS_DEFAULT_PERIOD_DAYS);
  if (from > today) from = today;
  if (from > to) [from, to] = [to, from];
  const earliest = addDaysIso(to, -(FOCUS_PERIOD_MAX_DAYS - 1));
  if (from < earliest) from = earliest;
  return { from, to };
}

/** The field weeks (Saturday starts) a period touches, in order. */
export function focusPeriodWeeks(period: FocusPeriod): string[] {
  const weeks: string[] = [];
  for (let week = fieldWeekStart(period.from); week <= period.to; week = addDaysIso(week, 7)) weeks.push(week);
  return weeks;
}

export type FocusWeekCount = { weekStart: string; visits: number };

/** A customer's visits inside the period, by field week — every week of the period listed, a zero included. */
export function focusWeekCounts(visitDays: readonly string[], period: FocusPeriod): FocusWeekCount[] {
  const counts = new Map(focusPeriodWeeks(period).map((week) => [week, 0]));
  for (const day of visitDays) {
    if (day < period.from || day > period.to) continue;
    const week = fieldWeekStart(day);
    counts.set(week, (counts.get(week) ?? 0) + 1);
  }
  return [...counts.entries()].map(([weekStart, visits]) => ({ weekStart, visits }));
}

/** Visits per week across the period, one decimal — "1.5 a week". Zero weeks never divide: an empty period is 0. */
export function focusWeeklyAverage(visits: number, period: FocusPeriod): number {
  const weeks = focusPeriodWeeks(period).length;
  return weeks === 0 ? 0 : Math.round((visits / weeks) * 10) / 10;
}

export const FOCUS_NO_GRADE = "No grade";
export const FOCUS_NO_BRICK = "Brick not known yet";

export type FocusGroupable = { grade: string | null; brick: string | null; customerName: string };

export type FocusBrickGroup<T> = { brick: string; entries: T[] };
export type FocusGradeGroup<T> = { grade: string; count: number; bricks: FocusBrickGroup<T>[] };

/**
 * Grouped by grade, then by brick — his order. Grades read A, B, C … with "No grade" last; bricks by name with
 * "Brick not known yet" last; customers by name inside a brick.
 */
export function groupFocusEntries<T extends FocusGroupable>(entries: readonly T[]): FocusGradeGroup<T>[] {
  const byGrade = new Map<string, Map<string, T[]>>();
  for (const entry of entries) {
    const grade = entry.grade?.trim() || FOCUS_NO_GRADE;
    const brick = entry.brick?.trim() || FOCUS_NO_BRICK;
    const bricks = byGrade.get(grade) ?? new Map<string, T[]>();
    byGrade.set(grade, bricks);
    const list = bricks.get(brick) ?? [];
    bricks.set(brick, list);
    list.push(entry);
  }
  const last = (value: string, placeholder: string) => (value === placeholder ? 1 : 0);
  return [...byGrade.entries()]
    .sort(([left], [right]) => last(left, FOCUS_NO_GRADE) - last(right, FOCUS_NO_GRADE) || left.localeCompare(right))
    .map(([grade, bricks]) => {
      const groups = [...bricks.entries()]
        .sort(([left], [right]) => last(left, FOCUS_NO_BRICK) - last(right, FOCUS_NO_BRICK) || left.localeCompare(right))
        .map(([brick, list]) => ({ brick, entries: [...list].sort((a, b) => a.customerName.localeCompare(b.customerName)) }));
      return { grade, count: groups.reduce((sum, group) => sum + group.entries.length, 0), bricks: groups };
    });
}

export type FocusReviewStatus = "waiting" | "kept";

/** What the rep reads about where his push stands — never who judged it, never a count. */
export function focusStandingText(status: FocusReviewStatus, pushedAs: "rep" | "manager"): string {
  if (pushedAs === "manager") return "Added by your manager";
  return status === "kept" ? "Kept by your manager" : "Waiting for your manager";
}

const FOCUS_VISIT_KIND_LABELS: Record<string, string> = {
  single: "Single visit",
  double: "Double visit",
  chain: "Chain visit",
  product_manager: "Product manager visit",
};

/** A visit's kind as the tracking names it; an unknown kind reads as a visit, never as a code. */
export function focusVisitKindLabel(kind: string | null | undefined): string {
  return (kind && FOCUS_VISIT_KIND_LABELS[kind]) || "Visit";
}

// ── What the Focus list screen reads (server/focus-list.ts builds it) ─────────────────────────────────────────

export type FocusLastVisit = {
  day: string;
  /** When the visit was SAVED (the rep's `captured_at`), never when he was at the door. Null for an old-CRM copy. */
  savedAt: string | null;
  kind: string;
  by: string;
  place: string | null;
  address: string | null;
  brick: string | null;
  imported: boolean;
};

export type FocusTracking = {
  visits: number;
  weeks: FocusWeekCount[];
  weeklyAverage: number;
  last: FocusLastVisit | null;
};

export type FocusEntry = {
  id: string;
  seatId: string;
  territoryName: string;
  customerId: string;
  customerName: string;
  speciality: string | null;
  grade: string | null;
  brick: string | null;
  reason: string;
  reasonPickLabel: string | null;
  pushedAs: "rep" | "manager";
  pushedAt: string;
  reviewStatus: FocusReviewStatus;
  /** The rep's sentence — "Waiting for your manager", "Kept by your manager", "Added by your manager". */
  standing: string;
  canKeep: boolean;
  canReturn: boolean;
  /** Manager mode only. */
  repNames?: string[];
  pushedByName?: string;
  tracking?: FocusTracking;
};

export type FocusTerritoryChoice = { seatId: string; name: string; repNames: string[] };

export type FocusListView = {
  mode: "rep" | "manager";
  isTest: boolean;
  today: string;
  /** The territory the list is of, or "all" — every territory the manager picks from. */
  selected: string;
  territories: FocusTerritoryChoice[];
  /** Whether the viewer may add a PM customer to the selected territory's list (never on "all"). */
  canPush: boolean;
  /** Manager mode: the period the tracking reads and its field weeks. */
  period: FocusPeriod | null;
  weeks: string[];
  entries: FocusEntry[];
  waiting: number;
};

export type FocusCandidate = { customerId: string; name: string; speciality: string | null; grade: string | null; brick: string | null };
