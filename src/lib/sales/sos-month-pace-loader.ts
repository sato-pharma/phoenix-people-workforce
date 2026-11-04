// IO for the month-pace strip on the portal Source of Sales page. See sos-month-pace.ts for why this
// is weekly, approximate, and kept apart from every official number.
//
// Targets come from the achievement engine, bounded by the same rule Sales vs Target uses
// (resolveVsTargetBound — a medical rep sees only the rows attributed to him). Weekly value comes from
// the Weekly Sales field-force build for the month (getPortalWeeklyMonthFieldForce), which spreads depot
// rows to areas the way the Weekly Sales page does — with the viewer's region bound lifted and narrowed
// straight back to his own areas, so a depot row still labelled with a region the organogram has since
// split reaches him — and is then narrowed to the viewer's line, areas and products here. Like every
// weekly report, it leaves unmapped products out.
//
// Direct orders come from phx_monthly_closing_direct — the closing's own direct half, so an order
// counts in the month Finance books it, at its pharmacy's area. They are left out when the month's
// weekly upload itself carries a Direct channel (the sheets did up to July 2026), or they would count
// twice.
//
// Every area is NAMED from the Source of Sales area master (loadAreaNameMap), whichever of the three it
// arrives on. Only the weekly rows carry a name of their own, so an area with a target but no weekly row
// yet — early in a month, a stopped feed, a new area — was labelled with its code: on production on
// 16 Sept 2026 a rep read "UE5" where the area is Sohag1, and a district manager "UE8" for Qena 2. The
// master and not au_v_canonical_areas, because only the master also names Main Store.

import type { AccessContext } from "@/lib/auth/permissions";
import { currentCairoDateParts } from "@/lib/i18n/format";
import { loadAreaNameMap, type AchievementRow } from "@/lib/sales/monthly-targets";
import { daysInPeriod } from "@/lib/sales/periods";
import { salesLineCodeForOfficialLine } from "@/lib/sales/portal-targets";
import { buildMonthPace, type MonthPaceResult } from "@/lib/sales/sos-month-pace";
import { isSalesPeriodReleased, loadSalesReleaseKeys } from "@/lib/sales/unpublished-sales-access";
import { loadAchievementRange } from "@/lib/sales/vs-target";
import { filterRowsForBound, resolveVsTargetBound, type VsTargetBound } from "@/lib/sales/vs-target-scope";
import { getPortalWeeklyMonthFieldForce } from "@/lib/sales/weekly/portal-weekly-dashboard";
import type { FieldForceProduct, FieldForceRep } from "@/lib/sales/weekly/portal-weekly-field-force";
import { getSupabaseAdmin, rpcAll, toQueryError } from "@/lib/supabase/server";

export type ClosingDirectRow = { area_code: string | null; product_code: string | null; sales_value: number | string | null };

/** A weekly field-force row, narrowed to what the strip reads. */
export type MonthPaceWeeklyRep = Pick<FieldForceRep, "kind" | "areaCode" | "areaName" | "lineName" | "value" | "allocatedValue"> & {
  products: readonly Pick<FieldForceProduct, "productCode" | "value">[];
};

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

/**
 * Pure: narrow one loaded month to the viewer, name every area, and build the strip. Kept apart from
 * the IO so a test drives it from fixtures (tests/sos-month-pace-area-names.test.ts).
 */
