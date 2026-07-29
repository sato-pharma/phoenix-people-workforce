// Analytics service — server-side data fetching for the three sales pipelines.
// All queries go through getSupabaseAdmin (service role) matching the existing
// Phoenix pattern. Access control is enforced at the page/API route layer.

import { unstable_cache } from "next/cache.js";

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { canViewHeadOfficeLine, canViewRestrictedProducts, isHeadOfficeLine, stripHeadOfficeRows } from "@/lib/sales/access-scope";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { shiftPeriod } from "@/lib/analytics/compare";
import type { PhoenixRole } from "@/lib/auth/permissions";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AnalyticsPeriod = {
  period: string;
  year: number;
  month: number;
  periodLabel: string;
};

export type AnalyticsWeek = {
  weekStart: string;
  year: number;
  month: number;
  isoWeek: number;
  weekLabel: string;
};

export type AnalyticsDimensions = {
  periods: AnalyticsPeriod[];
  weeks: AnalyticsWeek[];
  distributors: { code: string; name: string }[];
  lines: string[];
  families: string[];
  regions: { code: string; name: string }[];
  areas: { areaCode: string; areaName: string; regionCode: string; regionName: string }[];
  products: { code: string; name: string; line: string; family: string }[];
};

export type SosKpiRow = {
  period: string;
  year: number;
  month: number;
  channel: string;
  units: number;
  bonusUnits: number;
  value: number;
};

export type SosByAreaRow = {
  period: string;
  regionCode: string;
  regionName: string;
  areaCode: string;
  areaName: string;
  channel: string;
  units: number;
  value: number;
};

export type SosByProductRow = {
  period: string;
  productCode: string;
  productName: string;
  family: string;
  familyCode: string;
  line: string;
  channel: string;
  units: number;
  value: number;
};

export type SosByCustomerRow = {
  period: string;
  year: number;
  month: number;
  clientCode: string;
  /** Customer name resolved from the customer directory; falls back to clientCode. */
  customerName: string;
  line: string;
  regionCode: string;
  regionName: string;
  activeBatches: number;
};

export type ClosingByEmployeeRow = {
  period: string;
  line: string;
  employeeHrId: string | null;
  employeeName: string | null;
  managerHrId: string | null;
  /** Manager name resolved from the employee directory; falls back to managerHrId. */
  managerName: string | null;
  territory: string | null;
  salesValue: number;
  targetValue: number;
  salesUnits: number;
  targetUnits: number;
  achievementPct: number | null;
};

export type WeeklyFactRow = {
  weekStart: string;
  weekLabel: string;
  period: string;
  distributorCode: string;
  distributorName: string;
  regionCode: string;
  regionName: string;
  productCode: string;
  productName: string;
  line: string;
  family: string;
  salesQty: number;
  salesValue: number;
  stockQty: number;
};

export type CrossSourceRow = {
  period: string;
  line: string;
  sosValue: number | null;
  sosUnits: number | null;
  closingValue: number | null;
  closingUnits: number | null;
  targetValue: number | null;
  weeklyValue: number | null;
  weeklyUnits: number | null;
  closingAchievementPct: number | null;
  closingVsSosGapPct: number | null;
};

// ── Dimension loaders ─────────────────────────────────────────────────────────

