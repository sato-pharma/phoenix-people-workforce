/**
 * Builds the flat, one-row-per-trip data behind the "Export XLSX" button on the outstation
 * expense-approvals page.
 *
 * Deliberately reflects the SAVED database state, not any decision a reviewer has typed on screen
 * but not yet pressed Save on. This is a payroll-adjacent audit document — showing a deduction or
 * an approval that was never actually committed would produce a file that disagrees with what
 * payroll actually pays, which is worse than the file simply lagging one Save behind the screen.
 *
 * Filtering reuses the EXACT same pure functions the client's filter panel and search box already
 * use (`matchesExpenseApprovalFilters`, `matchesExpenseApprovalSearchText`), so this export can
 * never disagree with what the reviewer sees on screen for the same month/employee/search — there
 * is one filter rule, not a client copy and a server copy that could drift apart.
 */

import {
  expenseEmployeeKey,
  expenseTripMonthLabel,
  matchesExpenseApprovalFilters,
  matchesExpenseApprovalSearchText,
} from "@/lib/outstation/expense-approval-filters";
import type { ExpenseApprovalFilters } from "@/lib/outstation/expense-approval-filters";
import { expenseTripTriageLabel } from "@/lib/outstation/expense-approval-triage";
import { expenseApprovalState, EXPENSE_STATE_LABEL } from "@/lib/outstation/approval-state";
// The owner reads every stamp in Cairo local, never raw UTC (house rule).
import { cairoDateTimeSortable } from "@/lib/format/cairo-datetime";
import {
  OFFICIAL_OUTSTATION_MINIMUM_DISTANCE_KM,
  TOLERANCE_OUTSTATION_MINIMUM_DISTANCE_KM,
  classifyOutstationExpenseEligibility,
} from "@/lib/outstation/classification";
import { deductionFromApprovedAmount, payableExpenseAmount } from "@/lib/outstation/payable";
import type { PayrollExpenseApproval } from "@/lib/payroll/types";

export type ExpenseApprovalExportRow = {
  allowance: number;
  approvedAmount: number;
  approvedAt: string | null;
  approvedBy: string | null;
  claimedTotal: number;
  deduction: number;
  destination: string;
  distanceFlag: string;
  expenseType: string;
  from: string;
  hrComment: string;
  hrId: string;
  km: number;
  meetingAmount: number;
  other: number;
  reportId: string;
  specialist: string;
  sourceFileName: string;
  status: string;
  transportationType: string;
  travelCost: number;
  tripEndDate: string;
  tripId: string;
  tripStartDate: string;
  tripType: string;
  workloadAm: number;
  /** AM · PM · Pharmacies. The words, never a 0, when the trip did not count pharmacies apart
   * (a pre-split, hand-typed or imported trip) — Excel's SUM skips the text. */
  workloadPharmacies: number | string;
  workloadPm: number;
};

/** Same wording the on-screen km highlight uses, so the file and the screen never disagree. */
function distanceFlagLabel(km: number): string {
  if (!Number.isFinite(km) || km <= 0) return "";
  const { classification } = classifyOutstationExpenseEligibility({
    actualDistanceKm: km,
    policy: {
      officialMinimumDistanceKm: OFFICIAL_OUTSTATION_MINIMUM_DISTANCE_KM,
      toleranceMinimumDistanceKm: TOLERANCE_OUTSTATION_MINIMUM_DISTANCE_KM,
    },
  });
  if (classification === "not_eligible") return `Under ${TOLERANCE_OUTSTATION_MINIMUM_DISTANCE_KM} km floor`;
  if (classification === "tolerance_eligible") return "Tolerance band";
  return "";
}