export function buildPortalMonthPace(input: {
  period: string;
  dayOfMonth: number;
  lineCode: string;
  /** The viewer's area bound (rep / DM seat). null = no area narrowing beyond the bound below. */
  areaCodes: string[] | null;
  /** Product / Group Product Manager bound. null = the whole line. */
  productCodes: string[] | null;
  achievement: AchievementRow[];
  bound: VsTargetBound;
  weeklyReps: readonly MonthPaceWeeklyRep[];
  directRows: readonly ClosingDirectRow[];
  directInWeekly: boolean;
  /** area_code (upper) -> area name, from the Source of Sales area master. */
  areaNames: ReadonlyMap<string, string>;
}): MonthPaceResult {
  const { bound, lineCode } = input;
  const areaSet = input.areaCodes ? new Set(input.areaCodes.map((code) => code.toUpperCase())) : null;
  const productSet = input.productCodes ? new Set(input.productCodes.map((code) => code.toUpperCase())) : null;
  // loadAreaNameMap hands back the code itself for a blank master name; that is no name, so a weekly
  // row's own name still gets its turn.
  const areaNameOf = (code: string | null | undefined) => {
    const key = String(code ?? "").trim().toUpperCase();
    const name = input.areaNames.get(key)?.trim() ?? "";
    return name && name.toUpperCase() !== key ? name : null;
  };

  const targetRows = filterRowsForBound(input.achievement, bound).filter((row) => {
    if (row.lineCode !== lineCode || !row.hasTarget) return false;
    const area = String(row.areaCode ?? "").trim().toUpperCase();
    if (!area || (areaSet && !areaSet.has(area))) return false;
    return !productSet || productSet.has(row.productCode.toUpperCase());
  });
  const targetAreas = new Set(targetRows.map((row) => String(row.areaCode).trim().toUpperCase()));

  const weeklyRows = input.weeklyReps.filter((rep) => {
    if (rep.kind === "unattributed" || !rep.areaCode) return false;
    if (salesLineCodeForOfficialLine(rep.lineName) !== lineCode) return false;
    const area = rep.areaCode.trim().toUpperCase();
    // A rep with no explicit area bound is bounded by his own target rows; everyone else by the
    // weekly narrowing already applied upstream, plus their area bound when they have one.
    if (areaSet) return areaSet.has(area);
    if (bound.kind === "self") return targetAreas.has(area);
    return true;
  });
  const weeklyAreas = new Set(weeklyRows.map((rep) => String(rep.areaCode).trim().toUpperCase()));

  // The direct RPC reads the whole line, so it is always bounded here: the area bound when there is
  // one, otherwise the areas the viewer's own targets and weekly rows already reach.
  const direct = input.directRows.filter((row) => {
    const area = String(row.area_code ?? "").trim().toUpperCase();
    if (!area) return false;
    if (productSet && !productSet.has(String(row.product_code ?? "").trim().toUpperCase())) return false;
    if (areaSet) return areaSet.has(area);
    if (bound.kind === "self") return targetAreas.has(area);
    return targetAreas.has(area) || weeklyAreas.has(area);
  });

  return buildMonthPace({
    period: input.period,
    dayOfMonth: input.dayOfMonth,
    daysInMonth: daysInPeriod(input.period),
    targets: targetRows.map((row) => ({
      areaCode: String(row.areaCode),
      areaName: areaNameOf(row.areaCode),
      targetValue: row.targetValue ?? 0,
    })),
    weekly: weeklyRows.map((rep) => {
      // Product-scoped viewers: only their products' value, so it is measured against their products' target.
      const value = productSet
        ? rep.products.filter((product) => productSet.has(product.productCode.toUpperCase())).reduce((sum, product) => sum + product.value, 0)
        : rep.value;
      const allocatedShare = rep.value > 0 ? rep.allocatedValue / rep.value : 0;
      return {
        areaCode: rep.areaCode ?? "",
        areaName: areaNameOf(rep.areaCode) ?? rep.areaName,
        value,
        allocatedValue: value * allocatedShare,
      };
    }),
    direct: direct.map((row) => ({
      areaCode: String(row.area_code),
      areaName: areaNameOf(row.area_code),
      value: Number(row.sales_value) || 0,
    })),
    directInWeekly: input.directInWeekly,
  });
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

  // A failed direct read fails the strip (the route hides it) rather than showing areas behind that are
  // not, and a failed area-name read fails it rather than labelling areas with their codes.
  //
  // The weekly half is his carve-out and stays. The booked direct orders are the closing's own direct
  // half, so they wait for the month's closing like any other sale (owner, 2026-11-04); a running month
  // is not published, so the strip is weekly-only until then.
  const publishedKeys = await loadSalesReleaseKeys();
  const directReleased = isSalesPeriodReleased(period, lineCode, publishedKeys);
  const [achievement, bound, weekly, directRows, directInWeekly, areaNames] = await Promise.all([
    // The month through the achievement engine's token-keyed per-month cache (PERF-010, 2026-10-04)
    // rather than a raw phx_monthly_achievement call on every render. Same function underneath —
    // both RPCs return au.f_monthly_achievement(period) — and the rows the cached loader drops (no
    // sales line) never passed the line check in buildPortalMonthPace anyway.
    loadAchievementRange(period, period),
    resolveVsTargetBound(input.access),
    getPortalWeeklyMonthFieldForce(input.access, `${period}-01`).catch(() => null),
    directReleased
      ? rpcAll<ClosingDirectRow>(getSupabaseAdmin(), "phx_monthly_closing_direct", { p_line: input.line, p_period: period }, [
          "region_code",
          "area_code",
          "product_code",
        ])
      : [],
    weeklyUploadCarriesDirect(period, input.line),
    loadAreaNameMap(),
  ]);

  return buildPortalMonthPace({
    period,
    dayOfMonth: day,
    lineCode,
    areaCodes: input.areaCodes,
    productCodes: input.productCodes,
    achievement,
    bound,
    weeklyReps: weekly?.reps ?? [],
    directRows,
    directInWeekly,
    areaNames,
  });
}
