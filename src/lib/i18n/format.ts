import { parseDateOnly } from "../date-only.ts";

import { defaultIntlLocale, type AppLocale, DEFAULT_LOCALE } from "./config.ts";

function normalizeLocale(locale?: AppLocale | null): AppLocale {
  return locale ?? DEFAULT_LOCALE;
}

/** "1 request", "3 requests" — a count with its noun agreed, never "request(s)". */
export function countOf(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function formatCurrencyValue(
  value: number,
  locale?: AppLocale | null,
  options: Intl.NumberFormatOptions = {},
) {
  return new Intl.NumberFormat(defaultIntlLocale(normalizeLocale(locale)), {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
    ...options,
  }).format(Number.isFinite(value) ? value : 0);
}

export function formatNumberValue(
  value: number,
  locale?: AppLocale | null,
  options: Intl.NumberFormatOptions = {},
) {
  return new Intl.NumberFormat(defaultIntlLocale(normalizeLocale(locale)), {
    maximumFractionDigits: 0,
    ...options,
  }).format(Number.isFinite(value) ? value : 0);
}

export function formatCompactNumber(
  value: number,
  locale?: AppLocale | null,
  options: Intl.NumberFormatOptions = {},
) {
  return new Intl.NumberFormat(defaultIntlLocale(normalizeLocale(locale)), {
    maximumFractionDigits: 1,
    notation: "compact",
    ...options,
  }).format(Number.isFinite(value) ? value : 0);
}

// Phoenix operates in a single business timezone (Egypt). Server runtime (GCP Cloud
// Run) is UTC, so any "current local hour" logic (e.g. notification quiet hours) must be
// computed in Africa/Cairo, not from the server clock. Returns 24h hours+minutes.
export const PHOENIX_BUSINESS_TIME_ZONE = "Africa/Cairo";

export function currentCairoTimeHM(now: Date = new Date()): { hours: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
  }).formatToParts(now);
  const hours = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minutes = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return {
    hours: Number.isFinite(hours) ? hours : 0,
    minutes: Number.isFinite(minutes) ? minutes : 0,
  };
}

// Minutes since local midnight in Africa/Cairo (0–1439), for range comparisons.
export function currentCairoMinutesOfDay(now: Date = new Date()): number {
  const { hours, minutes } = currentCairoTimeHM(now);
  return hours * 60 + minutes;
}

// Today's calendar date in Africa/Cairo — use this instead of new Date().getFullYear()/
// getMonth()/getDate() for any "default to the current period" UI state. The server
// (UTC) and a Cairo browser can disagree on the date/month near midnight Cairo time;
// computing from the raw runtime clock renders a different default period per side.
export function currentCairoDateParts(now: Date = new Date()): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value ?? "0");
  const month = Number(parts.find((part) => part.type === "month")?.value ?? "0");
  const day = Number(parts.find((part) => part.type === "day")?.value ?? "0");
  return {
    year: Number.isFinite(year) ? year : now.getUTCFullYear(),
    month: Number.isFinite(month) ? month : now.getUTCMonth() + 1,
    day: Number.isFinite(day) ? day : now.getUTCDate(),
  };
}

// Today's calendar date in Africa/Cairo as a YYYY-MM-DD string — the canonical
// "Cairo today, date-only" primitive. Built on currentCairoDateParts rather than a
// second Intl call, so there's exactly one place that resolves Cairo's wall-clock
// date from an instant. Use instead of `new Date().toISOString().slice(0, 10)` or
// `toDateOnlyString(new Date())` anywhere "today" means Cairo business time.
export function currentCairoDateOnlyIso(now: Date = new Date()): string {
  const { year, month, day } = currentCairoDateParts(now);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function asValidDate(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  const date = parseDateOnly(value);
  return !date || Number.isNaN(date.getTime()) ? null : date;
}

function asValidDateTime(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateValue(
  value: Date | string | null | undefined,
  locale?: AppLocale | null,
  options: Intl.DateTimeFormatOptions = {},
) {
  if (!value) {
    return "-";
  }

  const date = asValidDate(value);
  if (!date) {
    return typeof value === "string" ? value : "-";
  }

  return new Intl.DateTimeFormat(defaultIntlLocale(normalizeLocale(locale)), {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
    ...options,
  }).format(date);
}

// ── Owner-specified notification format (2026-08-04) ──────────────────────────
// Outstation emails must read exactly "12:15 PM" and "Tuesday, 17 October 2026",
// always in Africa/Cairo. The locale on each formatter below is chosen for its
// GLYPH SHAPE, not for the reader's language, which is why neither uses the app's
// default `en-EG`:
//   - en-EG/en-US render the date American-style ("October 17, 2026").
//   - en-GB renders the time lowercase ("12:15 pm").
// Do not "unify" these onto one locale — each one is already the odd choice on
// purpose. These are deliberately separate from formatDateValue/formatDateTimeValue,
// which keep their short "17 Oct 2026" shape for dense admin tables.

/** "Tuesday, 17 October 2026" in Africa/Cairo. Accepts a date-only string or an instant. */
export function formatPhoenixLongDate(value: Date | string | null | undefined) {
  if (!value) return "—";
  const date = asValidDate(value) ?? asValidDateTime(value);
  if (!date) return typeof value === "string" ? value : "—";

  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
    weekday: "long",
    year: "numeric",
  }).format(date);
}

/** "September 2026" in Africa/Cairo. Accepts a date-only string (a month's first day) or an instant. */
export function formatPhoenixMonth(value: Date | string | null | undefined) {
  if (!value) return "—";
  const date = asValidDate(value) ?? asValidDateTime(value);
  if (!date) return typeof value === "string" ? value : "—";

  return new Intl.DateTimeFormat("en-GB", {
    month: "long",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
    year: "numeric",
  }).format(date);
}

/** "12:15 PM" in Africa/Cairo. */
export function formatPhoenixTime(value: Date | string | null | undefined) {
  if (!value) return "—";
  const date = asValidDateTime(value);
  if (!date) return typeof value === "string" ? value : "—";

  return (
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: true,
      minute: "2-digit",
      timeZone: PHOENIX_BUSINESS_TIME_ZONE,
    })
      .format(date)
      // ICU ≥ 72 separates the minutes from AM/PM with U+202F (narrow no-break
      // space), older builds use a plain space. The runtime's ICU version is not
      // ours to pin, so normalize every Unicode space to U+0020 — otherwise the
      // exact string the owner asked for depends on which Node image Railway
      // happens to build with.
      .replace(/\s/g, " ")
  );
}

/** "12:15 PM, Tuesday, 17 October 2026" in Africa/Cairo — the full stamp for an email. */
export function formatPhoenixDateTime(value: Date | string | null | undefined) {
  if (!value) return "—";
  const date = asValidDateTime(value);
  if (!date) return typeof value === "string" ? value : "—";
  return `${formatPhoenixTime(date)}, ${formatPhoenixLongDate(date)}`;
}

export function formatDateTimeValue(
  value: Date | string | null | undefined,
  locale?: AppLocale | null,
  options: Intl.DateTimeFormatOptions = {},
) {
  if (!value) {
    return "-";
  }

  const date = asValidDateTime(value);
  if (!date) {
    return typeof value === "string" ? value : "-";
  }

  return new Intl.DateTimeFormat(defaultIntlLocale(normalizeLocale(locale)), {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
    ...options,
  }).format(date);
}
