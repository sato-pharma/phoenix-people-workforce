// Analytics service — server-side data fetching for the three sales pipelines.
// All queries go through getSupabaseAdmin (service role) matching the existing
// Phoenix pattern. Access control is enforced at the page/API route layer.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { canViewRestrictedProducts } from "@/lib/sales/access-scope";
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
  const includeRestricted = canViewRestrictedProducts(role);

  const [periods, weeks, distributors, areas, products] = await Promise.all([
    db.from("analytics" as never).select("period,year,month,period_label").order("period", { ascending: false }).limit(36),
    db.from("analytics" as never).select("week_start,year,month,iso_week,week_label").order("week_start", { ascending: false }).limit(52),
    db.from("analytics" as never).select("distributor_code,distributor_name").order("distributor_name"),
    db.from("analytics" as never).select("area_code,area_name,region_code,region_name").order("region_name"),
    includeRestricted
      ? db.from("analytics" as never).select("product_code,product_name,line,family").order("product_name")
      : db.from("analytics" as never).select("product_code,product_name,line,family").order("product_name"),
  ] as const);

  // Extract distinct lines and families from products
  const productRows = (products.data ?? []) as { product_code: string; product_name: string; line: string; family: string }[];
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
  period?: string | null;
  periodFrom?: string | null;
  periodTo?: string | null;
  distributors?: string[];
  lines?: string[];
  regions?: string[];
  areas?: string[];
  products?: string[];
  families?: string[];
  channel?: string | null;
  clientCodes?: string[];
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

