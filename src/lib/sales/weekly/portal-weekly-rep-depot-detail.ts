// Weekly Sales — Depot Detail for a Medical Rep: his own area's share of every depot, laid out like
// Weekly Stock (owner, 2026-09-16: "His own area only").
//
// This rides the exact path his Weekly Sales page takes (portal-weekly-rep.ts): the same scope, the same
// own-seat match, the same month load with his geography lifted and his line bound kept, the same
// depot-split index. The one difference is the grain it keeps. His page sums each seat into a line of
// weekly totals; this keeps every depot row, so the two cannot disagree — selectOwnRepDepotParts files a
// row under a seat by the very lookup buildPortalWeeklyFieldForce uses, and the test suite holds the two
// totals equal.
//
// THE PRIVACY BOUNDARY IS selectOwnRepDepotParts. What leaves it is only the parts of depot rows that
// land on one of his own seats, relabelled with his seat's area and region. Another rep's share, the
// residue no seat takes, and every row of an area he does not hold stop there.

import { resolveEmployeeIdentityId, type AccessContext } from "@/lib/auth/permissions";
import { sharedIdentityKeys } from "@/lib/auth/identity-aliases";
import { resolveWeeklyAccessScope } from "@/lib/sales/weekly/access";
import { splitWeeklyRowsByBranch } from "@/lib/sales/weekly/branch-attribution";
import { loadWeeklyAreaSplitIndex, type WeeklyAreaSplitIndex } from "@/lib/sales/weekly/branch-area-split";
import { loadWeeklySalesUploadCalendar } from "@/lib/sales/weekly/depot-detail-service";
import {
  fieldForceKey,
  fieldForceLineKey,
  loadFieldForceSeatIndex,
  type FieldForceSeat,
  type FieldForceSeatIndex,
} from "@/lib/sales/weekly/portal-weekly-field-force";
import {
  loadValidatedWeeklyMonths,
  pickRepWeeklyMonth,
  repWeeklyLineName,
  repWeeklyLoadScope,
  repWeeklyScopeIsEmpty,
  repWeeklySeatKey,
  selectOwnRepSeats,
  type RepWeeklyMonthOption,
} from "@/lib/sales/weekly/portal-weekly-rep";
import {
  WEEKLY_SALES_DETAIL_NOTHING,
  buildWeeklySalesDepotDetail,
  weeklySalesPeriodLabel,
  type WeeklySalesDepotDetailPayload,
  type WeeklySalesDetailFilters,
  type WeeklySalesDetailSourceRow,
  type WeeklySalesDetailStatus,
} from "@/lib/sales/weekly/sales-depot-detail";
import { loadWeeklyDashboard } from "@/lib/sales/weekly/service";
import type { WeeklyFactExportRow } from "@/lib/sales/weekly/types";

export type RepWeeklyDepotDetailRequest = {
  /** cycle month code (YYYY-MM-DD); the newest month when absent or unknown */
  month: string | null;
  filters: WeeklySalesDetailFilters;
};

export type RepWeeklyDepotDetailPayload = WeeklySalesDepotDetailPayload & {
  month: RepWeeklyMonthOption | null;
};

function splitList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * The rep's query string. Every list is include-only; the client sends WEEKLY_SALES_DETAIL_NOTHING when
 * an exclude choice leaves nothing, and a week list holding it becomes [-1], which no week matches.
 */
export function parseRepWeeklyDepotDetailParams(params: URLSearchParams): RepWeeklyDepotDetailRequest {
  const month = params.get("month")?.trim() ?? "";
  const rawWeeks = splitList(params.get("weeks"));
  const weekNumbers = rawWeeks.includes(WEEKLY_SALES_DETAIL_NOTHING)
    ? [-1]
    : rawWeeks.map((part) => parseInt(part, 10)).filter((week) => Number.isFinite(week));
  return {
    month: /^\d{4}-\d{2}-\d{2}$/.test(month) ? month : null,
    filters: {
      weekNumbers,
      distributorCodes: splitList(params.get("distributors")),
      areaCodes: splitList(params.get("areas")),
      branchKeys: params
        .getAll("depot")
        .map((key) => key.trim())
        .filter(Boolean),
      productCodes: splitList(params.get("products")),
      movements: splitList(params.get("movements")),
    },
  };
}

/**
 * The parts of the month's depot rows that land on the rep's own seats. Pure.
 *
 * Mirrors buildPortalWeeklyFieldForce step for step: tag each row as hand-mapped BEFORE the split (a row
 * carrying an area came from a depot the owner mapped, and the split leaves exactly those alone), split
 * by the owner's depot rule, then file each part under the seat the index holds for its line and area.
 * A part is kept only when that seat's key is one of his own.
 */
