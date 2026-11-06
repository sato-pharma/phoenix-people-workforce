/**
 * The choices the Company Vacation Report's filter panel offers.
 *
 * Why this is a separate query rather than "the distinct values in the rows on screen": since the
 * owner's 2026-08-27 instruction the page opens EMPTY and only runs when Apply is pressed, so at
 * the moment the reader needs the dropdowns there are no rows to derive them from. Deriving them
 * from the result would also be circular in a way that hides data — you could only ever filter by
 * a line that was already visible, which is exactly the opposite of what a filter is for.
 *
 * All three lists come from small, cheap reads that are unrelated to the expensive part of the
 * report (the CRM visit scan), so a page load that shows nothing costs a roster read and nothing
 * else.
 */

import { unstable_cache } from "next/cache";

import { canonicalHrIdKey } from "@/lib/hr-id";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import {
  EMPLOYEE_LINE_SELECT,
  resolveEmployeeLineName,
  type EmployeeLineFields,
} from "@/lib/employees/employee-org-labels";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type CompanyVacationReportEmployeeOption = {
  hrId: string;
  jobTitle: string | null;
  label: string;
  lineName: string | null;
};

export type CompanyVacationReportFilterOptions = {
  employees: CompanyVacationReportEmployeeOption[];
  jobTitles: string[];
  lineNames: string[];
};

type EmployeeOptionRow = EmployeeLineFields & {
  full_name: string | null;
  hr_id: string;
  job_title: string | null;
  nickname: string | null;
};

type RequestOptionRow = {
  employee_hr_id: string | null;
  employee_name: string | null;
  line_name: string | null;
};

/** Alphabetical, case-insensitive, and blank-free. Every dropdown in the panel is built this way
 * so none of them ever shows an empty option that silently means "no value stored". */
function sortedUnique(values: Array<string | null | undefined>): string[] {
  const set = new Set<string>();
  for (const value of values) {
    const trimmed = (value ?? "").trim();
    if (trimmed) set.add(trimmed);
  }
  return [...set].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
}

async function loadFilterOptionsRaw(): Promise<CompanyVacationReportFilterOptions> {
  const supabase = getSupabaseAdmin();

  // Both tables, deliberately. The report's own row builders read the employee roster for job
  // title/line but take the HR id and name from whichever side produced the row, so an employee
  // with leave on record but no `employees` row (a real, recurring condition in this data) would
  // be missing from a roster-only dropdown — invisible in a filter that claims to list everyone.
  // Both reads are paged: a dropdown that "lists everyone" must not stop at the API's row ceiling
  // (the request table grows with every leave filed). A failed page keeps this module's own message.
  const readAll = async <T>(label: string, buildQuery: () => unknown, tiebreak: string): Promise<T[]> => {
    try {
      return await fetchAllRows<T>(buildQuery, tiebreak);
    } catch (error) {
      throw new Error(`${label}: ${(error as { message?: string } | null)?.message ?? String(error)}`);
    }
  };
  const [employeeRows, requestRows] = await Promise.all([
    // The line comes from the `line_id` LINK, not from `employees.line_name` — that label is a
    // denormalized copy nothing writes (1 of 198 rows carry it), so a roster read that took it
    // alone offered a Line filter with one entry in it. See employee-line.ts.
    readAll<EmployeeOptionRow>(
      "Failed to load vacation report employee options",
      () => supabase.from("employees").select(`hr_id,full_name,job_title,nickname,${EMPLOYEE_LINE_SELECT}`),
      "hr_id",
    ),
    readAll<RequestOptionRow>(
      "Failed to load vacation report request options",
      () => supabase.from("v2_vacation_requests").select("employee_hr_id,employee_name,line_name"),
      "id",
    ),
  ]);

  const byKey = new Map<string, CompanyVacationReportEmployeeOption>();
  for (const employee of employeeRows) {
    const key = canonicalHrIdKey(employee.hr_id);
    if (!key) continue;
    byKey.set(key, {
      hrId: employee.hr_id,
      jobTitle: employee.job_title,
      label: resolveEmployeeDisplayName(employee.full_name ?? employee.hr_id, employee.nickname),
      lineName: resolveEmployeeLineName(employee),
    });
  }
  // Only fills gaps — an id already known from the roster keeps the roster's display name, which
  // is the one the rest of the app shows.
  for (const request of requestRows) {
    const key = canonicalHrIdKey(request.employee_hr_id);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, {
      hrId: request.employee_hr_id ?? key,
      jobTitle: null,
      label: (request.employee_name ?? "").trim() || (request.employee_hr_id ?? key),
      lineName: request.line_name,
    });
  }

  const employees = [...byKey.values()].sort((left, right) =>
    left.label.localeCompare(right.label, undefined, { sensitivity: "base" }));

  return {
    employees,
    jobTitles: sortedUnique(employeeRows.map((employee) => employee.job_title)),
    // Both sides again: an HR row shows v2_vacation_requests.line_name in preference to the
    // roster's, so a line that exists only there still has to be selectable.
    lineNames: sortedUnique([
      // The roster's half of this list read the dead label until the type stopped carrying it, so
      // the Line dropdown was built from a column with ONE value in it — the same defect as the
      // row's own line, in the list of CHOICES rather than in a row, and only the typecheck found
      // it. A line missing from a filter looks like a line nobody is on.
      ...employeeRows.map((employee) => resolveEmployeeLineName(employee)),
      ...requestRows.map((request) => request.line_name),
    ]),
  };
}

/** Five minutes, the same window the report's own roster read uses — a same-day hire or a
 * corrected job title shows up in the dropdown about as fast as it shows up in the rows. */
export const getCompanyVacationReportFilterOptions = unstable_cache(
  loadFilterOptionsRaw,
  ["company-vacation-report-filter-options"],
  { revalidate: 300, tags: ["company-vacation-report"] },
);
