import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import {
  assembleComparison,
  buildValueGrid,
  type BrickRow,
  type ComparisonNameMaps,
  type CustomerRow,
  type DistProductRow,
  type MonthlyClosingComparison,
  type ValueGridRow,
} from "@/lib/sales/monthly-closing-comparison";

// Executive Report — a COMPANY-WIDE (all lines) Source of Sales comparison, either all-time
// (period = null) or narrowed to one month. It reuses the Monthly Closing comparison assembly
// (distributor rollups, rankings, mix, white-space, insights) with the line label "All Lines",
// and adds a line dimension on top: per-line rollups, a line × product matrix, and a
// line × distributor grid. Value is ALWAYS recomputed in the RPCs (Qty × (1 − discount) ×
// live factory_price); higher-level numbers are DERIVED from leaf rows (no double counting).

export const ALL_LINES_LABEL = "All Lines";

const round = (value: number) => Number((value || 0).toFixed(6));
const nameOf = (map: Map<string, string>, code: string) => map.get(code) ?? code;

export type ExecDistProductRow = DistProductRow & { officialLine: string };

export type ExecLineRollup = {
  areaCount: number;
  distributorCount: number;
  officialLine: string;
  productCount: number;
  units: number;
  value: number;
  valueShare: number; // ratio 0..1 of the company total
};

export type ExecLineProductRow = {
  lineShare: number; // ratio 0..1 of the product within its own line
  officialLine: string;
  productCode: string;
  productName: string;
  units: number;
  value: number;
};

// Fact blocks for the workbook's hidden Data sheet. distProduct carries the LINE so the
// By Line & Product / Line × Distributor formulas can SUMIFS on it.
export type ExecExportData = {
  bricks: { brickId: string; brickName: string; distributorCode: string; units: number; value: number }[];
  customers: { clientCode: string; clientName: string; distributorCode: string; units: number; value: number }[];
  distProduct: {
    areaCode: string; areaName: string; distributorCode: string; distributorName: string;
    officialLine: string; productCode: string; productName: string; regionCode: string; regionName: string;
    units: number; value: number;
  }[];
  masterAreas: { areaCode: string; areaName: string; regionName: string }[];
  masterBricks: { areaName: string; brickId: string; brickName: string; regionName: string }[];
};

export type ExecutiveReport = {
  availablePeriods: string[];
  byLine: ExecLineRollup[];
  comparison: MonthlyClosingComparison;
  data: ExecExportData;
  lineByDistributor: ValueGridRow[];
  lineProduct: ExecLineProductRow[];
  period: string | null;
};

// Slim, serializable projection for the page/preview (the full report carries the granular
// fact arrays that only the workbook needs).
export type ExecutiveReportView = {
  availablePeriods: string[];
  byDistributor: { distributorName: string; units: number; value: number; valueShare: number }[];
  byLine: ExecLineRollup[];
  distributorCount: number;
  lineProduct: ExecLineProductRow[];
  national: MonthlyClosingComparison["national"];
  period: string | null;
  totalAreas: number;
  totalBricks: number;
};

export function toExecutiveView(report: ExecutiveReport): ExecutiveReportView {
  const c = report.comparison;
  return {
    availablePeriods: report.availablePeriods,
    byDistributor: c.byDistributor.map((d) => ({ distributorName: d.distributorName, units: d.units, value: d.value, valueShare: d.valueShare })),
    byLine: report.byLine,
    distributorCount: c.distributors.length,
    lineProduct: report.lineProduct,
    national: c.national,
    period: report.period,
    totalAreas: c.totalAreas,
    totalBricks: c.totalBricks,
  };
}

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

export function rollupByLine(rows: ExecDistProductRow[]): ExecLineRollup[] {
  const byLine = new Map<string, { areas: Set<string>; distributors: Set<string>; products: Set<string>; units: number; value: number }>();
  rows.forEach((row) => {
    let entry = byLine.get(row.officialLine);
    if (!entry) { entry = { areas: new Set(), distributors: new Set(), products: new Set(), units: 0, value: 0 }; byLine.set(row.officialLine, entry); }
    entry.units += row.units;
    entry.value += row.value;
    if (row.value > 0 || row.units > 0) {
      entry.products.add(row.productCode);
      entry.areas.add(row.areaCode);
      entry.distributors.add(row.distributorCode);
    }
  });
  const total = [...byLine.values()].reduce((sum, entry) => sum + entry.value, 0);
  return [...byLine.entries()]
    .map(([officialLine, entry]) => ({
      areaCount: entry.areas.size,
      distributorCount: entry.distributors.size,
      officialLine,
      productCount: entry.products.size,
      units: round(entry.units),
      value: round(entry.value),
      valueShare: total > 0 ? round(entry.value / total) : 0,
    }))
    .sort((left, right) => right.value - left.value);
}

