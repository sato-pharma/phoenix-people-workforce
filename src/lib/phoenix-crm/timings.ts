/**
 * Phoenix CRM — a customer's timings, with no I/O.
 *
 * Owner, 2026-09-16: a customer is a real customer only once the rep brings the customer's timings — the
 * days the customer receives visits and the hours on each day, which can differ by day ("Saturday 2 to 4"). Timings
 * belong to a PLACE: a doctor who receives in two clinics has two places, each with its own timings.
 * A second set ("special visit time") is read only in Ramadan.
 *
 * The owner's own sheet gives a start time only ("8:00"), so the end of a window is optional.
 */

import type { PhoenixCrmSeason, PhoenixCrmTiming } from "@/lib/phoenix-crm/types";

export const PHOENIX_CRM_WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const PHOENIX_CRM_WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** The order a field-force week reads in: Saturday first. */
export const PHOENIX_CRM_WEEKDAY_ORDER = [6, 0, 1, 2, 3, 4, 5] as const;

const MINUTES_PER_DAY = 1440;
/** A window may run past midnight, never beyond 6:00 AM of the next day. */
const LATEST_END_MINUTE = MINUTES_PER_DAY + 360;
/** No customer receives for more than 16 hours in one window; longer is a typing slip. */
const LONGEST_WINDOW_MINUTES = 16 * 60;
export const PHOENIX_CRM_WINDOWS_PER_DAY_MAX = 4;

const CLOCK_PATTERN = /^(\d{1,2}):(\d{2})$/;

/** "18:30" → 1110. Null for anything that is not a real clock time. */
export function parseClockMinute(value: string): number | null {
  const match = CLOCK_PATTERN.exec(String(value ?? "").trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** 1110 → "18:30", for a time input. A past-midnight end folds back onto the clock. */
export function clockValue(minute: number): string {
  const folded = ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = Math.floor(folded / 60);
  const minutes = folded % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** 1110 → "6:30 PM"; 1500 → "1:00 AM". */
export function formatClockMinute(minute: number): string {
  const folded = ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours24 = Math.floor(folded / 60);
  const minutes = folded % 60;
  const suffix = hours24 < 12 ? "AM" : "PM";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

/** "6:00 PM – 8:00 PM", or "from 6:00 PM" when the end is not known. */
export function formatTimingWindow(timing: Pick<PhoenixCrmTiming, "startMinute" | "endMinute">): string {
  if (timing.endMinute === null) return `from ${formatClockMinute(timing.startMinute)}`;
  return `${formatClockMinute(timing.startMinute)} – ${formatClockMinute(timing.endMinute)}`;
}

/**
 * The end a rep typed, placed after the start. An end on the clock before the start is read as the
 * next morning (10:00 PM to 1:00 AM), which is how a clinic that closes after midnight is entered.
 */
export function resolveEndMinute(startMinute: number, endClockMinute: number | null): number | null {
  if (endClockMinute === null) return null;
  return endClockMinute > startMinute ? endClockMinute : endClockMinute + MINUTES_PER_DAY;
}

export type TimingDraft = {
  weekday: unknown;
  start: unknown;
  end?: unknown;
  season?: unknown;
};

export type TimingParseResult = { ok: true; timings: PhoenixCrmTiming[] } | { ok: false; error: string };

function windowEnd(timing: PhoenixCrmTiming): number {
  // An open-ended window is treated as one hour long when checking for overlaps.
  return timing.endMinute ?? timing.startMinute + 60;
}

/**
 * The timings a rep sent for one place: clock strings from the phone, checked and sorted.
 * At least one NORMAL window is required — that is what makes the customer real.
 */
export function parseTimings(raw: unknown): TimingParseResult {
  if (!Array.isArray(raw)) return { ok: false, error: "Add the days and hours this customer receives visits." };
  const timings: PhoenixCrmTiming[] = [];
  for (const entry of raw) {
    const body = (entry && typeof entry === "object" ? entry : {}) as TimingDraft;
    // A missing day is never Sunday: Number(null), Number("") and Number(false) are all 0.
    const rawDay = body.weekday;
    const weekday = typeof rawDay === "number" || (typeof rawDay === "string" && rawDay.trim() !== "") ? Number(rawDay) : Number.NaN;
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return { ok: false, error: "A timing has no day. Choose the day again." };
    }
    const dayName = PHOENIX_CRM_WEEKDAY_NAMES[weekday];
    const startMinute = parseClockMinute(String(body.start ?? ""));
    if (startMinute === null) return { ok: false, error: `${dayName} has no start time.` };
    const endText = String(body.end ?? "").trim();
    const endClock = endText ? parseClockMinute(endText) : null;
    if (endText && endClock === null) return { ok: false, error: `${dayName} has an end time that is not a time.` };
    const endMinute = resolveEndMinute(startMinute, endClock);
    if (endMinute !== null && (endMinute > LATEST_END_MINUTE || endMinute - startMinute > LONGEST_WINDOW_MINUTES)) {
      return {
        ok: false,
        error: `${dayName} ${formatClockMinute(startMinute)} to ${formatClockMinute(endMinute)} is longer than a clinic day. Check the times.`,
      };
    }
    const season: PhoenixCrmSeason = body.season === "ramadan" ? "ramadan" : "normal";
    timings.push({ weekday, startMinute, endMinute, season });
  }

  if (!timings.some((timing) => timing.season === "normal")) {
    return { ok: false, error: "Add at least one day and time this customer receives visits." };
  }

  const sorted = sortTimings(timings);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous.season !== current.season || previous.weekday !== current.weekday) continue;
    if (current.startMinute === previous.startMinute) {
      return { ok: false, error: `${PHOENIX_CRM_WEEKDAY_NAMES[current.weekday]} has the same time twice.` };
    }
    if (current.startMinute < windowEnd(previous)) {
      return {
        ok: false,
        error: `${PHOENIX_CRM_WEEKDAY_NAMES[current.weekday]} has two times that overlap (${formatTimingWindow(previous)} and ${formatTimingWindow(current)}).`,
      };
    }
  }
  for (const season of ["normal", "ramadan"] as const) {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const count = sorted.filter((timing) => timing.season === season && timing.weekday === weekday).length;
      if (count > PHOENIX_CRM_WINDOWS_PER_DAY_MAX) {
        return {
          ok: false,
          error: `${PHOENIX_CRM_WEEKDAY_NAMES[weekday]} has more than ${PHOENIX_CRM_WINDOWS_PER_DAY_MAX} times. Keep the real ones.`,
        };
      }
    }
  }
  return { ok: true, timings: sorted };
}

