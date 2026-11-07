// Recruitment — the interview calendar's week, days and half-hour rows, in Cairo local time.
//
// PURE AND CLIENT-SAFE. The schedule dialog, the calendar grid, the API and both exports all read
// the week from here, so a slot the dialog offers is a slot the grid has a row for and the export
// prints. Nothing in this file reads `process.env`, the database or the clock unless it is handed
// one — which is why the Cairo conversion below names "Africa/Cairo" itself rather than going
// through src/lib/attendance/timezone.ts (that one reads the server's environment).
//
// THE WEEK IS THE OWNER'S: every day of it, Sunday first, 9:00 AM to 5:00 PM, one row every 30
// minutes. An interview must start at 9:00 AM or later and END by 5:00 PM. It was Sunday to Thursday
// from 2026-09-18 until the owner opened Friday and Saturday on 7 Nov 2026: "remove this Interviews
// are booked Sunday to Thursday only. make able to schedule any day in the week".
//
// A DAY IS A "DATE KEY" — "2026-09-20" — never a Date. A Date is an instant, and an instant is a
// different calendar day in Cairo and in UTC for two or three hours of every night; carrying the
// key instead means no screen can shift an interview onto the neighbouring day by formatting it in
// the wrong zone. Arithmetic on keys runs at UTC noon, which no offset can push across midnight.

export const CALENDAR_TIME_ZONE = "Africa/Cairo";

/** 9:00 AM, in minutes after midnight. */
export const WORKDAY_START_MINUTES = 9 * 60;
/** 5:00 PM — the last interview must END by then. */
export const WORKDAY_END_MINUTES = 17 * 60;
export const SLOT_MINUTES = 30;

/** Sunday = 0 … Saturday = 6 — every day of the week can hold an interview (owner, 7 Nov 2026). */
export const CALENDAR_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

/** The lengths the dialog offers as buttons. */
export const DURATION_CHOICES = [30, 45, 60] as const;
/**
 * The longer ones, up to the whole working day — the owner, 2026-09-18: a single interview can run
 * "from 11 a.m. to 3 p.m.", or all of 9 to 5. Offered from a list beside the buttons.
 */
export const LONG_DURATION_CHOICES = [90, 120, 150, 180, 240, 300, 360, 420, 480] as const;
export const ALL_DURATION_CHOICES: readonly number[] = [...DURATION_CHOICES, ...LONG_DURATION_CHOICES];
export const DEFAULT_DURATION_MINUTES = 30;
/** The longest anything on the calendar can run: the whole day, 9:00 AM to 5:00 PM. */
export const MAX_DURATION_MINUTES = 8 * 60;

/**
 * An interview SESSION — one meeting for a block of the day, cut into slots a candidate each (the
 * owner, 2026-09-18: "day 20 from 11 a.m. to 3 p.m." with a candidate every half hour). The slot
 * lengths it offers; every slot starts on a quarter hour, like every interview.
 */
export const SESSION_SLOT_CHOICES = [15, 30, 45, 60] as const;
export const DEFAULT_SESSION_SLOT_MINUTES = 30;

