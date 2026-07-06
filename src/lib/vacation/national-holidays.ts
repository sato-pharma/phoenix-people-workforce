import { getCompanyHolidaysForMonth } from "@/lib/vacation/company-holidays";
import { listHolidayOverridesOverlappingRange } from "@/lib/vacation/holiday-override-store";

export type EgyptianNationalHoliday = {
  description: string | null;
  durationDays: number;
  endDate: string | null;
  id: string;
  name: string;
  source: "company" | "google_calendar";
  startDate: string;
};

export type EgyptianNationalHolidayResult = {
  calendarId: string | null;
  connected: boolean;
  holidays: EgyptianNationalHoliday[];
  message: string | null;
  month: number;
  sourceLabel: string;
  year: number;
};

type GoogleCalendarEvent = {
  description?: string | null;
  end?: { date?: string | null; dateTime?: string | null } | null;
  id?: string | null;
  start?: { date?: string | null; dateTime?: string | null } | null;
  summary?: string | null;
};

type ParsedIcsEvent = {
  description: string | null;
  endDate: string | null;
  id: string | null;
  name: string | null;
  startDate: string | null;
};

const egyptGoogleHolidayCalendarIds = [
  "en.eg#holiday@group.v.calendar.google.com",
  "en.egyptian#holiday@group.v.calendar.google.com",
] as const;
const holidayFetchTimeoutMs = 3500;
const holidayCacheTtlMs = 10 * 60 * 1000;
const holidayCache = new Map<string, { expiresAt: number; result: EgyptianNationalHolidayResult }>();

function clampMonth(value: number) {
  return Number.isInteger(value) && value >= 1 && value <= 12 ? value : null;
}

function validYear(value: number) {
  return Number.isInteger(value) && value >= 2000 && value <= 2100 ? value : null;
}

function dateOnlyFromGoogle(value: { date?: string | null; dateTime?: string | null } | null | undefined) {
  if (value?.date) return value.date;
  if (value?.dateTime) return value.dateTime.slice(0, 10);
  return null;
}

function dateOnlyFromIcs(value: string | null | undefined) {
  const normalized = String(value ?? "").trim();
  if (/^\d{8}$/.test(normalized)) {
    return `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)}`;
  }
  if (/^\d{8}T/.test(normalized)) {
    return `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)}`;
  }
  return null;
}

function dateOnlyAddDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function inclusiveGoogleEndDate(startDate: string, rawEndDate: string | null) {
  if (!rawEndDate || rawEndDate <= startDate) return startDate;
  return dateOnlyAddDays(rawEndDate, -1);
}

