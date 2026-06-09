import { parseDateOnly } from "../date-only.ts";

import { defaultIntlLocale, type AppLocale, DEFAULT_LOCALE } from "./config.ts";

function normalizeLocale(locale?: AppLocale | null): AppLocale {
  return locale ?? DEFAULT_LOCALE;
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

// Phoenix operates in a single business timezone (Egypt). Server runtime on Vercel is
// UTC, so any "current local hour" logic (e.g. notification quiet hours) must be
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
    ...options,
  }).format(date);
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
    ...options,
  }).format(date);
}
