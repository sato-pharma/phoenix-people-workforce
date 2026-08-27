import { canonicalHrIdKey } from "@/lib/hr-id";
import type { CompanyVacationReportRow } from "@/lib/vacation/company-vacation-report";
import { companyVacationSourceSystem } from "@/lib/vacation/company-vacation-report-source";
import { VACATION_TYPES } from "@/lib/vacation/types";

// ─────────────────────────────────────────────────────────────────────────────
// The one definition of the Company Vacation Report's filter.
//
// Owner instruction 2026-08-27: "the page is empty, but I have advanced filters through
// everything I need. I filter, then what I filtered on appears." So this report does not open on
// a year of leave and narrow it in the browser — it opens on NOTHING and runs when the reader
// presses Apply. Everything below is therefore a QUERY parameter, applied on the server, and the
// screen is the answer to the URL rather than a slice of a bigger answer held in a client array.
//
// That is also why the Export link needs no separate logic: it is the same URL, so the workbook
// and the "N rows · M employees · D days" counter are two renderings of one query, and the
// owner's standing rule (an export matches the screen) holds structurally instead of by
// discipline.
//
// THE DATE RANGE IS NOT IN THIS TYPE. It is picked with two date pickers and lives in
// company-vacation-report-range.ts, because it is the only field the DATABASE reads — everything
// here narrows the rows that query returned. Keeping them apart is what stops a screen from
// showing less than its own header says it covers.
//
// Every field is a plain string and every comparison is exact. An unrecognised value therefore
// matches NO row — the safe direction for an export, because the alternative (falling back to the
// default) would silently WIDEN the file past what the reader had on screen.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHAT KIND of leave a Phoenix row is — annual, emergency, sick, other, compensatory — taken from
 * the vacation domain's own list rather than re-typed, so a sixth type added there appears in this
 * report's filter without a second edit.
 *
 * It is here rather than in the source leaf because that leaf is pinned at zero imports (see its
 * header), and here rather than in the table because the WORKBOOK needs the same label: the owner's
 * standing rule is that an export matches the screen, and "Annual Vacation" on screen against a raw
 * `annual` in the file is exactly the kind of drift that rule exists to stop.
 *
 * This module is client-safe for the same reason the leaf is — every value it imports comes from a
 * module with no imports of its own (`@/lib/hr-id`, `@/lib/vacation/types`), and the one thing it
 * takes from company-vacation-report.ts is a TYPE, which is erased.
 */
export const COMPANY_VACATION_LEAVE_TYPES = VACATION_TYPES;

/**
 * The human label for a stored leave type. An unrecognised value passes through untouched, which
 * is what makes this safe to apply to EVERY row's `detail`: a CRM Signal's detail is an evidence
 * sentence rather than a type, and it comes back out exactly as written.
 */
export function companyVacationLeaveTypeLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  return VACATION_TYPES.find((option) => option.value === normalized)?.label ?? value;
}

export type CompanyVacationHasBalanceFilter = "All" | "N/A" | "No" | "Yes";

export type CompanyVacationReportFilters = {
  /** An exact HR ID, matched through canonicalHrIdKey. Two people can share a name; nobody
   * shares an HR ID, and the two source tables spell the same id in different cases (see
   * src/lib/hr-id.ts) — a raw string compare here silently drops that employee's rows. */
  employeeHrId: string;
  hasBalance: string;
  jobTitle: string;
  /** The kind of leave: "annual", "emergency", "sick", "other", "compensatory" — the value HR
   * stored on the request, which is what the Detail column shows for a Phoenix row. A CRM Signal
   * row has no leave type (its detail is the evidence sentence), so picking one narrows to
   * Phoenix rows by construction rather than by a second rule. */
  leaveType: string;
  lineName: string;
  query: string;
  source: string;
  /** "Phoenix" | "CRM" | "All" — the coarse where-did-this-come-from question, independent of the
   * detailed `source` above. Both are kept because they answer different questions: "CRM" is one
   * click, where the source list needs two of its six values selected one at a time. */
  sourceSystem: string;
};

export const NO_COMPANY_VACATION_REPORT_FILTERS: CompanyVacationReportFilters = {
  employeeHrId: "All",
  hasBalance: "All",
  jobTitle: "All",
  leaveType: "All",
  lineName: "All",
  query: "",
  source: "All",
  sourceSystem: "All",
};

/** Every key, in one place, so the query-string writer and reader can never drift apart — adding a
 * filter to the type without adding it here makes it work on screen and vanish from the export. */
export const COMPANY_VACATION_REPORT_FILTER_KEYS = [
  "employeeHrId",
  "hasBalance",
  "jobTitle",
  "leaveType",
  "lineName",
  "query",
  "source",
  "sourceSystem",
] as const satisfies ReadonlyArray<keyof CompanyVacationReportFilters>;

/**
 * The marker that says the reader has actually pressed Apply.
 *
 * It exists because "no filters" and "nothing asked for yet" are different states that would
 * otherwise look identical in a URL: without it, a bare /admin/vacation-report would have to
 * either run the full scan (the long page the owner rejected) or show an empty screen that reads
 * as a broken report. With it, the empty screen is explicit and a forwarded link still reproduces
 * exactly what the sender saw.
 */
export const COMPANY_VACATION_REPORT_APPLIED_PARAM = "applied";