/** Normal timings before Ramadan ones; within each, Saturday first through the week, then by start. */
export function sortTimings(timings: PhoenixCrmTiming[]): PhoenixCrmTiming[] {
  const dayRank = (weekday: number) => PHOENIX_CRM_WEEKDAY_ORDER.indexOf(weekday as (typeof PHOENIX_CRM_WEEKDAY_ORDER)[number]);
  return [...timings].sort(
    (left, right) =>
      (left.season === right.season ? 0 : left.season === "normal" ? -1 : 1) ||
      dayRank(left.weekday) - dayRank(right.weekday) ||
      left.startMinute - right.startMinute,
  );
}

export type SeasonalWindows = {
  windows: PhoenixCrmTiming[];
  /** True when it is Ramadan and the customer has no Ramadan timings, so the normal ones are shown. */
  noRamadanTime: boolean;
};

/**
 * The windows that apply on a weekday. In Ramadan the special timings are read; a customer with none
 * falls back to the normal timings, flagged "no Ramadan time" (decision 2026-09-16).
 */
export function windowsForWeekday(timings: PhoenixCrmTiming[], weekday: number, ramadan: boolean): SeasonalWindows {
  if (ramadan) {
    const hasRamadanTimings = timings.some((timing) => timing.season === "ramadan");
    if (hasRamadanTimings) {
      return { windows: timings.filter((timing) => timing.season === "ramadan" && timing.weekday === weekday), noRamadanTime: false };
    }
    return { windows: timings.filter((timing) => timing.season === "normal" && timing.weekday === weekday), noRamadanTime: true };
  }
  return { windows: timings.filter((timing) => timing.season === "normal" && timing.weekday === weekday), noRamadanTime: false };
}

/**
 * A window overlaps a clock range [fromMinute, toMinute). Used by the day filter "receives on this day
 * between X and Y". An open-ended window counts as one hour long, as everywhere else, and a window that
 * runs past midnight is compared on its real end so a late clinic still matches a late range.
 */
export function windowOverlapsRange(
  window: Pick<PhoenixCrmTiming, "startMinute" | "endMinute">,
  fromMinute: number,
  toMinute: number,
): boolean {
  const end = window.endMinute ?? window.startMinute + 60;
  return window.startMinute < toMinute && end > fromMinute;
}

/** True when the customer receives on `weekday` in a window overlapping [fromMinute, toMinute). */
export function receivesInRange(
  timings: PhoenixCrmTiming[],
  weekday: number,
  ramadan: boolean,
  fromMinute: number,
  toMinute: number,
): boolean {
  return windowsForWeekday(timings, weekday, ramadan).windows.some((window) => windowOverlapsRange(window, fromMinute, toMinute));
}

/**
 * "Sat 5:00 PM – 8:00 PM · Mon 6:00 PM" — every day a place receives, Saturday first, on a Ramadan day
 * its Ramadan hours where it has them. The plan's hours column (owner, 2026-09-30: "add a column for
 * timings but never block"). Empty when nothing is saved.
 */
export function weekTimingsText(timings: PhoenixCrmTiming[], ramadan: boolean): string {
  return PHOENIX_CRM_WEEKDAY_ORDER.map((weekday) => {
    const { windows } = windowsForWeekday(timings, weekday, ramadan);
    const ordered = [...windows].sort((left, right) => left.startMinute - right.startMinute);
    return ordered.length > 0 ? `${PHOENIX_CRM_WEEKDAY_SHORT[weekday]} ${ordered.map((window) => formatTimingWindow(window)).join(", ")}` : null;
  })
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/** "Sat, Mon, Tue" — the days a set of timings covers, Saturday first. */
export function receivingDaysLabel(timings: PhoenixCrmTiming[], season: PhoenixCrmSeason = "normal"): string {
  const days = new Set(timings.filter((timing) => timing.season === season).map((timing) => timing.weekday));
  return PHOENIX_CRM_WEEKDAY_ORDER.filter((weekday) => days.has(weekday))
    .map((weekday) => PHOENIX_CRM_WEEKDAY_SHORT[weekday])
    .join(", ");
}