export function buildLineProductMatrix(rows: ExecDistProductRow[]): ExecLineProductRow[] {
  const byKey = new Map<string, { name: string; officialLine: string; productCode: string; units: number; value: number }>();
  const lineTotals = new Map<string, number>();
  rows.forEach((row) => {
    const key = `${row.officialLine} ${row.productCode}`;
    let entry = byKey.get(key);
    if (!entry) { entry = { name: row.productName || row.productCode, officialLine: row.officialLine, productCode: row.productCode, units: 0, value: 0 }; byKey.set(key, entry); }
    entry.units += row.units;
    entry.value += row.value;
    lineTotals.set(row.officialLine, (lineTotals.get(row.officialLine) ?? 0) + row.value);
  });
  return [...byKey.values()]
    .map((entry) => {
      const lineTotal = lineTotals.get(entry.officialLine) ?? 0;
      return {
        lineShare: lineTotal > 0 ? round(entry.value / lineTotal) : 0,
        officialLine: entry.officialLine,
        productCode: entry.productCode,
        productName: entry.name,
        units: round(entry.units),
        value: round(entry.value),
      };
    })
    .sort((left, right) => left.officialLine.localeCompare(right.officialLine) || right.value - left.value);
}

// ── Server orchestrator ──────────────────────────────────────────────────────

