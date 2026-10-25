/**
 * Company-wide vacation report: merges official HR vacation requests with unverified
 * CRM-derived leave candidates, so admins can see everything in one place with a clear
 * `source` column distinguishing the two.
 *
 * IMPORTANT — read-only, advisory: the CRM-derived rows are estimates built from
 * heuristics (excuse-comment filtering, national-holiday exclusion, and attendance
 * cross-checks), not employee-submitted or HR-approved leave. This service never writes to
 * v2_vacation_requests or any leave balance — it only reads and reports. Turning a CRM
 * signal into a real leave adjustment is a separate, human-reviewed decision made through
 * the existing Field Workforce Compliance recommendation workflow
 * (src/lib/field-workforce-compliance/recommendations.ts), not this report.
 *
 * The CRM-signal methodology mirrors src/lib/field-workforce-compliance/{ireports360-source,
 * attendance-cross-check}.ts, but is intentionally NOT the same code path: FWC's preview is
 * scoped to "field commercial workforce" only (see eligibility.ts) and only produces whole-day
 * AV counts. This report covers every CRM identity org-wide (including Head Office admin/HR
 * roles FWC excludes by design).
 *
 * Owner-confirmed trigger rule (2026-07, ampm half-day added 2026-07-18): the ONLY thing that
 * counts a day as CRM leave is the CRM's own AV marking (visit_type -4) — after excuse-comment and
 * public-holiday exclusion, an AV day counts at the value the CRM itself recorded: a full day, or
 * 0.5 when the CRM marked it AM/PM. Honoring the CRM's own ampm half-day is NOT a heuristic — it's
 * the recorded value, the same reading the CRM master Vacations tab uses. What must NEVER be used
 * is a regular/campaign visit-count heuristic (e.g. "fewer than 5 PM visits") to downgrade or zero
 * out an AV day — that inference was tried and explicitly rejected as too aggressive. The other
 * downgrade is a device-mapped employee with a real fingerprint punch that day, which is physical
 * proof, not a soft inference — attendance-cross-check.ts's 5h threshold still applies there.
 * Report rows with 0 working days are never returned — see getCompanyVacationReport.
 *
 * Historical caching (2026-07, owner-requested): re-scanning the whole date range on every page
 * view is wasteful once a month is closed — that data essentially never changes. Every date-range
 * fetch below is split at the current-month boundary: everything strictly before this month is
 * "historical" and goes through a long-revalidate unstable_cache; the current month is always
 * fetched fresh. Cached fetchers return plain arrays (never Maps/Sets — those don't survive
 * Next's cache serialization) and do no employee-lookup — all classification/merging happens
 * afterward, uncached, so it always reflects the latest employee roster and device mappings.
 */

import { unstable_cache } from "next/cache";

import { COMPANY_VACATION_REPORT_CACHE_TAG } from "@/lib/dashboard/invalidation";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import {
  EMPLOYEE_LINE_SELECT,
  resolveEmployeeLineName,
  type EmployeeLineFields,
} from "@/lib/employees/employee-org-labels";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { queryVisits } from "@/lib/crm/reads";
import { loadActiveDeviceMappedHrIds } from "@/lib/attendance/device-user-mapping";
import { loadEmployeeDayPunchMinutes } from "@/lib/attendance/punch-minutes";
import { getConfirmedNationalHolidays, getConfirmedNationalHolidaysForPeriods } from "@/lib/vacation/national-holidays";
import type { CompanyVacationReportSource } from "@/lib/vacation/company-vacation-report-source";

/** Same threshold as attendance-cross-check.ts's AV_HALF_DAY_MAX_WORKED_MINUTES —
 * owner-confirmed (2026-07): under 5 worked hours on a CRM-AV day reads as a half-day. Only
 * ever consulted for device-mapped employees with real fingerprint data — see the module doc
 * comment above for why a visit-count heuristic is deliberately NOT used for anyone else. */
const AV_HALF_DAY_MAX_WORKED_MINUTES = 5 * 60;
const EXCUSE_COMMENT_PATTERN = /excuse/i;
/** CRM visit_type for "Annual Vacation" — see the visit-type table in crm/visit-type-meaning.ts.
 * Deliberately excludes -15 (Health Day): this report is scoped to vacation, not sick leave.
 * NOTE: this is intentionally NARROWER than the CRM master "Vacations" tab (crm/master.ts
 * computeVacationPeriods), which matches any 'vacation'-worded description. BOTH honor the CRM's
 * ampm half-day (0.5). This report additionally drops public-holiday / excuse-labeled /
 * proven-worked days and merges HR-approved leave, so its counts stay narrower than the raw tab
 * by design — see that function's docstring. */
