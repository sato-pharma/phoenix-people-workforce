import { pharmacyRecordingOf, pharmacyValueText, type VisitCountSplit } from "@/lib/crm/visit-count-buckets";
import { entryCountBucket, entryPeriodLabel } from "@/lib/double-visit-analytics/count-bucket";
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
    // A chain visit is in BOTH managers' records (owner, 2026-10-08), so either one's name or role finds it.
    if (filters.roleFilter !== ALL && row.doubleVisitorRole !== filters.roleFilter && row.doubleVisitor2Role !== filters.roleFilter) return false;
    if (
      filters.visitorFilter !== ALL &&
      (row.doubleVisitorName ?? row.doubleVisitorHrId) !== filters.visitorFilter &&
      (row.doubleVisitor2Name ?? row.doubleVisitor2HrId ?? null) !== filters.visitorFilter
    ) {
      return false;
    }
    if (filters.visitKindFilter !== ALL && row.visitKind !== filters.visitKindFilter) return false;
    // A pharmacy row is found under "Pharmacies", never under the PM its CRM period says.
    if (filters.periodFilter !== ALL && entryPeriodLabel(row) !== filters.periodFilter) return false;
    if (!term) return true;
    return (
      (row.visitedName ?? "").toLowerCase().includes(term) ||
      (row.doubleVisitorName ?? "").toLowerCase().includes(term) ||
      (row.doubleVisitor2Name ?? "").toLowerCase().includes(term) ||
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

/**
 * The Pharmacy Visits figure: the count, or — when Phoenix CRM double visits are behind it, which log
 * no pharmacy visit — the words "Not recorded in Phoenix", or the count named "(iReports360 only)"
 * (src/lib/crm/visit-count-buckets.ts). Never a 0 that reads as "no pharmacy visits".
 */
function pharmacyVisitsMetric(rows: DoubleVisitReportRow[]): number | string {
  const split: VisitCountSplit = { am: 0, pm: 0, pharmacies: 0 };
  let phoenix = 0;
  for (const row of rows) {
    const bucket = entryCountBucket(row);
    if (!bucket) continue;
    if (bucket === "AM") split.am += row.visitCount;
    else if (bucket === "PM") split.pm += row.visitCount;
    else split.pharmacies += row.visitCount;
    if (row.fromPhoenix) phoenix += row.visitCount;
  }
  if (phoenix > 0) split.phoenix = phoenix;
  return pharmacyRecordingOf(split) === "recorded" ? split.pharmacies : pharmacyValueText(split);
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
    { metric: "Distinct Double-Visitors", value: countDistinct(logRows.flatMap((row) => [row.doubleVisitorHrId ?? row.doubleVisitorName, row.doubleVisitor2HrId ?? row.doubleVisitor2Name])) },
    { metric: "Distinct Visited MRs", value: countDistinct(logRows.map((row) => row.visitedHrId ?? row.visitedName)) },
    { metric: "Distinct Areas", value: countDistinct(logRows.map((row) => row.areaName)) },
    { metric: "Distinct Regions", value: countDistinct(logRows.map((row) => row.regionName)) },
    // AM · PM · Pharmacies, three figures apart — a pharmacy is never counted among the PM doctors.
    { metric: "AM Visits", value: sumVisitCount(logRows.filter((row) => entryCountBucket(row) === "AM")) },
    { metric: "PM Visits", value: sumVisitCount(logRows.filter((row) => entryCountBucket(row) === "PM")) },
    { metric: "Pharmacy Visits", value: pharmacyVisitsMetric(logRows) },
    { metric: "Regular Visits", value: sumVisitCount(logRows.filter((row) => row.visitKind === "Regular")) },
    { metric: "Unplanned Visits", value: sumVisitCount(logRows.filter((row) => row.visitKind === "Unplanned")) },
    { metric: "Never Visited / At Risk (filtered)", value: neverVisitedRows.length },
    { metric: "Probation Watchlist (filtered)", value: probationRows.length },
  ];
}

export function formatActiveFilters(activeFilters: Record<string, string>): string {
  const entries = Object.entries(activeFilters).filter(([, value]) => value.trim().length > 0);
  return entries.length > 0 ? entries.map(([key, value]) => `${key}: ${value}`).join("; ") : "None";
}
