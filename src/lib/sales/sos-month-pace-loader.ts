// IO for the month-pace strip on the portal Source of Sales page. See sos-month-pace.ts for why this
// is weekly, approximate, and kept apart from every official number.
//
// Targets come from the achievement engine, bounded by the same rule Sales vs Target uses
// (resolveVsTargetBound — a medical rep sees only the rows attributed to him). Weekly value comes from
// the Weekly Sales field-force build, which already spreads depot rows to areas the way the Weekly
// Sales page does, and is then narrowed to the viewer's line, areas and products here.
//
// Direct orders come from phx_monthly_closing_direct — the closing's own direct half, so an order
// counts in the month Finance books it, at its pharmacy's area. They are left out when the month's
// weekly upload itself carries a Direct channel (the sheets did up to July 2026), or they would count
// twice.

import type { AccessContext } from "@/lib/auth/permissions";
import { currentCairoDateParts } from "@/lib/i18n/format";
import { loadMonthlyAchievement } from "@/lib/sales/monthly-targets";
import { daysInPeriod } from "@/lib/sales/periods";
import { salesLineCodeForOfficialLine } from "@/lib/sales/portal-targets";
import { buildMonthPace, type MonthPaceResult } from "@/lib/sales/sos-month-pace";
import { filterRowsForBound, resolveVsTargetBound } from "@/lib/sales/vs-target-scope";
import { getPortalWeeklyDashboard } from "@/lib/sales/weekly/portal-weekly-dashboard";
import { getSupabaseAdmin, rpcAll, toQueryError } from "@/lib/supabase/server";

type ClosingDirectRow = { area_code: string | null; product_code: string | null; sales_value: number | string | null };

async function weeklyUploadCarriesDirect(period: string, line: string): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin()
    .from("weekly_sales_rows")
    .select("id")
    .eq("cycle_month", `${period}-01`)
    .eq("official_line", line)
    .ilike("distributor_code", "direct")
    .limit(1);
  if (error) throw toQueryError(error);
  return (data ?? []).length > 0;
}

export async function loadPortalMonthPace(input: {
  access: AccessContext;
  line: string;
  /** The viewer's area bound (rep / DM seat). null = no area narrowing beyond the scopes below. */
  areaCodes: string[] | null;
  /** Product / Group Product Manager bound. null = the whole line. */
  productCodes: string[] | null;
}): Promise<MonthPaceResult | null> {
  const lineCode = salesLineCodeForOfficialLine(input.line);
  if (!lineCode) return null;

  const { year, month, day } = currentCairoDateParts();
  const period = `${year}-${String(month).padStart(2, "0")}`;
  const areaSet = input.areaCodes ? new Set(input.areaCodes.map((code) => code.toUpperCase())) : null;
  const productSet = input.productCodes ? new Set(input.productCodes.map((code) => code.toUpperCase())) : null;

  // A failed direct read fails the strip (the route hides it) rather than showing areas behind that are not.
  const [achievement, bound, weekly, directRows, directInWeekly] = await Promise.all([
    loadMonthlyAchievement(period),
    resolveVsTargetBound(input.access),
    getPortalWeeklyDashboard(
      { cycleMonths: [`${period}-01`], cycleMonthMode: "include" },
      input.access,
      { includeFieldForce: true },
    ).catch(() => null),
    rpcAll<ClosingDirectRow>(getSupabaseAdmin(), "phx_monthly_closing_direct", { p_line: input.line, p_period: period }, [
      "region_code",
      "area_code",
      "product_code",
    ]),
    weeklyUploadCarriesDirect(period, input.line),
  ]);

  const targetRows = filterRowsForBound(achievement, bound).filter((row) => {
    if (row.lineCode !== lineCode || !row.hasTarget) return false;
    const area = String(row.areaCode ?? "").trim().toUpperCase();
    if (!area || (areaSet && !areaSet.has(area))) return false;
    return !productSet || productSet.has(row.productCode.toUpperCase());
  });
  const targetAreas = new Set(targetRows.map((row) => String(row.areaCode).trim().toUpperCase()));

  const weeklyRows = (weekly?.fieldForce?.reps ?? []).filter((rep) => {
    if (rep.kind === "unattributed" || !rep.areaCode) return false;
    if (salesLineCodeForOfficialLine(rep.lineName) !== lineCode) return false;
    const area = rep.areaCode.trim().toUpperCase();
    // A rep with no explicit area bound is bounded by his own target rows; everyone else by the
    // weekly scope already applied upstream, plus their area bound when they have one.
    if (areaSet) return areaSet.has(area);
    if (bound.kind === "self") return targetAreas.has(area);
    return true;
  });
  const weeklyAreas = new Set(weeklyRows.map((rep) => String(rep.areaCode).trim().toUpperCase()));

  // The direct RPC reads the whole line, so it is always bounded here: the area bound when there is
  // one, otherwise the areas the viewer's own targets and weekly rows already reach.
  const direct = directRows.filter((row) => {
    const area = String(row.area_code ?? "").trim().toUpperCase();
    if (!area) return false;
    if (productSet && !productSet.has(String(row.product_code ?? "").trim().toUpperCase())) return false;
    if (areaSet) return areaSet.has(area);
    if (bound.kind === "self") return targetAreas.has(area);
    return targetAreas.has(area) || weeklyAreas.has(area);
  });

  return buildMonthPace({
    period,
    dayOfMonth: day,
    daysInMonth: daysInPeriod(period),
    targets: targetRows.map((row) => ({ areaCode: String(row.areaCode), targetValue: row.targetValue ?? 0 })),
    weekly: weeklyRows.map((rep) => {
      // Product-scoped viewers: only their products' value, so it is measured against their products' target.
      const value = productSet
        ? rep.products.filter((product) => productSet.has(product.productCode.toUpperCase())).reduce((sum, product) => sum + product.value, 0)
        : rep.value;
      const allocatedShare = rep.value > 0 ? rep.allocatedValue / rep.value : 0;
      return { areaCode: rep.areaCode ?? "", areaName: rep.areaName, value, allocatedValue: value * allocatedShare };
    }),
    direct: direct.map((row) => ({ areaCode: String(row.area_code), value: Number(row.sales_value) || 0 })),
    directInWeekly,
  });
}
