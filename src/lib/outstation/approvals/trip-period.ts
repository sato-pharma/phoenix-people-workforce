/**
 * The dates Expense Approvals can be narrowed to — a month, one day, or a period from one day to
 * another (owner, 2026-11-23: "AND FILTER BY PERIOD OR MONTH OR DATE").
 *
 * The date is the TRIP's own: the days the claim is for, the ones every row prints. A claim of
 * several days is in the period when any of its days is, so a trip that began on 30 Oct and ended
 * on 2 Nov is listed under October and under November.
 *
 *   - a month      → its first day to its last
 *   - one day      → From and To the same day
 *   - a period     → From to To, either end left open
 *
 * A day is read from its own text ("2026-11-23"), so no timezone can move it. A day that does not
 * exist filters nothing, and From after To is read the other way round rather than as an empty list.
 * Pure and import-free, so the page, the address and the history read share one definition
 * (tests/expense-desk-kind.test.ts).
 */

export type TripPeriod = { from: string | null; to: string | null };

export const NO_PERIOD: TripPeriod = { from: null, to: null };

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const pad = (value: number) => String(value).padStart(2, "0");
const iso = (date: Date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

function utc(day: string | null | undefined): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? "").trim());
  if (!match) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // A year typed digit by digit passes through "0002" and "0202": a year still being typed is not a day yet.
  if (year < 2000) return null;
  const read = new Date(Date.UTC(year, month - 1, date));
  // "2026-02-31" rolls over to March: a day that does not exist is not a day.
  return read.getUTCFullYear() === year && read.getUTCMonth() === month - 1 && read.getUTCDate() === date ? read : null;
}

/** A real day as "2026-11-23", or null for anything else — junk in the address filters nothing. */
export function dayParam(value: string | null | undefined): string | null {
  const read = utc(value);
  return read ? iso(read) : null;
}

/** The period two address values name. From after To is read the other way round. */
export function tripPeriodOf(from: string | null | undefined, to: string | null | undefined): TripPeriod {
  const start = dayParam(from);
  const end = dayParam(to);
  return start && end && start > end ? { from: end, to: start } : { from: start, to: end };
}

export function hasPeriod(period: TripPeriod): boolean {
  return Boolean(period.from || period.to);
}

/** The day after — where the history read stops, so a stored hour on the last day is still inside it. */
export function dayAfter(day: string): string {
  const read = utc(day);
  if (!read) return day;
  read.setUTCDate(read.getUTCDate() + 1);
  return iso(read);
}

/** "2026-11" → 1 Nov to 30 Nov; null when it is not a month. */
export function monthPeriod(month: string | null | undefined): TripPeriod | null {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month ?? "").trim());
  if (!match) return null;
  const first = utc(`${match[1]}-${match[2]}-01`);
  if (!first) return null;
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  return { from: iso(first), to: iso(last) };
}

/** "2026-11" when the period is exactly one whole month, else null. */
export function periodMonth(period: TripPeriod): string | null {
  if (!period.from || !period.to) return null;
  const month = period.from.slice(0, 7);
  const whole = monthPeriod(month);
  return whole && whole.from === period.from && whole.to === period.to ? month : null;
}

/** "November 2026". */
export function monthLabel(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const name = match ? MONTH_NAMES[Number(match[2]) - 1] : undefined;
  return match && name ? `${name} ${match[1]}` : month;
}

/** This month and the ones before it, newest first — what the month list offers. */
export function recentMonths(today: string, count = 12): string[] {
  const read = utc(today);
  if (!read) return [];
  const out: string[] = [];
  for (let back = 0; back < count; back += 1) {
    const month = new Date(Date.UTC(read.getUTCFullYear(), read.getUTCMonth() - back, 1));
    out.push(`${month.getUTCFullYear()}-${pad(month.getUTCMonth() + 1)}`);
  }
  return out;
}

/**
 * The period after a From day is picked. With no To yet — or a To before it — the choice is that
 * ONE day, so "filter by date" is a single pick; To can then be moved later to make it a period.
 */
export function withFrom(period: TripPeriod, from: string | null | undefined): TripPeriod {
  const day = dayParam(from);
  if (!day) return { from: null, to: period.to };
  return { from: day, to: !period.to || period.to < day ? day : period.to };
}

/**
 * The period after a To day is picked. From is left as it stands; a To before From is read the
 * other way round by `tripPeriodOf`, which every reader of a period goes through.
 */
export function withTo(period: TripPeriod, to: string | null | undefined): TripPeriod {
  return { from: period.from, to: dayParam(to) };
}

/** True when any day of the trip is inside the period. A trip with no readable day is in no period. */
export function claimInPeriod(claim: { tripEnd?: string | null; tripStart?: string | null }, period: TripPeriod): boolean {
  const { from, to } = tripPeriodOf(period.from, period.to);
  if (!from && !to) return true;
  const start = dayParam(String(claim.tripStart ?? "").slice(0, 10));
  if (!start) return false;
  const last = dayParam(String(claim.tripEnd ?? "").slice(0, 10));
  const end = last && last >= start ? last : start;
  return (!from || end >= from) && (!to || start <= to);
}

const SHORT_MONTHS = MONTH_NAMES.map((name) => name.slice(0, 3));

function dayWords(day: string): string {
  const read = utc(day);
  return read ? `${read.getUTCDate()} ${SHORT_MONTHS[read.getUTCMonth()]} ${read.getUTCFullYear()}` : day;
}

/** The period in words, for the line that says what the list is narrowed to; "" when there is none. */
export function periodWords(given: TripPeriod): string {
  const period = tripPeriodOf(given.from, given.to);
  const month = periodMonth(period);
  if (month) return monthLabel(month);
  if (period.from && period.to) return period.from === period.to ? dayWords(period.from) : `${dayWords(period.from)} to ${dayWords(period.to)}`;
  if (period.from) return `${dayWords(period.from)} onward`;
  if (period.to) return `up to ${dayWords(period.to)}`;
  return "";
}