/** "30 min", "1 h 30 min", "8 h". */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** A real calendar day written as YYYY-MM-DD — "2026-02-30" is refused, not rolled into March. */
export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_KEY.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day, 12));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function keyParts(key: string): [number, number, number] {
  const match = DATE_KEY.exec(key);
  if (!match) throw new Error(`Not a date: ${key}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function noonOf(key: string): Date {
  const [year, month, day] = keyParts(key);
  return new Date(Date.UTC(year, month - 1, day, 12));
}

function keyOf(noon: Date): string {
  return `${noon.getUTCFullYear()}-${pad(noon.getUTCMonth() + 1)}-${pad(noon.getUTCDate())}`;
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(key: string): number {
  return noonOf(key).getUTCDay();
}

export function addDays(key: string, days: number): string {
  const noon = noonOf(key);
  noon.setUTCDate(noon.getUTCDate() + days);
  return keyOf(noon);
}

/** The Sunday that starts the week holding this day. */
export function weekStartFor(key: string): string {
  return addDays(key, -weekdayOf(key));
}

/** The interview days of the week that starts on `weekStart` — Sunday to Saturday. */
export function weekDays(weekStart: string): string[] {
  const sunday = weekStartFor(weekStart);
  return CALENDAR_WEEKDAYS.map((offset) => addDays(sunday, offset));
}

/** Minutes after midnight of every row: 9:00 AM … 4:30 PM, sixteen rows. */
export function slotStarts(): number[] {
  const starts: number[] = [];
  for (let minutes = WORKDAY_START_MINUTES; minutes < WORKDAY_END_MINUTES; minutes += SLOT_MINUTES) {
    starts.push(minutes);
  }
  return starts;
}

/** The row an interview is drawn in: the half hour its start falls inside. */
export function slotFor(minutes: number): number {
  return minutes - (minutes % SLOT_MINUTES);
}

/** 570 → "9:30 AM". The owner's sheet writes time this way, so the screen and the file do too. */
export function formatTimeOfDay(minutes: number): string {
  const hours24 = Math.floor(minutes / 60) % 24;
  const mins = minutes % 60;
  const suffix = hours24 >= 12 ? "PM" : "AM";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12}:${pad(mins)} ${suffix}`;
}

/** "9:30 AM – 10:15 AM". */
export function formatTimeRange(startMinutes: number, durationMinutes: number): string {
  return `${formatTimeOfDay(startMinutes)} – ${formatTimeOfDay(startMinutes + durationMinutes)}`;
}

export function isBookableDay(key: string): boolean {
  return isDateKey(key) && (CALENDAR_WEEKDAYS as readonly number[]).includes(weekdayOf(key));
}

/** Starts at 9:00 AM or later, on a quarter hour, and ends by 5:00 PM. */
export function isBookableWindow(startMinutes: number, durationMinutes: number): boolean {
  if (!Number.isInteger(startMinutes) || !Number.isInteger(durationMinutes)) return false;
  if (startMinutes % 15 !== 0 || durationMinutes % 15 !== 0) return false;
  if (durationMinutes < 15 || durationMinutes > MAX_DURATION_MINUTES) return false;
  return startMinutes >= WORKDAY_START_MINUTES && startMinutes + durationMinutes <= WORKDAY_END_MINUTES;
}

/** "Sunday". */
export function weekdayName(key: string): string {
  return WEEKDAY_NAMES[weekdayOf(key)];
}

/** "Sun". */
export function weekdayShort(key: string): string {
  return WEEKDAY_SHORT[weekdayOf(key)];
}

/** "20 September 2026". */
export function formatLongDate(key: string): string {
  const [year, month, day] = keyParts(key);
  return `${day} ${MONTH_NAMES[month - 1]} ${year}`;
}

/** "Sunday 20 September 2026". */
export function formatDayLong(key: string): string {
  return `${weekdayName(key)} ${formatLongDate(key)}`;
}

/** "20 Sep". */
export function formatShortDate(key: string): string {
  const [, month, day] = keyParts(key);
  return `${day} ${MONTH_SHORT[month - 1]}`;
}

/** "September 2026" — the date picker's caption. */
export function formatMonthCaption(year: number, monthIndex: number): string {
  return `${MONTH_NAMES[monthIndex]} ${year}`;
}

/** "20 – 24 September 2026", or across a month or year boundary "29 September – 3 October 2026". */
export function formatWeekRange(weekStart: string): string {
  const days = weekDays(weekStart);
  const [firstYear, firstMonth, firstDay] = keyParts(days[0]);
  const [lastYear, lastMonth, lastDay] = keyParts(days[days.length - 1]);
  if (firstYear !== lastYear) {
    return `${firstDay} ${MONTH_NAMES[firstMonth - 1]} ${firstYear} – ${lastDay} ${MONTH_NAMES[lastMonth - 1]} ${lastYear}`;
  }
  if (firstMonth !== lastMonth) {
    return `${firstDay} ${MONTH_NAMES[firstMonth - 1]} – ${lastDay} ${MONTH_NAMES[lastMonth - 1]} ${lastYear}`;
  }
  return `${firstDay} – ${lastDay} ${MONTH_NAMES[lastMonth - 1]} ${lastYear}`;
}

/** "Week of: 20 September" — the owner's sheet heads its grid this way. */
export function formatWeekOf(weekStart: string): string {
  const [, month, day] = keyParts(weekStartFor(weekStart));
  return `Week of: ${day} ${MONTH_NAMES[month - 1]}`;
}

// ── Cairo local ↔ the instant stored in the database ────────────────────────────────────────────

const CAIRO_PARTS = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "2-digit",
  second: "2-digit",
  timeZone: CALENDAR_TIME_ZONE,
  year: "numeric",
});

