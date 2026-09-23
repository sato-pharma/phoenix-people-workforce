/**
 * Phoenix CRM — a customer's timings on the phone, with no I/O.
 *
 * PURE PORT of the web module's `src/lib/phoenix-crm/timings.ts`. `mobile/` is its own TypeScript
 * project and cannot import server-adjacent code, so the pure clock helpers and the same checks are
 * transcribed here, function for function. They must stay in step with the web copy — the server
 * applies the very same `parseTimings` when it saves, so a slip caught here is one the save would also
 * refuse, and a rule that drifts would let the phone offer a save the server then rejects at the door.
 */

import type { CrmSeason, CrmTiming } from "@/lib/crm/types";

export const CRM_WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const CRM_WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
/** The order a field-force week reads in: Saturday first. */
export const CRM_WEEKDAY_ORDER = [6, 0, 1, 2, 3, 4, 5] as const;

const MINUTES_PER_DAY = 1440;
/** A window may run past midnight, never beyond 6:00 AM of the next day. */
const LATEST_END_MINUTE = MINUTES_PER_DAY + 360;
/** No customer receives for more than 16 hours in one window; longer is a typing slip. */
const LONGEST_WINDOW_MINUTES = 16 * 60;
export const CRM_WINDOWS_PER_DAY_MAX = 4;

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

/** 1110 → "18:30". A past-midnight end folds back onto the clock. */
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
export function formatTimingWindow(timing: Pick<CrmTiming, "startMinute" | "endMinute">): string {
  if (timing.endMinute === null) return `from ${formatClockMinute(timing.startMinute)}`;
  return `${formatClockMinute(timing.startMinute)} – ${formatClockMinute(timing.endMinute)}`;
}

export type SeasonalWindows = {
  windows: CrmTiming[];
  /** True when it is Ramadan and the customer has no Ramadan timings, so the normal ones are shown. */
  noRamadanTime: boolean;
};

/**
 * The windows that apply on a weekday. PURE PORT of the web `windowsForWeekday`: in Ramadan the
 * special timings are read; a customer with none falls back to the normal timings, flagged
 * "no Ramadan time" (owner decision 2026-09-16).
 */
export function windowsForWeekday(timings: ReadonlyArray<CrmTiming>, weekday: number, ramadan: boolean): SeasonalWindows {
  if (ramadan) {
    const hasRamadan = timings.some((timing) => timing.season === "ramadan");
    if (hasRamadan) {
      return { windows: timings.filter((timing) => timing.season === "ramadan" && timing.weekday === weekday), noRamadanTime: false };
    }
    return { windows: timings.filter((timing) => timing.season === "normal" && timing.weekday === weekday), noRamadanTime: true };
  }
  return { windows: timings.filter((timing) => timing.season === "normal" && timing.weekday === weekday), noRamadanTime: false };
}

/** "Sat, Mon, Tue" — the days a place receives in a season, in field-week order. Mirrors the web copy. */
export function receivingDaysLabel(timings: ReadonlyArray<CrmTiming>, season: CrmSeason = "normal"): string {
  const days = new Set(timings.filter((timing) => timing.season === season).map((timing) => timing.weekday));
  return CRM_WEEKDAY_ORDER.filter((weekday) => days.has(weekday))
    .map((weekday) => CRM_WEEKDAY_SHORT[weekday])
    .join(", ");
}

/**
 * The end a rep typed, placed after the start. An end on the clock before the start is read as the
 * next morning (10:00 PM to 1:00 AM), which is how a clinic that closes after midnight is entered.
 */
export function resolveEndMinute(startMinute: number, endClockMinute: number | null): number | null {
  if (endClockMinute === null) return null;
  return endClockMinute > startMinute ? endClockMinute : endClockMinute + MINUTES_PER_DAY;
}

/** The shape the routes read: clock strings, as a time input gives them. */
export function timingsToDrafts(timings: ReadonlyArray<CrmTiming>): Array<{ weekday: number; start: string; end: string; season: CrmSeason }> {
  return timings.map((timing) => ({
    weekday: timing.weekday,
    start: clockValue(timing.startMinute),
    end: timing.endMinute === null ? "" : clockValue(timing.endMinute),
    season: timing.season,
  }));
}

export type TimingDraft = { weekday: unknown; start: unknown; end?: unknown; season?: unknown };
export type TimingParseResult = { ok: true; timings: CrmTiming[] } | { ok: false; error: string };