export async function loadSosByLine(filters: SosFilters = {}): Promise<SosByLineRow[]> {
  const db = getSupabaseAdmin();
  const { data, error } = await db.rpc("analytics_sos_by_line" as never, {
    p_period:      filters.period      ?? null,
    p_period_from: filters.periodFrom  ?? null,
    p_period_to:   filters.periodTo    ?? null,
    p_channel:     filters.channel     ?? null,
    p_distributors: filters.distributors?.length ? filters.distributors : null,
    p_regions:     filters.regions?.length     ? filters.regions     : null,
  } as never);
  if (error) throw new Error(`SoS by line: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    period:  s(r.period),
    year:    n(r.year),
    month:   n(r.month),
    line:    s(r.line),
    channel: s(r.channel),
    units:   n(r.units),
    value:   n(r.value),
  }));
}

export async function loadSosByPeriod(filters: SosFilters = {}): Promise<SosKpiRow[]> {
  const db = getSupabaseAdmin();
  // Query the analytics view via raw SQL through RPC or direct admin select.
  // We use .from() with schema qualifier via rpc pattern. Since analytics schema
  // tables are views (not public), we use a raw select via the admin client's
  // postgrest schema override. Supabase JS client defaults to public schema;
  // we call a helper SQL function instead.
  const { data, error } = await db.rpc("analytics_sos_by_period" as never, {
    p_period:      filters.period      ?? null,
    p_period_from: filters.periodFrom  ?? null,
    p_period_to:   filters.periodTo    ?? null,
    p_channel:     filters.channel     ?? null,
    p_lines:       filters.lines?.length       ? filters.lines       : null,
    p_distributors: filters.distributors?.length ? filters.distributors : null,
    p_regions:     filters.regions?.length     ? filters.regions     : null,
  } as never);
  if (error) throw new Error(`SoS by period: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map(mapSosKpiRow);
}

export async function loadSosByArea(filters: SosFilters = {}): Promise<SosByAreaRow[]> {
  const db = getSupabaseAdmin();
  const { data, error } = await db.rpc("analytics_sos_by_area" as never, {
    p_period:      filters.period      ?? null,
    p_period_from: filters.periodFrom  ?? null,
    p_period_to:   filters.periodTo    ?? null,
    p_channel:     filters.channel     ?? null,
    p_lines:       filters.lines?.length       ? filters.lines       : null,
    p_distributors: filters.distributors?.length ? filters.distributors : null,
    p_regions:     filters.regions?.length     ? filters.regions     : null,
    p_areas:       filters.areas?.length       ? filters.areas       : null,
  } as never);
  if (error) throw new Error(`SoS by area: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map(mapSosAreaRow);
}

export async function loadSosByProduct(filters: SosFilters = {}): Promise<SosByProductRow[]> {
  const db = getSupabaseAdmin();
  const { data, error } = await db.rpc("analytics_sos_by_product" as never, {
    p_period:      filters.period      ?? null,
    p_period_from: filters.periodFrom  ?? null,
    p_period_to:   filters.periodTo    ?? null,
    p_channel:     filters.channel     ?? null,
    p_lines:       filters.lines?.length       ? filters.lines       : null,
    p_distributors: filters.distributors?.length ? filters.distributors : null,
    p_products:    filters.products?.length    ? filters.products    : null,
    p_families:    filters.families?.length    ? filters.families    : null,
  } as never);
  if (error) throw new Error(`SoS by product: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map(mapSosProductRow);
}

export async function loadSosByCustomer(filters: SosFilters = {}): Promise<SosByCustomerRow[]> {
  const db = getSupabaseAdmin();
  const { data, error } = await db.rpc("analytics_sos_by_customer" as never, {
    p_period:       filters.period      ?? null,
    p_period_from:  filters.periodFrom  ?? null,
    p_period_to:    filters.periodTo    ?? null,
    p_lines:        filters.lines?.length       ? filters.lines       : null,
    p_regions:      filters.regions?.length     ? filters.regions     : null,
    p_client_codes: filters.clientCodes?.length ? filters.clientCodes : null,
  } as never);
  if (error) throw new Error(`SoS by customer: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map(mapSosCustomerRow);
}

// ── Monthly closing loaders ───────────────────────────────────────────────────

export type ClosingFilters = {
  period?: string | null;
  periodFrom?: string | null;
  periodTo?: string | null;
  lines?: string[];
  products?: string[];
  families?: string[];
  employeeHrId?: string | null;
  territory?: string | null;
  batchStatus?: string[];
  batchId?: string | null;
};

export async function loadClosingByEmployee(filters: ClosingFilters = {}): Promise<ClosingByEmployeeRow[]> {
  const db = getSupabaseAdmin();
  const { data, error } = await db.rpc("analytics_closing_by_employee" as never, {
    p_period:       filters.period      ?? null,
    p_period_from:  filters.periodFrom  ?? null,
    p_period_to:    filters.periodTo    ?? null,
    p_lines:        filters.lines?.length    ? filters.lines    : null,
    p_employee_hr_id: filters.employeeHrId ?? null,
    p_territory:    filters.territory   ?? null,
    p_batch_status: filters.batchStatus?.length ? filters.batchStatus : null,
    p_batch_id:     filters.batchId     ?? null,
  } as never);
  if (error) throw new Error(`Closing by employee: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map(mapClosingEmployeeRow);
}

// ── Weekly loaders ────────────────────────────────────────────────────────────

export type WeeklyFilters = {
  weekStart?: string | null;
  year?: number | null;
  distributors?: string[];
  lines?: string[];
  regions?: string[];
  products?: string[];
  families?: string[];
};

export async function loadWeeklyFact(filters: WeeklyFilters = {}): Promise<WeeklyFactRow[]> {
  const db = getSupabaseAdmin();
  const { data, error } = await db.rpc("analytics_weekly_fact" as never, {
    p_week_start:   filters.weekStart   ?? null,
    p_year:         filters.year        ?? null,
    p_distributors: filters.distributors?.length ? filters.distributors : null,
    p_lines:        filters.lines?.length        ? filters.lines        : null,
    p_regions:      filters.regions?.length      ? filters.regions      : null,
    p_products:     filters.products?.length     ? filters.products     : null,
    p_families:     filters.families?.length     ? filters.families     : null,
  } as never);
  if (error) throw new Error(`Weekly fact: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map(mapWeeklyRow);
}

// ── Cross-source comparison loader ────────────────────────────────────────────

export async function loadCrossSource(filters: { periodFrom?: string | null; periodTo?: string | null; lines?: string[] } = {}): Promise<CrossSourceRow[]> {
  const db = getSupabaseAdmin();
  const { data, error } = await db.rpc("analytics_cross_source" as never, {
    p_period_from: filters.periodFrom ?? null,
    p_period_to:   filters.periodTo   ?? null,
    p_lines:       filters.lines?.length ? filters.lines : null,
  } as never);
  if (error) throw new Error(`Cross-source: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map(mapCrossSourceRow);
}

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
    line:          s(r.line),
    regionCode:    s(r.region_code),
    regionName:    s(r.region_name),
    activeBatches: n(r.active_batches),
  };
}

function mapClosingEmployeeRow(r: Record<string, unknown>): ClosingByEmployeeRow {
  return {
    period:          s(r.period),
    line:            s(r.line),
    employeeHrId:    r.employee_hr_id   != null ? s(r.employee_hr_id)  : null,
    employeeName:    r.employee_name    != null ? s(r.employee_name)   : null,
    managerHrId:     r.manager_hr_id    != null ? s(r.manager_hr_id)   : null,
    territory:       r.territory        != null ? s(r.territory)        : null,
    salesValue:      n(r.sales_value),
    targetValue:     n(r.target_value),
    salesUnits:      n(r.sales_units),
    targetUnits:     n(r.target_units),
    achievementPct:  r.achievement_pct  != null ? n(r.achievement_pct) : null,
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
