// ─────────────────────────────────────────────────────────────────────────────
// SFE performance: targets vs actual, and IMS contribution.
//
// Two questions an SFE Manager is measured on that the overview did not answer:
//   1. "Am I hitting target?" — it showed a bare achievement %, no target, no gap, no line split.
//   2. "Is my sales distribution matching the market?" — the IMS ratios were nowhere.
//
// Targets reuse getSalesDashboard rather than re-querying sales_records, so this partition and the
// Sales-achievement tile are computed from one engine and cannot drift apart.
// ─────────────────────────────────────────────────────────────────────────────

import type { AccessContext } from "@/lib/auth/permissions";
import { loadLatestAnalyticsPeriod } from "@/lib/analytics/service";
import { getSalesDashboard } from "@/lib/sales/service";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** Region that holds the "Others" IMS residual at REGION level rather than per area. */
const IMS_OTHERS_REGION = "OT";

export type SfeLineTarget = {
  line: string;
  target: number;
  actual: number;
  /** actual / target; null when the line carries no target (a rate would be a divide-by-zero lie). */
  achievementRate: number | null;
};

export type SfeTargetPerformance = {
  lines: SfeLineTarget[];
  totalTarget: number;
  totalActual: number;
  /** Remaining to target; negative once the line is ahead. */
  gap: number;
  achievementRate: number | null;
};

export type SfeImsRow = {
  /** Area NAME, never the code — codes are internal. Falls back to the code only if a row has no name. */
  label: string;
  key: string;
  /** Share of in-scope sales this area carries, 0–100. */
  salesSharePct: number;
  /** The area's IMS market share, 0–100. */
  imsPct: number;
  /** salesSharePct − imsPct. Positive = over-indexing the market, negative = under. */
  gapPts: number;
};

export type SfeImsContribution = {
  period: string | null;
  /** Biggest over-indexers first. */
  over: SfeImsRow[];
  /** Biggest under-indexers first. */
  under: SfeImsRow[];
  /** Areas with sales but no IMS ratio on the master — excluded from the comparison, reported here. */
  areasWithoutRatio: number;
  /** Share of in-scope sales that DID match an IMS ratio, 0–100. Low means the rest is unreliable. */
  matchedSharePct: number;
};

function rate(actual: number, target: number): number | null {
  return target > 0 ? actual / target : null;
}

/**
 * Per-line target vs actual, restricted to the caller's visible lines.
 *
 * `visibleLines` is matched case-insensitively because the two sales datasets disagree on casing —
 * sales_records stores "cns" lowercase while Source of Sales stores "CNS".
 */
export async function getSfeTargetPerformance(
  access: AccessContext,
  visibleLines: readonly string[],
): Promise<SfeTargetPerformance> {
  const allowed = new Set(visibleLines.map((line) => line.trim().toLowerCase()));
  const dashboard = await getSalesDashboard({}, access);
  const rows = (dashboard.linePerformance ?? []) as Array<{ line?: string | null; sales?: number; target?: number }>;

  const lines: SfeLineTarget[] = rows
    .filter((row) => allowed.has(String(row.line ?? "").trim().toLowerCase()))
    .map((row) => {
      const actual = Number(row.sales ?? 0);
      const target = Number(row.target ?? 0);
      return { line: String(row.line ?? "").trim(), target, actual, achievementRate: rate(actual, target) };
    })
    .sort((a, b) => b.target - a.target);

  const totalTarget = lines.reduce((sum, line) => sum + line.target, 0);
  const totalActual = lines.reduce((sum, line) => sum + line.actual, 0);

  return {
    lines,
    totalTarget,
    totalActual,
    gap: totalTarget - totalActual,
    achievementRate: rate(totalActual, totalTarget),
  };
}

/**
 * Where sales land versus where the market is.
 *
 * Each area's share of in-scope sales is compared with its IMS ratio. An area pulling far more
 * share than the market says it holds is either a genuine concentration or — more often — a
 * mapping problem swallowing other areas' sales, and either way it is the SFE Manager's to chase.
 *
 * OT ("Others") is deliberately collapsed to a single row: its IMS residual is held at REGION
 * level and its areas carry no per-area ratio, so comparing them individually would report every
 * OT area as a 100% over-index against a null.
 */
