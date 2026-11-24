/**
 * Production Planner — the dates a person types, read back in words.
 *
 * Dr. Sahar's deliveries typed on 12 October 2026 were all stored as 10 November: the browser's date
 * box reads month/day, and 11/10 — the eleventh of October as Egypt writes it — went in as the tenth
 * of November. Nothing on the form said so. So every date field spells the chosen date out in the
 * page's language under the box, and a stock or production date after today is refused outright: a
 * balance cannot be known before the day it is counted.
 *
 * Pure, so `tests/production-planning-audit-fixes.test.ts` runs it without a browser.
 */

const MONTHS_AR = [
  "يناير",
  "فبراير",
  "مارس",
  "أبريل",
  "مايو",
  "يونيو",
  "يوليو",
  "أغسطس",
  "سبتمبر",
  "أكتوبر",
  "نوفمبر",
  "ديسمبر",
] as const;

const MONTHS_EN = [
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

/** "2026-11-10" → "10 November 2026" / "10 نوفمبر 2026". Anything that is not a date → "". */
export function spellDate(iso: string | null | undefined, lang: "ar" | "en"): string {
  const match = ISO_DATE.exec((iso ?? "").trim());
  if (!match) return "";
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  const name = (lang === "ar" ? MONTHS_AR : MONTHS_EN)[month - 1];
  return `${day} ${name} ${match[1]}`;
}

/** True when an ISO date falls after `today` (an ISO date, Cairo). Both are compared as text. */
export function isAfterToday(iso: string | null | undefined, today: string): boolean {
  const value = (iso ?? "").trim();
  return ISO_DATE.test(value) && value > today;
}

/** Today's date in Cairo as an ISO date — the same day the service stamps. */
export function cairoDate(at: Date | string = new Date()): string {
  const date = typeof at === "string" ? new Date(at) : at;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
