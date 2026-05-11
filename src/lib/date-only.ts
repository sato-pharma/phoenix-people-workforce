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

  return new Intl.DateTimeFormat(locale, options).format(date);
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