export async function getSfeImsContribution(visibleLines: readonly string[]): Promise<SfeImsContribution> {
  const allowed = new Set(visibleLines.map((line) => line.trim().toLowerCase()));
  const period = await loadLatestAnalyticsPeriod();
  if (!period) {
    return { period: null, over: [], under: [], areasWithoutRatio: 0, matchedSharePct: 0 };
  }

  const db = getSupabaseAdmin();
  const [factResult, areaResult, regionResult] = await Promise.all([
    db.schema("analytics").from("sos_fact_all" as never).select("line,area_code,area_name,region_code,value").eq("period", period),
    db.from("source_of_sales_areas").select("area_code,region_code,ims_ratio").eq("active", true),
    db.from("source_of_sales_regions").select("region_code,ims_ratio"),
  ]);
  if (factResult.error) throw new Error(`IMS contribution facts: ${factResult.error.message}`);

  const ratioByKey = new Map<string, number>();
  for (const row of (areaResult.data ?? []) as Array<{ area_code: string; region_code: string; ims_ratio: number | null }>) {
    if (row.region_code === IMS_OTHERS_REGION) continue;
    if (row.ims_ratio != null) ratioByKey.set(row.area_code, Number(row.ims_ratio));
  }
  for (const row of (regionResult.data ?? []) as Array<{ region_code: string; ims_ratio: number | null }>) {
    if (row.region_code === IMS_OTHERS_REGION && row.ims_ratio != null) {
      ratioByKey.set(IMS_OTHERS_REGION, Number(row.ims_ratio));
    }
  }

  const salesByKey = new Map<string, number>();
  // Area NAME per key, for display. The owner's standing rule is names in the UI, never codes;
  // the code stays only as the join key against the IMS master and as a last-resort label.
  const labelByKey = new Map<string, string>();
  let totalValue = 0;
  for (const row of (factResult.data ?? []) as unknown as Array<{
    line: string | null; area_code: string | null; area_name: string | null; region_code: string | null; value: number | null;
  }>) {
    if (!allowed.has(String(row.line ?? "").trim().toLowerCase())) continue;
    const value = Number(row.value ?? 0);
    if (!Number.isFinite(value)) continue;
    const isOthers = row.region_code === IMS_OTHERS_REGION;
    const key = isOthers ? IMS_OTHERS_REGION : String(row.area_code ?? "").trim();
    if (!key) continue;
    if (!labelByKey.has(key)) {
      labelByKey.set(key, isOthers ? "Others" : String(row.area_name ?? "").trim() || key);
    }
    salesByKey.set(key, (salesByKey.get(key) ?? 0) + value);
    totalValue += value;
  }

  if (totalValue <= 0) {
    return { period, over: [], under: [], areasWithoutRatio: 0, matchedSharePct: 0 };
  }

  const rows: SfeImsRow[] = [];
  let unmatched = 0;
  let matchedValue = 0;
  for (const [key, value] of salesByKey) {
    const ratio = ratioByKey.get(key);
    if (ratio == null) {
      unmatched++;
      continue;
    }
    matchedValue += value;
    const salesSharePct = (value / totalValue) * 100;
    const imsPct = ratio * 100;
    rows.push({
      label: labelByKey.get(key) ?? key,
      key,
      salesSharePct: Math.round(salesSharePct * 100) / 100,
      imsPct: Math.round(imsPct * 100) / 100,
      gapPts: Math.round((salesSharePct - imsPct) * 100) / 100,
    });
  }

  const byGap = [...rows].sort((a, b) => b.gapPts - a.gapPts);
  return {
    period,
    over: byGap.slice(0, 5),
    under: [...byGap].reverse().slice(0, 5),
    areasWithoutRatio: unmatched,
    matchedSharePct: Math.round((matchedValue / totalValue) * 10000) / 100,
  };
}