export async function loadExecutiveReport(period: string | null): Promise<ExecutiveReport> {
  const supabase = getSupabaseAdmin();
  // Cheap reference/master reads run concurrently and overlap the heavy aggregates below.
  const referencesPromise = loadSalesReferenceData();
  const brickMasterPromise = supabase
    .from("source_of_sales_bricks")
    .select("brick_id,brick_name,area_code,region_code")
    .eq("active", true);
  const periodsPromise = supabase
    .from("source_of_sales_import_batches")
    .select("period")
    .eq("status", "validated")
    .not("period", "is", null);

  // The three exec aggregates each scan the whole period's fact rows (seconds each). Run them
  // SEQUENTIALLY: in parallel they multiply DB contention and push individual requests past the
  // 15s Supabase fetch abort (and trip statement timeouts). Sequential keeps every request
  // isolated and well within budget, while still overlapping the cheap reads above. rpcAll now
  // fetches each in a SINGLE function execution (no per-page re-aggregation).
  const dpData = await rpcAll(supabase, "phx_exec_distributor_product", { p_period: period }, ["distributor_code", "official_line", "region_code", "area_code", "product_code"]);
  const brickData = await rpcAll(supabase, "phx_exec_brick", { p_period: period }, ["distributor_code", "region_code", "area_code", "brick_id"]);
  const custData = await rpcAll(supabase, "phx_exec_customers", { p_period: period }, ["client_code", "distributor_code"]);

  const [references, brickMasterResult, periodsResult] = await Promise.all([
    referencesPromise,
    brickMasterPromise,
    periodsPromise,
  ]);

  const regionName = new Map<string, string>();
  const areaName = new Map<string, string>();
  const distributorName = new Map<string, string>();
  const areaRegion = new Map<string, string>();
  references.regions.forEach((r) => { if (r.regionCode) regionName.set(r.regionCode, r.regionName || r.regionCode); });
  (references.areas ?? []).forEach((a) => {
    if (a.areaCode) { areaName.set(a.areaCode, a.areaName || a.areaCode); areaRegion.set(a.areaCode, a.regionCode); }
  });
  // The Direct channel has no area; phx_exec_distributor_product buckets it under 'DIRECT'.
  areaName.set("DIRECT", "Direct (company)");
  references.distributors.forEach((d) => { if (d.code) distributorName.set(d.code, d.name || d.code); });

  const baseMaps: ComparisonNameMaps = { areaName, distributorName, regionName };

  const masterAreas = (references.areas ?? []).map((a) => ({ areaCode: a.areaCode, areaName: a.areaName || a.areaCode, regionCode: a.regionCode }));
  const masterBricks = ((brickMasterResult.error ? [] : brickMasterResult.data ?? []) as Array<Record<string, unknown>>).map((b) => ({
    areaCode: String(b.area_code ?? ""), brickId: String(b.brick_id ?? ""), brickName: String(b.brick_name ?? "") || String(b.brick_id ?? ""), regionCode: String(b.region_code ?? ""),
  }));

  const distProductRows: ExecDistProductRow[] = (dpData as Array<Record<string, unknown>>).map((row) => ({
    areaCode: String(row.area_code ?? ""), distributorCode: String(row.distributor_code ?? ""),
    officialLine: String(row.official_line ?? "") || "Unknown", productCode: String(row.product_code ?? ""),
    productName: String(row.product_name ?? "") || String(row.product_code ?? ""), regionCode: String(row.region_code ?? ""),
    units: Number(row.units ?? 0), value: Number(row.value ?? 0),
  }));
  const brickRows: BrickRow[] = (brickData as Array<Record<string, unknown>>).map((row) => ({
    areaCode: String(row.area_code ?? ""), brickId: String(row.brick_id ?? ""), distributorCode: String(row.distributor_code ?? ""),
    regionCode: String(row.region_code ?? ""), units: Number(row.units ?? 0), value: Number(row.value ?? 0),
  }));
  const customerRows: CustomerRow[] = (custData as Array<Record<string, unknown>>).map((row) => ({
    areaCode: String(row.area_code ?? ""), brickId: String(row.brick_id ?? ""), clientCode: String(row.client_code ?? ""),
    clientName: String(row.client_name ?? "") || String(row.client_code ?? ""), distributorCode: String(row.distributor_code ?? ""),
    regionCode: String(row.region_code ?? ""), units: Number(row.units ?? 0), value: Number(row.value ?? 0),
  }));

  const comparison = assembleComparison({
    brickRows, customerRows, distProductRows,
    line: ALL_LINES_LABEL,
    maps: { areaName, areaRegion, distributorName, regionName },
    masterAreas, masterBricks, period,
  });

  const byLine = rollupByLine(distProductRows);
  const lineProduct = buildLineProductMatrix(distProductRows);
  const lineByDistributor = buildValueGrid(
    distProductRows.map((row) => ({ distributorCode: row.distributorCode, key: row.officialLine, label: row.officialLine, value: row.value })),
    comparison.distributors.map((d) => d.code),
    baseMaps,
  );

  const data: ExecExportData = {
    bricks: comparison.data.bricks,
    customers: comparison.data.customers,
    distProduct: distProductRows.map((row) => ({
      areaCode: row.areaCode, areaName: nameOf(areaName, row.areaCode), distributorCode: row.distributorCode, distributorName: nameOf(distributorName, row.distributorCode),
      officialLine: row.officialLine, productCode: row.productCode, productName: row.productName, regionCode: row.regionCode, regionName: nameOf(regionName, row.regionCode),
      units: round(row.units), value: round(row.value),
    })),
    masterAreas: comparison.data.masterAreas,
    masterBricks: comparison.data.masterBricks,
  };

  const availablePeriods = [...new Set(((periodsResult.error ? [] : periodsResult.data ?? []) as Array<Record<string, unknown>>)
    .map((row) => String(row.period ?? ""))
    .filter(Boolean))]
    .sort((left, right) => right.localeCompare(left));

  return { availablePeriods, byLine, comparison, data, lineByDistributor, lineProduct, period };
}

// Cheap lookup of the validated Source of Sales periods (YYYY-MM, newest first). Used by the
// Sales Command dashboard to default to the latest month and to decide which prior/year-ago
// periods actually exist (so month-over-month / year-over-year columns never invent data).
export async function listSalesPeriods(): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const result = await supabase
    .from("source_of_sales_import_batches")
    .select("period")
    .eq("status", "validated")
    .not("period", "is", null);
  if (result.error) return [];
  return [
    ...new Set(
      ((result.data ?? []) as Array<Record<string, unknown>>)
        .map((row) => String(row.period ?? ""))
        .filter(Boolean),
    ),
  ].sort((left, right) => right.localeCompare(left));
}
