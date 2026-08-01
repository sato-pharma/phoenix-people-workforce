import { normalizeHrIdForAccess } from "@/lib/auth/permissions";
import { payableExpenseAmount } from "@/lib/outstation/payable";
import { roundCurrency } from "@/lib/payroll/money";
import type { PayrollExpenseApproval } from "@/lib/payroll/types";

export type PayrollExpenseSummary = {
  approvedAmount: number;
  approvedRows: number;
  averageCostPerTrip: number;
  pendingAmount: number;
  pendingRows: number;
  specialistCount: number;
  totalAllowance: number;
  totalAmount: number;
  totalDistance: number;
  totalMeetingAmount: number;
  totalOther: number;
  totalRows: number;
  totalTravelCost: number;
};

export type PayrollExpenseGroupRow = {
  allowance: number;
  count: number;
  key: string;
  km: number;
  meeting: number;
  other: number;
  total: number;
  travel: number;
};

export type PayrollExpenseTrendPoint = {
  amount: number;
  period: string;
  rows: number;
};

export type PayrollExpenseBreakdownRow = {
  breakdown: string;
  name: string;
  val: number;
};

export type PayrollExpenseDsmScope = {
  fullName: string;
  hrId: string;
  lineName?: string | null;
};

export type PayrollExpenseDsmSummary = {
  activeDays: number;
  approvedAmount: number;
  approvedTrips: number;
  avgCostPerTrip: number;
  hrId: string;
  lastTripDate: string | null;
  lineName: string | null;
  name: string;
  pendingAmount: number;
  pendingTrips: number;
  totalDistance: number;
  totalExpenses: number;
  totalTrips: number;
};

