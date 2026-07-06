import type {
  DoubleVisitFocusProbationEntry,
  DoubleVisitFocusRosterEntry,
  DoubleVisitReportRow,
} from "@/lib/double-visit-analytics/types";

// Single source of truth for the Double Visit Report's filter semantics — used by the
// on-screen workspace (client-side, via useMemo) AND the export route (server-side), so the
// two can never drift apart. Keep these pure and free of React/hooks.

export const ALL = "ALL";

export type ReportLogFilters = {
  areaFilter: string;
  periodFilter: string;
  regionFilter: string;
  roleFilter: string;
  search: string;
  visitKindFilter: string;
  visitorFilter: string;
};

export type ReportNeverVisitedFilters = {
  areaFilter: string;
  flaggedOnly: boolean;
  search: string;
};

export type ReportProbationFilters = {
  dvStatusFilter: "ALL" | "done" | "pending";
  search: string;
};

export function filterLogRows(rows: DoubleVisitReportRow[], filters: ReportLogFilters): DoubleVisitReportRow[] {
  const term = filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.areaFilter !== ALL && row.areaName !== filters.areaFilter) return false;
    if (filters.regionFilter !== ALL && row.regionName !== filters.regionFilter) return false;
    if (filters.roleFilter !== ALL && row.doubleVisitorRole !== filters.roleFilter) return false;
    if (filters.visitorFilter !== ALL && (row.doubleVisitorName ?? row.doubleVisitorHrId) !== filters.visitorFilter) return false;
    if (filters.visitKindFilter !== ALL && row.visitKind !== filters.visitKindFilter) return false;
    if (filters.periodFilter !== ALL && row.period !== filters.periodFilter) return false;
    if (!term) return true;
    return (
      (row.visitedName ?? "").toLowerCase().includes(term) ||
      (row.doubleVisitorName ?? "").toLowerCase().includes(term) ||
      (row.visitedHrId ?? "").toLowerCase().includes(term)
    );
  });
}

export function filterNeverVisitedRows(
  rows: DoubleVisitFocusRosterEntry[],
  filters: ReportNeverVisitedFilters,
): DoubleVisitFocusRosterEntry[] {
  const term = filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.areaFilter !== ALL && row.areaName !== filters.areaFilter) return false;
    if (filters.flaggedOnly && !row.flagged) return false;
    if (!term) return true;
    return row.name.toLowerCase().includes(term) || row.hrId.toLowerCase().includes(term);
  });
}

export function filterProbationRows(
  rows: DoubleVisitFocusProbationEntry[],
  filters: ReportProbationFilters,
): DoubleVisitFocusProbationEntry[] {
  const term = filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.dvStatusFilter === "done" && row.dvDone !== true) return false;
    if (filters.dvStatusFilter === "pending" && row.dvDone !== false) return false;
    if (!term) return true;
    return row.name.toLowerCase().includes(term) || row.hrId.toLowerCase().includes(term);
  });
}

// ── Shared "Executive Summary" KPI computation for both export formats ──────────
// Both the xlsx and pdf builders call this so the two files can never report different
// numbers for the same filtered scope.

export type ReportSummaryMetric = { metric: string; value: number | string };

function sumVisitCount(rows: DoubleVisitReportRow[]) {
  return rows.reduce((sum, row) => sum + row.visitCount, 0);
}

function countDistinct<T>(values: Array<T | null | undefined>) {
  return new Set(values.filter((value): value is T => value !== null && value !== undefined)).size;
}

export function buildReportSummaryMetrics(filtered: {
  logRows: DoubleVisitReportRow[];
  neverVisitedRows: DoubleVisitFocusRosterEntry[];
  probationRows: DoubleVisitFocusProbationEntry[];
}): ReportSummaryMetric[] {
  const { logRows, neverVisitedRows, probationRows } = filtered;
  return [
    { metric: "Total Visits (filtered)", value: sumVisitCount(logRows) },
    { metric: "Log Rows (filtered)", value: logRows.length },
    { metric: "Distinct Double-Visitors", value: countDistinct(logRows.map((row) => row.doubleVisitorHrId ?? row.doubleVisitorName)) },
    { metric: "Distinct Visited MRs", value: countDistinct(logRows.map((row) => row.visitedHrId ?? row.visitedName)) },
    { metric: "Distinct Areas", value: countDistinct(logRows.map((row) => row.areaName)) },
    { metric: "Distinct Regions", value: countDistinct(logRows.map((row) => row.regionName)) },
    { metric: "AM Visits", value: sumVisitCount(logRows.filter((row) => row.period === "AM")) },
    { metric: "PM Visits", value: sumVisitCount(logRows.filter((row) => row.period === "PM")) },
    { metric: "Regular Visits", value: sumVisitCount(logRows.filter((row) => row.visitKind === "Regular")) },
    { metric: "Campaign Visits", value: sumVisitCount(logRows.filter((row) => row.visitKind !== "Regular")) },
    { metric: "Never Visited / At Risk (filtered)", value: neverVisitedRows.length },
    { metric: "Probation Watchlist (filtered)", value: probationRows.length },
  ];
}

export function formatActiveFilters(activeFilters: Record<string, string>): string {
  const entries = Object.entries(activeFilters).filter(([, value]) => value.trim().length > 0);
  return entries.length > 0 ? entries.map(([key, value]) => `${key}: ${value}`).join("; ") : "None";
}
