// Shared payload types for the Outstation Expense Command Center.
//
// This file is intentionally dependency-free (types only, no server imports) so
// BOTH the server service (`expense-command.ts`) and the client dashboard
// components can import it without dragging server-only code into the browser
// bundle. The same payload powers the admin (company scope) dashboard today and,
// later, a self-scoped employee-portal variant — admin-only fields are nullable so
// the portal reads a narrower but type-compatible object.

import type { PayrollExpenseApproval } from "@/lib/payroll/types";
import type {
  PayrollExpenseGroupRow,
  PayrollExpenseTrendPoint,
} from "@/lib/outstation/expense-metrics";

/** How an expense entered the system. */
export type ExpenseSource = "historical" | "live" | "manual";

export type ExpenseCommandScope = "company" | "self";

export type ExpenseDatePreset =
  | "all"
  | "today"
  | "7d"
  | "30d"
  | "90d"
  | "month"
  | "custom";

/**
 * Single-value filters (easy to use, easy to URL-encode). A cross-filter click in
 * the UI sets one of these. All optional; absent = no constraint on that field.
 */
export type ExpenseCommandFilters = {
  preset?: ExpenseDatePreset;
  /** Inclusive ISO yyyy-mm-dd bounds, used when preset === "custom". */
  from?: string | null;
  to?: string | null;
  region?: string | null; // brick-master area name
  line?: string | null;
  employeeHrId?: string | null;
  source?: ExpenseSource | null;
  status?: string | null; // "Approved" | "Pending" | "Rejected"
  transportation?: string | null;
  expenseType?: string | null; // tripType
};

/** One enriched expense row. Extends the unified payroll-expense row. */
export type ExpenseCommandRow = PayrollExpenseApproval & {
  source: ExpenseSource;
  region: string | null;
  line: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  mappable: boolean;
  // Admin-only intelligence — null in self (portal) scope.
  approvalRecommendation: string | null;
};

export type ExpenseSourceTotals = Record<ExpenseSource, { rows: number; amount: number }>;

export type ExpenseCommandKpis = {
  totalAmount: number;
  approvedAmount: number;
  pendingAmount: number;
  totalRows: number;
  approvedRows: number;
  pendingRows: number;
  employeeCount: number;
  averageCostPerTrip: number;
  totalDistance: number;
  totalTravelCost: number;
  totalAllowance: number;
  totalMeetingAmount: number;
  totalOther: number;
  bySource: ExpenseSourceTotals;
  mappableRows: number;
  unmappableRows: number;
  unmappedPct: number;
};

/**
 * Percent change of each KPI vs. the immediately-preceding window of the same
 * duration. `null` per-field when the previous window had a zero base (can't divide).
 * Whole object is `null` for preset="all" (no meaningful previous window).
 */
export type ExpenseCommandKpiDeltas = {
  totalAmountPct: number | null;
  approvedAmountPct: number | null;
  pendingAmountPct: number | null;
  totalRowsPct: number | null;
  employeeCountPct: number | null;
  previousLabel: string;
};

export type ExpenseCommandBreakdowns = {
  byRegion: PayrollExpenseGroupRow[];
  byLine: PayrollExpenseGroupRow[];
  byEmployee: PayrollExpenseGroupRow[];
  bySource: PayrollExpenseGroupRow[];
  byTransportation: PayrollExpenseGroupRow[];
  byExpenseType: PayrollExpenseGroupRow[];
  byStatus: PayrollExpenseGroupRow[];
};

export type ExpenseSpenderRow = {
  hrId: string;
  name: string;
  total: number;
  trips: number;
};

export type ExpenseCommandLeaderboards = {
  topSpenders: ExpenseSpenderRow[];
};

export type ExpenseCommandHeatPoint = {
  id: string; // region key
  latitude: number;
  longitude: number;
  weight: number; // = total spend for the location (all rows)
  approvedWeight: number; // spend where row.hrApproved
  pendingWeight: number; // spend where !row.hrApproved
  approvedCount: number;
  pendingCount: number;
  region: string | null;
  count: number; // expense rows aggregated into this location bubble
};

export type ExpenseCommandFilterOptions = {
  regions: string[];
  lines: string[];
  employees: Array<{ hrId: string; name: string }>;
  statuses: string[];
  sources: ExpenseSource[];
  transportationTypes: string[];
  expenseTypes: string[];
};

export type OutstationExpenseCommandData = {
  scope: ExpenseCommandScope;
  generatedAt: string;
  windowLabel: string;
  appliedFilters: ExpenseCommandFilters;
  filterOptions: ExpenseCommandFilterOptions;
  kpis: ExpenseCommandKpis;
  kpiDeltas: ExpenseCommandKpiDeltas | null;
  trend: PayrollExpenseTrendPoint[];
  breakdowns: ExpenseCommandBreakdowns;
  leaderboards: ExpenseCommandLeaderboards;
  heatPoints: ExpenseCommandHeatPoint[];
  rows: ExpenseCommandRow[];
};