const ANNUAL_VACATION_VISIT_TYPE = -4;
/** Historical (closed-month) data is "pinned" for 6 hours — long enough to avoid re-scanning
 * on every page view, short enough that a same-day HR correction or late CRM sync still shows
 * up within a business day. */
const HISTORICAL_REVALIDATE_SECONDS = 6 * 60 * 60;
/** Exported so the approve-and-deduct route (app/api/vacation/company-report/approve) can bust
 * this cache immediately after creating a real vacation_requests row — otherwise a newly
 * approved CRM Signal date could sit invisible in the historical cache for up to 6h. */
// Declared as a bare string in dashboard/invalidation.ts (its comment says why) and re-exported here.
export { COMPANY_VACATION_REPORT_CACHE_TAG };
const CACHE_TAG = COMPANY_VACATION_REPORT_CACHE_TAG;

/**
 * Re-exported as a TYPE ONLY, deliberately. The values that go with it (the source list, the
 * Phoenix/CRM mapping) live in ./company-vacation-report-source because the report table is a
 * client component and this module reaches node:crypto through @/lib/crm/reads — see that file's
 * header. A type re-export is erased at compile time and costs the client bundle nothing; adding
 * `export { COMPANY_VACATION_REPORT_SOURCES }` here would quietly undo the split.
 */
export type { CompanyVacationReportSource } from "@/lib/vacation/company-vacation-report-source";

/** Which half of the day a 0.5-day entry covers. "full_day" for a 1-day entry. Threaded through
 * from the CRM's own ampm marking so the approve route (app/api/vacation/company-report/approve)
 * can record the correct half instead of always guessing PM — see classifyAvDate. */
export type CompanyVacationDayPart = "am_only" | "full_day" | "pm_only";

export type CompanyVacationReportRow = {
  /** Remaining balance after this request, as stored on the HR request at creation time (see
   * src/lib/vacation/service.ts's calculatePaymentForRequest / VacationBalanceSnapshot). Only
   * set for an "HR Approved" row whose vacation_type isn't "compensatory" — see buildHrRows for
   * why both of those exclusions matter. Null for everything else (CRM Signal rows never
   * touched the balance engine; Pending/Rejected/Cancelled rows never actually deducted
   * anything, so their stored snapshot would misleadingly read as a real balance change). */
  balanceAfterDays: number | null;
  /** Balance available immediately before this request was deducted. Same scope as
   * balanceAfterDays above. */
  balanceBeforeDays: number | null;
  /** Which half of the day this row covers, for a 0.5-day CRM Signal row only (null for HR rows
   * and full-day rows — HR rows already have their own stored day_part and never go through the
   * approve route). Lets the "Approve as real leave" action record the correct half instead of
   * defaulting to PM regardless of the actual CRM/fingerprint evidence. */
  dayPart: CompanyVacationDayPart | null;
  detail: string;
  employeeName: string;
  endDate: string;
  /** Derived from balanceBeforeDays > 0. Null (not "No") wherever balanceBeforeDays is null —
   * see that field's doc comment for the full list of cases this covers. */
  hasBalance: boolean | null;
  hrId: string;
  jobTitle: string | null;
  lineName: string | null;
  requestId: string | null;
  source: CompanyVacationReportSource;
  startDate: string;
  workingDays: number;
};

type VisitRow = {
  agent_hr_id: string | null;
  agent_name: string | null;
  ampm: string | null;
  comment: string | null;
  visit_date: string;
  visit_type: number;
};

type EmployeeRow = EmployeeLineFields & {
  full_name: string | null;
  hr_id: string;
  job_title: string | null;
  nickname: string | null;
};

