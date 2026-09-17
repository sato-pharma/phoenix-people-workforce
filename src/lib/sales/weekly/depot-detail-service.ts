// Weekly Sales — Depot Detail: the managers' loader (portal DM, RM, NSM, PM, GPM, MM, plus CEO and
// Super Admin on the same component), shared by the feed and the export so the download is the screen.
//
// Scope resolves from the SESSION through resolvePortalWeeklyScope, exactly as the portal Weekly Sales
// dashboard's own tabs do, and is enforced inside loadWeeklyDashboard. Query params only narrow inside
// what the viewer may already see.
//
// A district or regional manager's region bound is LIFTED for the load and narrowed straight back to his
// own areas (own-area-scope.ts), as his Field Force tab and Weekly Stock are. Depot rows keep the region
// label they were mapped with, so an Upper Egypt 1, Upper Egypt 2 or Delta (3) manager's region-bound load
// never fetched the "Upper Egypt" or Delta (1)/(2) rows the depot split shares with his areas, and this
// tab read nearly empty beside a full Field Force tab.
//
// Every weekly report sets excludeUnmapped (owner rule), so a product the Product Master has not mapped
// to a line never reaches these totals. The screen and the workbook both say so.

import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import type { WeeklyAccessScope } from "@/lib/sales/weekly/access";
import { loadWeeklyAreaSplitIndex, type WeeklyAreaSplitIndex } from "@/lib/sales/weekly/branch-area-split";
import { splitWeeklyRowsByBranch } from "@/lib/sales/weekly/branch-attribution";
import {
  mayLiftWeeklyGeography,
  weeklyFieldForceGeography,
  weeklyScopeOwnAreaKeys,
} from "@/lib/sales/weekly/own-area-scope";
import { resolvePortalWeeklyScope, type PortalWeeklyFilters } from "@/lib/sales/weekly/portal-weekly-dashboard";
import { fieldForceKey, type FieldForceGeography } from "@/lib/sales/weekly/portal-weekly-field-force";
import {
  buildWeeklySalesDepotDetail,
  weeklySalesPeriodLabel,
  type WeeklySalesDepotDetailPayload,
  type WeeklySalesDetailFilters,
  type WeeklySalesDetailSourceRow,
  type WeeklySalesDetailUpload,
} from "@/lib/sales/weekly/sales-depot-detail";
import { weeklyScopeRegionPart } from "@/lib/sales/weekly/scope-region-names";
import { loadWeeklyDashboard } from "@/lib/sales/weekly/service";
import type { WeeklyFactExportRow, WeeklyFilterMode } from "@/lib/sales/weekly/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type WeeklySalesDetailManagerRequest = {
  /** The Weekly Sales page's own filters (the host filter bar). */
  page: PortalWeeklyFilters;
  /** The detail's local filters. */
  local: WeeklySalesDetailFilters;
};

function splitList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

const modeOf = (params: URLSearchParams, key: string): WeeklyFilterMode =>
  params.get(key)?.trim() === "exclude" ? "exclude" : "include";

/**
 * Depot keys travel as one repeated `depot` parameter, never a comma list: a depot with no code is keyed
 * by its NAME, and a depot name can hold a comma.
 */
export function parseDepotKeys(params: URLSearchParams): string[] {
  return params
    .getAll("depot")
    .map((key) => key.trim())
    .filter(Boolean);
}

/** One query-string contract for the managers' feed, their export and the client. */
export function parseWeeklySalesDetailManagerParams(params: URLSearchParams): WeeklySalesDetailManagerRequest {
  return {
    page: {
      cycleMonths: splitList(params.get("months")),
      cycleMonthMode: modeOf(params, "monthsMode"),
      weekNumbers: splitList(params.get("weeks"))
        .map((part) => parseInt(part, 10))
        .filter((week) => Number.isFinite(week)),
      weekNumberMode: modeOf(params, "weeksMode"),
      distributorCodes: splitList(params.get("distributors")),
      distributorFilterMode: modeOf(params, "distributorsMode"),
      regionCodes: splitList(params.get("regions")),
      regionFilterMode: modeOf(params, "regionsMode"),
      productCodes: splitList(params.get("products")),
      productFilterMode: modeOf(params, "productsMode"),
      lineCodes: splitList(params.get("lines")),
      lineFilterMode: modeOf(params, "linesMode"),
    },
    local: {
      areaCodes: splitList(params.get("areas")),
      branchKeys: parseDepotKeys(params),
      movements: splitList(params.get("movements")),
    },
  };
}

/** Area names for the depot rows. Fails soft: without names a depot shows its area code, not an error page. */
export async function loadWeeklyAreaNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const { data, error } = await getSupabaseAdmin().from("source_of_sales_areas").select("area_code, area_name");
    if (error) return names;
    for (const row of (data ?? []) as { area_code: string | null; area_name: string | null }[]) {
      const code = row.area_code?.trim().toUpperCase();
      if (code && row.area_name?.trim() && !names.has(code)) names.set(code, row.area_name.trim());
    }
  } catch {
    // fall through with whatever loaded
  }
  return names;
}