export function selectOwnRepDepotParts(input: {
  rows: readonly WeeklyFactExportRow[];
  areaSplit: WeeklyAreaSplitIndex | null;
  seatIndex: FieldForceSeatIndex;
  ownSeats: readonly FieldForceSeat[];
}): WeeklySalesDetailSourceRow[] {
  const ownByKey = new Map(input.ownSeats.map((seat) => [repWeeklySeatKey(seat), seat]));
  if (ownByKey.size === 0) return [];

  const tagged = input.rows.map((row) => ({ ...row, exactArea: Boolean(String(row.areaCode ?? "").trim()) }));
  const { rows: split } = splitWeeklyRowsByBranch(tagged, input.areaSplit);

  const parts: WeeklySalesDetailSourceRow[] = [];
  for (const row of split) {
    const areaCode = String(row.areaCode ?? "").trim().toUpperCase();
    if (!areaCode) continue;
    const seat = input.seatIndex.byLineArea.get(fieldForceKey(row.line, areaCode));
    if (!seat) continue;
    const own = ownByKey.get(`${fieldForceLineKey(seat.lineCode)}|${seat.areaCode}`);
    if (!own) continue;
    parts.push({
      batchId: row.batchId,
      distributorCode: row.distributorCode,
      distributorName: row.distributorName,
      // His seat names the place, never the depot row: the row's region is the depot's.
      regionCode: own.regionCode,
      regionName: own.regionName,
      areaCode: own.areaCode,
      areaName: own.areaName,
      branchCode: row.branchCode,
      branchName: row.branchName,
      productCode: row.productCode,
      productName: row.productName,
      line: row.line,
      cycleMonth: row.cycleMonth,
      weekNumber: row.weekNumber,
      weekStart: row.weekStart,
      salesValue: Number(row.salesValue) || 0,
      salesUnits: Number(row.salesUnits) || 0,
      basis: row.exactArea ? "mapped" : "allocated",
    });
  }
  return parts;
}

/** "Heliopolis · CNS · Medical Rep" — his own areas and lines, in names. */
export function repDepotDetailScopeSummary(ownSeats: readonly FieldForceSeat[]): string {
  const areas = [...new Set(ownSeats.map((seat) => seat.areaName).filter(Boolean))];
  const lines = [...new Set(ownSeats.map((seat) => repWeeklyLineName(seat)).filter(Boolean))];
  return [...areas, ...lines, "Medical Rep"].join(" · ");
}

function emptyPayload(
  status: Exclude<WeeklySalesDetailStatus, "ok">,
  month: RepWeeklyMonthOption | null = null,
): RepWeeklyDepotDetailPayload {
  return {
    view: buildWeeklySalesDepotDetail({ audience: "rep", rows: [], areaNames: new Map(), uploads: [] }),
    scope: { summary: "Medical Rep", periodLabel: month ? month.name : "" },
    status,
    allocationUnavailable: false,
    month,
  };
}

/** The rep's own Depot detail for one month. Server-only; the route calls it for a Medical Rep. */
export async function getPortalWeeklyRepDepotDetail(
  ctx: AccessContext,
  request: RepWeeklyDepotDetailRequest,
): Promise<RepWeeklyDepotDetailPayload> {
  const [scope, months, seatIndex] = await Promise.all([
    resolveWeeklyAccessScope(ctx),
    loadValidatedWeeklyMonths(),
    loadFieldForceSeatIndex(),
  ]);

  if (repWeeklyScopeIsEmpty(scope)) return emptyPayload("no_access");
  if (seatIndex.seats.length === 0) return emptyPayload("seat_index_unavailable");

  const viewerKeys = sharedIdentityKeys(resolveEmployeeIdentityId(ctx));
  const allowedLineNames = scope.tier === "territory" ? scope.allowedLineNames : null;
  const ownSeats = selectOwnRepSeats(seatIndex.seats, viewerKeys, allowedLineNames);
  if (ownSeats.length === 0) return emptyPayload("no_seat");

  const month = pickRepWeeklyMonth(request.month, months);
  if (!month) return emptyPayload("no_data");

  const [dashboard, areaSplit, uploads] = await Promise.all([
    loadWeeklyDashboard({
      accessScope: repWeeklyLoadScope(scope),
      allWeeks: true,
      cycleMonths: [month.code],
      cycleMonthMode: "include",
      narrowRowsToCycleMonths: [month.code],
      includeFactRows: true,
      excludeUnmapped: true,
    }),
    loadWeeklyAreaSplitIndex().catch(() => null),
    loadWeeklySalesUploadCalendar([month.code]),
  ]);

  const parts = selectOwnRepDepotParts({ rows: dashboard.factRows ?? [], areaSplit, seatIndex, ownSeats });
  const period = { cycleMonths: [month.code], cycleMonthMode: "include" as const };
  const view = buildWeeklySalesDepotDetail({
    audience: "rep",
    rows: parts,
    areaNames: new Map(),
    uploads,
    period,
    filters: request.filters,
  });

  return {
    view,
    scope: {
      summary: repDepotDetailScopeSummary(ownSeats),
      periodLabel: weeklySalesPeriodLabel(period, request.filters.weekNumbers),
    },
    status: "ok",
    allocationUnavailable:
      areaSplit === null || (areaSplit.areasByLineRegion.size === 0 && areaSplit.areasByLineGovernorate.size === 0),
    month,
  };
}