function cairoWallClock(instant: Date): { key: string; minutes: number; asUtcMs: number } {
  const parts: Record<string, number> = {};
  for (const part of CAIRO_PARTS.formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const hour = parts.hour === 24 ? 0 : parts.hour;
  const key = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  return {
    asUtcMs: Date.UTC(parts.year, parts.month - 1, parts.day, hour, parts.minute, parts.second),
    key,
    minutes: hour * 60 + parts.minute,
  };
}

/** The Cairo calendar day an instant falls on. */
export function cairoDateKey(instant: Date): string {
  return cairoWallClock(instant).key;
}

/** A requested day that is before today (Cairo) — a request on it can no longer be given a time. */
export function requestDayHasPassed(requestedDay: string, todayKey: string): boolean {
  return requestedDay < todayKey;
}

/** Minutes after Cairo midnight for an instant. */
export function cairoMinutesOfDay(instant: Date): number {
  return cairoWallClock(instant).minutes;
}

/**
 * The instant that reads `minutes` after midnight on `key` on a Cairo wall clock.
 *
 * Egypt keeps daylight saving again since 2023, so the offset is +2 or +3 depending on the date and
 * cannot be a constant. The guess-and-correct below reads the real offset at the answer; it needs
 * one correction at most. Egypt changes its clocks at midnight, so the 9-to-5 window this calendar
 * books is never inside a skipped or repeated hour.
 */
export function cairoLocalToUtc(key: string, minutes: number): Date {
  const [year, month, day] = keyParts(key);
  const wanted = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
  let guess = wanted - 2 * 60 * 60 * 1000;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const drift = cairoWallClock(new Date(guess)).asUtcMs - wanted;
    if (drift === 0) break;
    guess -= drift;
  }
  return new Date(guess);
}

/** The Sunday of the week that holds today in Cairo. */
export function currentWeekStart(now: Date): string {
  return weekStartFor(cairoDateKey(now));
}

/**
 * The week the calendar opens on: this week while it still has an interview day left in it, else the
 * coming one. With every day an interview day, that is always this week.
 */
export function upcomingWeekStart(now: Date): string {
  const today = cairoDateKey(now);
  const sunday = weekStartFor(today);
  return (CALENDAR_WEEKDAYS as readonly number[]).includes(weekdayOf(today)) ? sunday : addDays(sunday, 7);
}

/** The first and last instant of the week, for the database query: Sunday 00:00 to next Sunday 00:00. */
export function weekInstantRange(weekStart: string): { from: Date; to: Date } {
  const sunday = weekStartFor(weekStart);
  return { from: cairoLocalToUtc(sunday, 0), to: cairoLocalToUtc(addDays(sunday, 7), 0) };
}

/** The grid of a month for the date picker: whole weeks, Sunday first, days outside the month blank. */
export function monthGrid(year: number, monthIndex: number): Array<Array<string | null>> {
  const first = `${year}-${pad(monthIndex + 1)}-01`;
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0, 12)).getUTCDate();
  const rows: Array<Array<string | null>> = [];
  let row: Array<string | null> = Array.from({ length: weekdayOf(first) }, () => null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    row.push(`${year}-${pad(monthIndex + 1)}-${pad(day)}`);
    if (row.length === 7) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length > 0) {
    while (row.length < 7) row.push(null);
    rows.push(row);
  }
  return rows;
}

export const WEEKDAY_INITIALS = WEEKDAY_SHORT;
