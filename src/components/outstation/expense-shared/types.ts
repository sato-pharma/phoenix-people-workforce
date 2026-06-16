// Client-facing re-exports for the Outstation Expense Command Center. The canonical
// payload types live in the dependency-free lib module so both the server service
// and these client components share one definition.

export type {
  ExpenseCommandFilters,
  ExpenseCommandFilterOptions,
  ExpenseCommandRow,
  ExpenseCommandKpis,
  ExpenseCommandKpiDeltas,
  ExpenseCommandBreakdowns,
  ExpenseCommandLeaderboards,
  ExpenseCommandHeatPoint,
  ExpenseSpenderRow,
  ExpenseRiskLocationRow,
  ExpenseSource,
  ExpenseSourceTotals,
  ExpenseDatePreset,
  ExpenseCommandScope,
  OutstationExpenseCommandData,
} from "@/lib/outstation/expense-command-types";

/** Controls labels / hidden columns only — never fetch or authorization. */
export type ExpenseDashboardVariant = "admin" | "portal";