/**
 * Every validated upload of the given months (all months when null), whether or not its rows reach
 * the viewer. The average per week counts a distributor's weeks from its uploads, and a week with no
 * sale in the viewer's scope is still a week the distributor reported. Fails soft to an empty list,
 * which leaves the builder with the uploads the rows themselves came from.
 */
export async function loadWeeklySalesUploadCalendar(cycleMonths: readonly string[] | null): Promise<WeeklySalesDetailUpload[]> {
  const uploads: WeeklySalesDetailUpload[] = [];
  const pageSize = 1000;
  try {
    const supabase = getSupabaseAdmin();
    for (let from = 0; ; from += pageSize) {
      let query = supabase
        .from("weekly_sales_batches")
        .select("id, distributor_code, cycle_month, week_number, week_start")
        .eq("status", "validated")
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1);
      if (cycleMonths && cycleMonths.length > 0) query = query.in("cycle_month", [...cycleMonths]);
      const { data, error } = await query;
      if (error) return [];
      const rows = (data ?? []) as {
        id: string | number;
        distributor_code: string | null;
        cycle_month: string | null;
        week_number: number | null;
        week_start: string | null;
      }[];
      for (const row of rows) {
        uploads.push({
          batchId: String(row.id),
          distributorCode: String(row.distributor_code ?? ""),
          cycleMonth: row.cycle_month ? String(row.cycle_month) : null,
          weekNumber: row.week_number != null ? Number(row.week_number) : null,
          weekStart: row.week_start ? String(row.week_start) : null,
        });
      }
      if (rows.length < pageSize) break;
    }
  } catch {
    return [];
  }
  return uploads;
}

/**
 * A manager's depot rows. Every row whole — unless his load lifted its geography (own-area-scope.ts), when
 * he gets the rule every lifted weekly screen follows: a row his own scope admits counts whole, exactly as
 * before the lift, and any other row counts only for the share the owner's depot split places in one of
 * HIS areas, labelled an allocation. Another district's share and the residue of a row he could not see
 * stop here. A share keeps the depot's region label, which is what the page's Region filter reads, so a
 * drill into that region keeps it. Pure.
 */
export function selectManagerDepotRows(input: {
  rows: readonly WeeklyFactExportRow[];
  /** Required whenever `rows` came from a load with the geography lifted; null = every row counts whole. */
  geography: FieldForceGeography | null;
  areaSplit: WeeklyAreaSplitIndex | null;
}): WeeklySalesDetailSourceRow[] {
  const { geography } = input;
  if (!geography) return wholeDepotRows(input.rows);

  const admitted: WeeklyFactExportRow[] = [];
  const outside: (WeeklyFactExportRow & { exactArea: boolean })[] = [];
  for (const row of input.rows) {
    // Asked of the row the caller handed in: the split's parts are copies.
    if (geography.admitsWhole(row)) admitted.push(row);
    // Tagged BEFORE the split, as buildPortalWeeklyFieldForce tags: a row carrying an area came from a depot
    // mapped by hand, and the split leaves exactly those alone.
    else outside.push({ ...row, exactArea: Boolean(String(row.areaCode ?? "").trim()) });
  }

  const shares: WeeklySalesDetailSourceRow[] = [];
  for (const part of splitWeeklyRowsByBranch(outside, input.areaSplit).rows) {
    if (!geography.ownAreaKeys.has(fieldForceKey(part.line, part.areaCode))) continue;
    const [row] = wholeDepotRows([part]);
    shares.push({
      ...row,
      areaCode: String(part.areaCode).trim().toUpperCase(),
      basis: part.exactArea ? "whole" : "allocated",
    });
  }
  return [...wholeDepotRows(admitted), ...shares];
}

/** A manager reads every depot row whole: no split, no allocation. */
export function wholeDepotRows(rows: readonly WeeklyFactExportRow[]): WeeklySalesDetailSourceRow[] {
  return rows.map((row) => ({
    batchId: row.batchId,
    distributorCode: row.distributorCode,
    distributorName: row.distributorName,
    regionCode: row.regionCode,
    regionName: row.regionName,
    areaCode: row.areaCode,
    branchCode: row.branchCode,
    branchName: row.branchName,
    productCode: row.productCode,
    productName: row.productName,
    line: row.line,
    cycleMonth: row.cycleMonth,
    weekNumber: row.weekNumber,
    weekStart: row.weekStart,
    salesValue: row.salesValue,
    salesUnits: row.salesUnits,
    basis: "whole",
  }));
}

