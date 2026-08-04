import type { CompanyVacationReportRow } from "@/lib/vacation/company-vacation-report";

// ─────────────────────────────────────────────────────────────────────────────
// The one definition of the Company Vacation Report's on-screen filter.
//
// The page renders the whole requested range and narrows in the browser; the Export Excel link
// is a plain GET that re-loads the same range server-side. Both sides narrow through
// filterCompanyVacationReportRows so the workbook and the "N rows · M employees · D total days"
// counter next to the link can never describe two different populations.
// ─────────────────────────────────────────────────────────────────────────────

export type CompanyVacationHasBalanceFilter = "All" | "N/A" | "No" | "Yes";

/**
 * Every field is a plain string and every comparison is exact. An unrecognised value therefore
 * matches no row — the safe direction for an export, because the alternative (falling back to
 * the default) would silently WIDEN the file past what the reader had on screen.
 */
export type CompanyVacationReportFilters = {
  fromDate: string;
  hasBalance: string;
  lineName: string;
  query: string;
  source: string;
  toDate: string;
};

export const NO_COMPANY_VACATION_REPORT_FILTERS: CompanyVacationReportFilters = {
  fromDate: "",
  hasBalance: "All",
  lineName: "All",
  query: "",
  source: "All",
  toDate: "",
};

export function companyVacationHasBalanceValue(row: CompanyVacationReportRow): CompanyVacationHasBalanceFilter {
  if (row.hasBalance === null) return "N/A";
  return row.hasBalance ? "Yes" : "No";
}

export function filterCompanyVacationReportRows(
  rows: CompanyVacationReportRow[],
  filters: CompanyVacationReportFilters,
): CompanyVacationReportRow[] {
  const needle = filters.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.source !== "All" && row.source !== filters.source) return false;
    if (filters.lineName !== "All" && (row.lineName ?? "") !== filters.lineName) return false;
    if (filters.hasBalance !== "All" && companyVacationHasBalanceValue(row) !== filters.hasBalance) return false;
    // From/To narrow by OVERLAP, not containment: a request that straddles the boundary is still
    // partly inside the window the reader asked for, so dropping it would hide real leave.
    if (filters.fromDate && row.endDate < filters.fromDate) return false;
    if (filters.toDate && row.startDate > filters.toDate) return false;
    if (!needle) return true;
    return `${row.employeeName} ${row.hrId} ${row.jobTitle ?? ""} ${row.lineName ?? ""}`.toLowerCase().includes(needle);
  });
}

/** The query params the export link carries. Only non-default values are written, so an
 * unfiltered export keeps the plain `?startDate=…&endDate=…` URL it has always had. */
export function companyVacationReportFilterParams(filters: CompanyVacationReportFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of ["fromDate", "hasBalance", "lineName", "query", "source", "toDate"] as const) {
    if (filters[key] !== NO_COMPANY_VACATION_REPORT_FILTERS[key]) params.set(key, filters[key]);
  }
  return params;
}

export function parseCompanyVacationReportFilters(params: URLSearchParams): CompanyVacationReportFilters {
  const read = (key: keyof CompanyVacationReportFilters) => {
    const value = params.get(key);
    return value == null || value === "" ? NO_COMPANY_VACATION_REPORT_FILTERS[key] : value;
  };
  return {
    fromDate: read("fromDate"),
    hasBalance: read("hasBalance"),
    lineName: read("lineName"),
    query: read("query"),
    source: read("source"),
    toDate: read("toDate"),
  };
}

/**
 * Human-readable stamp for the workbook, or null when nothing is filtered. A downloaded file
 * gets forwarded without the screen it came from, so a filtered one has to say so on its own
 * face — otherwise a slice of the year reads as the whole year to whoever opens it next.
 */
export function describeCompanyVacationReportFilters(filters: CompanyVacationReportFilters): string | null {
  const parts: string[] = [];
  if (filters.source !== "All") parts.push(`Source: ${filters.source}`);
  if (filters.lineName !== "All") parts.push(`Line: ${filters.lineName}`);
  if (filters.hasBalance !== "All") parts.push(`Has balance: ${filters.hasBalance}`);
  if (filters.fromDate) parts.push(`From: ${filters.fromDate}`);
  if (filters.toDate) parts.push(`To: ${filters.toDate}`);
  if (filters.query.trim()) parts.push(`Search: "${filters.query.trim()}"`);
  return parts.length > 0 ? `Filtered export — this workbook covers only: ${parts.join(" · ")}.` : null;
}
