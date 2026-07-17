import {
  getExpensesScope,
  normalizeHrId,
  normalizeHrIdForAccess,
  resolveEmployeeIdentityId,
  type AccessContext,
} from "@/lib/auth/permissions";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { roundCurrency } from "@/lib/payroll/money";
import {
  buildPayrollExpenseTrend,
  groupPayrollExpenses,
  summarizePayrollExpenses,
} from "@/lib/outstation/expense-metrics";
import { listUnifiedOutstationExpenses } from "@/lib/outstation/expenses";
import type { PayrollExpenseApproval } from "@/lib/payroll/types";
import { listOutstationRequests } from "@/lib/outstation/service";
import { resolveRegionCentroid } from "@/lib/outstation/region-centroids";
import { normalizeDestinationKey, resolveDestinationCoords } from "@/lib/outstation/destination-geocode";
import { canonicalizeLocation } from "@/lib/employee-360/egypt-locations";
import type { OutstationExpenseRequest } from "@/lib/outstation/types";
import type {
  ExpenseCommandFilters,
  ExpenseCommandHeatPoint,
  ExpenseCommandKpiDeltas,
  ExpenseCommandRow,
  ExpenseCommandScope,
  ExpenseSource,
  ExpenseSourceTotals,
  OutstationExpenseCommandData,
} from "@/lib/outstation/expense-command-types";

const LEADERBOARD_LIMIT = 10;
const OUTSTATION_TRIP_PREFIX = "OUTSTATION-";

// The "by type" dimension is trip_type (Return same day / Overnight stay), but
// meetings / misc rows have no trip_type. Fall back to request_type (Meeting /
// Other / Traveling / Outstation) so they are labelled correctly instead of the
// meaningless "Unspecified".
function expenseTypeLabel(row: { tripType?: string | null; requestType?: string | null }): string {
  // tripType is pre-normalized to the literal "Unspecified" for blank trip types
  // (meetings/misc have no travel trip_type), so treat that as empty and fall back
  // to request_type (Meeting / Other / Traveling / Outstation).
  const t = (row.tripType ?? "").trim();
  if (t && t !== "Unspecified") return t;
  return row.requestType || "Other";
}

function resolveScope(access: AccessContext): ExpenseCommandScope {
  if (access.scope === "system" || access.scope === "company") return "company";
  return getExpensesScope({ role: access.role }) === "COMPANY" ? "company" : "self";
}

/** Numeric request id embedded in an "OUTSTATION-<id>" tripId, else null. */
function requestIdFromTripId(tripId: string): number | null {
  if (!tripId.startsWith(OUTSTATION_TRIP_PREFIX)) return null;
  const raw = tripId.slice(OUTSTATION_TRIP_PREFIX.length);
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Distinguish admin-manual entries from live employee submissions. Both write to
 * `outstation_expense_requests` with sourceFileName "Outstation Requests", so the
 * flattened row is insufficient — we inspect the raw request. (A dedicated
 * `entry_source` column would make this robust; tracked as a follow-up.)
 */
function isManualOutstationRequest(request: OutstationExpenseRequest): boolean {
  const reason = (request.approvalReason ?? "").toLowerCase();
  if (reason.startsWith("manual outstation expense created by admin")) return true;
  return (
    request.capturedAccuracyMeters === 0 &&
    request.approvalRecommendation === "manager_review"
  );
}

type DateWindow = { from: number | null; to: number | null; label: string };

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function endOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999).getTime();
}

/** Resolve the active date window from the filter preset / custom bounds. */
function resolveDateWindow(filters: ExpenseCommandFilters): DateWindow {
  const preset = filters.preset ?? "all";
  const now = new Date();

  switch (preset) {
    case "today":
      return { from: startOfDay(now), to: endOfDay(now), label: "Today" };
    case "7d":
      return { from: startOfDay(new Date(now.getTime() - 6 * 86_400_000)), to: endOfDay(now), label: "Last 7 days" };
    case "30d":
      return { from: startOfDay(new Date(now.getTime() - 29 * 86_400_000)), to: endOfDay(now), label: "Last 30 days" };
    case "90d":
      return { from: startOfDay(new Date(now.getTime() - 89 * 86_400_000)), to: endOfDay(now), label: "Last 90 days" };
    case "month": {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: startOfDay(first), to: endOfDay(now), label: "This month" };
    }
    case "custom": {
      const from = filters.from ? startOfDay(new Date(filters.from)) : null;
      const to = filters.to ? endOfDay(new Date(filters.to)) : null;
      const label =
        filters.from || filters.to
          ? `${filters.from ?? "…"} → ${filters.to ?? "…"}`
          : "Custom range";
      return { from, to, label };
    }
    case "all":
    default:
      return { from: null, to: null, label: "All time" };
  }
}

