import { getSupabaseAdmin } from "@/lib/supabase/server";

export type PublicHolidayCalendarSyncInput = {
  country?: string;
  year?: number;
  calendarId?: string;
};

export type PublicHolidayCalendarSyncResult = {
  country: string;
  calendarId: string;
  year: number;
  syncedCount: number;
  skippedCount: number;
};

type GoogleCalendarEventDate = {
  date?: string;
  dateTime?: string;
  timeZone?: string;
};

type GoogleCalendarEvent = {
  summary?: string;
  status?: string;
  start?: GoogleCalendarEventDate | null;
  end?: GoogleCalendarEventDate | null;
};

type GoogleCalendarResponse = {
  items?: GoogleCalendarEvent[] | null;
  error?: {
    code?: number;
    message?: string;
  };
};

type SyncRow = {
  country: string;
  date: string;
  end_date: string;
  duration_days: number;
  year: number;
  is_active: true;
  name: string;
};

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function round2(value: number) {
  return Number(value.toFixed(2));
}

function isDateOnly(value: string | undefined) {
  return Boolean(value) && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseDateOnly(value: string) {
  const text = cleanText(value);
  if (!isDateOnly(text)) return null;
  const [year, month, day] = text.split("-").map((part) => Number(part));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function addDays(dateText: string, offset: number) {
  const date = parseDateOnly(dateText);
  if (!date) return null;
  const moved = new Date(date.getTime());
  moved.setUTCDate(moved.getUTCDate() + offset);
  return formatDate(moved);
}

function parseYear(value: unknown) {
  if (value === undefined || value === null) {
    return new Date().getUTCFullYear();
  }

  const parsed = Number(cleanText(value));
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error("year must be an integer.");
  }

  return parsed;
}

function buildGoogleCalendarRange(year: number) {
  return {
    min: `${String(year).padStart(4, "0")}-01-01T00:00:00Z`,
    max: `${String(year + 1).padStart(4, "0")}-01-01T00:00:00Z`,
  };
}

function calculateInclusiveRange(
  eventStart: string,
  eventEnd: string,
  isAllDay: boolean,
) {
  const start = parseDateOnly(eventStart);
  const end = parseDateOnly(eventEnd);
  if (!start || !end) {
    return null;
  }

  if (end < start) return null;

  const endText = isAllDay ? addDays(eventEnd, -1) : eventEnd;
  if (!endText) return null;

  const endDate = parseDateOnly(endText);
  if (!endDate || endDate < start) return null;

  const durationDays = round2((endDate.getTime() - start.getTime()) / (24 * 60 * 60 * 1000) + 1);
  if (!Number.isFinite(durationDays) || durationDays <= 0) return null;

  return {
    date: formatDate(start),
    endDate: endText,
    durationDays,
  };
}

function normalizeEvent(event: GoogleCalendarEvent) {
  if (cleanText(event.status) === "cancelled") return null;
  const start = event.start ?? {};
  const end = event.end ?? {};
  const startDate = cleanText(start.date ?? start.dateTime);
  const endDate = cleanText(end.date ?? end.dateTime);
  const name = cleanText(event.summary);

  if (!startDate || !endDate || !name) return null;

  const isAllDay = Boolean(start.date);
  if (isAllDay && !isDateOnly(startDate)) return null;
  if (isAllDay && !isDateOnly(endDate)) return null;

  if (isAllDay) {
    return calculateInclusiveRange(startDate, endDate, true);
  }

  const startAt = new Date(startDate);
  const endAt = new Date(endDate);
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || endAt <= startAt) return null;

  const durationDays = round2((endAt.getTime() - startAt.getTime()) / (24 * 60 * 60 * 1000));
  if (!Number.isFinite(durationDays) || durationDays <= 0) return null;

  return {
    date: formatDate(startAt),
    endDate: formatDate(new Date(endAt.getTime() - 1)),
    durationDays,
  };
}

async function fetchGoogleCalendarEvents(calendarId: string, apiKey: string, year: number) {
  const { min, max } = buildGoogleCalendarRange(year);
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("timeMin", min);
  url.searchParams.set("timeMax", max);
  url.searchParams.set("timeZone", "UTC");
  url.searchParams.set("maxResults", "2500");

  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Calendar fetch failed (${response.status}): ${text}`);
  }

  const payload = (await response.json()) as GoogleCalendarResponse;
  if (payload.error?.message) {
    throw new Error(payload.error.message);
  }

  return Array.isArray(payload.items) ? payload.items : [];
}

export async function syncPublicHolidayCalendar(input: PublicHolidayCalendarSyncInput = {}): Promise<PublicHolidayCalendarSyncResult> {
  const country = cleanText(input.country || process.env.GOOGLE_HOLIDAY_COUNTRY || "EG").toUpperCase() || "EG";
  const calendarId = cleanText(input.calendarId || process.env.GOOGLE_HOLIDAY_CALENDAR_ID_EG);
  const apiKey = cleanText(process.env.GOOGLE_CALENDAR_API_KEY);

  if (!calendarId) {
    throw new Error("Missing GOOGLE_HOLIDAY_CALENDAR_ID_EG (or calendarId input).");
  }

  if (!apiKey) {
    throw new Error("Missing GOOGLE_CALENDAR_API_KEY.");
  }

  const year = parseYear(input.year);
  const items = await fetchGoogleCalendarEvents(calendarId, apiKey, year);
  const rows: SyncRow[] = [];
  let skipped = 0;

  for (const event of items) {
    const normalized = normalizeEvent(event);
    if (!normalized) {
      skipped += 1;
      continue;
    }

    const rowYear = Number(normalized.date.slice(0, 4));
    if (!Number.isFinite(rowYear) || rowYear !== year) {
      skipped += 1;
      continue;
    }

    rows.push({
      country,
      date: normalized.date,
      duration_days: normalized.durationDays,
      end_date: normalized.endDate,
      is_active: true,
      name: cleanText(event.summary || ""),
      year: rowYear,
    });
  }

  if (rows.length === 0) {
    return {
      calendarId,
      country,
      skippedCount: skipped,
      syncedCount: 0,
      year,
    };
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("public_holidays")
    .upsert(rows, { onConflict: "country,date" })
    .select("id");

  if (error) {
    throw new Error(error.message);
  }

  return {
    country,
    calendarId,
    year,
    skippedCount: skipped,
    syncedCount: rows.length,
  };
}