export function payrollExpensePeriodKey(row: {
  date?: string | null;
  payoutMonth?: number | null;
  payoutYear?: number | null;
}) {
  if (row.payoutMonth && row.payoutYear) {
    return `${row.payoutYear}-${String(row.payoutMonth).padStart(2, "0")}`;
  }

  if (!row.date) return "";
  const date = new Date(row.date);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function summarizePayrollExpenses(
  expenses: PayrollExpenseApproval[],
): PayrollExpenseSummary {
  const approvedRows = expenses.filter((expense) => expense.hrApproved);
  const totalAmount = roundCurrency(expenses.reduce((sum, expense) => sum + (expense.total || 0), 0));

  return {
    // The approved figure must match what payroll pays, so it follows the same payable rule
    // (HR's adjusted amount when there is one, the claim otherwise). `totalAmount` and
    // `pendingAmount` below stay on `total` — those are what was CLAIMED, not what pays.
    approvedAmount: roundCurrency(
      approvedRows.reduce(
        (sum, expense) => sum + payableExpenseAmount(expense.approvedAmount, expense.total),
        0,
      ),
    ),
    approvedRows: approvedRows.length,
    averageCostPerTrip: expenses.length > 0 ? roundCurrency(totalAmount / expenses.length) : 0,
    pendingAmount: roundCurrency(
      expenses
        .filter((expense) => !expense.hrApproved)
        .reduce((sum, expense) => sum + (expense.total || 0), 0),
    ),
    pendingRows: expenses.filter((expense) => !expense.hrApproved).length,
    specialistCount: new Set(expenses.map((expense) => expense.specialist).filter(Boolean)).size,
    totalAllowance: roundCurrency(expenses.reduce((sum, expense) => sum + (expense.allowance || 0), 0)),
    totalAmount,
    totalDistance: expenses.reduce((sum, expense) => sum + (expense.km || 0), 0),
    totalMeetingAmount: roundCurrency(expenses.reduce((sum, expense) => sum + (expense.meetingAmount || 0), 0)),
    totalOther: roundCurrency(expenses.reduce((sum, expense) => sum + (expense.other || 0), 0)),
    totalRows: expenses.length,
    totalTravelCost: roundCurrency(expenses.reduce((sum, expense) => sum + (expense.travelCost || 0), 0)),
  };
}

export function groupPayrollExpenses(
  expenses: PayrollExpenseApproval[],
  getKey: (expense: PayrollExpenseApproval) => string,
): PayrollExpenseGroupRow[] {
  const map = new Map<string, PayrollExpenseGroupRow>();

  expenses.forEach((expense) => {
    const key = getKey(expense) || "Unassigned";
    const current = map.get(key) ?? {
      allowance: 0,
      count: 0,
      key,
      km: 0,
      meeting: 0,
      other: 0,
      total: 0,
      travel: 0,
    };

    current.allowance += expense.allowance || 0;
    current.count += 1;
    current.km += expense.km || 0;
    current.meeting += expense.meetingAmount || 0;
    current.other += expense.other || 0;
    current.total += expense.total || 0;
    current.travel += expense.travelCost || 0;
    map.set(key, current);
  });

  return Array.from(map.values())
    .map((row) => ({
      ...row,
      allowance: roundCurrency(row.allowance),
      meeting: roundCurrency(row.meeting),
      other: roundCurrency(row.other),
      total: roundCurrency(row.total),
      travel: roundCurrency(row.travel),
    }))
    .sort((left, right) => right.total - left.total);
}

export function buildPayrollExpenseTrend(
  expenses: PayrollExpenseApproval[],
  limit = 6,
): PayrollExpenseTrendPoint[] {
  const periodRows = groupPayrollExpenses(expenses, payrollExpensePeriodKey)
    .filter((row) => row.key)
    .map((row) => ({ amount: row.total, period: row.key, rows: row.count }))
    .sort((left, right) => left.period.localeCompare(right.period));

  return limit > 0 ? periodRows.slice(-limit) : periodRows;
}

export function buildPayrollExpenseBreakdown(
  expenses: PayrollExpenseApproval[],
  limit = 5,
): PayrollExpenseBreakdownRow[] {
  return groupPayrollExpenses(
    expenses,
    (expense) => expense.requestType || expense.tripType || "Others",
  )
    .map((row) => ({
      breakdown: `Total for ${row.key}`,
      name: row.key,
      val: row.total,
    }))
    .slice(0, limit);
}

export function getApprovedExpenseTotalsByHrId(
  expenses: PayrollExpenseApproval[],
) {
  const totals = new Map<string, number>();

  expenses
    .filter((expense) => expense.hrApproved && expense.hrId)
    .forEach((expense) => {
      const hrId = String(expense.hrId);
      totals.set(
        hrId,
        (totals.get(hrId) ?? 0) + payableExpenseAmount(expense.approvedAmount, expense.total),
      );
    });

  return totals;
}

export function buildPayrollExpenseDsmSummaries(input: {
  dsms: PayrollExpenseDsmScope[];
  expenses: PayrollExpenseApproval[];
}) {
  const dsmByCanonicalHrId = new Map<string, PayrollExpenseDsmScope>();
  input.dsms.forEach((dsm) => {
    const canonicalHrId = normalizeHrIdForAccess(dsm.hrId);
    if (canonicalHrId) dsmByCanonicalHrId.set(canonicalHrId, dsm);
  });

  const summaryByDsm = new Map<string, PayrollExpenseDsmSummary>();
  dsmByCanonicalHrId.forEach((dsm, canonicalHrId) => {
    summaryByDsm.set(canonicalHrId, {
      activeDays: 0,
      approvedAmount: 0,
      approvedTrips: 0,
      avgCostPerTrip: 0,
      hrId: dsm.hrId,
      lastTripDate: null,
      lineName: dsm.lineName ?? null,
      name: dsm.fullName,
      pendingAmount: 0,
      pendingTrips: 0,
      totalDistance: 0,
      totalExpenses: 0,
      totalTrips: 0,
    });
  });

  input.expenses.forEach((expense) => {
    const canonicalHrId = normalizeHrIdForAccess(expense.hrId);
    if (!canonicalHrId) return;
    const existing = summaryByDsm.get(canonicalHrId);
    if (!existing) return;

    existing.totalTrips += 1;
    existing.totalExpenses += expense.total || 0;
    existing.totalDistance += expense.km || 0;

    if (expense.hrApproved) {
      existing.approvedTrips += 1;
      existing.approvedAmount += expense.total || 0;
    } else {
      existing.pendingTrips += 1;
      existing.pendingAmount += expense.total || 0;
    }

    if (expense.date) {
      const tripDate = expense.date.slice(0, 10);
      if (!existing.lastTripDate || tripDate > existing.lastTripDate) {
        existing.lastTripDate = tripDate;
      }
    }
  });

  return Array.from(summaryByDsm.values())
    .map((dsm) => {
      const dsmCanonicalHrId = normalizeHrIdForAccess(dsm.hrId);
      const dsmRows = input.expenses.filter(
        (expense) => normalizeHrIdForAccess(expense.hrId) === dsmCanonicalHrId,
      );

      return {
        ...dsm,
        activeDays: new Set(
          dsmRows.map((expense) => expense.date?.slice(0, 10)).filter(Boolean),
        ).size,
        approvedAmount: roundCurrency(dsm.approvedAmount),
        avgCostPerTrip: dsm.totalTrips > 0 ? roundCurrency(dsm.totalExpenses / dsm.totalTrips) : 0,
        pendingAmount: roundCurrency(dsm.pendingAmount),
        totalExpenses: roundCurrency(dsm.totalExpenses),
      };
    })
    .sort(
      (left, right) =>
        right.totalExpenses - left.totalExpenses ||
        right.totalTrips - left.totalTrips ||
        left.name.localeCompare(right.name),
    );
}