export type HrVacationRequestRow = {
  balance_after_days: number | string | null;
  balance_before_days: number | string | null;
  duration_days: number | null;
  employee_hr_id: string | null;
  employee_name: string | null;
  end_date: string;
  id: string;
  line_name: string | null;
  start_date: string;
  status: string | null;
  vacation_type: string | null;
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function addDaysIso(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function currentMonthStartIso(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-01`;
}

type DateRange = { end: string; start: string };

/** Splits [startDate,endDate] at the current-month boundary. Everything strictly before this
 * month is "historical" (safe to cache long-term — those months are effectively closed); the
 * rest is "current" (always fetched fresh). Either half is null when the range doesn't reach it. */
function splitHistoricalAndCurrent(startDate: string, endDate: string): {
  current: DateRange | null;
  historical: DateRange | null;
} {
  const monthStart = currentMonthStartIso();
  const historicalEnd = addDaysIso(monthStart, -1);
  const historical = startDate <= historicalEnd
    ? { end: endDate < historicalEnd ? endDate : historicalEnd, start: startDate }
    : null;
  const current = endDate >= monthStart
    ? { end: endDate, start: startDate > monthStart ? startDate : monthStart }
    : null;
  return { current, historical };
}

function monthKeysBetween(startDate: string, endDate: string): Array<{ month: number; year: number }> {
  const keys: Array<{ month: number; year: number }> = [];
  let year = Number(startDate.slice(0, 4));
  let month = Number(startDate.slice(5, 7));
  const endYear = Number(endDate.slice(0, 4));
  const endMonth = Number(endDate.slice(5, 7));
  while (year < endYear || (year === endYear && month <= endMonth)) {
    keys.push({ month, year });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return keys;
}

/**
 * Whether the day being approved can be told apart from a public holiday.
 *
 * The listing below is best-effort on purpose — an outage just under-excludes a month, and the
 * historical half is cached under this report's own tag, so a degraded list can outlive the
 * 10-minute holiday cache. Approving is the part that costs money: it takes the day off the
 * employee's annual balance for good. So the approve path asks this first and refuses while
 * Google's calendar cannot be read (owner, 2026-09-16), rather than approve what may be an Eid.
 */
export async function getHolidayCalendarReadinessForLeave(
  startDate: string,
  endDate: string,
): Promise<{ message: string | null; readable: boolean }> {
  const { calendarReachable } = await getConfirmedNationalHolidaysForPeriods(monthKeysBetween(startDate, endDate));
  if (calendarReachable) return { message: null, readable: true };
  return {
    message:
      "The public holiday calendar could not be read, so a day that was actually a public holiday cannot be told from a working day. Nothing was approved and no balance was changed — try again shortly.",
    readable: false,
  };
}

async function loadHolidayDates(startDate: string, endDate: string): Promise<string[]> {
  return holidayDatesOf(await loadHolidayResults(startDate, endDate));
}

async function loadHolidayResults(startDate: string, endDate: string) {
  // One call per month, run concurrently — sequential awaits here were a meaningful chunk of
  // page load time for a multi-month range with no benefit (each month's lookup is independent).
  return Promise.all(monthKeysBetween(startDate, endDate).map(({ month, year }) =>
    getConfirmedNationalHolidays({ month, year }).catch(() => null)));
}

/**
 * The historical half, which is cached for 6 h — so it THROWS when any month could not be read
 * (cache audit, 2026-10-26). A month Google's feed could not answer comes back with the fixed-date
 * holidays only, and cached that way the Eid days counted as vacation days in the report and its
 * export for six hours after the feed was back. A throw is never cached: loadHolidayDateSet falls
 * back to the uncached best-effort read for this one load, and the next load asks again.
 */
async function loadHolidayDatesComplete(startDate: string, endDate: string): Promise<string[]> {
  const results = await loadHolidayResults(startDate, endDate);
  if (results.some((result) => !result || !result.calendarReachable)) {
    throw new Error("The public holiday calendar could not be read for every month of this range.");
  }
  return holidayDatesOf(results);
}

function holidayDatesOf(results: Awaited<ReturnType<typeof loadHolidayResults>>): string[] {
  const dates = new Set<string>();
  for (const result of results) {
    if (!result) continue; // Best-effort — a holiday lookup outage just under-excludes that month.
    for (const holiday of result.holidays) {
      const start = holiday.startDate;
      const end = holiday.endDate ?? holiday.startDate;
      for (let date = start; date <= end; date = addDaysIso(date, 1)) {
        dates.add(date);
      }
    }
  }
  return [...dates];
}

// A NEW key: an entry the old best-effort version cached during an outage is never read back.
const loadHolidayDatesCached = unstable_cache(loadHolidayDatesComplete, ["company-vacation-report-holidays-complete"], {
  revalidate: HISTORICAL_REVALIDATE_SECONDS,
  tags: [CACHE_TAG],
});

async function loadHolidayDateSet(startDate: string, endDate: string): Promise<Set<string>> {
  const { current, historical } = splitHistoricalAndCurrent(startDate, endDate);
  const [historicalDates, currentDates] = await Promise.all([
    historical
      ? loadHolidayDatesCached(historical.start, historical.end).catch(() => loadHolidayDates(historical.start, historical.end))
      : Promise.resolve([]),
    current ? loadHolidayDates(current.start, current.end) : Promise.resolve([]),
  ]);
  return new Set([...historicalDates, ...currentDates]);
}

/** Raw HR-side leave requests for the range — no employee lookup here (kept cacheable), that
 * happens once for both HR and CRM rows in getCompanyVacationReport. */
async function loadHrVacationRequestsRaw(startDate: string, endDate: string): Promise<HrVacationRequestRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("v2_vacation_requests")
    .select("id,employee_hr_id,employee_name,line_name,vacation_type,start_date,end_date,duration_days,status,balance_before_days,balance_after_days")
    .lte("start_date", endDate)
    .gte("end_date", startDate);
  if (error) throw new Error(`Failed to load HR vacation requests: ${error.message}`);
  return (data ?? []) as HrVacationRequestRow[];
}

const loadHrVacationRequestsRawCached = unstable_cache(loadHrVacationRequestsRaw, ["company-vacation-report-hr-requests"], {
  revalidate: HISTORICAL_REVALIDATE_SECONDS,
  tags: [CACHE_TAG],
});

/**
 * A single request can span the historical/current split boundary (e.g. starts June 28, ends
 * July 5) — the underlying query matches on date-range OVERLAP, so a boundary-spanning request
 * satisfies both the historical and current sub-queries and would otherwise appear twice in the
 * concatenated result. Dedupe by id — never by date, since two distinct real requests can
 * legitimately share a date. Exported and pure so this is directly unit-testable.
 */
export function dedupeHrVacationRequestsById(rows: HrVacationRequestRow[]): HrVacationRequestRow[] {
  const byId = new Map<string, HrVacationRequestRow>();
  for (const row of rows) byId.set(row.id, row);
  return [...byId.values()];
}

async function loadHrVacationRequests(startDate: string, endDate: string): Promise<HrVacationRequestRow[]> {
  const { current, historical } = splitHistoricalAndCurrent(startDate, endDate);
  const [historicalRows, currentRows] = await Promise.all([
    historical ? loadHrVacationRequestsRawCached(historical.start, historical.end) : Promise.resolve([]),
    current ? loadHrVacationRequestsRaw(current.start, current.end) : Promise.resolve([]),
  ]);
  return dedupeHrVacationRequestsById([...historicalRows, ...currentRows]);
}

/** ireports360_visits has ~99k+ rows total, far past PostgREST's default 1000-row cap, so a
 * plain .select() silently truncates without pagination. Only visit_type = -4 (Annual
 * Vacation) rows are ever read by this report — everything else is discarded downstream — so
 * filtering here too avoids fetching ~99% of rows just to throw them away. Cut this page's
 * server render from 33s down to about a second before the historical-caching split below cut
 * it further. */
async function loadAnnualVacationVisits(startDate: string, endDate: string): Promise<VisitRow[]> {
  // Only visit_type = -4 (Annual Vacation) rows are ever read by this report; the CRM read
  // layer full-scans (keyset) so the ~99% of non-AV rows are filtered server-side, not fetched.
  return queryVisits<VisitRow>({
    visitTypes: [ANNUAL_VACATION_VISIT_TYPE],
    dateFrom: startDate,
    dateTo: endDate,
    requireAgentHrId: true,
    columns: "agent_hr_id,agent_name,visit_date,ampm,comment,visit_type",
  });
}

const loadAnnualVacationVisitsCached = unstable_cache(loadAnnualVacationVisits, ["company-vacation-report-visits"], {
  revalidate: HISTORICAL_REVALIDATE_SECONDS,
  tags: [CACHE_TAG],
});

async function loadAnnualVacationVisitsSplit(startDate: string, endDate: string): Promise<VisitRow[]> {
  const { current, historical } = splitHistoricalAndCurrent(startDate, endDate);
  const [historicalRows, currentRows] = await Promise.all([
    historical ? loadAnnualVacationVisitsCached(historical.start, historical.end) : Promise.resolve([]),
    current ? loadAnnualVacationVisits(current.start, current.end) : Promise.resolve([]),
  ]);
  return [...historicalRows, ...currentRows];
}

async function loadEmployeesRaw(): Promise<EmployeeRow[]> {
  // The line comes from the `line_id` LINK — `employees.line_name` is a denormalized copy nothing
  // writes (1 of 198 rows carry it). See employee-line.ts.
  const { data, error } = await getSupabaseAdmin()
    .from("employees")
    .select(`hr_id,full_name,job_title,nickname,${EMPLOYEE_LINE_SELECT}`);
  if (error) throw new Error(`Failed to load employees: ${error.message}`);
  return (data ?? []) as EmployeeRow[];
}

// Employee roster and device mappings aren't date-ranged — short revalidate (5 min) so a
// same-day hire, role change, or new fingerprint mapping still shows up quickly.
const loadEmployeesCached = unstable_cache(loadEmployeesRaw, ["company-vacation-report-employees"], {
  revalidate: 300,
  tags: [CACHE_TAG],
});
// A failed read THROWS, exactly as the employee roster above does (cache audit, 2026-10-26). It used
// to be caught here as "nobody is fingerprint-mapped", and that empty answer was cached for 5 min:
// days the fingerprints prove were WORKED showed as CRM vacation signals, and the approve route takes
// the day count the screen sends — so an approval in that window could deduct leave for a worked
// day. An error page that clears on reload is the safe failure. A new key, so no empty set the old
// version cached is ever read back.
const loadDeviceMappedHrIdsCached = unstable_cache(
  async () => [...(await loadActiveDeviceMappedHrIds())],
  ["company-vacation-report-device-mapped-v2"],
  { revalidate: 300, tags: [CACHE_TAG] },
);

export type ClassifiedAvDate = {
  dayPart: CompanyVacationDayPart;
  detail: string;
  source: CompanyVacationReportSource;
  workingDays: number;
};

/** Picks which half a 0.5-day result covers, from the CRM's own ampm marking on the surviving
 * (non-excuse) rows for that date — the same authoritative signal classifyAvDate already reads
 * to decide the day is a half-day at all, not a new inference. Falls back to "pm_only" (the
 * previous unconditional behavior) only when no row carries an AM/PM mark at all — e.g. a
 * fingerprint-driven downgrade of a CRM-claimed full day, where the CRM never recorded which
 * half was actually worked. */
function resolveHalfDayPart(rows: Array<{ ampm: string | null }>): CompanyVacationDayPart {
  const marked = rows.find((row) => row.ampm === "AM" || row.ampm === "PM");
  return marked?.ampm === "AM" ? "am_only" : "pm_only";
}

/**
 * Pure decision logic for one employee-day's AV visit rows, extracted so it's directly
 * unit-testable without a DB. Returns null when the day should NOT appear in the report at
 * all: every AV row that day was excuse-labeled, it's a public holiday, or (device-mapped
 * only) fingerprint activity proves >=5h worked that day — see the module doc comment for why
 * a 0-day "not vacation" row is never returned rather than shown with workingDays: 0.
 */
export function classifyAvDate(input: {
  comments: Array<string | null>;
  /** Parallel to `comments` (same order/length): the CRM `ampm` flag of each AV row that day.
   * An "AM"/"PM" row is a CRM-marked HALF day; anything else (null/empty) is a full day. Optional
   * so older callers/tests that don't pass it fall back to whole-day behavior. */
  ampms?: Array<string | null>;
  isDeviceMapped: boolean;
  isHoliday: boolean;
  workedMinutes: number | null;
}): ClassifiedAvDate | null {
  if (input.isHoliday) return null;

  // Only rows NOT labeled as an excuse count toward this date being a real leave day — if even
  // one non-excuse AV row survives, the date still counts. Only an all-excuse day is dropped.
  // Keep each surviving row's ampm alongside its comment so the half-day marking stays aligned.
  const ampms = input.ampms ?? [];
  const nonExcuseRows = input.comments
    .map((comment, i) => ({ comment, ampm: ampms[i] ?? null }))
    .filter((row) => !EXCUSE_COMMENT_PATTERN.test(row.comment ?? ""));
  if (nonExcuseRows.length === 0) return null;
  const comment = nonExcuseRows.map((row) => row.comment).find((value) => value) ?? "";

  // The CRM's OWN half-day marking (ampm), honored the same way the CRM master Vacations tab does:
  // each AM/PM row is 0.5, each unmarked row is a full day; a single calendar day is capped at 1.0.
  // This is the CRM's recorded value, NOT a visit-count inference (which is still never used here).
  const isHalf = (ampm: string | null) => ampm === "AM" || ampm === "PM";
  const crmDayValue = Math.min(1, nonExcuseRows.reduce((sum, row) => sum + (isHalf(row.ampm) ? 0.5 : 1), 0));

  const hasFingerprintData = input.isDeviceMapped && input.workedMinutes != null;
  if (hasFingerprintData) {
    const workedMinutes = input.workedMinutes as number;
    if (workedMinutes >= AV_HALF_DAY_MAX_WORKED_MINUTES) {
      // Proven fully worked — not a vacation day at all, so it's dropped, never shown as 0.
      return null;
    }
    const halfDayPart = resolveHalfDayPart(nonExcuseRows);
    return {
      dayPart: halfDayPart,
      detail: `Fingerprint shows under 5h worked — likely a half-day ("${comment}")${
        nonExcuseRows.some((row) => row.ampm === "AM" || row.ampm === "PM")
          ? ` (${halfDayPart === "am_only" ? "AM" : "PM"})`
          : ""
      }.`,
      source: "CRM Signal — Half-Day (Attendance Partial)",
      workingDays: 0.5,
    };
  }

  // No fingerprint proof available (not device-mapped, or no punch that day) — trust the CRM AV
  // marking, including its own AM/PM half-day flag. No visit-count inference: a regular/campaign
  // visit-count heuristic must never downgrade or zero an AV day here.
  const isCrmHalfDay = crmDayValue <= 0.5;
  const halfDayPart = isCrmHalfDay ? resolveHalfDayPart(nonExcuseRows) : "full_day";
  return {
    dayPart: halfDayPart,
    detail: isCrmHalfDay
      ? `${comment || "Annual Vacation"} (half-day — CRM ${halfDayPart === "am_only" ? "AM" : "PM"})`
      : (comment || "Annual Vacation"),
    source: "CRM Signal — Vacation",
    workingDays: crmDayValue,
  };
}

function buildEmployeeLookup(rows: EmployeeRow[]): Map<string, EmployeeRow> {
  const employeeByKey = new Map<string, EmployeeRow>();
  for (const row of rows) {
    const key = canonicalHrIdKey(row.hr_id);
    if (key) employeeByKey.set(key, row);
  }
  return employeeByKey;
}

/** Every HR vacation request in range, tagged by its current status. Job title/line come from
 * the shared employee lookup (employeeByKey), not from v2_vacation_requests, which has no
 * job_title column — this is what previously left job title blank on every HR-sourced row.
 * Exported (pure, DB-free) so the balance-column exclusions below are directly unit-testable. */
export function buildHrRows(rawRows: HrVacationRequestRow[], employeeByKey: Map<string, EmployeeRow>): CompanyVacationReportRow[] {
  const statusToSource: Record<string, CompanyVacationReportSource> = {
    approved: "HR Approved",
    cancelled: "HR Cancelled",
    pending: "HR Pending",
    rejected: "HR Rejected",
  };

  return rawRows.map((row): CompanyVacationReportRow => {
    const key = canonicalHrIdKey(row.employee_hr_id ?? "");
    const employee = key ? employeeByKey.get(key) : undefined;
    const source = statusToSource[String(row.status ?? "").toLowerCase()] ?? "HR Pending";
    const rawBalanceBeforeDays = row.balance_before_days == null ? null : Number(row.balance_before_days);
    const rawBalanceAfterDays = row.balance_after_days == null ? null : Number(row.balance_after_days);
    // The stored balance snapshot is only meaningful for a request that actually deducted
    // balance: it must be Approved (Pending/Rejected/Cancelled never touched the balance — the
    // stored numbers are just a submission-time snapshot of what WOULD have happened) AND not
    // "compensatory" (calculateVacationPayment always returns balanceBeforeDays/AfterDays 0/0 for
    // compensatory, which isn't drawn from the annual/emergency balance pool at all — showing
    // that as "Has Balance: No" would misleadingly read as "ran out of leave").
    const balanceApplies = source === "HR Approved" && row.vacation_type !== "compensatory";
    const balanceBeforeDays = balanceApplies && rawBalanceBeforeDays != null && Number.isFinite(rawBalanceBeforeDays)
      ? rawBalanceBeforeDays
      : null;
    const balanceAfterDays = balanceApplies && rawBalanceAfterDays != null && Number.isFinite(rawBalanceAfterDays)
      ? rawBalanceAfterDays
      : null;
    return {
      balanceAfterDays,
      balanceBeforeDays,
      dayPart: null,
      detail: row.vacation_type ?? "",
      employeeName: row.employee_name ?? row.employee_hr_id ?? "",
      endDate: row.end_date,
      hasBalance: balanceBeforeDays != null ? balanceBeforeDays > 0 : null,
      hrId: row.employee_hr_id ?? "",
      jobTitle: employee?.job_title ?? null,
      // The REQUEST's own line first — that one is real data written when the request was made,
      // and it is the line the person was on at the time. The roster is the fallback, resolved
      // from the link rather than from the dead label it used to read.
      lineName: row.line_name ?? resolveEmployeeLineName(employee),
      requestId: row.id,
      source,
      startDate: row.start_date,
      // duration_days, NOT working_days: working_days has a static DB default of 1 and is
      // never actually written by src/lib/vacation/service.ts's create/admin-create paths (only
      // duration_days is) — confirmed live: a real half-day (0.50) and a real 3-day (3.00)
      // request both showed working_days=1. duration_days is the one the app actually computes
      // and writes (calculateVacationDurationDays), so it's the only trustworthy source here.
      workingDays: Number(row.duration_days ?? 0),
    };
  });
}

/** Recomputes this session's validated CRM-signal methodology org-wide (not scoped to FWC's
 * "field commercial workforce" eligibility list) — see the module doc comment above. */
async function buildCrmSignalRows(input: {
  deviceMappedKeys: Set<string>;
  employeeByKey: Map<string, EmployeeRow>;
  endDate: string;
  startDate: string;
}): Promise<CompanyVacationReportRow[]> {
  const { deviceMappedKeys, employeeByKey, endDate, startDate } = input;

  const [visits, holidayDates] = await Promise.all([
    loadAnnualVacationVisitsSplit(startDate, endDate),
    loadHolidayDateSet(startDate, endDate),
  ]);

  // Per hrKey, AV-type visits grouped by date (for excuse-detection + dedupe). visits is
  // already filtered to visit_type = -4 at the query level in loadAnnualVacationVisits — see
  // the module doc comment on why a regular/campaign visit-count heuristic is not used here.
  const avVisitsByKeyAndDate = new Map<string, Map<string, VisitRow[]>>();
  for (const visit of visits) {
    const key = canonicalHrIdKey(visit.agent_hr_id ?? "");
    if (!key) continue;
    const byDate = avVisitsByKeyAndDate.get(key) ?? new Map<string, VisitRow[]>();
    const dayVisits = byDate.get(visit.visit_date) ?? [];
    dayVisits.push(visit);
    byDate.set(visit.visit_date, dayVisits);
    avVisitsByKeyAndDate.set(key, byDate);
  }

  // Worked minutes (fingerprint), only meaningful for device-mapped employees. Historical
  // months' punches are also frozen once closed, but punch-minutes isn't split/cached here —
  // it's only ever computed for a handful of device-mapped employees, not the ~99k-row cost
  // the visits fetch was.
  const trackedHrIds = [...avVisitsByKeyAndDate.keys()]
    .filter((key) => deviceMappedKeys.has(key))
    .map((key) => employeeByKey.get(key)?.hr_id)
    .filter((hrId): hrId is string => Boolean(hrId));
  const dayPunchMinutes = trackedHrIds.length > 0
    ? await loadEmployeeDayPunchMinutes({ dateFromIso: startDate, dateToIso: endDate, employeeHrIds: trackedHrIds })
    : new Map();
  const workedMinutesByKeyAndDate = new Map<string, number | null>();
  for (const [hrId, byDate] of dayPunchMinutes as Map<string, Map<string, { firstPunchMinutes: number | null; lastPunchMinutes: number | null; visiblePunchCount: number }>>) {
    const key = canonicalHrIdKey(hrId);
    if (!key) continue;
    for (const [dateIso, punches] of byDate) {
      // A single punch (or two punches at the identical minute) computes worked=0 minutes,
      // which would otherwise satisfy "<5h worked" and misclassify a stray/device-artifact
      // punch as a real half-day. Require at least 2 distinct punch times before trusting the
      // duration as real evidence — with fewer than that, fall through to null (no fingerprint
      // proof), which trusts the CRM AV entry at face value as a full day, same as any other
      // device-mapped day with zero punches.
      const span = punches.visiblePunchCount >= 2 && punches.firstPunchMinutes != null && punches.lastPunchMinutes != null
        ? punches.lastPunchMinutes - punches.firstPunchMinutes
        : null;
      // Guard the October DST fall-back edge: punches are ordered by absolute time then folded
      // to Cairo minute-of-day, so on the one night the 02:00-02:59 window repeats, the last
      // punch's minute-of-day can be smaller than the first's -> a NEGATIVE span. A negative
      // (physically impossible) span is unmeasurable, not a "<5h half-day": treat it as null so
      // classifyAvDate trusts the CRM AV entry at face value as a full day, never fabricating a
      // half-day from garbled data. Behaviour-neutral on all real (non-folded) days.
      const worked = span != null && span >= 0 ? span : null;
      workedMinutesByKeyAndDate.set(`${key}|${dateIso}`, worked);
    }
  }

  const rows: CompanyVacationReportRow[] = [];
  for (const [key, byDate] of avVisitsByKeyAndDate) {
    const employee = employeeByKey.get(key);
    for (const [dateIso, dayVisits] of byDate) {
      const isDeviceMapped = deviceMappedKeys.has(key);
      const workedMinutes = isDeviceMapped ? workedMinutesByKeyAndDate.get(`${key}|${dateIso}`) ?? null : null;
      const classified = classifyAvDate({
        comments: dayVisits.map((visit) => visit.comment),
        ampms: dayVisits.map((visit) => visit.ampm),
        isDeviceMapped,
        isHoliday: holidayDates.has(dateIso),
        workedMinutes,
      });
      if (!classified) continue;

      rows.push({
        // CRM Signal rows are unverified estimates that never went through the balance engine
        // (see the CompanyVacationReportRow doc comment) — left null, not computed on the fly,
        // to avoid an N+1 balance-period lookup per row for every CRM signal in the range.
        balanceAfterDays: null,
        balanceBeforeDays: null,
        dayPart: classified.dayPart,
        detail: classified.detail,
        employeeName: resolveEmployeeDisplayName(employee?.full_name ?? dayVisits[0]?.agent_name ?? key, employee?.nickname),
        endDate: dateIso,
        hasBalance: null,
        hrId: employee?.hr_id ?? key,
        jobTitle: employee?.job_title ?? null,
        lineName: resolveEmployeeLineName(employee),
        requestId: null,
        source: classified.source,
        startDate: dateIso,
        workingDays: classified.workingDays,
      });
    }
  }

  return rows;
}

/**
 * Full company vacation report for [startDate, endDate] (inclusive, ISO dates): every HR
 * vacation request (any status) plus every CRM-derived leave signal, each row tagged with its
 * Source. Read-only — never writes to v2_vacation_requests or any leave balance.
 *
 * Owner-confirmed (2026-07): a vacation report never shows a 0-day row — a day fingerprint-
 * proved was fully worked (>=5h, device-mapped only) isn't a vacation day at all, so it's
 * dropped here rather than shown as "0 days of vacation."
 */
export async function getCompanyVacationReport(input: {
  endDate: string;
  startDate: string;
}): Promise<CompanyVacationReportRow[]> {
  // Employee roster and device mappings are needed by both the HR-row and CRM-row builders
  // (this is what fixes job title being blank on HR-sourced rows — they now share the same
  // lookup CRM rows already used), so resolve them once up front.
  const [employeeRows, deviceMappedHrIds] = await Promise.all([
    loadEmployeesCached(),
    loadDeviceMappedHrIdsCached(),
  ]);
  const employeeByKey = buildEmployeeLookup(employeeRows);
  const deviceMappedKeys = new Set(
    deviceMappedHrIds.map((id) => canonicalHrIdKey(id)).filter((key): key is string => Boolean(key)),
  );

  const [hrRequests, crmRows] = await Promise.all([
    loadHrVacationRequests(input.startDate, input.endDate),
    buildCrmSignalRows({ deviceMappedKeys, employeeByKey, endDate: input.endDate, startDate: input.startDate }),
  ]);
  const hrRows = buildHrRows(hrRequests, employeeByKey);

  // Once a CRM Signal date has a real approved HR request covering it (including one just
  // created via the approve-and-deduct route), stop showing it as a separate "unverified"
  // row — it's no longer a signal, it's a real record, and leaving both visible would let an
  // admin approve the same date twice (a duplicate balance deduction).
  //
  // Keyed by canonicalHrIdKey, NOT the raw hrId string: HR rows' hrId comes from
  // v2_vacation_requests.employee_hr_id while CRM rows' hrId comes from employees.hr_id — two
  // different source columns that are usually the same literal string but aren't guaranteed to
  // be (casing/format drift between tables is a documented, recurring issue in this codebase —
  // see src/lib/hr-id.ts). Comparing raw strings here would let this exact safety check silently
  // fail to match for a hrId format mismatch, defeating the whole point of the dedupe.
  const approvedRangesByHrKey = new Map<string, DateRange[]>();
  for (const row of hrRows) {
    if (row.source !== "HR Approved") continue;
    const key = canonicalHrIdKey(row.hrId);
    if (!key) continue;
    const ranges = approvedRangesByHrKey.get(key) ?? [];
    ranges.push({ end: row.endDate, start: row.startDate });
    approvedRangesByHrKey.set(key, ranges);
  }
  const isAlreadyApproved = (row: CompanyVacationReportRow) => {
    const key = canonicalHrIdKey(row.hrId);
    if (!key) return false;
    return (approvedRangesByHrKey.get(key) ?? []).some((range) => row.startDate >= range.start && row.startDate <= range.end);
  };
  const unapprovedCrmRows = crmRows.filter((row) => !isAlreadyApproved(row));

  return [...hrRows, ...unapprovedCrmRows]
    .filter((row) => row.workingDays > 0)
    .sort((left, right) =>
      left.hrId.localeCompare(right.hrId, undefined, { numeric: true }) || left.startDate.localeCompare(right.startDate));
}
