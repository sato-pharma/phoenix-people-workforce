const DATE_PREFIX_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;

function padDatePart(value: number) {
  return String(value).padStart(2, "0");
}

export function isDateOnlyString(value: string) {
  return DATE_PREFIX_PATTERN.test(value.trim());
}

export function toDateOnlyString(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return [
      value.getFullYear(),
      padDatePart(value.getMonth() + 1),
      padDatePart(value.getDate()),
    ].join("-");
  }

  const text = value.trim();
  if (!text) return null;

  const dateOnly = text.match(DATE_PREFIX_PATTERN);
  if (dateOnly) {
    return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return text;
  }

  return [
    parsed.getFullYear(),
    padDatePart(parsed.getMonth() + 1),
    padDatePart(parsed.getDate()),
  ].join("-");
}

export function parseDateOnly(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const text = value.trim();
  const match = text.match(DATE_PREFIX_PATTERN);

  if (match) {
    const year = Number(match[1]);
    const monthIndex = Number(match[2]) - 1;
    const day = Number(match[3]);
    const date = new Date(year, monthIndex, day);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatDateOnly(
  value: Date | string | null | undefined,
  locale: string,
  options: Intl.DateTimeFormatOptions,
  fallback = "-",
) {
  if (!value) {
    return fallback;
  }

  const date = parseDateOnly(value);
  if (!date) {
    return typeof value === "string" ? value : fallback;
  }

  return new Intl.DateTimeFormat(locale, options)
    .format(date)
    .replace(/\bSept\b/g, "Sep");
}

export function addDaysToDateOnly(value: string | null | undefined, days: number) {
  const date = parseDateOnly(value);
  if (!date) return null;
  date.setDate(date.getDate() + days);
  return toDateOnlyString(date);
}

export function addYearsToDateOnly(value: string | null | undefined, years: number) {
  const date = parseDateOnly(value);
  if (!date) return null;
  date.setFullYear(date.getFullYear() + years);
  return toDateOnlyString(date);
}

export function daysBetweenDateOnly(start: string | null | undefined, end: Date = new Date()) {
  const startDate = parseDateOnly(start);
  if (!startDate) return null;

  const endDate = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.round((endDate.getTime() - startDate.getTime()) / 86400000);
}

/**
 * TODAY IN CAIRO, as YYYY-MM-DD, safely on any browser.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT `toLocaleDateString("en-CA")`. Four places in this codebase computed today's
 * Cairo date that way, each with a comment saying en-CA renders as yyyy-mm-dd. It does — on the
 * engines it was written and tested on. THE PATTERN IS LOCALE DATA, NOT SPEC, and the value it
 * produces is whatever the browser's ICU says. Two ways that bites, both reproduced in a real
 * browser on 2026-09-05:
 *
 *   ar-EG  ->  ٢٠٢٦-٠٩-٠٥   Arabic-Indic digits. Right order, unusable string.
 *   en-GB  ->  05/09/2026    Latin digits, wrong order.
 *
 * The owner hit this: pressing "Today" on a hiring-pack document filled the date box with
 * something that looked like a date, and the sign route answered 400 "Pass signedDate as
 * YYYY-MM-DD". The failure reads as though the operator typed something wrong, which is why it
 * survived — nobody suspects a button that fills the field for you.
 *
 * NEITHER HALF OF THE FIX IS ENOUGH ALONE, which is the part worth remembering:
 *   · assembling from `formatToParts` fixes the ORDER but still yields ٢٠٢٦-٠٩-٠٥ under ar-EG;
 *   · forcing `numberingSystem: "latn"` fixes the DIGITS but still yields 05/09/2026 under en-GB.
 * So this does both, and never returns the formatter's own rendering.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
export function todayInCairo(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    // Latin digits regardless of what locale the engine actually resolves to.
    numberingSystem: "latn",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).formatToParts(now);

  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";

  return `${part("year")}-${part("month")}-${part("day")}`;
}
