// Weekly Sales — Depot Detail: the managers' loader (portal DM, RM, NSM, PM, GPM, MM, plus CEO and
// Super Admin on the same component), shared by the feed and the export so the download is the screen.
//
// Scope resolves from the SESSION through resolvePortalWeeklyScope, exactly as the portal Weekly Sales
// dashboard's own tabs do, and is enforced inside loadWeeklyDashboard. Query params only narrow inside
// what the viewer may already see.
//
// Every weekly report sets excludeUnmapped (owner rule), so a product the Product Master has not mapped
// to a line never reaches these totals. The screen and the workbook both say so.

import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import type { WeeklyAccessScope } from "@/lib/sales/weekly/access";
import { resolvePortalWeeklyScope, type PortalWeeklyFilters } from "@/lib/sales/weekly/portal-weekly-dashboard";
import {
  buildWeeklySalesDepotDetail,
  weeklySalesPeriodLabel,
  type WeeklySalesDepotDetailPayload,
  type WeeklySalesDetailFilters,
  type WeeklySalesDetailSourceRow,
  type WeeklySalesDetailUpload,
} from "@/lib/sales/weekly/sales-depot-detail";
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

/** The workbook's scope line, in names — the same wording Weekly Stock uses. */
function buildDetailScopeSummary(
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
      if (!scope.allowedRegionCodes) parts.push("all regions");
      else if (scope.allowedRegionCodes.size === 1) {
        const code = [...scope.allowedRegionCodes][0];
        parts.push(regionNames.get(code) ?? "1 region");
      } else parts.push(`${scope.allowedRegionCodes.size} regions`);
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

  const [data, areaNames, uploads] = await Promise.all([
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
      // Owner rule for every weekly report and export: unmapped products never reach a total.
      excludeUnmapped: true,
    }),
    loadWeeklyAreaNames(),
    loadWeeklySalesUploadCalendar(includeMonths),
  ]);

  const period = {
    cycleMonths: page.cycleMonths,
    cycleMonthMode: page.cycleMonthMode,
    weekNumbers: page.weekNumbers,
    weekNumberMode: page.weekNumberMode,
  };
  const view = buildWeeklySalesDepotDetail({
    audience: "manager",
    rows: wholeDepotRows(data.factRows ?? []),
    areaNames,
    uploads,
    period,
    filters: request.local,
  });
  const regionNames = new Map(data.availableRegions.map((region) => [region.code.toUpperCase(), region.name]));

  return {
    view,
    scope: {
      summary: buildDetailScopeSummary(scope.accessScope, ctx.role, regionNames),
      periodLabel: weeklySalesPeriodLabel(period),
    },
    status: "ok",
    allocationUnavailable: false,
  };
}