function inclusiveDaysBetween(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00Z`).getTime();
  const end = new Date(`${endDate}T00:00:00Z`).getTime();
  return Math.max(1, Math.round((end - start) / 86400000) + 1);
}

function normalizeHolidayName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function mergeHolidayRows(holidays: EgyptianNationalHoliday[]) {
  const rows = new Map<string, EgyptianNationalHoliday>();
  const dateRangeIndex = new Map<string, string>();

  for (const holiday of holidays) {
    const nameKey = normalizeHolidayName(holiday.name);
    const dateRangeKey = `${holiday.startDate}:${holiday.endDate ?? holiday.startDate}`;
    const key = dateRangeIndex.get(dateRangeKey) ?? nameKey;
    const existing = rows.get(key);
    if (!existing) {
      rows.set(key, holiday);
      dateRangeIndex.set(dateRangeKey, key);
      continue;
    }

    const startDate = holiday.startDate < existing.startDate ? holiday.startDate : existing.startDate;
    const existingEnd = existing.endDate ?? existing.startDate;
    const holidayEnd = holiday.endDate ?? holiday.startDate;
    const endDate = holidayEnd > existingEnd ? holidayEnd : existingEnd;
    rows.set(key, {
      ...existing,
      description: existing.description ?? holiday.description,
      durationDays: inclusiveDaysBetween(startDate, endDate),
      endDate,
      id: `${existing.id}-${holiday.id}`,
      startDate,
    });
    dateRangeIndex.set(`${startDate}:${endDate}`, key);
  }

  return [...rows.values()].sort((left, right) => left.startDate.localeCompare(right.startDate));
}

function monthRange(year: number, month: number) {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return {
    timeMax: end.toISOString(),
    timeMin: start.toISOString(),
  };
}

function monthDateRange(year: number, month: number) {
  const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
  const next = new Date(Date.UTC(year, month, 1));
  const endDate = dateOnlyAddDays(next.toISOString().slice(0, 10), -1);
  return { endDate, startDate };
}

function overlapsMonth(input: { endDate: string | null; monthEnd: string; monthStart: string; startDate: string }) {
  const endDate = input.endDate ?? input.startDate;
  return input.startDate <= input.monthEnd && endDate >= input.monthStart;
}

function companyHolidayRows(month: number, year: number): EgyptianNationalHoliday[] {
  return getCompanyHolidaysForMonth({ month, year }).map((holiday) => {
    const endDate = holiday.endDate ?? holiday.startDate;
    return {
      description: null,
      durationDays: inclusiveDaysBetween(holiday.startDate, endDate),
      endDate,
      id: `company-${holiday.startDate}`,
      name: holiday.name,
      source: "company" as const,
      startDate: holiday.startDate,
    };
  });
}

/** Merges company-defined holidays into the Google calendar holidays for a month. */
function withCompanyHolidays(
  googleHolidays: EgyptianNationalHoliday[],
  company: EgyptianNationalHoliday[],
): EgyptianNationalHoliday[] {
  return company.length > 0 ? mergeHolidayRows([...googleHolidays, ...company]) : googleHolidays;
}

async function fetchGoogleHolidayCalendar(input: {
  apiKey: string;
  calendarId: string;
  timeMax: string;
  timeMin: string;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), holidayFetchTimeoutMs);
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events`);
  url.searchParams.set("key", input.apiKey);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("timeMin", input.timeMin);
  url.searchParams.set("timeMax", input.timeMax);

  try {
    return await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchGoogleHolidayCalendarIcs(calendarId: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), holidayFetchTimeoutMs);
  const url = new URL(`https://calendar.google.com/calendar/ical/${encodeURIComponent(calendarId)}/public/basic.ics`);
  try {
    return await fetch(url, {
      cache: "no-store",
      headers: { Accept: "text/calendar,text/plain,*/*" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function unfoldIcsLines(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .reduce<string[]>((lines, line) => {
      if (/^[ \t]/.test(line) && lines.length > 0) {
        lines[lines.length - 1] += line.slice(1);
      } else {
        lines.push(line);
      }
      return lines;
    }, []);
}

function decodeIcsText(value: string | null | undefined) {
  return String(value ?? "")
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function icsPropertyName(line: string) {
  return line.split(":", 1)[0]?.split(";", 1)[0]?.toUpperCase() ?? "";
}

function icsPropertyValue(line: string) {
  const index = line.indexOf(":");
  return index >= 0 ? line.slice(index + 1) : "";
}

function parseGoogleHolidayIcs(value: string) {
  const events: ParsedIcsEvent[] = [];
  let current: Record<string, string> | null = null;

  for (const line of unfoldIcsLines(value)) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) {
        const startDate = dateOnlyFromIcs(current.DTSTART);
        const endDate = inclusiveGoogleEndDate(startDate ?? "", dateOnlyFromIcs(current.DTEND));
        events.push({
          description: decodeIcsText(current.DESCRIPTION) || null,
          endDate,
          id: current.UID ?? null,
          name: decodeIcsText(current.SUMMARY) || null,
          startDate,
        });
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const property = icsPropertyName(line);
    if (property === "DTSTART" || property === "DTEND" || property === "SUMMARY" || property === "DESCRIPTION" || property === "UID") {
      current[property] = icsPropertyValue(line);
    }
  }

  return events;
}

function googleEventsToHolidays(events: GoogleCalendarEvent[], monthStart: string, monthEnd: string) {
  return mergeHolidayRows(events
    .map((event): EgyptianNationalHoliday | null => {
      const startDate = dateOnlyFromGoogle(event.start);
      if (!startDate) return null;
      const endDate = inclusiveGoogleEndDate(startDate, dateOnlyFromGoogle(event.end));
      if (!overlapsMonth({ endDate, monthEnd, monthStart, startDate })) return null;
      return {
        description: event.description ?? null,
        durationDays: inclusiveDaysBetween(startDate, endDate),
        endDate,
        id: event.id ?? `${startDate}-${event.summary ?? "holiday"}`,
        name: event.summary ?? "Official holiday",
        source: "google_calendar",
        startDate,
      };
    })
    .filter((event): event is EgyptianNationalHoliday => Boolean(event)));
}

function icsEventsToHolidays(events: ParsedIcsEvent[], monthStart: string, monthEnd: string) {
  return mergeHolidayRows(events
    .map((event): EgyptianNationalHoliday | null => {
      if (!event.startDate) return null;
      const endDate = event.endDate ?? event.startDate;
      if (!overlapsMonth({ endDate, monthEnd, monthStart, startDate: event.startDate })) return null;
      return {
        description: event.description,
        durationDays: inclusiveDaysBetween(event.startDate, endDate),
        endDate,
        id: event.id ?? `${event.startDate}-${event.name ?? "holiday"}`,
        name: event.name ?? "Official holiday",
        source: "google_calendar",
        startDate: event.startDate,
      };
    })
    .filter((event): event is EgyptianNationalHoliday => Boolean(event)));
}

export async function getEgyptianNationalHolidays(input: {
  month: number;
  year: number;
}): Promise<EgyptianNationalHolidayResult> {
  const now = new Date();
  const year = validYear(input.year) ?? now.getFullYear();
  const month = clampMonth(input.month) ?? now.getMonth() + 1;
  const cacheKey = `${year}-${String(month).padStart(2, "0")}`;
  const cached = holidayCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const company = companyHolidayRows(month, year);
  const configuredCalendarId = process.env.GOOGLE_HOLIDAY_CALENDAR_ID_EG?.trim();
  const calendarCandidates = Array.from(new Set([
    configuredCalendarId,
    ...egyptGoogleHolidayCalendarIds,
  ].filter((value): value is string => Boolean(value))));
  const apiKey = process.env.GOOGLE_CALENDAR_API_KEY ?? "";

  const { timeMax, timeMin } = monthRange(year, month);
  const { endDate: monthEnd, startDate: monthStart } = monthDateRange(year, month);
  let lastStatus = 0;

  for (const candidateCalendarId of calendarCandidates) {
    const icsResponse = await fetchGoogleHolidayCalendarIcs(candidateCalendarId).catch(() => null);
    if (!icsResponse) {
      lastStatus = 0;
    } else {
      lastStatus = icsResponse.status;
      if (icsResponse.ok) {
        const holidays = withCompanyHolidays(
          icsEventsToHolidays(parseGoogleHolidayIcs(await icsResponse.text()), monthStart, monthEnd),
          company,
        );
        const result = {
          calendarId: candidateCalendarId,
          connected: true,
          holidays,
          message: null,
          month,
          sourceLabel: "Google Calendar Egypt public holidays",
          year,
        };
        holidayCache.set(cacheKey, { expiresAt: Date.now() + holidayCacheTtlMs, result });
        return result;
      }
    }

    if (!apiKey.trim()) continue;

    const apiResponse = await fetchGoogleHolidayCalendar({
      apiKey,
      calendarId: candidateCalendarId,
      timeMax,
      timeMin,
    }).catch(() => null);
    if (!apiResponse) {
      lastStatus = 0;
      continue;
    }
    lastStatus = apiResponse.status;
    if (apiResponse.ok) {
      const payload = await apiResponse.json() as { items?: GoogleCalendarEvent[] };
      const result = {
        calendarId: candidateCalendarId,
        connected: true,
        holidays: withCompanyHolidays(googleEventsToHolidays(payload.items ?? [], monthStart, monthEnd), company),
        message: null,
        month,
        sourceLabel: "Google Calendar Egypt public holidays",
        year,
      };
      holidayCache.set(cacheKey, { expiresAt: Date.now() + holidayCacheTtlMs, result });
      return result;
    }
  }

  const result = {
    calendarId: calendarCandidates[0] ?? null,
    connected: company.length > 0,
    holidays: company,
    message: company.length > 0
      ? null
      : `Google Calendar Egypt holiday calendar could not be loaded from the public iCal feed${apiKey.trim() ? " or Calendar API" : ""}. Last status: ${lastStatus || "unknown"}.`,
    month,
    sourceLabel: "Google Calendar Egypt public holidays",
    year,
  };
  holidayCache.set(cacheKey, { expiresAt: Date.now() + holidayCacheTtlMs, result });
  return result;
}

/**
 * Rule: a national holiday's real day off is only authoritative once a System
 * Admin has explicitly confirmed it (see the T-3-day reminder in
 * holiday-confirmation.ts) — the raw ministry/Google Calendar date
 * (getEgyptianNationalHolidays) is a provisional default, not a substitute
 * for that confirmation, because postponements are common (e.g. the June 30
 * Revolution Day being observed on July 2 instead). Every consumer that
 * decides "is this day off" — calendars, weekly/monthly plans, vacation,
 * attendance, field workforce compliance — must call THIS function, not
 * getEgyptianNationalHolidays directly.
 *
 * A holiday whose official and observed dates fall in different months is
 * handled per-month-call: the official month's raw entry is dropped (it is
 * no longer a holiday there) and the observed month's call injects a
 * synthetic entry at the observed date, so callers that query one month at a
 * time (the normal calling pattern everywhere in this codebase) each see the
 * confirmed date land in the correct month regardless of which side of the
 * month boundary the shift crosses.
 */
export async function getConfirmedNationalHolidays(input: {
  month: number;
  year: number;
}): Promise<EgyptianNationalHolidayResult> {
  const raw = await getEgyptianNationalHolidays(input);
  const { endDate: monthEnd, startDate: monthStart } = monthDateRange(raw.year, raw.month);
  const overrides = await listHolidayOverridesOverlappingRange(monthStart, monthEnd).catch(() => []);
  if (overrides.length === 0) return raw;

  const overrideByOfficialDate = new Map(overrides.map((override) => [override.officialDate, override]));

  // Drop entries whose official date has a confirmed override — the real day
  // off lives at the observed date instead (injected below, in whichever
  // month it actually falls in).
  const withoutOverriddenOfficialDates = raw.holidays.filter(
    (holiday) => !overrideByOfficialDate.has(holiday.startDate),
  );

  const injected: EgyptianNationalHoliday[] = [];
  for (const override of overrides) {
    // Range overlap: the confirmed observed period is observedDate..observedEndDate
    // (a multi-day national vacation, not just a single shifted day).
    if (override.observedEndDate < monthStart || override.observedDate > monthEnd) continue;
    const alreadyPresent = withoutOverriddenOfficialDates.some((holiday) => holiday.startDate === override.observedDate);
    if (alreadyPresent) continue;
    injected.push({
      description: override.notes,
      durationDays: inclusiveDaysBetween(override.observedDate, override.observedEndDate),
      endDate: override.observedEndDate,
      id: `override-${override.id}`,
      name: override.holidayName,
      source: "company",
      startDate: override.observedDate,
    });
  }

  if (injected.length === 0 && withoutOverriddenOfficialDates.length === raw.holidays.length) return raw;

  return {
    ...raw,
    holidays: [...withoutOverriddenOfficialDates, ...injected].sort((left, right) => left.startDate.localeCompare(right.startDate)),
  };
}