/**
 * The window immediately preceding the current window, of the same duration. Used
 * to compute "vs prev …" KPI deltas. Returns null for preset="all" (no meaningful
 * comparison) and for custom ranges with no `from` bound.
 */
function resolvePreviousWindow(
  filters: ExpenseCommandFilters,
  current: DateWindow,
): { from: number; to: number; label: string } | null {
  const preset = filters.preset ?? "all";
  if (preset === "all") return null;

  if (preset === "today") {
    const yest = new Date(Date.now() - 86_400_000);
    return { from: startOfDay(yest), to: endOfDay(yest), label: "vs yesterday" };
  }

  if (preset === "month") {
    const now = new Date();
    const lastMonthFirst = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    // Day 0 of the current month = last day of the previous month.
    const lastMonthLast = new Date(now.getFullYear(), now.getMonth(), 0);
    return {
      from: startOfDay(lastMonthFirst),
      to: endOfDay(lastMonthLast),
      label: "vs last month",
    };
  }

  // 7d / 30d / 90d / custom: mirror the current duration immediately before it.
  if (current.from === null || current.to === null) return null;
  const duration = current.to - current.from;
  const prevTo = current.from - 1;
  const prevFrom = prevTo - duration;
  const labels: Record<string, string> = {
    "7d": "vs prev 7d",
    "30d": "vs prev 30d",
    "90d": "vs prev 90d",
    custom: "vs prev period",
  };
  return { from: prevFrom, to: prevTo, label: labels[preset] ?? "vs prev period" };
}

function withinWindow(row: PayrollExpenseApproval, window: DateWindow): boolean {
  if (window.from === null && window.to === null) return true;
  if (!row.date) return false;
  const time = new Date(row.date).getTime();
  if (Number.isNaN(time)) return false;
  if (window.from !== null && time < window.from) return false;
  if (window.to !== null && time > window.to) return false;
  return true;
}