export async function loadAnalyticsDimensions(role: PhoenixRole): Promise<AnalyticsDimensions> {
  const db = getSupabaseAdmin();
  const analytics = db.schema("analytics");
  const includeRestricted = canViewRestrictedProducts(role);
  const productDimensionView = includeRestricted ? "dim_products_all" : "dim_products";

  const [periods, weeks, distributors, areas, products] = await Promise.all([
    analytics.from("dim_periods" as never).select("period,year,month,period_label").order("period", { ascending: false }).limit(36),
    analytics.from("dim_weeks" as never).select("week_start,year,month,iso_week,week_label").order("week_start", { ascending: false }).limit(52),
    analytics.from("dim_distributors" as never).select("distributor_code,distributor_name").order("distributor_name"),
    analytics.from("dim_areas" as never).select("area_code,area_name,region_code,region_name").order("region_name"),
    analytics.from(productDimensionView as never).select("product_code,product_name,line,family").order("product_name"),
  ] as const);

  // Extract distinct lines and families from products. Head Office is confidential (same lock
  // class as the restricted codes above — see canViewHeadOfficeLine's docstring): strip it from
  // the dimension lists too, not just the aggregated rows, so a non-CEO/Super-Admin viewer's
  // filter dropdowns never offer it as a selectable Line/Product/Family in the first place. Belt
  // and braces alongside the dim_products view's own WHERE-clause exclusion (defense in depth,
  // matching this file's existing stripHeadOfficeRows-on-every-row-loader pattern).
  const canViewHeadOffice = canViewHeadOfficeLine(role);
  const allProductRows = (products.data ?? []) as { product_code: string; product_name: string; line: string; family: string }[];
  const productRows = canViewHeadOffice ? allProductRows : allProductRows.filter((p) => !isHeadOfficeLine(p.line));
  const lines = [...new Set(productRows.map((p) => p.line).filter(Boolean))].sort();
  const families = [...new Set(productRows.map((p) => p.family).filter(Boolean))].sort();
  const areaRows = (areas.data ?? []) as { area_code: string; area_name: string; region_code: string; region_name: string }[];
  const regions = [...new Map(areaRows.map((a) => [a.region_code, { code: a.region_code, name: a.region_name }])).values()];

  return {
    periods: ((periods.data ?? []) as { period: string; year: number; month: number; period_label: string }[]).map((r) => ({
      period: r.period,
      year: r.year,
      month: r.month,
      periodLabel: r.period_label,
    })),
    weeks: ((weeks.data ?? []) as { week_start: string; year: number; month: number; iso_week: number; week_label: string }[]).map((r) => ({
      weekStart: r.week_start,
      year: r.year,
      month: r.month,
      isoWeek: r.iso_week,
      weekLabel: r.week_label,
    })),
    distributors: ((distributors.data ?? []) as { distributor_code: string; distributor_name: string }[]).map((r) => ({
      code: r.distributor_code,
      name: r.distributor_name,
    })),
    lines,
    families,
    regions,
    areas: areaRows.map((a) => ({
      areaCode: a.area_code,
      areaName: a.area_name,
      regionCode: a.region_code,
      regionName: a.region_name,
    })),
    products: productRows.map((p) => ({
      code: p.product_code,
      name: p.product_name,
      line: p.line,
      family: p.family,
    })),
  };
}

// ── SoS loaders ───────────────────────────────────────────────────────────────

export type SosFilters = {
  period?: string[];
  periodFrom?: string | null;
  periodTo?: string | null;
  distributors?: string[];
  lines?: string[];
  regions?: string[];
  areas?: string[];
  products?: string[];
  families?: string[];
  channel?: string[];
  clientCodes?: string[];
  /** Head Office line confidential lock — pass canViewHeadOfficeLine(role). Absent ⇒ strip (fail-closed). */
  canViewHeadOffice?: boolean;
};

export type SosByLineRow = {
  period: string;
  year: number;
  month: number;
  line: string;
  channel: string;
  units: number;
  value: number;
};

async function loadSosByLineUncached(filters: SosFilters): Promise<SosByLineRow[]> {
  const db = getSupabaseAdmin();
  const { data, error } = await db.rpc("analytics_sos_by_line" as never, {
    p_periods:     filters.period?.length      ? filters.period      : null,
    p_period_from: filters.periodFrom  ?? null,
    p_period_to:   filters.periodTo    ?? null,
    p_channels:    filters.channel?.length     ? filters.channel     : null,
    p_lines:       filters.lines?.length       ? filters.lines       : null,
    p_distributors: filters.distributors?.length ? filters.distributors : null,
    p_regions:     filters.regions?.length     ? filters.regions     : null,
    p_areas:       filters.areas?.length       ? filters.areas       : null,
    p_products:    filters.products?.length    ? filters.products    : null,
    p_families:    filters.families?.length    ? filters.families    : null,
    p_client_codes: filters.clientCodes?.length ? filters.clientCodes : null,
  } as never);
  if (error) throw new Error(`SoS by line: ${error.message}`);
  const rows = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    period:  s(r.period),
    year:    n(r.year),
    month:   n(r.month),
    line:    s(r.line),
    channel: s(r.channel),
    units:   n(r.units),
    value:   n(r.value),
  }));
  return stripHeadOfficeRows(rows, (r) => r.line, !filters.canViewHeadOffice);
}

