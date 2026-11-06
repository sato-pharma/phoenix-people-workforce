import { getCompanyHolidaysForMonth, getEgyptFixedPublicHolidaysForMonth } from "@/lib/vacation/company-holidays";
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
  /**
   * True only when the Google Egypt holiday calendar was actually READ (iCal feed or Calendar
   * API). Distinct from `connected`, which is also true when the calendar was unreachable but a
   * hardcoded COMPANY_HOLIDAYS entry happens to overlap the requested month — in that case the
   * result silently contains ONLY the company entries and every public holiday is missing.
   * Money-safe consumers (Field Workforce Compliance payroll deductions) must gate on THIS flag,
   * because a missing public holiday reads downstream as a normal working day with no activity.
   */
  calendarReachable: boolean;
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

export function normalizeHolidayName(value: string) {
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

/**
 * DEGRADED-MODE ONLY: Egypt's fixed-date public holidays for the month, shaped like company rows.
 * Used when the Google calendar could not be read, so a national holiday is not silently treated
 * as an ordinary working day. Never merged into a successful lookup — Google already returns these.
 */
function fixedPublicHolidayRows(month: number, year: number): EgyptianNationalHoliday[] {
  return getEgyptFixedPublicHolidaysForMonth({ month, year }).map((holiday) => ({
    description: null,
    durationDays: 1,
    endDate: holiday.startDate,
    id: `fixed-public-${holiday.startDate}`,
    name: holiday.name,
    source: "company" as const,
    startDate: holiday.startDate,
  }));
}

/** Merges company-defined holidays into the Google calendar holidays for a month. */
function withCompanyHolidays(
  googleHolidays: EgyptianNationalHoliday[],
  company: EgyptianNationalHoliday[],
): EgyptianNationalHoliday[] {
  return company.length > 0 ? mergeHolidayRows([...googleHolidays, ...company]) : googleHolidays;
}

/**
 * Both helpers hand the RESPONSE back to their caller, which then reads `.text()` / `.json()` on
 * it — so a manual `AbortController` + `clearTimeout(timer)` in a `finally` protected nothing that
 * mattered: the deadline died here, at the return, and the caller's body read ran unbounded. That
 * is the same defect that let a CRM sync burn 301 seconds on 2026-09-02 (fetchJson in the
 * iReports360 client, since retired). `AbortSignal.timeout` is the right shape for a helper like this: the
 * deadline travels WITH the response and stays armed across the caller's body read. No caller here
 * keys on the error's name, so the DOMException rename (AbortError -> TimeoutError) changes nothing.
 */
async function fetchGoogleHolidayCalendar(input: {
  apiKey: string;
  calendarId: string;
  timeMax: string;
  timeMin: string;
}) {
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events`);
  url.searchParams.set("key", input.apiKey);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("timeMin", input.timeMin);
  url.searchParams.set("timeMax", input.timeMax);

  return await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(holidayFetchTimeoutMs),
  });
}

async function fetchGoogleHolidayCalendarIcs(calendarId: string) {
  const url = new URL(`https://calendar.google.com/calendar/ical/${encodeURIComponent(calendarId)}/public/basic.ics`);
  return await fetch(url, {
    cache: "no-store",
    headers: { Accept: "text/calendar,text/plain,*/*" },
    signal: AbortSignal.timeout(holidayFetchTimeoutMs),
  });
}

/**
 * ONE DOWNLOAD OF THE FEED, NOT ONE PER MONTH (2026-10-01, "slow to transfer between page and
 * page"). The iCal feed is the WHOLE calendar, yet every month that missed `holidayCache` downloaded
 * all of it again — a vacation report spanning twenty months fetched the same file twenty times, one
 * after another. The body is now kept per calendar for the same ten minutes a month's answer is
 * kept, and months that ask at the same moment share one download.
 *
 * What each month does with the body is unchanged, and so is every failure: only a readable (`ok`)
 * body is kept, so an unreachable feed is asked again next time exactly as before; a failed fetch
 * still reads as `null`; and a body that fails to read still throws, now to each caller waiting on
 * it. An entry also remembers the `fetch` that downloaded it and is only handed back to that same
 * `fetch` — so anything that swaps `fetch` (every holiday test stubs it) gets its own answer, never a
 * body another `fetch` downloaded.
 */
type GoogleHolidayIcsDownload = { body: string | null; status: number };
const googleHolidayIcsCache = new Map<string, { body: string; expiresAt: number; fetchImpl: typeof fetch; status: number }>();
const googleHolidayIcsInFlight = new Map<string, { download: Promise<GoogleHolidayIcsDownload | null>; fetchImpl: typeof fetch }>();

function loadGoogleHolidayCalendarIcs(calendarId: string): Promise<GoogleHolidayIcsDownload | null> {
  const fetchImpl = globalThis.fetch;
  const cached = googleHolidayIcsCache.get(calendarId);
  if (cached && cached.fetchImpl === fetchImpl && cached.expiresAt > Date.now()) {
    return Promise.resolve({ body: cached.body, status: cached.status });
  }
  const inFlight = googleHolidayIcsInFlight.get(calendarId);
  if (inFlight && inFlight.fetchImpl === fetchImpl) return inFlight.download;

  const download = (async (): Promise<GoogleHolidayIcsDownload | null> => {
    const response = await fetchGoogleHolidayCalendarIcs(calendarId).catch(() => null);
    if (!response) return null;
    if (!response.ok) return { body: null, status: response.status };
    const body = await response.text();
    googleHolidayIcsCache.set(calendarId, {
      body,
      expiresAt: Date.now() + holidayCacheTtlMs,
      fetchImpl,
      status: response.status,
    });
    return { body, status: response.status };
  })();
  googleHolidayIcsInFlight.set(calendarId, { download, fetchImpl });
  const release = () => {
    if (googleHolidayIcsInFlight.get(calendarId)?.download === download) googleHolidayIcsInFlight.delete(calendarId);
  };
  // Both handlers, so this bookkeeping chain can never itself be an unhandled rejection; the caller
  // still receives the download's own rejection from the promise returned below.
  void download.then(release, release);
  return download;
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

/**
 * Google's Egypt public-holiday calendar mixes two event types: entries whose DESCRIPTION is
 * exactly "Public holiday" (a real day off) and entries whose DESCRIPTION starts with
 * "Observance" (a cultural/religious date Google notes for awareness only — its own event text
 * literally says "To hide observances, go to Google Calendar Settings"). An observance is never a
 * day off; treating it as one is how e.g. "Flooding of the Nile" (Wafaa El-Nil, Aug 15) ended up
 * silently marked as a national holiday everywhere with no admin ever confirming it.
 */
function isObservanceOnly(description: string | null | undefined) {
  return /^observance/i.test(String(description ?? "").trim());
}

function googleEventsToHolidays(events: GoogleCalendarEvent[], monthStart: string, monthEnd: string) {
  return mergeHolidayRows(events
    .filter((event) => !isObservanceOnly(event.description))
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
    .filter((event) => !isObservanceOnly(event.description))
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
    // Shared per calendar across months — see loadGoogleHolidayCalendarIcs. `body` is non-null
    // exactly when the response was `ok`, which is the branch the inline read took.
    const ics = await loadGoogleHolidayCalendarIcs(candidateCalendarId);
    if (!ics) {
      lastStatus = 0;
    } else {
      lastStatus = ics.status;
      if (ics.body !== null) {
        const holidays = withCompanyHolidays(
          icsEventsToHolidays(parseGoogleHolidayIcs(ics.body), monthStart, monthEnd),
          company,
        );
        const result = {
          calendarId: candidateCalendarId,
          calendarReachable: true,
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
        calendarReachable: true,
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

  // Every path to here means the Google calendar could NOT be read, so `calendarReachable` is
  // false even when `connected` is true off the back of a company-holiday entry. The message is
  // now always populated: it used to be null whenever a COMPANY_HOLIDAYS entry overlapped the
  // month, which made a total calendar outage indistinguishable from a healthy lookup.
  // Degraded mode: fall back to company holidays PLUS Egypt's fixed-date public holidays, so a
  // national holiday is not silently reclassified as an ordinary working day. Moving Islamic /
  // Coptic holidays still cannot be derived here — hence calendarReachable: false, which money-safe
  // consumers gate on.
  const degradedHolidays = mergeHolidayRows([...company, ...fixedPublicHolidayRows(month, year)]);
  const unreachableMessage =
    `Google Calendar Egypt holiday calendar could not be loaded from the public iCal feed${apiKey.trim() ? " or Calendar API" : ""}. Last status: ${lastStatus || "unknown"}.` +
    " Falling back to company + fixed-date public holidays only; moving Islamic/Coptic holidays are missing for this month.";
  const result = {
    calendarId: calendarCandidates[0] ?? null,
    calendarReachable: false,
    connected: degradedHolidays.length > 0,
    holidays: degradedHolidays,
    message: unreachableMessage,
    month,
    sourceLabel: "Google Calendar Egypt public holidays",
    year,
  };
  holidayCache.set(cacheKey, { expiresAt: Date.now() + holidayCacheTtlMs, result });
  return result;
}

/**
 * GOOGLE STATES A POSTPONEMENT AS A SECOND EVENT, AND READING BOTH AS DAYS OFF BLOCKS TWO WORKING
 * DAYS FOR ONE HOLIDAY.
 *
 * Egypt's public-holiday calendar does not move an event when the government postpones the day
 * off. It keeps the official date and adds a second "Public holiday" event named
 * `Day off for <X>` on the substitute date. Read from the live feed, 2026-10-01:
 *
 *   2026-01-25  Revolution Day January 25     2026-01-29  Day off for Revolution Day January 25
 *   2026-06-30  June 30 Revolution            2026-07-02  Day off for June 30 Revolution
 *   2026-10-06  Armed Forces Day              2026-10-08  Day off for Armed Forces Day
 *   2027-01-25  Revolution Day January 25     2027-01-28  Day off for Revolution Day January 25
 *
 * Only ONE of each pair is a day off. Reading both is what blocked Tuesday 6 October AND Thursday
 * 8 October in the District Managers' weekly/monthly plans on 2026-10-01, and it is why moving the
 * 6 October row in the Bulk Holiday Calendar changed nothing anyone could see: the Thursday was
 * carrying its own separate entry the whole time, and the pair had to be hand-corrected twice.
 * It is not an October problem — it recurs every time a holiday falls midweek, and 2027 already
 * has one waiting.
 *
 * So the substitute's own name is taken at its word: where `Day off for <X>` exists, the event
 * named exactly `<X>` is NOT a day off. The substitute can land either side of the official date
 * (2025 carried `Day off for Sinai Liberation Day` the day BEFORE it) and can fall in an adjacent
 * month (June 30 -> July 2), so the neighbouring months are consulted too — both are already
 * cached per month and share one feed download, so this costs no extra network.
 *
 * TWO THINGS IT DELIBERATELY DOES NOT DO:
 *  - It never overrules an admin. A holiday whose official date carries a confirmed override is
 *    left alone here and relocated by that override exactly as before — including an override
 *    that says the official date IS the day off after all.
 *  - It never folds on a name that merely looks related. `Eid el Fitr` + `Eid el Fitr Holiday`,
 *    and `Prophet Mohamed's Birthday` + `Prophet Mohamed's Birthday Holiday`, are genuinely
 *    separate days off; they carry no `Day off for` prefix, so nothing matches.
 *
 * When a neighbouring month cannot be read the fold simply does not happen, leaving the extra day
 * marked as a holiday — the safe direction for anything that moves money.
 */
const DAY_OFF_FOR_PREFIX = /^day\s+off\s+for\s+/i;

/** `Day off for Armed Forces Day` -> the normalized name `armed forces day`; anything else -> null. */
export function substitutedHolidayName(name: string): string | null {
  const trimmed = String(name ?? "").trim();
  if (!DAY_OFF_FOR_PREFIX.test(trimmed)) return null;
  const base = trimmed.replace(DAY_OFF_FOR_PREFIX, "").trim();
  return base ? normalizeHolidayName(base) : null;
}

function adjacentPeriod(input: { month: number; year: number }, offset: number) {
  const index = input.year * 12 + (input.month - 1) + offset;
  return { month: (index % 12) + 1, year: Math.floor(index / 12) };
}

/**
 * The normalized names every `Day off for <X>` event supersedes, across the month and its two
 * neighbours. RAW source only: an override must never feed this, or an admin's own confirmation
 * would start folding other rows away.
 */
async function supersededHolidayNames(input: { month: number; year: number }): Promise<Set<string>> {
  const periods = [adjacentPeriod(input, -1), { month: input.month, year: input.year }, adjacentPeriod(input, 1)];
  const results = await Promise.all(periods.map((period) => getEgyptianNationalHolidays(period).catch(() => null)));
  const names = new Set<string>();
  for (const result of results) {
    if (!result) continue;
    for (const holiday of result.holidays) {
      const superseded = substitutedHolidayName(holiday.name);
      if (superseded) names.add(superseded);
    }
  }
  return names;
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
  const [overrides, superseded] = await Promise.all([
    listHolidayOverridesOverlappingRange(monthStart, monthEnd).catch(() => []),
    supersededHolidayNames({ month: raw.month, year: raw.year }),
  ]);

  const overrideByOfficialDate = new Map(overrides.map((override) => [override.officialDate, override]));

  // Drop entries whose official date has a confirmed override — the real day
  // off lives at the observed date instead (injected below, in whichever
  // month it actually falls in) — and entries Google's own `Day off for <X>`
  // event has already moved to another date (see supersededHolidayNames). An
  // override wins over the fold: it is the admin's explicit confirmation.
  const withoutOverriddenOfficialDates = raw.holidays.filter(
    (holiday) =>
      !overrideByOfficialDate.has(holiday.startDate) && !superseded.has(normalizeHolidayName(holiday.name)),
  );

  const injected: EgyptianNationalHoliday[] = [];
  for (const override of overrides) {
    // Range overlap: the confirmed observed period is observedDate..observedEndDate
    // (a multi-day national vacation, not just a single shifted day).
    if (override.observedEndDate < monthStart || override.observedDate > monthEnd) continue;
    // No "already present at this date" skip here: every holiday whose official
    // date had a confirmed override was already dropped above, so this override's
    // own raw entry can never collide with itself. Injecting unconditionally means
    // two distinct holidays that happen to land on the same observed date both
    // still show up, instead of one silently disappearing behind the other.
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

/**
 * Confirmed holidays across several months at once, PLUS whether Google's calendar could be read
 * for every one of them.
 *
 * A Google Calendar outage is not the same as "no holidays". Company and fixed-date public
 * holidays still load, so `connected` stays true for a month holding one (1 May, say) while the
 * moving Islamic and Coptic holidays — both Eids, Islamic New Year, the Prophet's Birthday and
 * Coptic Easter — are missing and read as ordinary working days. Owner rule, 2026-09-16: a path
 * that can cost an employee money refuses while `calendarReachable` is false, rather than charge,
 * approve or allow a day that was actually a public holiday. Each caller words its own refusal,
 * because what it is refusing to do differs; this gathers the months, dedupes, and reports both
 * flags.
 */
export async function getConfirmedNationalHolidaysForPeriods(
  periods: ReadonlyArray<{ month: number; year: number }>,
): Promise<{ calendarReachable: boolean; connected: boolean; holidays: EgyptianNationalHoliday[] }> {
  const results = await Promise.all(periods.map((period) => getConfirmedNationalHolidays(period)));
  const holidays: EgyptianNationalHoliday[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    for (const holiday of result.holidays) {
      if (seen.has(holiday.id)) continue;
      seen.add(holiday.id);
      holidays.push(holiday);
    }
  }
  return {
    calendarReachable: results.every((result) => result.calendarReachable),
    connected: results.every((result) => result.connected),
    holidays,
  };
}

/**
 * Every confirmed national-holiday DATE between two ISO dates, as a set.
 *
 * Exists because a consumer that walks a calendar day by day needs "is this date a holiday", not
 * a month's worth of holiday records. `getConfirmedNationalHolidays` answers one month at a time
 * and returns SPANS (`startDate`..`endDate`, and `endDate` is null for a single day), so every
 * such consumer was expanding the spans and looping the months itself. This is that loop, once,
 * in the module that owns the data.
 *
 * BEST EFFORT, and the direction of the failure matters. A month whose lookup throws is skipped
 * rather than fatal, so an outage UNDER-excludes holidays. Downstream that reads as an ordinary
 * working day, which for an absence detector means a false alarm rather than a missed one — the
 * safer direction, but not a free one: read `calendarReachable` on EgyptianNationalHolidayResult
 * before using this anywhere a missing holiday would move money.
 *
 * NOTE: company-vacation-report.ts keeps its own copy of this loop deliberately. That version is
 * wrapped in the report's own `unstable_cache` under the report's cache tag so it can be busted
 * when a leave row is approved; this one has no cache of its own and is cached by its callers.
 */
export async function getNationalHolidayDateSet(startDate: string, endDate: string): Promise<Set<string>> {
  const dates = new Set<string>();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate > endDate) {
    return dates;
  }

  const months: Array<{ month: number; year: number }> = [];
  let year = Number(startDate.slice(0, 4));
  let month = Number(startDate.slice(5, 7));
  const endYear = Number(endDate.slice(0, 4));
  const endMonth = Number(endDate.slice(5, 7));
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push({ month, year });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  const nextDay = (dateIso: string) => {
    const next = new Date(`${dateIso}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString().slice(0, 10);
  };

  const results = await Promise.all(
    months.map(({ month: m, year: y }) => getConfirmedNationalHolidays({ month: m, year: y }).catch(() => null)),
  );
  for (const result of results) {
    if (!result) continue;
    for (const holiday of result.holidays) {
      const spanEnd = holiday.endDate ?? holiday.startDate;
      for (let date = holiday.startDate; date <= spanEnd; date = nextDay(date)) {
        if (date >= startDate && date <= endDate) dates.add(date);
      }
    }
  }
  return dates;
}