/**
 * The workbook's scope line, in names — the same wording Weekly Stock uses. A single bound region is named from
 * the organogram names resolvePortalWeeklyScope read, never from the depot rows' own labels. Pure.
 */
export function buildDetailScopeSummary(
  scope: WeeklyAccessScope,
  role: PhoenixRole,
  regionNames: ReadonlyMap<string, string>,
): string {
  const parts: string[] = [];
  switch (scope.tier) {
    case "full":
      parts.push("All tracked lines", "all regions");
      break;
    case "product":
      parts.push(`${scope.productCodes.size} product${scope.productCodes.size === 1 ? "" : "s"}`);
      break;
    case "territory":
      parts.push(scope.allowedLineNames && scope.allowedLineNames.size > 0 ? [...scope.allowedLineNames].join(" · ") : "All tracked lines");
      parts.push(weeklyScopeRegionPart(scope.allowedRegionCodes, regionNames));
      break;
    case "none":
      parts.push("No access");
      break;
  }
  parts.push(role);
  return parts.join(" · ");
}

export async function loadWeeklySalesDepotDetail(
  request: WeeklySalesDetailManagerRequest,
  ctx: AccessContext,
): Promise<WeeklySalesDepotDetailPayload> {
  const scope = await resolvePortalWeeklyScope(ctx);
  const page = request.page;
  // Whole months only, and include mode only: an exclude choice names months to DROP, so it cannot
  // become a fetch whitelist. The option lists this narrowing would trim are never read here.
  const includeMonths =
    page.cycleMonthMode !== "exclude" && (page.cycleMonths ?? []).length > 0 ? (page.cycleMonths ?? []) : null;
  // His own areas, straight from his seat's scope — the keys his Field Force tab narrows by. Only a
  // territory manager with a region bound and known areas lifts; every other viewer loads as before.
  const ownAreaKeys = weeklyScopeOwnAreaKeys(scope.accessScope);
  const liftGrain = mayLiftWeeklyGeography(scope.accessScope, ownAreaKeys);

  const [data, areaNames, uploads, areaSplit] = await Promise.all([
    loadWeeklyDashboard({
      cycleMonths: page.cycleMonths,
      cycleMonthMode: page.cycleMonthMode,
      weekNumbers: page.weekNumbers,
      weekNumberMode: page.weekNumberMode,
      distributorCodes: page.distributorCodes,
      distributorFilterMode: page.distributorFilterMode,
      regionCodes: page.regionCodes,
      regionFilterMode: page.regionFilterMode,
      productCodes: page.productCodes,
      productFilterMode: page.productFilterMode,
      lineCodes: page.lineCodes,
      lineFilterMode: page.lineFilterMode,
      accessScope: scope.accessScope,
      allWeeks: true,
      narrowRowsToCycleMonths: includeMonths,
      includeFactRows: true,
      // Unrounded rows: rounded one by one, they add up to a few pounds off the Weekly Sales headline beside
      // this tab. A rep's detail does not ask for them, because it must match his own page, which adds the
      // rounded rows.
      factRowsFullPrecision: true,
      // Owner rule for every weekly report and export: unmapped products never reach a total.
      excludeUnmapped: true,
      // Only the row grain lifts; the page's KPIs and option lists stay on his own scope. The grain is then
      // wider than he may see, and selectManagerDepotRows narrows it before a single figure is built.
      liftRowGrainGeography: liftGrain,
    }),
    loadWeeklyAreaNames(),
    loadWeeklySalesUploadCalendar(includeMonths),
    // The owner's depot-split rule, read only for a lifted load. Fails soft to null: he then keeps the
    // depots his own scope admits, and the screen says his figures read low.
    liftGrain ? loadWeeklyAreaSplitIndex().catch(() => null) : Promise.resolve(null),
  ]);

  const factRows = data.factRows ?? [];
  const geography =
    liftGrain && scope.accessScope.tier === "territory"
      ? weeklyFieldForceGeography(factRows, scope.accessScope, ownAreaKeys)
      : null;

  const period = {
    cycleMonths: page.cycleMonths,
    cycleMonthMode: page.cycleMonthMode,
    weekNumbers: page.weekNumbers,
    weekNumberMode: page.weekNumberMode,
  };
  const view = buildWeeklySalesDepotDetail({
    audience: "manager",
    rows: selectManagerDepotRows({ rows: factRows, geography, areaSplit }),
    areaNames,
    uploads,
    period,
    filters: request.local,
  });

  return {
    view,
    scope: {
      summary: buildDetailScopeSummary(scope.accessScope, ctx.role, scope.regionNames),
      periodLabel: weeklySalesPeriodLabel(period),
    },
    status: "ok",
    allocationUnavailable:
      geography !== null &&
      (areaSplit === null || (areaSplit.areasByLineRegion.size === 0 && areaSplit.areasByLineGovernorate.size === 0)),
  };
}
