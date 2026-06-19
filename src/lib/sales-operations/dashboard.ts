// Sales Operations Module — dashboard data loader.
//
// Reads ONLY the pre-aggregated rollup tables (tens–~1k rows each) — never the fact rows — so the
// dashboard loads fast at scale and never approaches the 8s statement-timeout that plagued the old
// module. Each panel is one small indexed select.

import { getSupabaseAdmin } from "@/lib/supabase/server";

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export type SalesOpsTotals = {
  totalValue: number;
  totalQty: number;
  rowCount: number;
  distributorCount: number;
  areaCount: number;
  brickCount: number;
  productCount: number;
};

export type SalesOpsDashboardData = {
  period: string | null;
  hasData: boolean;
  totals: SalesOpsTotals | null;
  byDistributor: { distributorCode: string; rowCount: number; totalQty: number; totalValue: number }[];
  byLine: { officialLine: string; totalQty: number; totalValue: number }[];
  byRegion: { regionCode: string; regionName: string; totalQty: number; totalValue: number }[];
  byArea: { areaCode: string; areaName: string; regionCode: string; totalQty: number; totalValue: number }[];
  byProduct: { productCode: string; productName: string; family: string; totalQty: number; totalValue: number }[];
  areaProduct: { areaCode: string; productCode: string; totalQty: number; totalValue: number }[];
};

// Periods that actually have committed data (the rollup_period table only holds non-empty periods).
export async function listSalesOpsPeriods(): Promise<string[]> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.from("sales_ops_rollup_period").select("period").order("period", { ascending: false });
    if (error) return [];
    return (data ?? []).map((r) => String((r as { period: unknown }).period ?? "")).filter(Boolean);
  } catch {
    return [];
  }
}

// Value/units per period across the whole module (for the trend panel). Small table — full read.
export async function loadSalesOpsTrend(): Promise<{ period: string; totalValue: number; totalQty: number }[]> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.from("sales_ops_rollup_period").select("period,total_value,total_qty").order("period", { ascending: true });
    if (error) return [];
    return (data ?? []).map((r) => {
      const row = r as { period: unknown; total_value: unknown; total_qty: unknown };
      return { period: String(row.period ?? ""), totalValue: num(row.total_value), totalQty: num(row.total_qty) };
    });
  } catch {
    return [];
  }
}

const EMPTY = (period: string | null): SalesOpsDashboardData => ({
  period,
  hasData: false,
  totals: null,
  byDistributor: [],
  byLine: [],
  byRegion: [],
  byArea: [],
  byProduct: [],
  areaProduct: [],
});

// Load every panel for one period from the rollups (parallel, all small indexed selects).
export async function loadSalesOpsDashboard(period: string | null): Promise<SalesOpsDashboardData> {
  if (!period) return EMPTY(null);
  try {
    const supabase = getSupabaseAdmin();
    const [totalsR, distR, lineR, regionR, areaR, productR, areaProductR] = await Promise.all([
      supabase.from("sales_ops_rollup_period").select("total_value,total_qty,row_count,distributor_count,area_count,brick_count,product_count").eq("period", period).maybeSingle(),
      supabase.from("sales_ops_rollup_by_distributor").select("distributor_code,row_count,total_qty,total_value").eq("period", period).order("total_value", { ascending: false }),
      supabase.from("sales_ops_rollup_by_line").select("official_line,total_qty,total_value").eq("period", period).order("total_value", { ascending: false }),
      supabase.from("sales_ops_rollup_by_region").select("region_code,region_name,total_qty,total_value").eq("period", period).order("total_value", { ascending: false }),
      supabase.from("sales_ops_rollup_by_area").select("area_code,area_name,region_code,total_qty,total_value").eq("period", period).order("total_value", { ascending: false }),
      supabase.from("sales_ops_rollup_by_product").select("product_code,product_name,family,total_qty,total_value").eq("period", period).order("total_value", { ascending: false }),
      supabase.from("sales_ops_rollup_area_product").select("area_code,product_code,total_qty,total_value").eq("period", period),
    ]);

    const t = totalsR.data as Record<string, unknown> | null;
    return {
      period,
      hasData: Boolean(t),
      totals: t
        ? {
            totalValue: num(t.total_value),
            totalQty: num(t.total_qty),
            rowCount: num(t.row_count),
            distributorCount: num(t.distributor_count),
            areaCount: num(t.area_count),
            brickCount: num(t.brick_count),
            productCount: num(t.product_count),
          }
        : null,
      byDistributor: ((distR.data ?? []) as Record<string, unknown>[]).map((r) => ({ distributorCode: String(r.distributor_code ?? ""), rowCount: num(r.row_count), totalQty: num(r.total_qty), totalValue: num(r.total_value) })),
      byLine: ((lineR.data ?? []) as Record<string, unknown>[]).map((r) => ({ officialLine: String(r.official_line ?? ""), totalQty: num(r.total_qty), totalValue: num(r.total_value) })),
      byRegion: ((regionR.data ?? []) as Record<string, unknown>[]).map((r) => ({ regionCode: String(r.region_code ?? ""), regionName: String(r.region_name ?? ""), totalQty: num(r.total_qty), totalValue: num(r.total_value) })),
      byArea: ((areaR.data ?? []) as Record<string, unknown>[]).map((r) => ({ areaCode: String(r.area_code ?? ""), areaName: String(r.area_name ?? ""), regionCode: String(r.region_code ?? ""), totalQty: num(r.total_qty), totalValue: num(r.total_value) })),
      byProduct: ((productR.data ?? []) as Record<string, unknown>[]).map((r) => ({ productCode: String(r.product_code ?? ""), productName: String(r.product_name ?? ""), family: String(r.family ?? ""), totalQty: num(r.total_qty), totalValue: num(r.total_value) })),
      areaProduct: ((areaProductR.data ?? []) as Record<string, unknown>[]).map((r) => ({ areaCode: String(r.area_code ?? ""), productCode: String(r.product_code ?? ""), totalQty: num(r.total_qty), totalValue: num(r.total_value) })),
    };
  } catch {
    return EMPTY(period);
  }
}