function toExportRow(record: PayrollExpenseApproval): ExpenseApprovalExportRow {
  // The SAME two functions the decision panel's Deduction field is built on, so "value before" and
  // "value after" in the export are the exact figures HR saved — never re-derived a second way.
  const approvedAmount = payableExpenseAmount(record.approvedAmount, record.total);
  const deduction = deductionFromApprovedAmount(record.total, approvedAmount);

  return {
    allowance: record.allowance,
    approvedAmount,
    approvedAt: record.approvedAt,
    approvedBy: record.approvedBy,
    claimedTotal: record.total,
    deduction,
    destination: record.location || record.to || "",
    distanceFlag: distanceFlagLabel(record.km),
    expenseType: record.requestType,
    from: record.from,
    hrComment: record.hrComment ?? "",
    hrId: record.hrId ?? "",
    km: record.km,
    meetingAmount: record.meetingAmount,
    other: record.other,
    reportId: record.reportId ?? "",
    specialist: String(record.specialist ?? "").trim() || "Unassigned",
    sourceFileName: record.sourceFileName ?? "",
    status: EXPENSE_STATE_LABEL[expenseApprovalState(record)],
    transportationType: record.transportationType,
    travelCost: record.travelCost,
    tripEndDate: record.toDate,
    tripId: record.tripId,
    tripStartDate: record.date,
    tripType: record.tripType,
    workloadAm: record.amWorkload,
    workloadPharmacies:
      record.pharmacyWorkload === null || record.pharmacyWorkload === undefined
        ? "Not counted separately"
        : record.pharmacyWorkload,
    workloadPm: record.pmWorkload,
  };
}

/**
 * Filters to the same month/employee/search scope as the on-screen queue, but across all three
 * decision states at once — "the filtered period and person" means everything for that scope, not
 * just whichever queue tab happens to be open (the Status column tells the rows apart). Sorted by
 * employee, then newest trip first within each employee — the same "newest first" convention every
 * other list on this page already uses.
 */
export function buildExpenseApprovalExportRows(
  records: ReadonlyArray<PayrollExpenseApproval>,
  filters: ExpenseApprovalFilters,
  searchQuery: string,
): ExpenseApprovalExportRow[] {
  const matched = records.filter(
    (record) => matchesExpenseApprovalFilters(record, filters) && matchesExpenseApprovalSearchText(record, searchQuery),
  );

  return matched
    .map(toExportRow)
    .sort((left, right) => {
      const bySpecialist = left.specialist.localeCompare(right.specialist);
      if (bySpecialist !== 0) return bySpecialist;
      return tripTime(right.tripStartDate) - tripTime(left.tripStartDate);
    });
}

function tripTime(date: string): number {
  const parsed = new Date(String(date ?? ""));
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

/** Reuses the employee-key grouping so the filename's employee segment matches the filter's own label. */
export function expenseApprovalExportEmployeeLabel(
  records: ReadonlyArray<PayrollExpenseApproval>,
  employeeKey: string,
): string {
  if (!employeeKey) return "";
  const match = records.find((record) => expenseEmployeeKey(record) === employeeKey);
  return match ? String(match.specialist ?? "").trim() || "Unassigned" : "";
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** e.g. `expense-approvals-april-2026-ahmed-nashaat.xlsx`, or a plain default when nothing is filtered. */
export function expenseApprovalExportFilename(
  filters: ExpenseApprovalFilters,
  employeeLabel: string,
): string {
  const parts = ["expense-approvals"];
  if (filters.month) parts.push(slugify(expenseTripMonthLabel(filters.month)));
  if (employeeLabel) parts.push(slugify(employeeLabel));
  return `${parts.join("-")}.xlsx`;
}

/** Human-readable scope line for the workbook's subtitle band. */
export function expenseApprovalExportSubtitle(
  filters: ExpenseApprovalFilters,
  employeeLabel: string,
  rowCount: number,
): string {
  const scope: string[] = [];
  if (filters.month) scope.push(expenseTripMonthLabel(filters.month));
  if (employeeLabel) scope.push(employeeLabel);
  if (filters.triage) scope.push(expenseTripTriageLabel(filters.triage));
  const scopeLabel = scope.length > 0 ? scope.join(" · ") : "All trips";
  return `${scopeLabel} · ${rowCount.toLocaleString()} rows · exported ${cairoDateTimeSortable(new Date().toISOString())} Cairo`;
}
