/**
 * Phoenix CRM — when the rep means to START his AM round and his PM round on a planned day, with no I/O.
 *
 * The old CRM's weekly plan carried "Start AM 11:00 AM · Start PM 2:00 PM" on every day, and its Daily
 * Plan report repeated them in the day's header. The owner walked through both on 2026-09-29, and
 * "Start AM / Start PM time for each day" was one of the Plan items his status sheet of 2026-09-30
 * marked not done.
 *
 * 🔴 A STATEMENT, NEVER A RULE. They are the rep's own word about his day. No call rate reads them, no
 * visit is judged against them, and nothing he ticks is refused because of them — golden rule #1: his
 * app never checks him, and a start time turned into a check would be one.
 *
 * Both are optional and stand apart: a day may carry one, the other, both or neither. A Thursday is a
 * morning (AM only), so a PM start sent for one is dropped rather than refused — a detail of the plan is
 * never a reason to lose the plan, which is how a planned activity on a day that cannot change is
 * treated too.
 *
 * Minutes of the Cairo day (0–1439), as a plan item's own start minute is, so the clock helpers in
 * timings.ts read and write them.
 */

import { planDayListTypes } from "@/lib/phoenix-crm/calendar";
import { clockValue, formatClockMinute, parseClockMinute } from "@/lib/phoenix-crm/timings";

/** One day's two start times; null where he set none. */
export type PlanDayStarts = { startAmMinute: number | null; startPmMinute: number | null };

/** A day's start times as the week's save carries them. */
export type PlannedDayStart = PlanDayStarts & { planDate: string };

const LAST_MINUTE_OF_DAY = 23 * 60 + 59;

export function noDayStarts(): PlanDayStarts {
  return { startAmMinute: null, startPmMinute: null };
}

/** A whole minute of the day, 0 to 1439. */
export function isMinuteOfDay(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= LAST_MINUTE_OF_DAY;
}

function minuteOrNull(value: unknown): number | null {
  return isMinuteOfDay(value) ? value : null;
}

export function hasDayStarts(starts: PlanDayStarts): boolean {
  return starts.startAmMinute !== null || starts.startPmMinute !== null;
}

/** A time input's "11:00" → 660; an empty input, or anything that is not a clock time → null. */
export function startMinuteFromInput(value: string): number | null {
  return value.trim() === "" ? null : parseClockMinute(value);
}

/** 660 → "11:00", the value a time input holds; null → "". */
export function startInputValue(minute: number | null): string {
  return minute === null ? "" : clockValue(minute);
}

/**
 * "Start AM 11:00 AM · Start PM 5:00 PM" — the old weekly plan's own words, and only the ones he set.
 * Null when he set neither, so a day read back says nothing rather than "no start time".
 */
export function describeDayStarts(starts: PlanDayStarts): string | null {
  const parts: string[] = [];
  if (starts.startAmMinute !== null) parts.push(`Start AM ${formatClockMinute(starts.startAmMinute)}`);
  if (starts.startPmMinute !== null) parts.push(`Start PM ${formatClockMinute(starts.startPmMinute)}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** What a day can carry: a morning (a Thursday) has no PM round, so it keeps no PM start. */
export function startsForDay(date: string, starts: PlanDayStarts): PlanDayStarts {
  const lists = planDayListTypes(date);
  return {
    startAmMinute: lists.includes("AM") ? minuteOrNull(starts.startAmMinute) : null,
    startPmMinute: lists.includes("PM") ? minuteOrNull(starts.startPmMinute) : null,
  };
}

/** One day's start times out of the week's list, or neither. */
export function startsOn(starts: ReadonlyArray<PlannedDayStart>, date: string): PlanDayStarts {
  const found = starts.find((entry) => entry.planDate === date);
  return found ? { startAmMinute: found.startAmMinute, startPmMinute: found.startPmMinute } : noDayStarts();
}

/** Sets one day's start times. A day left with neither comes off the list — that is how a save clears it. */
export function setPlannedStart(starts: ReadonlyArray<PlannedDayStart>, date: string, next: PlanDayStarts): PlannedDayStart[] {
  const rest = starts.filter((entry) => entry.planDate !== date);
  const all = hasDayStarts(next) ? [...rest, { planDate: date, startAmMinute: next.startAmMinute, startPmMinute: next.startPmMinute }] : rest;
  return all.sort((left, right) => left.planDate.localeCompare(right.planDate));
}

/**
 * The start times from a save body, on the days the rep may still change. Anything else is DROPPED, not
 * refused: a start time is a detail of the plan, never a reason to lose the plan. One entry a day — the
 * last one sent wins — and a day left with neither time is simply not in the list.
 */
export function parsePlanDayStarts(raw: unknown, editableDays: ReadonlySet<string>): PlannedDayStart[] {
  if (!Array.isArray(raw)) return [];
  const byDay = new Map<string, PlannedDayStart>();
  for (const entry of raw) {
    const body = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const planDate = typeof body.planDate === "string" ? body.planDate : null;
    if (!planDate || !editableDays.has(planDate)) continue;
    const starts = startsForDay(planDate, { startAmMinute: minuteOrNull(body.startAmMinute), startPmMinute: minuteOrNull(body.startPmMinute) });
    if (hasDayStarts(starts)) byDay.set(planDate, { planDate, ...starts });
    else byDay.delete(planDate);
  }
  return [...byDay.values()].sort((left, right) => left.planDate.localeCompare(right.planDate));
}