function distinctSorted(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((value) => (value ?? "").trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function buildSourceTotals(rows: ExpenseCommandRow[]): ExpenseSourceTotals {
  const totals: ExpenseSourceTotals = {
    historical: { rows: 0, amount: 0 },
    live: { rows: 0, amount: 0 },
    manual: { rows: 0, amount: 0 },
  };
  rows.forEach((row) => {
    const bucket = totals[row.source];
    bucket.rows += 1;
    bucket.amount += row.total || 0;
  });
  (Object.keys(totals) as ExpenseSource[]).forEach((key) => {
    totals[key].amount = roundCurrency(totals[key].amount);
  });
  return totals;
}

export async function getOutstationExpenseCommandData(
  access: AccessContext,
  filters: ExpenseCommandFilters = {},
): Promise<OutstationExpenseCommandData> {
  const scope = resolveScope(access);
  const isAdmin = scope === "company";

  const [unifiedExpenses, directory, rawRequests] = await Promise.all([
    listUnifiedOutstationExpenses(undefined, undefined, undefined, access),
    getEmployeeDirectory(),
    listOutstationRequests(),
  ]);

  // In self scope, listOutstationRequests bypasses access scoping — restrict to
  // the caller's own requests before it is ever read.
  const ownCanonicalHrId = normalizeHrIdForAccess(resolveEmployeeIdentityId(access));
  const scopedRequests = isAdmin
    ? rawRequests
    : rawRequests.filter((request) => normalizeHrIdForAccess(request.employeeHrId) === ownCanonicalHrId);

  const requestById = new Map<number, OutstationExpenseRequest>();
  scopedRequests.forEach((request) => requestById.set(request.id, request));

  const employeeByHrId = new Map<string, (typeof directory.employees)[number]>();
  directory.employees.forEach((employee) => {
    const key = normalizeHrIdForAccess(employee.hrId);
    if (key) employeeByHrId.set(key, employee);
  });

  // Enrich every unified expense row.
  const enriched: ExpenseCommandRow[] = unifiedExpenses.map((expense) => {
    const requestId = requestIdFromTripId(expense.tripId);
    const request = requestId !== null ? requestById.get(requestId) ?? null : null;

    let source: ExpenseSource;
    if (request) {
      source = isManualOutstationRequest(request) ? "manual" : "live";
    } else {
      source = "historical";
    }

    const directoryRow = expense.hrId
      ? employeeByHrId.get(normalizeHrIdForAccess(expense.hrId) ?? "") ?? null
      : null;

    const region = directoryRow?.areaName ?? directoryRow?.regionName ?? request?.employeeArea ?? request?.toArea ?? null;
    const line = directoryRow?.lineName ?? request?.employeeLine ?? null;
    const city = request?.toCity ?? null;

    // Place every row on the map by its brick-master region centroid (covers the
    // historical/manual rows that have no GPS — the bulk of spend). Rows whose
    // region has no known centroid stay unmapped and are disclosed honestly.
    const regionCentroid = resolveRegionCentroid(region);
    const latitude = regionCentroid?.lat ?? null;
    const longitude = regionCentroid?.lng ?? null;
    const mappable = regionCentroid !== null;

    const approvalRecommendation = request ? request.approvalRecommendation : null;

    // Canonicalise the free-text destination (English/Arabic variants + full
    // addresses all fold to one governorate, e.g. "الإسكندرية…" and "Alexandria")
    // so the ledger and heatmap dedupe instead of scattering the same place.
    const rawDestination = expense.to || expense.location || "";
    const canonicalDestination = rawDestination ? canonicalizeLocation(rawDestination) : expense.to;
    const isRejected = String(expense.status ?? "").toLowerCase().includes("reject");

    return {
      ...expense,
      to: canonicalDestination,
      // Approval is 3-state. hr_approved stays the canonical "approved" signal (so
      // the Approved-spend KPI is unchanged); the rest split into Rejected (from raw
      // status) vs Pending, so Rejected is no longer hidden inside Pending.
      status: expense.hrApproved ? "Approved" : isRejected ? "Rejected" : "Pending",
      source,
      region,
      line,
      city,
      latitude,
      longitude,
      mappable,
      approvalRecommendation,
    };
  });

  // In self (portal) scope, restrict to the caller's own rows so the row scope
  // matches the own-only request enrichment — a manager collapsed to self never
  // sees, or mis-labels, team rows. Admin scope sees everything.
  const visibleEnriched = isAdmin
    ? enriched
    : enriched.filter((row) => normalizeHrIdForAccess(row.hrId) === ownCanonicalHrId);

  // Filter options from the (scope-visible) UNFILTERED set so the UI always offers every value.
  const filterOptions = {
    regions: distinctSorted(visibleEnriched.map((row) => row.region)),
    lines: distinctSorted(visibleEnriched.map((row) => row.line)),
    employees: Array.from(
      new Map(
        visibleEnriched
          .filter((row) => row.hrId)
          .map((row) => [
            normalizeHrId(row.hrId) ?? "",
            { hrId: normalizeHrId(row.hrId) ?? "", name: row.specialist || (normalizeHrId(row.hrId) ?? "") },
          ]),
      ).values(),
    )
      .filter((employee) => employee.hrId)
      .sort((a, b) => a.name.localeCompare(b.name)),
    statuses: distinctSorted(visibleEnriched.map((row) => row.status)),
    sources: (["live", "manual", "historical"] as ExpenseSource[]).filter((source) =>
      visibleEnriched.some((row) => row.source === source),
    ),
    transportationTypes: distinctSorted(visibleEnriched.map((row) => row.transportationType)),
    expenseTypes: distinctSorted(visibleEnriched.map((row) => expenseTypeLabel(row))),
  };

  // Apply the active filters (single pass, in-memory).
  const window = resolveDateWindow(filters);
  const filterRegion = filters.region?.trim() || null;
  const filterLine = filters.line?.trim() || null;
  const filterEmployee = filters.employeeHrId ? normalizeHrIdForAccess(filters.employeeHrId) : null;
  const filterStatus = filters.status?.trim() || null;
  const filterSource = filters.source ?? null;
  const filterTransport = filters.transportation?.trim() || null;
  const filterExpenseType = filters.expenseType?.trim() || null;

  // Comparisons use the SAME placeholder fallback the breakdown buckets use
  // ("Unassigned"/"Unspecified"), so clicking a placeholder bar round-trips and
  // doesn't silently return zero rows.
  const rows = visibleEnriched.filter((row) => {
    if (!withinWindow(row, window)) return false;
    if (filterRegion && (row.region || "Unassigned") !== filterRegion) return false;
    if (filterLine && (row.line || "Unassigned") !== filterLine) return false;
    if (filterEmployee && normalizeHrIdForAccess(row.hrId) !== filterEmployee) return false;
    if (filterStatus && row.status !== filterStatus) return false;
    if (filterSource && row.source !== filterSource) return false;
    if (filterTransport && (row.transportationType || "Unspecified") !== filterTransport) return false;
    if (filterExpenseType && expenseTypeLabel(row) !== filterExpenseType) return false;
    return true;
  });

  // Upgrade region-centroid coordinates to PRECISE coordinates: exact GPS for live
  // submissions, else the geocoded destination town (cached). Rows whose destination
  // can't be geocoded keep their region-centroid fallback. Net: the map plots actual
  // destinations and still covers the full spend.
  const destinationCoords = await resolveDestinationCoords(
    rows.map((row) => row.to || row.location || "").filter(Boolean),
  );
  rows.forEach((row) => {
    const requestId = requestIdFromTripId(row.tripId);
    const request = requestId !== null ? requestById.get(requestId) ?? null : null;
    // Only treat REAL GPS as precise. captured_latitude/longitude are coerced to 0 for
    // null DB values (and the medical-rep manual flow stores 0,0 when residence GPS is
    // missing), so 0,0 is a "no fix" sentinel — not a coordinate off the coast of Africa.
    // Let those fall through to the geocoded destination town / region centroid.
    const gps =
      request &&
      Number.isFinite(request.capturedLatitude) &&
      Number.isFinite(request.capturedLongitude) &&
      (request.capturedLatitude !== 0 || request.capturedLongitude !== 0)
        ? { lat: request.capturedLatitude, lng: request.capturedLongitude }
        : null;
    const destKey = normalizeDestinationKey(row.to || row.location || "");
    const precise = gps ?? (destKey ? destinationCoords.get(destKey) ?? null : null);
    if (precise) {
      row.latitude = precise.lat;
      row.longitude = precise.lng;
      row.mappable = true;
    }
  });

  // KPIs (reuse the canonical money math).
  const summary = summarizePayrollExpenses(rows);
  const mappableRows = rows.filter((row) => row.mappable).length;
  const unmappableRows = rows.length - mappableRows;
  const employeeCount = new Set(
    rows.map((row) => normalizeHrIdForAccess(row.hrId)).filter(Boolean),
  ).size;

  const kpis = {
    totalAmount: summary.totalAmount,
    approvedAmount: summary.approvedAmount,
    pendingAmount: summary.pendingAmount,
    totalRows: summary.totalRows,
    approvedRows: summary.approvedRows,
    pendingRows: summary.pendingRows,
    employeeCount,
    averageCostPerTrip: summary.averageCostPerTrip,
    totalDistance: summary.totalDistance,
    totalTravelCost: summary.totalTravelCost,
    totalAllowance: summary.totalAllowance,
    totalMeetingAmount: summary.totalMeetingAmount,
    totalOther: summary.totalOther,
    bySource: buildSourceTotals(rows),
    mappableRows,
    unmappableRows,
    unmappedPct: rows.length > 0 ? roundCurrency((unmappableRows / rows.length) * 100) : 0,
  };

  // Cross-period deltas: same in-memory rows, but filtered to the previous window of
  // the same duration. All other filters identical so the comparison is apples-to-apples.
  const previousWindow = resolvePreviousWindow(filters, window);
  let kpiDeltas: ExpenseCommandKpiDeltas | null = null;
  if (previousWindow && rows.length > 0) {
    const previousRows = visibleEnriched.filter((row) => {
      if (!withinWindow(row, previousWindow)) return false;
      if (filterRegion && (row.region || "Unassigned") !== filterRegion) return false;
      if (filterLine && (row.line || "Unassigned") !== filterLine) return false;
      if (filterEmployee && normalizeHrIdForAccess(row.hrId) !== filterEmployee) return false;
      if (filterStatus && row.status !== filterStatus) return false;
      if (filterSource && row.source !== filterSource) return false;
      if (filterTransport && (row.transportationType || "Unspecified") !== filterTransport) return false;
      if (filterExpenseType && expenseTypeLabel(row) !== filterExpenseType) return false;
      return true;
    });
    const prevSummary = summarizePayrollExpenses(previousRows);
    const prevEmployeeCount = new Set(
      previousRows.map((row) => normalizeHrIdForAccess(row.hrId)).filter(Boolean),
    ).size;
    const pctDelta = (current: number, previous: number): number | null => {
      if (previous === 0) return null;
      return roundCurrency(((current - previous) / previous) * 100);
    };
    kpiDeltas = {
      totalAmountPct: pctDelta(summary.totalAmount, prevSummary.totalAmount),
      approvedAmountPct: pctDelta(summary.approvedAmount, prevSummary.approvedAmount),
      pendingAmountPct: pctDelta(summary.pendingAmount, prevSummary.pendingAmount),
      totalRowsPct: pctDelta(summary.totalRows, prevSummary.totalRows),
      employeeCountPct: pctDelta(employeeCount, prevEmployeeCount),
      previousLabel: previousWindow.label,
    };
  }

  // Breakdowns (reuse groupPayrollExpenses; ExpenseCommandRow extends the base row).
  const sourceLabels: Record<ExpenseSource, string> = {
    historical: "Historical upload",
    live: "Employee submission",
    manual: "Admin manual entry",
  };
  const breakdowns = {
    byRegion: groupPayrollExpenses(rows, (row) => (row as ExpenseCommandRow).region ?? "Unassigned"),
    byLine: groupPayrollExpenses(rows, (row) => (row as ExpenseCommandRow).line ?? "Unassigned"),
    byEmployee: groupPayrollExpenses(rows, (row) => row.specialist || "Unassigned"),
    bySource: groupPayrollExpenses(rows, (row) => sourceLabels[(row as ExpenseCommandRow).source]),
    byTransportation: groupPayrollExpenses(
      rows.filter((row) => !!row.transportationType),
      (row) => row.transportationType,
    ),
    // Group by tripType (NOT requestType) so the "by type" slice key matches the
    // expenseType filter field and the Expense-type dropdown options.
    byExpenseType: groupPayrollExpenses(rows, (row) => expenseTypeLabel(row as ExpenseCommandRow)),
    byStatus: groupPayrollExpenses(rows, (row) => row.status || "Pending"),
  };

  // Leaderboards.
  const spendByHrId = new Map<string, { hrId: string; name: string; total: number; trips: number }>();
  rows.forEach((row) => {
    const canonical = normalizeHrId(row.hrId);
    if (!canonical) return;
    const current = spendByHrId.get(canonical) ?? {
      hrId: canonical,
      name: row.specialist || canonical,
      total: 0,
      trips: 0,
    };
    current.total += row.total || 0;
    current.trips += 1;
    spendByHrId.set(canonical, current);
  });
  const topSpenders = Array.from(spendByHrId.values())
    .map((entry) => ({ ...entry, total: roundCurrency(entry.total) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, LEADERBOARD_LIMIT);

  // Location bubbles: aggregate spend by resolved coordinate (geocoded destination
  // town, exact GPS, or region-centroid fallback). One weighted, clickable
  // proportional marker per location — covers the FULL spend without the deprecated
  // heat layer.
  const bubbleMap = new Map<string, ExpenseCommandHeatPoint>();
  rows
    .filter((row) => row.mappable && row.latitude !== null && row.longitude !== null)
    .forEach((row) => {
      const lat = row.latitude as number;
      const lng = row.longitude as number;
      const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
      const label = row.to || row.location || row.region || "Unassigned";
      const amount = row.total || 0;
      const isApproved = Boolean(row.hrApproved);
      const existing = bubbleMap.get(key);
      if (existing) {
        existing.weight += amount;
        existing.count += 1;
        if (isApproved) {
          existing.approvedWeight += amount;
          existing.approvedCount += 1;
        } else {
          existing.pendingWeight += amount;
          existing.pendingCount += 1;
        }
      } else {
        bubbleMap.set(key, {
          id: key,
          latitude: lat,
          longitude: lng,
          weight: amount,
          approvedWeight: isApproved ? amount : 0,
          pendingWeight: isApproved ? 0 : amount,
          approvedCount: isApproved ? 1 : 0,
          pendingCount: isApproved ? 0 : 1,
          region: label,
          count: 1,
        });
      }
    });
  const heatPoints: ExpenseCommandHeatPoint[] = Array.from(bubbleMap.values())
    .map((point) => ({
      ...point,
      weight: roundCurrency(point.weight),
      approvedWeight: roundCurrency(point.approvedWeight),
      pendingWeight: roundCurrency(point.pendingWeight),
    }))
    .sort((a, b) => b.weight - a.weight);

  // In self scope, strip admin-only intelligence from the rows themselves.
  const exposedRows: ExpenseCommandRow[] = isAdmin
    ? rows
    : rows.map((row) => ({
        ...row,
        approvalRecommendation: null,
      }));

  return {
    scope,
    generatedAt: new Date().toISOString(),
    windowLabel: window.label,
    appliedFilters: filters,
    filterOptions,
    kpis,
    kpiDeltas,
    trend: buildPayrollExpenseTrend(rows, 0),
    breakdowns,
    leaderboards: {
      topSpenders,
    },
    heatPoints,
    rows: exposedRows,
  };
}
