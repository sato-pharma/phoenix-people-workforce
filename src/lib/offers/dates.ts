/**
 * Dates on an offer letter.
 *
 * ── The two formats, and why both exist ──
 * A date picker speaks ISO — `2026-09-01`, the only thing `<input type="date">` will accept or
 * emit. A letter speaks English — `01 September 2026`. This module is the boundary between them,
 * in one place, so the screen can hold a picker without the document changing shape.
 *
 * The STORED and SENT format is unchanged: still the English string, exactly as the letter has
 * always carried it. Nothing here alters a saved offer, a PDF, or an email. The ISO form lives
 * only inside the composer, between the picker and the moment the fields are handed off.
 *
 * ── Why a bare date is read as UTC, never as local ──
 * `new Date("2026-09-01")` is midnight UTC. Formatted in a zone behind UTC that prints as
 * 31 August — an off-by-one on a start date, which is the kind of error nobody notices until a
 * candidate turns up on the wrong day. So a bare date is parsed as UTC and formatted as UTC: no
 * zone is involved because a calendar date has no time of day to shift.
 *
 * `todayInCairo` is the one function that DOES need a zone, because "what is today" is a question
 * about a place, and this company's place is Cairo.
 */

const MONTHS = [
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

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A `yyyy-mm-dd` string as a UTC Date, or null if it is not one. */
function isoToUtcDate(iso: string): Date | null {
  const match = ISO_DATE.exec(iso.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  // Rejects 2026-02-30, which `Date.UTC` would happily roll forward into March. A letter dated
  // "02 March" when somebody typed 30 February is worse than an empty field.
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() !== Number(month) - 1 ||
    parsed.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return parsed;
}

function utcDateToIso(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** True when the string is a real calendar date in `yyyy-mm-dd`. */
export function isIsoDate(value: string): boolean {
  return isoToUtcDate(value) !== null;
}

/**
 * Today's date in Africa/Cairo as `yyyy-mm-dd`.
 *
 * Cairo runs three hours ahead of UTC in summer, so between 21:00 and midnight UTC the two
 * disagree about what day it is. An offer issued at 11pm Cairo must be dated tomorrow's date in
 * nobody's reckoning — it is dated today, here.
 */
export { todayInCairo } from "@/lib/date-only";

/**
 * `2026-09-01` → `01 September 2026`, the form the letter has always used.
 *
 * Two-digit day, deliberately, because that is what the module shipped with and what is on the
 * template the owner approved line by line. Switching to a bare `1` would silently restyle every
 * letter issued on the first nine days of a month.
 *
 * An unparseable value returns "" rather than a guess — `fillOfferTokens` then leaves the
 * placeholder standing in braces, which is visible, and a visible hole beats a wrong date.
 */
export function toLetterDate(iso: string): string {
  const parsed = isoToUtcDate(iso);
  if (!parsed) return "";
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  return `${day} ${MONTHS[parsed.getUTCMonth()]} ${parsed.getUTCFullYear()}`;
}

/**
 * `01 September 2026` → `2026-09-01`, or null when the text is not a letter date.
 *
 * Accepts a bare day (`1 September 2026`) and any capitalisation, because this also has to read
 * dates typed by hand into the old free-text fields, and "1 september 2026" is a date a person
 * clearly meant. Returns null rather than a guess for anything else, so a value that cannot be
 * understood is left alone instead of being replaced with a plausible wrong one.
 */
export function parseLetterDate(text: string): string | null {
  const match = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(text.trim());
  if (!match) return null;
  const [, day, monthName, year] = match;
  const monthIndex = MONTHS.findIndex((month) => month.toLowerCase() === monthName.toLowerCase());
  if (monthIndex < 0) return null;
  const iso = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${day.padStart(2, "0")}`;
  return isIsoDate(iso) ? iso : null;
}

/** The same calendar date shifted by whole days. Returns "" if the input is not a date. */
export function addDays(iso: string, days: number): string {
  const parsed = isoToUtcDate(iso);
  if (!parsed) return "";
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return utcDateToIso(parsed);
}

/**
 * The first day of the month after this one — the single most common start date on an offer,
 * because payroll runs by month and nobody wants a part-month first salary.
 */
export function firstOfNextMonth(iso: string): string {
  const parsed = isoToUtcDate(iso);
  if (!parsed) return "";
  return utcDateToIso(new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 1)));
}

/** Whole days from one date to another, negative when `to` is earlier. "" for either means null. */
export function daysBetween(from: string, to: string): number | null {
  const start = isoToUtcDate(from);
  const end = isoToUtcDate(to);
  if (!start || !end) return null;
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

/**
 * How long a job offer stands by default.
 *
 * Lives here rather than in the composer because the composer is no longer the only thing that
 * creates an offer: the recruitment bridge does too, and a second copy of this number would mean
 * a letter opened from an application quietly stood for a different length of time than one
 * typed by hand.
 */
export const DEFAULT_OFFER_VALIDITY_DAYS = 7;

/**
 * True once a letter's "valid until" day is over in Cairo — `todayIso` is later than it.
 *
 * Read the way the accept link reads it (`offerAcceptExpiry`): the stored English string, or an ISO
 * date. An unreadable or missing date returns false — a letter whose deadline cannot be read is not
 * declared over on a guess.
 *
 * The valid-until day itself still counts: a letter valid until 21 October is live all of the 21st.
 */
export function offerLetterLapsed(validUntil: string | null | undefined, todayIso: string): boolean {
  const raw = String(validUntil ?? "").trim();
  if (!raw || !isIsoDate(todayIso)) return false;
  const iso = isIsoDate(raw) ? raw : parseLetterDate(raw);
  return iso !== null && iso < todayIso;
}