async function loadSosByPeriodUncached(filters: SosFilters): Promise<SosKpiRow[]> {
  const db = getSupabaseAdmin();
  // Query the analytics view via raw SQL through RPC or direct admin select.
  // We use .from() with schema qualifier via rpc pattern. Since analytics schema
  // tables are views (not public), we use a raw select via the admin client's
  // postgrest schema override. Supabase JS client defaults to public schema;
  // we call a helper SQL function instead.
  const { data, error } = await db.rpc("analytics_sos_by_period" as never, {
    p_periods:     filters.period?.length      ? filters.period      : null,
    p_period_from: filters.periodFrom  ?? null,
    p_period_to:   filters.periodTo    ?? null,
    p_channels:    filters.channel?.length     ? filters.channel     : null,
    p_lines:       filters.lines?.length       ? filters.lines       : null,
    p_distributors: filters.distributors?.length ? filters.distributors : null,
    p_regions:     filters.regions?.length     ? filters.regions     : null,
    p_areas:       filters.areas?.length       ? filters.areas       : null,
    p_products:    filters.products?.length    ? filters.products    : null,
    p_families:    filters.families?.length    ? filters.families    : null,
    p_client_codes: filters.clientCodes?.length ? filters.clientCodes : null,
    // Head Office is line-aggregated away here, so it can't be stripped in TS afterward —
    // exclude it inside the RPC. Fail-closed: absent canViewHeadOffice ⇒ exclude.
    p_exclude_head_office: !filters.canViewHeadOffice,
  } as never);
  if (error) throw new Error(`SoS by period: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map(mapSosKpiRow);
}

async function loadSosByAreaUncached(filters: SosFilters): Promise<SosByAreaRow[]> {
  const db = getSupabaseAdmin();
  const { data, error } = await db.rpc("analytics_sos_by_area" as never, {
    p_periods:     filters.period?.length      ? filters.period      : null,
    p_period_from: filters.periodFrom  ?? null,
    p_period_to:   filters.periodTo    ?? null,
    p_channels:    filters.channel?.length     ? filters.channel     : null,
    p_lines:       filters.lines?.length       ? filters.lines       : null,
    p_distributors: filters.distributors?.length ? filters.distributors : null,
    p_regions:     filters.regions?.length     ? filters.regions     : null,
    p_areas:       filters.areas?.length       ? filters.areas       : null,
    p_products:    filters.products?.length    ? filters.products    : null,
    p_families:    filters.families?.length    ? filters.families    : null,
    p_client_codes: filters.clientCodes?.length ? filters.clientCodes : null,
    // Head Office is line-aggregated away here, so it can't be stripped in TS afterward —
    // exclude it inside the RPC. Fail-closed: absent canViewHeadOffice ⇒ exclude.
    p_exclude_head_office: !filters.canViewHeadOffice,
  } as never);
  if (error) throw new Error(`SoS by area: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map(mapSosAreaRow);
}

async function loadSosByProductUncached(filters: SosFilters): Promise<SosByProductRow[]> {
  const db = getSupabaseAdmin();
  const { data, error } = await db.rpc("analytics_sos_by_product" as never, {
    p_periods:     filters.period?.length      ? filters.period      : null,
    p_period_from: filters.periodFrom  ?? null,
    p_period_to:   filters.periodTo    ?? null,
    p_channels:    filters.channel?.length     ? filters.channel     : null,
    p_lines:       filters.lines?.length       ? filters.lines       : null,
    p_distributors: filters.distributors?.length ? filters.distributors : null,
    p_regions:     filters.regions?.length     ? filters.regions     : null,
    p_areas:       filters.areas?.length       ? filters.areas       : null,
    p_products:    filters.products?.length    ? filters.products    : null,
    p_families:    filters.families?.length    ? filters.families    : null,
    p_client_codes: filters.clientCodes?.length ? filters.clientCodes : null,
  } as never);
  if (error) throw new Error(`SoS by product: ${error.message}`);
  const rows = ((data ?? []) as Record<string, unknown>[]).map(mapSosProductRow);
  return stripHeadOfficeRows(rows, (r) => r.line, !filters.canViewHeadOffice);
}

async function loadSosByCustomerUncached(filters: SosFilters): Promise<SosByCustomerRow[]> {
  const db = getSupabaseAdmin();
  const { data, error } = await db.rpc("analytics_sos_by_customer" as never, {
    p_periods:      filters.period?.length      ? filters.period      : null,
    p_period_from:  filters.periodFrom  ?? null,
    p_period_to:    filters.periodTo    ?? null,
    p_lines:        filters.lines?.length       ? filters.lines       : null,
    p_regions:      filters.regions?.length     ? filters.regions     : null,
    p_client_codes: filters.clientCodes?.length ? filters.clientCodes : null,
  } as never);
  if (error) throw new Error(`SoS by customer: ${error.message}`);
  const rows = ((data ?? []) as Record<string, unknown>[]).map(mapSosCustomerRow);
  const scoped = stripHeadOfficeRows(rows, (r) => r.line, !filters.canViewHeadOffice);
  return resolveCustomerNames(scoped);
}

// ── Monthly closing loaders ───────────────────────────────────────────────────

export type ClosingFilters = {
  period?: string[];
  periodFrom?: string | null;
  periodTo?: string | null;
  lines?: string[];
  products?: string[];
  families?: string[];
  employeeHrId?: string | null;
  territory?: string | null;
  /** Head Office line confidential lock — pass canViewHeadOfficeLine(role). Absent ⇒ strip (fail-closed). */
  canViewHeadOffice?: boolean;
};

// ── Rep-level achievement (Source of Sales + the seat-model Targets engine) ────
//
// Was: analytics_closing_by_employee -> analytics.closing_fact_all_statuses, a view over the
// LEGACY "Sales Queue" tables (public.sales_records / sales_import_batches) — a manual,
// hand-uploaded pipeline, last touched 2026-07-17, never populated for most of the company.
// Retired from this loader (owner decision, 2026-07-29): every dashboard reading
// loadClosingByEmployee now gets rep-level achievement computed live from Source of Sales
// actuals against the seat-model Targets engine (src/lib/sales/monthly-targets.ts, PR #1140,
// live since 2026-07-18) via public.phx_monthly_achievement, which wraps
// au.f_monthly_achievement = au.f_monthly_attribution (SoS actuals, seat-resolved "as of"
// period end) joined to au.monthly_targets. Confidential products (LA003/LA004/SS001) are
// excluded inside au.f_monthly_attribution itself — not just here — so there is no
// per-caller path that can leak them.
//
// Per the owner: targets are only entered from 2026-07 onward. Earlier periods still return
// real SoS sales figures (actualValue/actualUnits) with target/achievement left null — never
// a fabricated 0% — exactly like the CASE-based null the RPC itself already returns when a
// (line, area, product) key has no target row.
//
// au.f_monthly_achievement takes ONE period at a time (it's a seat-occupancy snapshot "as of"
// that period's end, not a range query) — resolveRepAchievementPeriods below turns whatever
// period/periodFrom/periodTo the caller passed into a small, capped list of periods to fetch
// and merge, defaulting to the current calendar month when the caller specified neither.

/** Fixed, owner-locked 3-line model — mirrors LINE_ALIASES in monthly-targets.ts. */
const REP_ACHIEVEMENT_LINE_DISPLAY: Record<string, string> = {
  anti_infective: "Anti Infective",
  cns: "CNS",
  pedia: "Pedia",
};

const REP_ACHIEVEMENT_LINE_CODE_BY_DISPLAY = new Map(
  Object.entries(REP_ACHIEVEMENT_LINE_DISPLAY).map(([code, display]) => [display.toLowerCase(), code]),
);

// Hard cap on how many distinct periods a single request will fetch — each one is a full
// attribution-engine pass. 12 covers any single-year range a filter could reasonably ask for;
// an explicit request for more silently truncates rather than fanning out unboundedly.
const MAX_REP_ACHIEVEMENT_PERIODS = 12;

function currentCalendarPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Pure — unit-tested directly. */
export function resolveRepAchievementPeriods(filters: Pick<ClosingFilters, "period" | "periodFrom" | "periodTo">): string[] {
  if (filters.period?.length) {
    return [...new Set(filters.period)].slice(0, MAX_REP_ACHIEVEMENT_PERIODS);
  }
  if (filters.periodFrom || filters.periodTo) {
    const from = filters.periodFrom ?? filters.periodTo!;
    const to = filters.periodTo ?? filters.periodFrom!;
    const periods: string[] = [];
    let cursor = from;
    // from > to (a reversed range) would loop forever without this guard on top of the count cap.
    for (let i = 0; i < MAX_REP_ACHIEVEMENT_PERIODS && cursor <= to; i += 1) {
      periods.push(cursor);
      cursor = shiftPeriod(cursor, -1);
    }
    return periods;
  }
  return [currentCalendarPeriod()];
}

type RawAchievementRow = {
  period: string;
  line_code: string;
  area_code: string | null;
  rep_hr_id: string | null;
  dm_hr_id: string | null;
  product_code: string;
  actual_units: unknown;
  actual_value: unknown;
  target_units: unknown;
  target_value: unknown;
};

async function fetchMonthlyAchievement(db: ReturnType<typeof getSupabaseAdmin>, period: string): Promise<RawAchievementRow[]> {
  const { data, error } = await db.rpc("phx_monthly_achievement" as never, { p_period: period } as never);
  if (error) throw new Error(`Monthly achievement (${period}): ${error.message}`);
  return (data ?? []) as unknown as RawAchievementRow[];
}

type AreaNameLookup = { areaName: string; regionName: string };

async function loadAreaNameLookup(db: ReturnType<typeof getSupabaseAdmin>): Promise<Map<string, AreaNameLookup>> {
  const { data } = await db.schema("analytics").from("dim_areas" as never).select("area_code,area_name,region_name");
  const rows = (data ?? []) as { area_code: string; area_name: string; region_name: string }[];
  return new Map(rows.map((r) => [r.area_code, { areaName: r.area_name, regionName: r.region_name }]));
}

type ProductFamilyLookup = { family: string; productName: string };

async function loadProductFamilyLookup(db: ReturnType<typeof getSupabaseAdmin>): Promise<Map<string, ProductFamilyLookup>> {
  const { data } = await db.schema("analytics").from("dim_products_all" as never).select("product_code,product_name,family");
  const rows = (data ?? []) as { product_code: string; product_name: string; family: string }[];
  return new Map(rows.map((r) => [r.product_code, { family: r.family, productName: r.product_name }]));
}

type RepAggBucket = {
  period: string;
  lineCode: string;
  repHrId: string;
  dmHrId: string | null;
  areaCode: string | null;
  salesValue: number;
  targetValue: number;
  salesUnits: number;
  targetUnits: number;
  hasTarget: boolean;
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

async function loadClosingByEmployeeUncached(filters: ClosingFilters): Promise<ClosingByEmployeeRow[]> {
  const db = getSupabaseAdmin();
  const periods = resolveRepAchievementPeriods(filters);
  const [perPeriod, areaNames, productFamilies] = await Promise.all([
    Promise.all(periods.map((period) => fetchMonthlyAchievement(db, period))),
    loadAreaNameLookup(db),
    loadProductFamilyLookup(db),
  ]);
  const raw = perPeriod.flat();

  const wantedLineCodes = filters.lines?.length
    ? new Set(filters.lines.map((l) => REP_ACHIEVEMENT_LINE_CODE_BY_DISPLAY.get(l.trim().toLowerCase())).filter((v): v is string => Boolean(v)))
    : null;
  const wantedProducts = filters.products?.length ? new Set(filters.products.map((p) => p.trim().toUpperCase())) : null;
  const wantedFamilies = filters.families?.length ? new Set(filters.families.map((f) => f.trim().toLowerCase())) : null;

  // Filter at raw (period, line, area, product) grain — product/family only make sense before
  // rows are summed into a per-rep total.
  const filtered = raw.filter((r) => {
    if (wantedLineCodes && !wantedLineCodes.has(r.line_code)) return false;
    if (wantedProducts && !wantedProducts.has(r.product_code.trim().toUpperCase())) return false;
    if (wantedFamilies) {
      const family = productFamilies.get(r.product_code)?.family ?? "";
      if (!wantedFamilies.has(family.trim().toLowerCase())) return false;
    }
    return true;
  });

  // Aggregate to (period, line, rep) — the grain ClosingByEmployeeRow reports at. Rows with no
  // rep_hr_id (Branch B2/C in au.f_monthly_attribution: direct sales with no area, or genuinely
  // unmapped) carry nothing to attribute to an employee and are dropped here; their value still
  // reaches the area/region-level SoS dashboards (Overview/By Line) through the sos_* loaders.
  const buckets = new Map<string, RepAggBucket>();
  for (const r of filtered) {
    if (!r.rep_hr_id) continue;
    const key = `${r.period} ${r.line_code} ${r.rep_hr_id}`;
    const bucket = buckets.get(key) ?? {
      areaCode: r.area_code,
      dmHrId: r.dm_hr_id,
      hasTarget: false,
      lineCode: r.line_code,
      period: r.period,
      repHrId: r.rep_hr_id,
      salesUnits: 0,
      salesValue: 0,
      targetUnits: 0,
      targetValue: 0,
    };
    bucket.salesValue += n(r.actual_value);
    bucket.salesUnits += n(r.actual_units);
    if (r.target_value != null) {
      bucket.targetValue += n(r.target_value);
      bucket.hasTarget = true;
    }
    if (r.target_units != null) bucket.targetUnits += n(r.target_units);
    buckets.set(key, bucket);
  }

  const directory = await getEmployeeDirectory().catch(() => null);
  const nameByHrId = directory
    ? new Map(directory.employees.map((e) => [e.hrId.trim().toUpperCase(), e.displayName]))
    : null;

  let rows: ClosingByEmployeeRow[] = [...buckets.values()]
    .filter((b) => !filters.employeeHrId || b.repHrId.trim().toUpperCase() === filters.employeeHrId.trim().toUpperCase())
    .map((b) => {
      const area = b.areaCode ? areaNames.get(b.areaCode) : null;
      return {
        achievementPct: b.hasTarget && b.targetValue > 0 ? round2((b.salesValue / b.targetValue) * 100) : null,
        employeeHrId: b.repHrId,
        employeeName: nameByHrId ? (nameByHrId.get(b.repHrId.trim().toUpperCase()) ?? UNKNOWN_NAME) : UNKNOWN_NAME,
        line: REP_ACHIEVEMENT_LINE_DISPLAY[b.lineCode] ?? b.lineCode,
        managerHrId: b.dmHrId,
        managerName: b.dmHrId, // placeholder only; overwritten (name or UNKNOWN_NAME) by resolveManagerNames()
        period: b.period,
        salesUnits: round2(b.salesUnits),
        salesValue: round2(b.salesValue),
        targetUnits: round2(b.targetUnits),
        targetValue: round2(b.targetValue),
        // "Territory" has no direct equivalent on the seat model — the seat's area name is the
        // closest match (the geographic patch the rep is attributed to) and keeps the field
        // populated for the existing search/sort UI rather than leaving it blank.
        territory: area?.areaName ?? null,
      };
    });

  if (filters.territory) {
    const needle = filters.territory.trim().toLowerCase();
    rows = rows.filter((r) => (r.territory ?? "").toLowerCase().includes(needle));
  }

  const scoped = stripHeadOfficeRows(rows, (r) => r.line, !filters.canViewHeadOffice);
  return resolveManagerNames(scoped);
}

// ── Weekly loaders ────────────────────────────────────────────────────────────

export type WeeklyFilters = {
  weekStart?: string[];
  year?: number[];
  distributors?: string[];
  lines?: string[];
  regions?: string[];
  products?: string[];
  families?: string[];
  /** Head Office line confidential lock — pass canViewHeadOfficeLine(role). Absent ⇒ strip (fail-closed). */
  canViewHeadOffice?: boolean;
};

async function loadWeeklyFactUncached(filters: WeeklyFilters): Promise<WeeklyFactRow[]> {
  const db = getSupabaseAdmin();
  const { data, error } = await db.rpc("analytics_weekly_fact" as never, {
    p_week_starts:  filters.weekStart?.length ? filters.weekStart : null,
    p_years:        filters.year?.length      ? filters.year      : null,
    p_distributors: filters.distributors?.length ? filters.distributors : null,
    p_lines:        filters.lines?.length        ? filters.lines        : null,
    p_regions:      filters.regions?.length      ? filters.regions      : null,
    p_products:     filters.products?.length     ? filters.products     : null,
    p_families:     filters.families?.length     ? filters.families     : null,
  } as never);
  if (error) throw new Error(`Weekly fact: ${error.message}`);
  const rows = ((data ?? []) as Record<string, unknown>[]).map(mapWeeklyRow);
  return stripHeadOfficeRows(rows, (r) => r.line, !filters.canViewHeadOffice);
}

// ── Cross-source comparison loader ────────────────────────────────────────────

type CrossSourceFilters = { periodFrom?: string | null; periodTo?: string | null; lines?: string[]; canViewHeadOffice?: boolean };
async function loadCrossSourceUncached(filters: CrossSourceFilters): Promise<CrossSourceRow[]> {
  const db = getSupabaseAdmin();
  const { data, error } = await db.rpc("analytics_cross_source" as never, {
    p_period_from: filters.periodFrom ?? null,
    p_period_to:   filters.periodTo   ?? null,
    p_lines:       filters.lines?.length ? filters.lines : null,
  } as never);
  if (error) throw new Error(`Cross-source: ${error.message}`);
  const rows = ((data ?? []) as Record<string, unknown>[]).map(mapCrossSourceRow);
  return stripHeadOfficeRows(rows, (r) => r.line, !filters.canViewHeadOffice);
}

// ── Display-name enrichment ─────────────────────────────────────────────────────
// The analytics_* RPCs return manager HR IDs and customer client codes. Phoenix shows people and
// customers BY NAME — never by code — so resolve those to names here. On any lookup failure or
// unresolved match, fall back to the UNKNOWN_NAME placeholder rather than the raw HR ID / client
// code, so a directory outage or missing rollup entry can never leak a bare code into a name column.

const UNKNOWN_NAME = "Unknown";

async function resolveManagerNames(rows: ClosingByEmployeeRow[]): Promise<ClosingByEmployeeRow[]> {
  const ids = [...new Set(rows.map((r) => r.managerHrId).filter((v): v is string => Boolean(v)))];
  if (ids.length === 0) return rows;
  let nameByKey: Map<string, string>;
  try {
    const directory = await getEmployeeDirectory();
    // displayName is nickname-aware (the canonical live-UI name); key by a normalized HR ID.
    nameByKey = new Map(directory.employees.map((e) => [e.hrId.trim().toUpperCase(), e.displayName]));
  } catch {
    // directory unavailable → never fall back to the raw HR ID (that's still a code)
    return rows.map((r) => (r.managerHrId ? { ...r, managerName: UNKNOWN_NAME } : r));
  }
  return rows.map((r) => {
    if (!r.managerHrId) return r;
    const name = nameByKey.get(r.managerHrId.trim().toUpperCase());
    return { ...r, managerName: name ?? UNKNOWN_NAME };
  });
}

async function resolveCustomerNames(rows: SosByCustomerRow[]): Promise<SosByCustomerRow[]> {
  const codes = [...new Set(rows.map((r) => r.clientCode).filter(Boolean))];
  if (codes.length === 0) return rows;
  const nameByCode = new Map<string, string>();
  try {
    const db = getSupabaseAdmin();
    const CHUNK = 300; // bound the PostgREST in(...) URL length for large customer sets
    for (let i = 0; i < codes.length; i += CHUNK) {
      const { data } = await db
        .from("source_of_sales_customer_directory_rollup")
        .select("client_code,client_name,latest_row_created_at")
        .in("client_code", codes.slice(i, i + CHUNK))
        .not("client_name", "is", null)
        .order("latest_row_created_at", { ascending: false });
      for (const row of (data ?? []) as { client_code: string | null; client_name: string | null }[]) {
        const code = String(row.client_code ?? "");
        const name = String(row.client_name ?? "").trim();
        if (code && name && !nameByCode.has(code)) nameByCode.set(code, name); // first seen = latest
      }
    }
  } catch {
    // rollup unavailable → never fall back to the raw client code (that's still a code)
    return rows.map((r) => ({ ...r, customerName: UNKNOWN_NAME }));
  }
  return rows.map((r) => ({ ...r, customerName: nameByCode.get(r.clientCode) ?? UNKNOWN_NAME }));
}

// ── Row mappers ───────────────────────────────────────────────────────────────

// ── Cached public loaders ─────────────────────────────────────────────────────
// Each /admin/analytics/* loader reads a rollup-view-backed analytics_* RPC whose
// output is fully determined by its filter args (scope + head-office flag are folded
// into `filters` by the caller), so wrapping in unstable_cache is scope-safe: two
// callers share a cache entry only when they requested identical, already-scoped
// filters. Tags are busted by the sales/SoS import paths (SALES_DASHBOARD_CACHE_TAGS
// in src/lib/dashboard/invalidation.ts); the 300s TTL bounds any un-wired path.
const ANALYTICS_SOS_TAG = "analytics-sos";
const ANALYTICS_CLOSING_TAG = "analytics-closing";
const ANALYTICS_WEEKLY_TAG = "analytics-weekly";

// Sort a copy of every array field so the same logical filter set always maps to the
// same cache key regardless of the order values arrive in (the RPCs treat arrays as sets).
function sortArraysForKey<F>(filters: F): F {
  const src = filters as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) {
    const value = src[key];
    out[key] = Array.isArray(value) ? [...value].map((v) => String(v)).sort() : value;
  }
  return out as F;
}

function cachedAnalyticsLoader<F, R>(
  keyName: string,
  tags: string[],
  raw: (filters: F) => Promise<R>,
): (filters?: F) => Promise<R> {
  const wrapped = unstable_cache((filters: F) => raw(filters), [keyName], { revalidate: 300, tags });
  return (filters: F = {} as F) => wrapped(sortArraysForKey(filters));
}

export const loadSosByLine = cachedAnalyticsLoader("analytics-sos-by-line", [ANALYTICS_SOS_TAG], loadSosByLineUncached);
export const loadSosByPeriod = cachedAnalyticsLoader("analytics-sos-by-period", [ANALYTICS_SOS_TAG], loadSosByPeriodUncached);
export const loadSosByArea = cachedAnalyticsLoader("analytics-sos-by-area", [ANALYTICS_SOS_TAG], loadSosByAreaUncached);
export const loadSosByProduct = cachedAnalyticsLoader("analytics-sos-by-product", [ANALYTICS_SOS_TAG], loadSosByProductUncached);
export const loadSosByCustomer = cachedAnalyticsLoader("analytics-sos-by-customer", [ANALYTICS_SOS_TAG], loadSosByCustomerUncached);
export const loadClosingByEmployee = cachedAnalyticsLoader("analytics-closing-by-employee", [ANALYTICS_CLOSING_TAG], loadClosingByEmployeeUncached);
export const loadWeeklyFact = cachedAnalyticsLoader("analytics-weekly-fact", [ANALYTICS_WEEKLY_TAG], loadWeeklyFactUncached);
export const loadCrossSource = cachedAnalyticsLoader("analytics-cross-source", [ANALYTICS_SOS_TAG, ANALYTICS_CLOSING_TAG, ANALYTICS_WEEKLY_TAG], loadCrossSourceUncached);

// ── Row mappers ───────────────────────────────────────────────────────────────

function n(v: unknown): number { return Number(v ?? 0); }
function s(v: unknown): string { return String(v ?? ""); }

function mapSosKpiRow(r: Record<string, unknown>): SosKpiRow {
  return {
    period:     s(r.period),
    year:       n(r.year),
    month:      n(r.month),
    channel:    s(r.channel),
    units:      n(r.units),
    bonusUnits: n(r.bonus_units),
    value:      n(r.value),
  };
}

function mapSosAreaRow(r: Record<string, unknown>): SosByAreaRow {
  return {
    period:     s(r.period),
    regionCode: s(r.region_code),
    regionName: s(r.region_name),
    areaCode:   s(r.area_code),
    areaName:   s(r.area_name),
    channel:    s(r.channel),
    units:      n(r.units),
    value:      n(r.value),
  };
}

function mapSosProductRow(r: Record<string, unknown>): SosByProductRow {
  return {
    period:      s(r.period),
    productCode: s(r.product_code),
    productName: s(r.product_name),
    family:      s(r.family),
    familyCode:  s(r.family_code),
    line:        s(r.line),
    channel:     s(r.channel),
    units:       n(r.units),
    value:       n(r.value),
  };
}

function mapSosCustomerRow(r: Record<string, unknown>): SosByCustomerRow {
  return {
    period:        s(r.period),
    year:          n(r.year),
    month:         n(r.month),
    clientCode:    s(r.client_code),
    customerName:  s(r.client_code), // placeholder only; always overwritten (name or UNKNOWN_NAME) by resolveCustomerNames()
    line:          s(r.line),
    regionCode:    s(r.region_code),
    regionName:    s(r.region_name),
    activeBatches: n(r.active_batches),
  };
}

function mapWeeklyRow(r: Record<string, unknown>): WeeklyFactRow {
  return {
    weekStart:       s(r.week_start),
    weekLabel:       s(r.week_label),
    period:          s(r.period),
    distributorCode: s(r.distributor_code),
    distributorName: s(r.distributor_name),
    regionCode:      s(r.region_code),
    regionName:      s(r.region_name),
    productCode:     s(r.product_code),
    productName:     s(r.product_name),
    line:            s(r.line),
    family:          s(r.family),
    salesQty:        n(r.sales_qty),
    salesValue:      n(r.sales_value),
    stockQty:        n(r.stock_qty),
  };
}

function mapCrossSourceRow(r: Record<string, unknown>): CrossSourceRow {
  return {
    period:                  s(r.period),
    line:                    s(r.line),
    sosValue:                r.sos_value         != null ? n(r.sos_value)                  : null,
    sosUnits:                r.sos_units         != null ? n(r.sos_units)                  : null,
    closingValue:            r.closing_value     != null ? n(r.closing_value)              : null,
    closingUnits:            r.closing_units     != null ? n(r.closing_units)              : null,
    targetValue:             r.target_value      != null ? n(r.target_value)               : null,
    weeklyValue:             r.weekly_value      != null ? n(r.weekly_value)               : null,
    weeklyUnits:             r.weekly_units      != null ? n(r.weekly_units)               : null,
    closingAchievementPct:   r.closing_achievement_pct   != null ? n(r.closing_achievement_pct)  : null,
    closingVsSosGapPct:      r.closing_vs_sos_gap_pct    != null ? n(r.closing_vs_sos_gap_pct)   : null,
  };
}
