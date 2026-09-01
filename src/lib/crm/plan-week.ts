/**
 * The field week — the vocabulary the Reps Weekly Plans tab picks with, and nothing else.
 *
 * NO I/O, deliberately. The week rule is the one thing on that tab a test must be able to pin
 * without a database, and it is also imported by a client component: a module that talked to
 * Supabase could not be.
 *
 * ## Why the week starts on SATURDAY
 *
 * Not a convention borrowed from a calendar library — measured against production on 2026-09-01,
 * over every weekly plan the CRM mirror holds (2,391 plans, 2026-01-01 to 2026-09-03):
 *
 *   Sat 2,082 · Sun 138 · Mon 83 · Tue 75 · Wed 7 · Thu 6 · Fri 0
 *
 * 87% start on a Saturday, none starts on a Friday, and the later a plan starts the shorter it is
 * (Sat plans average 3.96 days, Tue plans 1.12) — the tail is reps filing a PARTIAL week, not a
 * different week. That matches `isFieldWorkforceWeeklyOff`: a medical rep and a district manager
 * are Friday-only off, so their working week is Saturday through Thursday.
 *
 * The decisive check is the one below it: of those 2,391 plans, **zero** cross a Saturday boundary.
 * A Saturday-anchored week therefore contains every plan whole — there is no plan this picker can
 * split in half, and none it can show twice.
 *
 * ## Dates here are plain ISO wall-clock, and are never parsed into a local Date
 *
 * The vendor sends zone-less Cairo dates and the mirror stores them as-is. Every arithmetic below
 * goes through UTC on purpose: `new Date("2026-08-29")` in a browser west of Greenwich is the 28th,
 * which would shift a whole week's worth of plans by one day for that reader and nobody else.
 */

/** Saturday, as `Date.prototype.getUTCDay` numbers it. The field week's first day. */
export const FIELD_WEEK_START_DOW = 6;

/** Days in a field week. Saturday through Friday — the rep's six working days plus his day off. */
export const FIELD_WEEK_LENGTH = 7;

export type PlanWeek = {
  /** Friday. Inclusive — a plan ending on this date is inside the week. */
  end: string;
  /** What rides in the URL. The Saturday, so the key is the week and needs no separate id. */
  key: string;
  /** Written out for a human: "Sat 30 Aug – Fri 5 Sep 2026". Never a raw date range. */
  label: string;
  /** 0 = the week containing today, -1 = last week, +1 = next week. */
  offset: number;
  /** Saturday. */
  start: string;
};

/**
 * Whether `?week=` is a real calendar date.
 *
 * THE SHAPE IS NOT ENOUGH. `2026-13-45` matches the pattern, parses to NaN, and every helper below
 * ends in `.toISOString()` — which THROWS RangeError on an invalid date rather than returning
 * anything. A hand-typed, truncated or stale week parameter would take the whole board down with a
 * crash page, so the value is round-tripped through Date here and rejected unless it comes back
 * identical. Caught by tests/reps-weekly-plans.test.ts before it ever shipped.
 */
export function isPlanWeekKey(value: string | null | undefined): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function shiftDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The Saturday on or before `iso`.
 *
 * `(dow + 1) % 7` is the distance back to Saturday: Saturday itself is 0, Sunday 1, Friday 6.
 */
export function weekStartFor(iso: string): string {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return shiftDays(iso, -((dow + 1) % 7));
}

/** The Friday closing the week that `iso` falls in. */
export function weekEndFor(iso: string): string {
  return shiftDays(weekStartFor(iso), FIELD_WEEK_LENGTH - 1);
}

/**
 * Today in Cairo, as a plain ISO date.
 *
 * The owner's standing rule is that every time is Africa/Cairo, and here it decides which week the
 * picker opens on. Read through `Intl` rather than by adding three hours: Egypt has observed
 * summer time again since 2023, so a fixed offset is wrong for part of the year.
 */
export function cairoTodayIso(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).formatToParts(now);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

/**
 * "Sat 30 Aug – Fri 5 Sep 2026".
 *
 * The year appears once, at the end, unless the week straddles December — then both halves carry
 * their own, because "Sat 28 Dec – Fri 3 Jan 2027" would date the Saturday to the wrong year.
 */
export function formatPlanWeekLabel(start: string): string {
  const end = shiftDays(start, FIELD_WEEK_LENGTH - 1);
  // Composed part by part rather than through one format call. A single en-GB format of
  // weekday+day+month+year yields "Fri, 4 Sept 2026" — a comma this label does not want and
  // "Sept", the one month en-GB abbreviates to four letters, which makes the picker ragged.
  const part = (iso: string, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options }).format(new Date(`${iso}T00:00:00Z`));
  const day = (iso: string, withYear: boolean) => {
    const text = `${part(iso, { weekday: "short" })} ${part(iso, { day: "numeric" })} ${part(iso, { month: "short" })}`;
    return withYear ? `${text} ${iso.slice(0, 4)}` : text;
  };
  // The year appears once, at the end — unless the week straddles December, when both halves carry
  // their own, because "Sat 26 Dec - Fri 1 Jan 2027" would date the Saturday to the wrong year.
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  return `${day(start, !sameYear)} – ${day(end, true)}`;
}

/** True when `iso` falls inside the week starting at `start`. */
/**
 * One planned day, as a person says it: "Sun 30 Aug".
 *
 * Composed part by part for the same reason formatPlanWeekLabel is — a single en-GB call yields
 * "Sun, 30 Sept", with a comma this cell has no room for and the one month en-GB gives four
 * letters. No year: every day on this screen is inside a week the heading has already dated.
 */
export function formatPlanDay(iso: string): string {
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options }).format(new Date(`${iso}T00:00:00Z`));
  return `${part({ weekday: "short" })} ${part({ day: "numeric" })} ${part({ month: "short" })}`;
}
export function weekContains(start: string, iso: string | null | undefined): boolean {
  if (!iso) return false;
  return iso >= start && iso <= shiftDays(start, FIELD_WEEK_LENGTH - 1);
}

/**
 * The weeks the picker offers, newest first.
 *
 * FUTURE WEEKS ARE OFFERED FIRST AND ON PURPOSE. A plan is verified BEFORE the week it covers —
 * that is the whole point of the exercise — so next week is the one a district manager opens this
 * tab to act on, and burying it under six months of history would put the useful case last.
 *
 * A future week normally shows no plan at all: measured on production 2026-09-01, exactly ONE
 * weekly plan in the mirror was dated ahead of today. That empty state is the honest answer to
 * "has my rep filed yet", not a defect.
 */
export function listPlanWeeks(input: { back?: number; forward?: number; todayIso: string }): PlanWeek[] {
  const back = Math.max(0, input.back ?? 52);
  const forward = Math.max(0, input.forward ?? 4);
  const current = weekStartFor(input.todayIso);
  const weeks: PlanWeek[] = [];
  for (let offset = forward; offset >= -back; offset -= 1) {
    const start = shiftDays(current, offset * FIELD_WEEK_LENGTH);
    weeks.push({
      end: shiftDays(start, FIELD_WEEK_LENGTH - 1),
      key: start,
      label: formatPlanWeekLabel(start),
      offset,
      start,
    });
  }
  return weeks;
}

/**
 * The week a URL asked for, or the current one.
 *
 * Falls back rather than erroring, matching every other filter on these two boards: a hand-typed
 * week outside the offered range lands on the current week, which is a readable screen.
 */
export function resolvePlanWeek(requested: string | null | undefined, todayIso: string): string {
  return isPlanWeekKey(requested) ? weekStartFor(requested) : weekStartFor(todayIso);
}
