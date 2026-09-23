/**
 * Phoenix CRM — how days, times and counts read on the phone.
 *
 * Times are Cairo's, always (owner rule): the rep is in Egypt and the server reports Cairo, so a raw
 * device clock would print the wrong hour on a phone set to another zone. `Intl` with the
 * `Africa/Cairo` time zone handles the offset and its DST; the app already formats dates this way
 * (departure-photo-card.tsx). A calendar day ("2026-09-16") is a date, not an instant, so it is built
 * at noon UTC and read in UTC — the day is the same whatever zone the phone is on.
 */

const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
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
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"] as const;

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDay(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DAY.test(value)) return false;
  const instant = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(instant.getTime());
}

/** The weekday (0=Sun) of an ISO day, built at noon UTC so the zone cannot shift it. */
function weekdayOf(isoDay: string): number {
  return new Date(`${isoDay}T12:00:00Z`).getUTCDay();
}

function isoParts(isoDay: string): { year: number; month: number; day: number } | null {
  const match = ISO_DAY.exec(isoDay);
  if (!match) return null;
  return { day: Number(match[3]), month: Number(match[2]), year: Number(match[1]) };
}

/** "Wed 16 Sept" */
export function dayLabel(isoDay: string): string {
  const parts = isoParts(isoDay);
  if (!parts) return "—";
  return `${WEEKDAY_SHORT[weekdayOf(isoDay)]} ${parts.day} ${MONTH_SHORT[parts.month - 1]}`;
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
  return `${WEEKDAY_LONG[weekdayOf(isoDay)]} ${parts.day} ${MONTH_LONG[parts.month - 1]} ${parts.year}`;
}

/** The ISO day `days` after (or before) this one. */
export function shiftIsoDay(isoDay: string, days: number): string {
  const value = new Date(`${isoDay}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday of an ISO day, built at noon UTC so the phone's zone cannot shift it. */
export function weekdayOfIsoDay(isoDay: string): number {
  return new Date(`${isoDay}T12:00:00Z`).getUTCDay();
}

/** "Sat 19 Sept – Thu 24 Sept" — the field week, Saturday to Thursday. */
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
  try {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: true, minute: "2-digit", timeZone: "Africa/Cairo" }).format(value);
  } catch {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: true, minute: "2-digit" }).format(value);
  }
}

/** "Wed 16 Sept, 6:30 PM" in Cairo. */
export function cairoStamp(iso: string | null | undefined): string {
  const value = instantOf(iso);
  if (!value) return "—";
  let day = value;
  try {
    // The Cairo calendar day of the instant, so a late-evening visit is not filed to the next day.
    const parts = new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone: "Africa/Cairo", year: "numeric" }).format(value);
    const iso2 = parts.replace(/(\d{4})-(\d{2})-(\d{2})/, "$1-$2-$3");
    if (isIsoDay(iso2)) day = new Date(`${iso2}T12:00:00Z`);
  } catch {
    // Fall back to the raw instant's day.
  }
  return `${dayLabel(day.toISOString().slice(0, 10))}, ${cairoClock(iso)}`;
}

const COUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function countText(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? COUNT.format(value) : "—";
}

/** "3 visits", "1 visit" — the word follows the count. */
export function plural(count: number, one: string, many: string): string {
  return `${countText(count)} ${count === 1 ? one : many}`;
}
