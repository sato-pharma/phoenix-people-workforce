/**
 * The Company Vacation Report's date range — resolved in ONE place so the screen, the export and
 * the audit row can never describe different windows.
 *
 * Owner instruction 2026-08-27: the range is picked with two date pickers, and the report shows
 * only what those pickers select. That makes the range a REAL query parameter rather than a
 * client-side slice of a fixed year: picking a start before the old hard-coded 2026-01-01 has to
 * actually go and fetch those months, not filter an array that never contained them.
 *
 * A leaf module with no imports, deliberately — the table is a `"use client"` component and
 * company-vacation-report.ts reaches node:crypto through @/lib/crm/reads, so anything the client
 * needs at runtime lives outside it. Same reason as company-vacation-report-source.ts.
 */

/** Where the report starts when nobody has picked anything. */
export const COMPANY_VACATION_REPORT_DEFAULT_START_DATE = "2026-01-01";

/**
 * The floor a picked start is clamped to. Not a business rule about when leave began — a guard so
 * a mistyped or pasted year (`0202-01-01`) cannot turn one page load into a full-table scan.
 */
export const COMPANY_VACATION_REPORT_EARLIEST_DATE = "2015-01-01";

export type CompanyVacationReportRange = {
  endDate: string;
  startDate: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True for a real calendar day written `YYYY-MM-DD`. The shape test alone is not enough:
 * `2026-02-31` and `2026-13-01` both match the pattern, and both reach the database as-is.
 */
export function isIsoDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  // Day 0 of the NEXT month is the last day of this one, which is how February and the 30/31 split
  // get checked without a table of month lengths.
  const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= lastDayOfMonth;
}

/**
 * Turns whatever arrived in the query string into a range that is safe to hand the database.
 *
 * Anything unusable falls back rather than throwing — a bad URL should show the default report,
 * not an error page. A REVERSED pair is swapped instead of returned empty: picking the end before
 * the start is a mis-click, and an empty report is the one outcome that reads as "the system is
 * broken" rather than "you picked backwards". The swap is visible, because the pickers re-render
 * from the resolved range.
 */
export function resolveCompanyVacationReportRange(
  raw: { endDate?: string | null; startDate?: string | null },
  today: string,
): CompanyVacationReportRange {
  const fallbackEnd = isIsoDateOnly(today) ? today : COMPANY_VACATION_REPORT_DEFAULT_START_DATE;

  let startDate = isIsoDateOnly(raw.startDate) ? raw.startDate : COMPANY_VACATION_REPORT_DEFAULT_START_DATE;
  let endDate = isIsoDateOnly(raw.endDate) ? raw.endDate : fallbackEnd;

  if (startDate < COMPANY_VACATION_REPORT_EARLIEST_DATE) startDate = COMPANY_VACATION_REPORT_EARLIEST_DATE;
  if (endDate < COMPANY_VACATION_REPORT_EARLIEST_DATE) endDate = COMPANY_VACATION_REPORT_EARLIEST_DATE;

  if (startDate > endDate) return { endDate: startDate, startDate: endDate };
  return { endDate, startDate };
}

/**
 * The query string those two pickers write. Both keys are always present: a link that carries only
 * one of them resolves the other from a default, so forwarding it tomorrow silently moves the
 * window — the export link and the audit row both hang off this.
 */
export function companyVacationReportRangeParams(range: CompanyVacationReportRange): URLSearchParams {
  const params = new URLSearchParams();
  params.set("startDate", range.startDate);
  params.set("endDate", range.endDate);
  return params;
}
