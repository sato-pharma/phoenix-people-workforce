/**
 * Company Activity Report's date range — resolved in one place so the screen, the export and the
 * audit row can never describe different windows. Mirrors company-vacation-report-range.ts.
 *
 * Default is deliberately narrow (month-to-date), not year-to-date like the Vacation Report's
 * default: this report scans CRM visits + attendance punches + leave requests across the WHOLE
 * filtered roster for every day in range, a materially heavier read than a leave-request scan. A
 * reader who wants a wider window asks for one explicitly.
 */

/** The floor a picked start is clamped to — a guard against a mistyped/pasted year turning one
 * page load into a full-table scan, not a business rule about when activity began. */
export const COMPANY_ACTIVITY_REPORT_EARLIEST_DATE = "2015-01-01";

export type CompanyActivityReportRange = {
  endDate: string;
  startDate: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar day written `YYYY-MM-DD`. The shape test alone is not enough:
 * `2026-02-31` and `2026-13-01` both match the pattern. */
export function isIsoDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= lastDayOfMonth;
}

function firstOfMonth(today: string): string {
  return isIsoDateOnly(today) ? `${today.slice(0, 7)}-01` : COMPANY_ACTIVITY_REPORT_EARLIEST_DATE;
}

/**
 * Turns whatever arrived in the query string into a range safe to hand the database. Anything
 * unusable falls back rather than throwing. A REVERSED pair is swapped instead of returned empty —
 * picking the end before the start is a mis-click, not a request for zero rows.
 */
export function resolveCompanyActivityReportRange(
  raw: { endDate?: string | null; startDate?: string | null },
  today: string,
): CompanyActivityReportRange {
  const fallbackEnd = isIsoDateOnly(today) ? today : COMPANY_ACTIVITY_REPORT_EARLIEST_DATE;
  const fallbackStart = firstOfMonth(today);

  let startDate = isIsoDateOnly(raw.startDate) ? raw.startDate : fallbackStart;
  let endDate = isIsoDateOnly(raw.endDate) ? raw.endDate : fallbackEnd;

  if (startDate < COMPANY_ACTIVITY_REPORT_EARLIEST_DATE) startDate = COMPANY_ACTIVITY_REPORT_EARLIEST_DATE;
  if (endDate < COMPANY_ACTIVITY_REPORT_EARLIEST_DATE) endDate = COMPANY_ACTIVITY_REPORT_EARLIEST_DATE;

  if (startDate > endDate) return { endDate: startDate, startDate: endDate };
  return { endDate, startDate };
}

/** The query string the two date pickers write — the export link and the audit row both hang off
 * this, same convention as company-vacation-report-range.ts. */
export function companyActivityReportRangeParams(range: CompanyActivityReportRange): URLSearchParams {
  const params = new URLSearchParams();
  params.set("startDate", range.startDate);
  params.set("endDate", range.endDate);
  return params;
}
