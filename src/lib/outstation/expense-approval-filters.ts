/**
 * Month + employee narrowing for the outstation expense-approvals queue.
 *
 * This lives outside the component because the month bucketing is the part that can silently be
 * wrong: the queue renders each trip's date through `formatDateValue`, which formats in
 * Africa/Cairo, while `date` itself arrives as a UTC ISO string. Bucketing on the raw string's
 * UTC month would file a trip that reads "01 Aug" on screen under July, and nobody would notice
 * until a month's approvals came up short.
 */

import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";
import {
  type ExpenseApprovalSort,
  type ExpenseTripTriageFilter,
  type ExpenseTripTriageRecord,
  matchesExpenseTripTriage,
} from "@/lib/outstation/expense-approval-triage";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const CAIRO_MONTH_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "2-digit",
  timeZone: PHOENIX_BUSINESS_TIME_ZONE,
  year: "numeric",
});

/** The key a trip with no employee name is grouped under — matches the list's own fallback text. */
export const UNASSIGNED_EMPLOYEE_KEY = "unassigned";

export type ExpenseApprovalFilterRecord = ExpenseTripTriageRecord & {
  date: string;
  specialist: string;
};

export type ExpenseApprovalFilters = {
  employee: string;
  month: string;
  /** The order within each decision state. Not a narrowing, so never counted as an active filter. */
  sort?: ExpenseApprovalSort;
  /** The rail's "Needs a look" / "Clean" (expense-approval-triage.ts). Empty or absent = all. */
  triage?: ExpenseTripTriageFilter;
};

/** Everything empty = nothing narrowed. */
export const NO_EXPENSE_APPROVAL_FILTERS: ExpenseApprovalFilters = { employee: "", month: "", sort: "value", triage: "" };

export type ExpenseApprovalFilterOption = { label: string; value: string };

/**
 * A trip's calendar month in Africa/Cairo, as `YYYY-MM`. Empty when the trip carries no usable
 * date, so undated rows are never silently swept into whichever month is selected.
 */
export function expenseTripMonthKey(date: string | null | undefined): string {
  const raw = String(date ?? "").trim();
  if (!raw) return "";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    // The mapper passes an unparseable date straight through rather than dropping it, so accept a
    // leading YYYY-MM instead of losing the row from the month list entirely.
    const match = /^(\d{4})-(\d{2})/.exec(raw);
    return match ? `${match[1]}-${match[2]}` : "";
  }
  const parts = CAIRO_MONTH_FORMAT.formatToParts(parsed);
  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  return year && month ? `${year}-${month}` : "";
}

/** `2026-07` → `July 2026`. An unrecognised key renders as itself rather than blank. */
export function expenseTripMonthLabel(monthKey: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(String(monthKey ?? ""));
  if (!match) return String(monthKey ?? "");
  const name = MONTH_NAMES[Number(match[2]) - 1];
  return name ? `${name} ${match[1]}` : monthKey;
}

/**
 * Groups a queue by person on the employee's NAME, not the HR ID.
 *
 * Historical Excel rows resolve their HR ID by name lookup and some genuinely fail to resolve
 * (the decision panel shows "HR ID not mapped" for those). Keying on the HR ID would list the
 * same person twice — once mapped, once not — and picking either entry would hide half their
 * trips. Name-keying can only ever over-include (two real people sharing a full name), which is
 * the safe direction for a review queue: you see an extra trip, you never miss one.
 */
export function expenseEmployeeKey(record: { specialist: string }): string {
  // Dots and underscores collapse to spaces because the SAME person arrives under two spellings:
  // "Ahmed.Abdallah" from the Phoenix request path and "Ahmed Abdallah" from the Excel import.
  // Both are live in production today, and leaving them split puts one human in the dropdown
  // twice — where picking either entry hides half their trips.
  const name = String(record.specialist ?? "")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return name || UNASSIGNED_EMPLOYEE_KEY;
}

function employeeLabel(record: { specialist: string }): string {
  return String(record.specialist ?? "").replace(/\s+/g, " ").trim() || "Unassigned";
}

/** A handle-style spelling is a fallback, never the label when a human-written name exists. */
function isHandleSpelling(label: string): boolean {
  return /[._]/.test(label);
}

/**
 * The month and employee choices actually present in the loaded queue — never a fixed calendar or
 * the whole employee directory, so a selectable option always has at least one trip behind it.
 * Months run newest first (the queue is worked newest first); employees run alphabetically.
 */
export function buildExpenseApprovalFilterOptions(
  records: ReadonlyArray<ExpenseApprovalFilterRecord>,
): { employees: ExpenseApprovalFilterOption[]; months: ExpenseApprovalFilterOption[] } {
  const monthKeys = new Set<string>();
  const employeeLabels = new Map<string, string>();

  for (const record of records) {
    const monthKey = expenseTripMonthKey(record.date);
    if (monthKey) monthKeys.add(monthKey);
    const employeeKey = expenseEmployeeKey(record);
    const label = employeeLabel(record);
    const existing = employeeLabels.get(employeeKey);
    if (existing === undefined || (isHandleSpelling(existing) && !isHandleSpelling(label))) {
      employeeLabels.set(employeeKey, label);
    }
  }

  return {
    employees: [...employeeLabels.entries()]
      .map(([value, label]) => ({ label, value }))
      .sort((left, right) => left.label.localeCompare(right.label)),
    months: [...monthKeys]
      .sort((left, right) => right.localeCompare(left))
      .map((value) => ({ label: expenseTripMonthLabel(value), value })),
  };
}

/** An unset filter matches everything, so the two narrow independently. */
export function matchesExpenseApprovalFilters(
  record: ExpenseApprovalFilterRecord,
  filters: ExpenseApprovalFilters,
): boolean {
  if (filters.month && expenseTripMonthKey(record.date) !== filters.month) return false;
  if (filters.employee && expenseEmployeeKey(record) !== filters.employee) return false;
  if (!matchesExpenseTripTriage(record, filters.triage)) return false;
  return true;
}

export function countActiveExpenseApprovalFilters(filters: ExpenseApprovalFilters): number {
  return (filters.month ? 1 : 0) + (filters.employee ? 1 : 0) + (filters.triage ? 1 : 0);
}

/** The export URL's `triage` value, read back strictly: anything unknown narrows nothing. */
export function parseExpenseTripTriageFilter(value: string | null | undefined): ExpenseTripTriageFilter {
  return value === "look" || value === "clean" ? value : "";
}

export type ExpenseApprovalSearchRecord = {
  hrId?: string | null;
  location: string;
  specialist: string;
  to: string;
  tripId: string;
};

/**
 * The free-text box's own match rule — extracted so the XLSX export can narrow by the SAME
 * query the reviewer typed on screen. One function, used by both sides, so an export can never
 * disagree with what the search box is currently showing.
 */
export function matchesExpenseApprovalSearchText(
  record: ExpenseApprovalSearchRecord,
  query: string,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [record.specialist, record.hrId ?? "", record.tripId, record.location, record.to]
    .join(" ")
    .toLowerCase()
    .includes(normalized);
}
