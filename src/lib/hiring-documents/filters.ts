// ─────────────────────────────────────────────────────────────────────────────
// Hiring documents: the filter state the screen holds, and the predicate it filters with.
//
// WHY THIS IS A MODULE AND NOT A `useMemo`. The export must match the screen — an XLSX that
// silently carries the whole company while HR is looking at one line is worse than no export, and
// the owner's standing rule on exports says so plainly. The screen filters in the browser and the
// workbook is built on the server, so the only way the two can agree is for both to call the same
// function. The state travels as query parameters; this file owns both halves of that trip.
//
// Free of React and of anything server-only, on purpose: the manager is a client component and the
// export route is a Node route, and both import this.
// ─────────────────────────────────────────────────────────────────────────────

import { hiringDocumentsFor } from "@/lib/hiring-documents/readiness-signal";
import type {
  HiringDocumentDefinition,
  HiringDocumentEmployeeRow,
} from "@/lib/hiring-documents/types";

/** The "no filter" sentinel the screen's selects use. A real value can never collide with it. */
export const HIRING_DOCUMENT_FILTER_ALL = "__all__";

export type HiringDocumentFilterState = {
  /** Upper bound on an employee's completion percentage, as typed — "" means no bound. */
  completionMax: string;
  completionMin: string;
  hireDateFrom: string;
  hireDateTo: string;
  jobTitle: string;
  line: string;
  manager: string;
  query: string;
  status: string;
};

export const EMPTY_HIRING_DOCUMENT_FILTERS: HiringDocumentFilterState = {
  completionMax: "",
  completionMin: "",
  hireDateFrom: "",
  hireDateTo: "",
  jobTitle: HIRING_DOCUMENT_FILTER_ALL,
  line: HIRING_DOCUMENT_FILTER_ALL,
  manager: HIRING_DOCUMENT_FILTER_ALL,
  query: "",
  status: HIRING_DOCUMENT_FILTER_ALL,
};

function parseDateString(value: string) {
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * How much of one employee's checklist is submitted, 0-100.
 *
 * Counts SUBMITTED against the documents that APPLY TO THIS PERSON rather than against the rows
 * that happen to exist. Two different things hang on that wording:
 *
 * - A document nobody has touched still counts against them — a missing status row reads as
 *   pending, never as "not applicable", which is the very thing this screen is for.
 * - An EXIT document does not count against an active employee at all (owner ruling, 2026-09-29).
 *   It leaves the denominator, not just the numerator, because while those five slots are counted
 *   nobody who has not resigned can ever reach 100%.
 */
export function hiringDocumentCompletionPercent(
  employee: HiringDocumentEmployeeRow,
  documents: HiringDocumentDefinition[],
): number {
  const applicable = hiringDocumentsFor(documents, employee);
  if (applicable.length === 0) return 0;
  const submitted = applicable.filter(
    (document) => employee.documents[document.id]?.status === "submitted",
  ).length;
  return Math.round((submitted / applicable.length) * 100);
}

/** The screen's row filter, exactly — same order, same comparisons. */
export function filterHiringDocumentEmployees(
  employees: HiringDocumentEmployeeRow[],
  documents: HiringDocumentDefinition[],
  filters: HiringDocumentFilterState,
): HiringDocumentEmployeeRow[] {
  const search = filters.query.trim().toLowerCase();
  const minCompletion = Number.parseInt(filters.completionMin, 10);
  const maxCompletion = Number.parseInt(filters.completionMax, 10);
  const fromDate = filters.hireDateFrom ? new Date(`${filters.hireDateFrom}T00:00:00`) : null;
  const toDate = filters.hireDateTo ? new Date(`${filters.hireDateTo}T23:59:59`) : null;

  return employees.filter((employee) => {
    const hireDate = parseDateString(employee.hireDate ?? "");
    const completion = hiringDocumentCompletionPercent(employee, documents);

    if (fromDate && hireDate && hireDate < fromDate) return false;
    if (toDate && hireDate && hireDate > toDate) return false;
    if (Number.isInteger(minCompletion) && completion < minCompletion) return false;
    if (Number.isInteger(maxCompletion) && completion > maxCompletion) return false;

    const searchable = [
      employee.fullName,
      employee.hrId,
      employee.jobTitle,
      employee.lineName,
      employee.managerName,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return (
      (!search || searchable.includes(search)) &&
      (filters.line === HIRING_DOCUMENT_FILTER_ALL || employee.lineName === filters.line) &&
      (filters.status === HIRING_DOCUMENT_FILTER_ALL || employee.employmentStatus === filters.status) &&
      (filters.manager === HIRING_DOCUMENT_FILTER_ALL || employee.managerName === filters.manager) &&
      (filters.jobTitle === HIRING_DOCUMENT_FILTER_ALL || employee.jobTitle === filters.jobTitle)
    );
  });
}

/**
 * The filters in one line of English, for the workbook cover.
 *
 * A saved file outlives the screen it was taken from, so a reader six weeks later has no other way
 * to know whether the 41 rows in front of them are the company or one district.
 */
export function describeHiringDocumentFilters(filters: HiringDocumentFilterState): string {
  const parts: string[] = [];
  if (filters.query.trim()) parts.push(`Search: "${filters.query.trim()}"`);
  if (filters.line !== HIRING_DOCUMENT_FILTER_ALL) parts.push(`Line: ${filters.line}`);
  if (filters.status !== HIRING_DOCUMENT_FILTER_ALL) parts.push(`Employment status: ${filters.status}`);
  if (filters.manager !== HIRING_DOCUMENT_FILTER_ALL) parts.push(`Manager: ${filters.manager}`);
  if (filters.jobTitle !== HIRING_DOCUMENT_FILTER_ALL) parts.push(`Job title: ${filters.jobTitle}`);
  if (filters.hireDateFrom || filters.hireDateTo) {
    parts.push(`Hire date: ${filters.hireDateFrom || "any"} to ${filters.hireDateTo || "any"}`);
  }
  if (filters.completionMin || filters.completionMax) {
    parts.push(`Completion: ${filters.completionMin || "0"}% to ${filters.completionMax || "100"}%`);
  }
  return parts.length > 0 ? parts.join("   ·   ") : "No filters applied (every employee in view)";
}

/** Query-parameter names, one place, so the writer and the reader below cannot drift. */
const PARAM_KEYS: Array<[keyof HiringDocumentFilterState, string]> = [
  ["completionMax", "completionMax"],
  ["completionMin", "completionMin"],
  ["hireDateFrom", "hireFrom"],
  ["hireDateTo", "hireTo"],
  ["jobTitle", "jobTitle"],
  ["line", "line"],
  ["manager", "manager"],
  ["query", "q"],
  ["status", "status"],
];

/** The state as query parameters, omitting anything left at its default. */
export function hiringDocumentFilterSearchParams(filters: HiringDocumentFilterState): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, param] of PARAM_KEYS) {
    const value = filters[key];
    if (!value || value === HIRING_DOCUMENT_FILTER_ALL) continue;
    params.set(param, value);
  }
  return params;
}

/**
 * The state back out of a URL.
 *
 * An absent parameter is the DEFAULT, never an empty string: a select handed `""` would match no
 * employee at all and the export would come back with a masthead and no rows.
 */
export function readHiringDocumentFilters(params: URLSearchParams): HiringDocumentFilterState {
  const filters = { ...EMPTY_HIRING_DOCUMENT_FILTERS };
  for (const [key, param] of PARAM_KEYS) {
    const value = params.get(param);
    if (value === null || value === "") continue;
    filters[key] = value;
  }
  return filters;
}
