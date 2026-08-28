/**
 * The choices the Company Activity Report's filter panel offers — Line / Team / Area / Region /
 * Job Title, derived from the roster directly (unlike the Vacation Report, which also has to merge
 * in a second table's values — every field this report filters on lives on the employee record).
 *
 * A separate query from the report itself, same reasoning as company-vacation-report-options.ts:
 * the page opens empty until Apply is pressed, so at the moment the reader needs the dropdowns
 * there are no result rows to derive them from.
 */

import { unstable_cache } from "next/cache";

import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";

export type CompanyActivityFilterOptions = {
  lineNames: string[];
  teamNames: string[];
  areaNames: string[];
  regionNames: string[];
  jobTitles: string[];
};

function sortedUnique(values: Array<string | null | undefined>): string[] {
  const set = new Set<string>();
  for (const value of values) {
    const trimmed = (value ?? "").trim();
    if (trimmed) set.add(trimmed);
  }
  return [...set].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
}

async function loadFilterOptionsRaw(): Promise<CompanyActivityFilterOptions> {
  // Inactive/resigned included, same as the report's own roster read — a range that reaches back
  // before someone left must still be able to filter to them.
  const employees = await getEmployeeDirectoryRows({ includeInactive: true });
  return {
    lineNames: sortedUnique(employees.map((employee) => employee.lineName)),
    teamNames: sortedUnique(employees.map((employee) => employee.teamName)),
    areaNames: sortedUnique(employees.map((employee) => employee.areaName)),
    regionNames: sortedUnique(employees.map((employee) => employee.regionName)),
    jobTitles: sortedUnique(employees.map((employee) => employee.jobTitle)),
  };
}

/** Five minutes — the same window the Vacation Report's filter options use. */
export const getCompanyActivityReportFilterOptions = unstable_cache(
  loadFilterOptionsRaw,
  ["company-activity-report-filter-options"],
  { revalidate: 300, tags: ["company-activity-report"] },
);