export function isCompanyVacationReportApplied(params: URLSearchParams): boolean {
  return params.get(COMPANY_VACATION_REPORT_APPLIED_PARAM) === "1";
}

export function companyVacationHasBalanceValue(row: CompanyVacationReportRow): CompanyVacationHasBalanceFilter {
  if (row.hasBalance === null) return "N/A";
  return row.hasBalance ? "Yes" : "No";
}

export function filterCompanyVacationReportRows(
  rows: CompanyVacationReportRow[],
  filters: CompanyVacationReportFilters,
): CompanyVacationReportRow[] {
  const needle = filters.query.trim().toLowerCase();
  const employeeKey = filters.employeeHrId === "All" ? null : canonicalHrIdKey(filters.employeeHrId);
  const leaveType = filters.leaveType === "All" ? null : filters.leaveType.trim().toLowerCase();

  return rows.filter((row) => {
    if (filters.source !== "All" && row.source !== filters.source) return false;
    if (filters.sourceSystem !== "All" && companyVacationSourceSystem(row.source) !== filters.sourceSystem) return false;
    if (filters.lineName !== "All" && (row.lineName ?? "") !== filters.lineName) return false;
    if (filters.jobTitle !== "All" && (row.jobTitle ?? "") !== filters.jobTitle) return false;
    if (filters.hasBalance !== "All" && companyVacationHasBalanceValue(row) !== filters.hasBalance) return false;
    // A named employee that resolves to no canonical key (an empty or junk id in the URL) matches
    // nothing, rather than falling through to "All" and exporting the whole company.
    if (filters.employeeHrId !== "All" && canonicalHrIdKey(row.hrId) !== employeeKey) return false;
    if (leaveType !== null && row.detail.trim().toLowerCase() !== leaveType) return false;
    if (!needle) return true;
    return `${row.employeeName} ${row.hrId} ${row.jobTitle ?? ""} ${row.lineName ?? ""}`.toLowerCase().includes(needle);
  });
}

/** The query params the screen and the export link both carry. Only non-default values are
 * written, so a URL stays readable — the `applied` marker above is added by the caller, since the
 * export route does not need it and the page does. */
export function companyVacationReportFilterParams(filters: CompanyVacationReportFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of COMPANY_VACATION_REPORT_FILTER_KEYS) {
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
    employeeHrId: read("employeeHrId"),
    hasBalance: read("hasBalance"),
    jobTitle: read("jobTitle"),
    leaveType: read("leaveType"),
    lineName: read("lineName"),
    query: read("query"),
    source: read("source"),
    sourceSystem: read("sourceSystem"),
  };
}

/** How many filters are narrowing the report right now — the number on the "Filters" chip, and
 * the difference between "this is everyone" and "this is a slice" at a glance. */
export function countActiveCompanyVacationReportFilters(filters: CompanyVacationReportFilters): number {
  return COMPANY_VACATION_REPORT_FILTER_KEYS.filter(
    (key) => filters[key] !== NO_COMPANY_VACATION_REPORT_FILTERS[key],
  ).length;
}

export type CompanyVacationReportFilterChip = {
  key: keyof CompanyVacationReportFilters;
  label: string;
};

/**
 * One entry per ACTIVE filter, in reading order — rendered as removable chips on screen and joined
 * into the workbook's stamp, so both say the same thing in the same words.
 *
 * The `key` travels with the label deliberately. A chip has to be able to clear the filter it
 * names, and pairing a list of labels with a separately-built list of keys by array index is the
 * kind of correspondence that holds until someone reorders one of them and then silently clears
 * the wrong filter.
 */
export function describeCompanyVacationReportFilterList(
  filters: CompanyVacationReportFilters,
): CompanyVacationReportFilterChip[] {
  const chips: CompanyVacationReportFilterChip[] = [];
  if (filters.employeeHrId !== "All") chips.push({ key: "employeeHrId", label: `Employee: ${filters.employeeHrId}` });
  if (filters.sourceSystem !== "All") chips.push({ key: "sourceSystem", label: `Source: ${filters.sourceSystem}` });
  if (filters.source !== "All") chips.push({ key: "source", label: `Detail type: ${filters.source}` });
  if (filters.leaveType !== "All") {
    chips.push({ key: "leaveType", label: `Leave type: ${companyVacationLeaveTypeLabel(filters.leaveType)}` });
  }
  if (filters.jobTitle !== "All") chips.push({ key: "jobTitle", label: `Job title: ${filters.jobTitle}` });
  if (filters.lineName !== "All") chips.push({ key: "lineName", label: `Line: ${filters.lineName}` });
  if (filters.hasBalance !== "All") chips.push({ key: "hasBalance", label: `Has balance: ${filters.hasBalance}` });
  if (filters.query.trim()) chips.push({ key: "query", label: `Search: "${filters.query.trim()}"` });
  return chips;
}

/**
 * Human-readable stamp for the workbook, or null when nothing is filtered. A downloaded file
 * gets forwarded without the screen it came from, so a filtered one has to say so on its own
 * face — otherwise a slice of the year reads as the whole year to whoever opens it next.
 */
export function describeCompanyVacationReportFilters(filters: CompanyVacationReportFilters): string | null {
  const chips = describeCompanyVacationReportFilterList(filters);
  return chips.length > 0
    ? `Filtered export — this workbook covers only: ${chips.map((chip) => chip.label).join(" · ")}.`
    : null;
}