function windowEnd(timing: CrmTiming): number {
  return timing.endMinute ?? timing.startMinute + 60;
}

/**
 * The timings a rep sent for one place: clock strings from the phone, checked and sorted. At least one
 * NORMAL window is required — that is what makes the customer real. Mirrors the server's `parseTimings`.
 */
export function parseTimings(raw: unknown): TimingParseResult {
  if (!Array.isArray(raw)) return { ok: false, error: "Add the days and hours this customer receives visits." };
  const timings: CrmTiming[] = [];
  for (const entry of raw) {
    const body = (entry && typeof entry === "object" ? entry : {}) as TimingDraft;
    const rawDay = body.weekday;
    const weekday = typeof rawDay === "number" || (typeof rawDay === "string" && rawDay.trim() !== "") ? Number(rawDay) : Number.NaN;
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return { ok: false, error: "A timing has no day. Choose the day again." };
    const dayName = CRM_WEEKDAY_NAMES[weekday];
    const startMinute = parseClockMinute(String(body.start ?? ""));
    if (startMinute === null) return { ok: false, error: `${dayName} has no start time.` };
    const endText = String(body.end ?? "").trim();
    const endClock = endText ? parseClockMinute(endText) : null;
    if (endText && endClock === null) return { ok: false, error: `${dayName} has an end time that is not a time.` };
    const endMinute = resolveEndMinute(startMinute, endClock);
    if (endMinute !== null && (endMinute > LATEST_END_MINUTE || endMinute - startMinute > LONGEST_WINDOW_MINUTES)) {
      return { ok: false, error: `${dayName} ${formatClockMinute(startMinute)} to ${formatClockMinute(endMinute)} is longer than a clinic day. Check the times.` };
    }
    const season: CrmSeason = body.season === "ramadan" ? "ramadan" : "normal";
    timings.push({ endMinute, season, startMinute, weekday });
  }

  if (!timings.some((timing) => timing.season === "normal")) {
    return { ok: false, error: "Add at least one day and time this customer receives visits." };
  }

  const sorted = sortTimings(timings);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous.season !== current.season || previous.weekday !== current.weekday) continue;
    if (current.startMinute === previous.startMinute) return { ok: false, error: `${CRM_WEEKDAY_NAMES[current.weekday]} has the same time twice.` };
    if (current.startMinute < windowEnd(previous)) {
      return { ok: false, error: `${CRM_WEEKDAY_NAMES[current.weekday]} has two times that overlap (${formatTimingWindow(previous)} and ${formatTimingWindow(current)}).` };
    }
  }
  for (const season of ["normal", "ramadan"] as const) {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const count = sorted.filter((timing) => timing.season === season && timing.weekday === weekday).length;
      if (count > CRM_WINDOWS_PER_DAY_MAX) return { ok: false, error: `${CRM_WEEKDAY_NAMES[weekday]} has more than ${CRM_WINDOWS_PER_DAY_MAX} times. Keep the real ones.` };
    }
  }
  return { ok: true, timings: sorted };
}

/** Normal timings before Ramadan ones; within each, Saturday first through the week, then by start. */
export function sortTimings(timings: CrmTiming[]): CrmTiming[] {
  const dayRank = (weekday: number) => CRM_WEEKDAY_ORDER.indexOf(weekday as (typeof CRM_WEEKDAY_ORDER)[number]);
  return [...timings].sort(
    (left, right) =>
      (left.season === right.season ? 0 : left.season === "normal" ? -1 : 1) ||
      dayRank(left.weekday) - dayRank(right.weekday) ||
      left.startMinute - right.startMinute,
  );
}

/**
 * The server's check, for a list still being built: Ramadan hours may be entered before the normal
 * ones, so "no normal hours yet" is left to the save.
 */
export function checkTimingsWhileEditing(timings: ReadonlyArray<CrmTiming>): TimingParseResult {
  if (timings.length === 0) return { ok: true, timings: [] };
  const drafts = timingsToDrafts(timings);
  const result = parseTimings(drafts);
  if (result.ok) return result;
  if (timings.some((timing) => timing.season === "normal")) return result;
  const asOneSeason = parseTimings(drafts.map((draft) => ({ ...draft, season: "normal" })));
  return asOneSeason.ok ? { ok: true, timings: sortTimings([...timings]) } : { ok: false, error: asOneSeason.error };
}
