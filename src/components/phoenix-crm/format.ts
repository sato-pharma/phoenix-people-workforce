/**
 * Phoenix CRM — how days, times, counts and shares read on screen.
 *
 * Built from numbers, never from the browser's date formatting: the server renders the page first and
 * the phone renders it again, and a phone's older date data would print a different hour or month
 * name (React throws the server's page away on one differing character). Times are Cairo's, from the
 * offset table that ships with the code (src/lib/format/cairo-zone.ts).
 */

import { weekdayOfIsoDay } from "@/lib/phoenix-crm/calendar";
import { formatClockMinute, PHOENIX_CRM_WEEKDAY_NAMES, PHOENIX_CRM_WEEKDAY_SHORT } from "@/lib/phoenix-crm/timings";
import { CAIRO_MONTHS } from "@/lib/format/cairo-datetime";
import { cairoWallClock } from "@/lib/format/cairo-zone";

// Short month names come from the one table the rest of Phoenix prints (CAIRO_MONTHS). Full names
// never changed between engines, so they are spelled out here.
const MONTH_LONG = [
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

function isoParts(isoDay: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** "Wed 16 Sept" */
export function dayLabel(isoDay: string): string {
  const parts = isoParts(isoDay);
  if (!parts) return "—";
  return `${PHOENIX_CRM_WEEKDAY_SHORT[weekdayOfIsoDay(isoDay)]} ${parts.day} ${CAIRO_MONTHS[parts.month - 1]}`;
}

/** "Wed 16 Sept 2026" */
export function dayLabelWithYear(isoDay: string): string {
  const parts = isoParts(isoDay);
  if (!parts) return "—";
  return `${dayLabel(isoDay)} ${parts.year}`;
}

/** "Wednesday 16 September 2026" */
export function dayLabelLong(isoDay: string): string {
  const parts = isoParts(isoDay);
  if (!parts) return "—";
  return `${PHOENIX_CRM_WEEKDAY_NAMES[weekdayOfIsoDay(isoDay)]} ${parts.day} ${MONTH_LONG[parts.month - 1]} ${parts.year}`;
}

/** "September 2026", from "2026-09". */
export function monthLabel(monthKey: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) return "—";
  return `${MONTH_LONG[Number(match[2]) - 1]} ${match[1]}`;
}

/** The ISO day `days` after (or before) this one. */
export function shiftIsoDay(isoDay: string, days: number): string {
  const value = new Date(`${isoDay}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** "Sat 12 Sept – Thu 17 Sept", for a field week starting that Saturday. */
export function weekLabel(weekStart: string): string {
  return `${dayLabel(weekStart)} – ${dayLabel(shiftIsoDay(weekStart, 5))}`;
}

function instantOf(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const value = new Date(iso);
  return Number.isNaN(value.getTime()) ? null : value;
}

/** "6:30 PM" in Cairo. */
export function cairoClock(iso: string | null | undefined): string {
  const value = instantOf(iso);
  if (!value) return "—";
  const wall = cairoWallClock(value);
  return formatClockMinute(wall.getUTCHours() * 60 + wall.getUTCMinutes());
}

/** "18:30" in Cairo — the 24-hour form, for a time printed beside a long date. */
export function cairoClock24(iso: string | null | undefined): string {
  const value = instantOf(iso);
  if (!value) return "—";
  const wall = cairoWallClock(value);
  return `${String(wall.getUTCHours()).padStart(2, "0")}:${String(wall.getUTCMinutes()).padStart(2, "0")}`;
}

/** The Cairo calendar day of an instant, "2026-09-16". */
export function cairoDayOf(iso: string | null | undefined): string | null {
  const value = instantOf(iso);
  return value ? cairoWallClock(value).toISOString().slice(0, 10) : null;
}

/** "Wed 16 Sept, 6:30 PM" in Cairo. */
export function cairoStamp(iso: string | null | undefined): string {
  const day = cairoDayOf(iso);
  return day ? `${dayLabel(day)}, ${cairoClock(iso)}` : "—";
}

const COUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function countText(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? COUNT.format(value) : "—";
}

/** "68.4%", "100%"; no list to measure against reads "—", never a misleading 0%. */
export function percentText(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

/**
 * A figure's colour. Report percentages stay neutral: nobody has set a coverage or frequency level
 * that counts as good, so the screens do not invent one.
 */
export type Tone = "good" | "warn" | "bad" | "neutral";

/** "3 doctors", "1 account" — the word follows the count. */
export function plural(count: number, one: string, many: string): string {
  return `${countText(count)} ${count === 1 ? one : many}`;
}
