/**
 * The Company Activity Report's filter — narrows the ROSTER to an employeeHrIds[] list BEFORE the
 * service call, unlike the Vacation Report which scans everyone and filters rows after. Filtering
 * here is what keeps the heavy per-day scan (CRM + attendance + leave, across every day in range)
 * scoped to only the people actually asked for.
 *
 * Line / Team / Area / Region are real, independent fields (confirmed with the owner 2026-08-28 —
 * Team is not the same as Line, and Region is computed from Line+Area so it can come back blank for
 * some combinations) and are all multi-select with an include/exclude mode, matching
 * MultiSelectFilter's own semantics: an EMPTY selection means "All" (no narrowing).
 */

import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import type { CompanyActivityFilters, CompanyActivityMultiSelectMode } from "@/lib/company-activity-report/types";

export const NO_COMPANY_ACTIVITY_REPORT_FILTERS: CompanyActivityFilters = {
  lineNames: [],
  lineMode: "include",
  teamNames: [],
  teamMode: "include",
  areaNames: [],
  areaMode: "include",
  regionNames: [],
  regionMode: "include",
  jobTitle: "All",
  query: "",
};

/**
 * The marker that says the reader has actually pressed Apply — same reasoning as the Vacation
 * Report's own marker (2026-08-27 owner instruction: the page opens empty and only runs when
 * asked). This report's scan is heavier still, so the same gate applies with more reason.
 */
export const COMPANY_ACTIVITY_REPORT_APPLIED_PARAM = "applied";

export function isCompanyActivityReportApplied(params: URLSearchParams): boolean {
  return params.get(COMPANY_ACTIVITY_REPORT_APPLIED_PARAM) === "1";
}

function parseMode(value: string | null): CompanyActivityMultiSelectMode {
  return value === "exclude" ? "exclude" : "include";
}

function parseList(value: string | null): string[] {
  if (!value) return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

export function parseCompanyActivityFilters(params: URLSearchParams): CompanyActivityFilters {
  return {
    lineNames: parseList(params.get("lines")),
    lineMode: parseMode(params.get("lineMode")),
    teamNames: parseList(params.get("teams")),
    teamMode: parseMode(params.get("teamMode")),
    areaNames: parseList(params.get("areas")),
    areaMode: parseMode(params.get("areaMode")),
    regionNames: parseList(params.get("regions")),
    regionMode: parseMode(params.get("regionMode")),
    jobTitle: params.get("jobTitle") || "All",
    query: params.get("query") || "",
  };
}

/** The query params the screen and the export link both carry. Only non-default values are
 * written, so a URL stays readable. */
export function companyActivityFilterParams(filters: CompanyActivityFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.lineNames.length) {
    params.set("lines", filters.lineNames.join(","));
    if (filters.lineMode !== "include") params.set("lineMode", filters.lineMode);
  }
  if (filters.teamNames.length) {
    params.set("teams", filters.teamNames.join(","));
    if (filters.teamMode !== "include") params.set("teamMode", filters.teamMode);
  }
  if (filters.areaNames.length) {
    params.set("areas", filters.areaNames.join(","));
    if (filters.areaMode !== "include") params.set("areaMode", filters.areaMode);
  }
  if (filters.regionNames.length) {
    params.set("regions", filters.regionNames.join(","));
    if (filters.regionMode !== "include") params.set("regionMode", filters.regionMode);
  }
  if (filters.jobTitle !== "All") params.set("jobTitle", filters.jobTitle);
  if (filters.query.trim()) params.set("query", filters.query.trim());
  return params;
}

function matchesMultiSelect(value: string | null, selected: string[], mode: CompanyActivityMultiSelectMode): boolean {
  if (selected.length === 0) return true;
  const has = selected.includes(value ?? "");
  return mode === "include" ? has : !has;
}

/** Narrows the roster to the filtered set. Called once, server-side, before the heavy service
 * call — never applied to result rows after the fact. */
export function filterCompanyActivityEmployees(
  roster: EmployeeDirectoryRow[],
  filters: CompanyActivityFilters,
): EmployeeDirectoryRow[] {
  const needle = filters.query.trim().toLowerCase();
  return roster.filter((employee) => {
    if (!matchesMultiSelect(employee.lineName, filters.lineNames, filters.lineMode)) return false;
    if (!matchesMultiSelect(employee.teamName, filters.teamNames, filters.teamMode)) return false;
    if (!matchesMultiSelect(employee.areaName, filters.areaNames, filters.areaMode)) return false;
    if (!matchesMultiSelect(employee.regionName, filters.regionNames, filters.regionMode)) return false;
    if (filters.jobTitle !== "All" && (employee.jobTitle ?? "") !== filters.jobTitle) return false;
    if (!needle) return true;
    return `${employee.displayName} ${employee.fullName} ${employee.hrId} ${employee.jobTitle ?? ""}`
      .toLowerCase()
      .includes(needle);
  });
}

export function countActiveCompanyActivityFilters(filters: CompanyActivityFilters): number {
  let count = 0;
  if (filters.lineNames.length) count += 1;
  if (filters.teamNames.length) count += 1;
  if (filters.areaNames.length) count += 1;
  if (filters.regionNames.length) count += 1;
  if (filters.jobTitle !== "All") count += 1;
  if (filters.query.trim()) count += 1;
  return count;
}

export type CompanyActivityFilterChip = { key: string; label: string };

function modeSuffix(mode: CompanyActivityMultiSelectMode): string {
  return mode === "exclude" ? " (excluded)" : "";
}

/** One entry per active filter, in reading order — rendered as removable chips on screen and
 * joined into the workbook's stamp, so both say the same thing in the same words. */
export function describeCompanyActivityFilterList(filters: CompanyActivityFilters): CompanyActivityFilterChip[] {
  const chips: CompanyActivityFilterChip[] = [];
  if (filters.lineNames.length) chips.push({ key: "lines", label: `Line: ${filters.lineNames.join(", ")}${modeSuffix(filters.lineMode)}` });
  if (filters.teamNames.length) chips.push({ key: "teams", label: `Team: ${filters.teamNames.join(", ")}${modeSuffix(filters.teamMode)}` });
  if (filters.areaNames.length) chips.push({ key: "areas", label: `Area: ${filters.areaNames.join(", ")}${modeSuffix(filters.areaMode)}` });
  if (filters.regionNames.length) chips.push({ key: "regions", label: `Region: ${filters.regionNames.join(", ")}${modeSuffix(filters.regionMode)}` });
  if (filters.jobTitle !== "All") chips.push({ key: "jobTitle", label: `Job title: ${filters.jobTitle}` });
  if (filters.query.trim()) chips.push({ key: "query", label: `Search: "${filters.query.trim()}"` });
  return chips;
}

/** Human-readable stamp for the workbook, or null when nothing is filtered — a downloaded file is
 * forwarded without the screen it came from, so a filtered one has to say so on its own face. */
export function describeCompanyActivityFilters(filters: CompanyActivityFilters): string | null {
  const chips = describeCompanyActivityFilterList(filters);
  return chips.length > 0
    ? `Filtered export — this workbook covers only: ${chips.map((chip) => chip.label).join(" · ")}.`
    : null;
}
