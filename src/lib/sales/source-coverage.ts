// Source Coverage — which SOURCES fed a month's closing, compared to the month before.
//
// WHY THIS EXISTS (audit, 2026-08-04). July 2026's closing was built on 4 of the ~18 source files
// June had — EPDA-BULK, Ibn Sina, Ramco, Marcyrl, the EGD family and others were simply absent,
// and the Anti Infective Direct sheet carried 3 regions where June carried 8. Every number on the
// sheet was arithmetically exact, and the owner still (rightly) refused to trust it, because
// NOTHING on any tab said "this month is missing most of its inputs". The closing showed
// composition, never completeness. This module is the completeness half: per distributor (and,
// for the Direct channel, per region), what fed last month vs what has fed this month so far.
//
// It deliberately mirrors the closing's own bases so its numbers tie to the headline the reader
// is staring at: distributor rows are valued effective_units × factory_price and Direct rows at
// their submitted direct_value, confidential products (LA003/LA004/SS001) are skipped — exactly
// the phx_monthly_closing_matrix / phx_monthly_closing_direct predicates.
//
// This is COVERAGE, not blame: a source can be legitimately absent (no business that month, or a
// merged file — July's EPDA-Pharmacies file already carried roughly June's PHS+BULK combined).
// The output states what is absent and how big it was last month; deciding why is the owner's.
//
// `import-coverage.ts` next door answers a different question — how well one upload's rows mapped
// to bricks. This module answers whether the upload happened at all.

import { normalizeLineKey } from "@/lib/sales/access-scope";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** Mirrors the confidential exclusion baked into both closing RPCs. */
const CONFIDENTIAL_PRODUCT_CODES = new Set(["LA003", "LA004", "SS001"]);

const PAGE = 1000;

export type SourceCoverageStatus = "present" | "missing" | "new";

export type SourceCoverageEntry = {
  /** Distributor code, or region code for the Direct-channel breakdown. */
  key: string;
  /** Human-readable name (standing rule: names, never raw codes). */
  name: string;
  prevUnits: number;
  prevValue: number;
  curUnits: number;
  curValue: number;
  /**
   * Presence is decided on ROWS, not value: a source whose rows net to zero value is still
   * present, and a credit-note-only month (negative value) must not read as "missing".
   */
  status: SourceCoverageStatus;
};

export type MonthlySourceCoverage = {
  line: string;
  period: string;
  prevPeriod: string;
  /** False when the previous month has no validated batches at all — nothing to compare against. */
  hasPrevData: boolean;
  /** Every source seen in either month, biggest last-month value first. */
  sources: SourceCoverageEntry[];
  /** Direct-channel rows per region — catches "the Direct sheet arrived but half its regions did not". */
  directRegions: SourceCoverageEntry[];
  /** Derived: sources with rows last month and none this month, biggest first. */
  missingSources: SourceCoverageEntry[];
  missingDirectRegions: SourceCoverageEntry[];
  prevSourceCount: number;
  /** Last-month value of everything currently missing — the scale of the hole. */
  missingPrevValue: number;
  /** Latest validated upload for the CURRENT month (ISO), i.e. how fresh this month's data is. */
  latestUploadAt: string | null;
};

/** "2026-07" → "2026-06". Null for anything that is not a YYYY-MM string. */
export function previousPeriod(period: string | null | undefined): string | null {
  const match = /^(\d{4})-(\d{2})$/.exec(String(period ?? "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  return `${prevYear}-${String(prevMonth).padStart(2, "0")}`;
}

/** One aggregated side (per key): row presence plus the closing-basis units and value. */
export type CoverageAggregate = { rows: number; units: number; value: number };

export type CoverageFactRow = {
  distributorCode: string;
  regionCode: string;
  isDirect: boolean;
  productCode: string;
  period: string;
  totalQty: number;
  effectiveUnits: number;
  directValue: number;
};

export type CoverageAggregates = {
  sourcesPrev: Map<string, CoverageAggregate>;
  sourcesCur: Map<string, CoverageAggregate>;
  directPrev: Map<string, CoverageAggregate>;
  directCur: Map<string, CoverageAggregate>;
};

function bump(map: Map<string, CoverageAggregate>, key: string, units: number, value: number) {
  const entry = map.get(key) ?? { rows: 0, units: 0, value: 0 };
  entry.rows += 1;
  entry.units += units;
  entry.value += value;
  map.set(key, entry);
}

/**
 * Pure aggregation over rollup-shaped rows. Value follows the closing exactly:
 * Direct rows carry their submitted value; distributor rows are effective_units × factory price
 * (a product with no price contributes 0, the same as the matrix RPC's coalesce). Confidential
 * products are skipped on both sides so the totals here relate to the published headline.
 */
export function aggregateCoverage(
  rows: readonly CoverageFactRow[],
  input: { period: string; prevPeriod: string; factoryPriceByProduct: ReadonlyMap<string, number> },
): CoverageAggregates {
  const aggregates: CoverageAggregates = {
    sourcesPrev: new Map(),
    sourcesCur: new Map(),
    directPrev: new Map(),
    directCur: new Map(),
  };

  for (const row of rows) {
    const productCode = row.productCode.trim().toUpperCase();
    if (CONFIDENTIAL_PRODUCT_CODES.has(productCode)) continue;

    const isCurrent = row.period === input.period;
    const isPrevious = row.period === input.prevPeriod;
    if (!isCurrent && !isPrevious) continue;

    const value = row.isDirect
      ? row.directValue
      : row.effectiveUnits * (input.factoryPriceByProduct.get(productCode) ?? 0);

    const sourceKey = row.distributorCode.trim() || "(unknown source)";
    bump(isCurrent ? aggregates.sourcesCur : aggregates.sourcesPrev, sourceKey, row.totalQty, value);

    if (row.isDirect) {
      const regionKey = row.regionCode.trim().toUpperCase() || "(no region)";
      bump(isCurrent ? aggregates.directCur : aggregates.directPrev, regionKey, row.totalQty, value);
    }
  }

  return aggregates;
}

/**
 * Pure classification of prev vs current aggregates into coverage entries.
 * Status is decided on row presence (see SourceCoverageEntry.status). Sorted biggest
 * last-month value first so the largest hole is always the first row a reader sees.
 */
export function classifyCoverage(
  prev: ReadonlyMap<string, CoverageAggregate>,
  cur: ReadonlyMap<string, CoverageAggregate>,
  nameFor: (key: string) => string,
): SourceCoverageEntry[] {
  const keys = new Set<string>([...prev.keys(), ...cur.keys()]);
  const entries: SourceCoverageEntry[] = [];
  for (const key of keys) {
    const before = prev.get(key);
    const now = cur.get(key);
    const status: SourceCoverageStatus =
      (before?.rows ?? 0) > 0 && (now?.rows ?? 0) === 0
        ? "missing"
        : (before?.rows ?? 0) === 0 && (now?.rows ?? 0) > 0
          ? "new"
          : "present";
    entries.push({
      key,
      name: nameFor(key) || key,
      prevUnits: before?.units ?? 0,
      prevValue: Number((before?.value ?? 0).toFixed(2)),
      curUnits: now?.units ?? 0,
      curValue: Number((now?.value ?? 0).toFixed(2)),
      status,
    });
  }
  return entries.sort(
    (left, right) => right.prevValue - left.prevValue || left.name.localeCompare(right.name),
  );
}

/**
 * Read every rollup row of one line for the two periods, keyset-paged on the bigint id.
 * `.range()` offset paging without a stable order has dropped rows in this repo before, so the
 * cursor pattern from monthly-closing-details is reused verbatim.
 */
async function readCoverageRows(line: string, periods: string[]): Promise<CoverageFactRow[]> {
  const supabase = getSupabaseAdmin();
  const wanted = normalizeLineKey(line);
  const rows: CoverageFactRow[] = [];
  let cursor: number | null = null;
  for (;;) {
    let query = supabase
      .from("source_of_sales_fact_rollup")
      .select("id,official_line,distributor_code,region_code,is_direct,product_code,period,total_qty,effective_units,direct_value")
      .in("period", periods)
      // Server-side narrow first — ilike with no wildcard is case-insensitive equality, which
      // cuts the two-month fetch to one line's rows instead of the whole company's (~50k). The
      // normalizeLineKey re-check below stays as the correctness net for spacing variants.
      .ilike("official_line", line.trim())
      .order("id", { ascending: true })
      .limit(PAGE);
    if (cursor !== null) query = query.gt("id", cursor);

    const { data, error } = await query;
    if (error) throw error;
    const page = (data ?? []) as Array<Record<string, unknown>>;
    if (page.length === 0) break;
    for (const row of page) {
      // Line filtering happens HERE, with the same normalizer the details module uses — the raw
      // eq/ilike operators cannot express lower(btrim()) and a padded line value would silently
      // vanish from coverage while still counting in the closing RPCs.
      if (normalizeLineKey(String(row.official_line ?? "")) !== wanted) continue;
      rows.push({
        distributorCode: String(row.distributor_code ?? ""),
        regionCode: String(row.region_code ?? ""),
        isDirect: Boolean(row.is_direct),
        productCode: String(row.product_code ?? ""),
        period: String(row.period ?? ""),
        totalQty: Number(row.total_qty ?? 0),
        effectiveUnits: Number(row.effective_units ?? 0),
        directValue: Number(row.direct_value ?? 0),
      });
    }
    if (page.length < PAGE) break;
    const last = Number(page[page.length - 1]?.id);
    if (!Number.isFinite(last)) break; // no usable cursor — stop rather than loop forever
    cursor = last;
  }
  return rows;
}

/**
 * The completeness picture for one line and month. Null when there is nothing to compare —
 * no line, no period, or a period that is not YYYY-MM. Never throws for "no data": an empty
 * month yields entries that are all "missing", which is exactly the truth worth showing.
 */
export async function loadMonthlySourceCoverage(
  line: string | null | undefined,
  period: string | null | undefined,
): Promise<MonthlySourceCoverage | null> {
  const selectedLine = String(line ?? "").trim();
  const selectedPeriod = String(period ?? "").trim();
  const prevPeriod = previousPeriod(selectedPeriod);
  if (!selectedLine || !selectedPeriod || !prevPeriod) return null;

  const supabase = getSupabaseAdmin();
  const [rows, batchesResult, productsResult, regionsResult] = await Promise.all([
    readCoverageRows(selectedLine, [selectedPeriod, prevPeriod]),
    supabase
      .from("source_of_sales_import_batches")
      .select("distributor_code,distributor_name,period,created_at")
      .eq("status", "validated")
      .in("period", [selectedPeriod, prevPeriod]),
    supabase.from("source_of_sales_products").select("product_code,factory_price").eq("active", true),
    supabase.from("source_of_sales_regions").select("region_code,region_name"),
  ]);
  if (batchesResult.error) throw batchesResult.error;
  if (productsResult.error) throw productsResult.error;
  if (regionsResult.error) throw regionsResult.error;

  const factoryPriceByProduct = new Map<string, number>();
  for (const row of productsResult.data ?? []) {
    const typed = row as { product_code?: unknown; factory_price?: unknown };
    const code = String(typed.product_code ?? "").trim().toUpperCase();
    if (code) factoryPriceByProduct.set(code, Number(typed.factory_price ?? 0));
  }

  // Latest human-entered name per distributor code, and the freshness stamp for this month.
  const sourceNameByCode = new Map<string, string>();
  let hasPrevData = false;
  let latestUploadAt: string | null = null;
  for (const row of batchesResult.data ?? []) {
    const typed = row as { distributor_code?: unknown; distributor_name?: unknown; period?: unknown; created_at?: unknown };
    const code = String(typed.distributor_code ?? "").trim();
    const name = String(typed.distributor_name ?? "").trim();
    if (code && name && !sourceNameByCode.has(code)) sourceNameByCode.set(code, name);
    const batchPeriod = String(typed.period ?? "");
    if (batchPeriod === prevPeriod) hasPrevData = true;
    if (batchPeriod === selectedPeriod) {
      const createdAt = String(typed.created_at ?? "");
      if (createdAt && (!latestUploadAt || createdAt > latestUploadAt)) latestUploadAt = createdAt;
    }
  }

  const regionNameByCode = new Map<string, string>();
  for (const row of regionsResult.data ?? []) {
    const typed = row as { region_code?: unknown; region_name?: unknown };
    const code = String(typed.region_code ?? "").trim().toUpperCase();
    const name = String(typed.region_name ?? "").trim();
    if (code && name) regionNameByCode.set(code, name);
  }

  const aggregates = aggregateCoverage(rows, {
    period: selectedPeriod,
    prevPeriod,
    factoryPriceByProduct,
  });

  const sources = classifyCoverage(
    aggregates.sourcesPrev,
    aggregates.sourcesCur,
    (key) => sourceNameByCode.get(key) ?? key,
  );
  const directRegions = classifyCoverage(
    aggregates.directPrev,
    aggregates.directCur,
    (key) => regionNameByCode.get(key) ?? key,
  );

  const missingSources = sources.filter((entry) => entry.status === "missing");
  const missingDirectRegions = directRegions.filter((entry) => entry.status === "missing");

  return {
    line: selectedLine,
    period: selectedPeriod,
    prevPeriod,
    hasPrevData,
    sources,
    directRegions,
    missingSources,
    missingDirectRegions,
    prevSourceCount: aggregates.sourcesPrev.size,
    missingPrevValue: Number(
      missingSources.reduce((sum, entry) => sum + entry.prevValue, 0).toFixed(2),
    ),
    latestUploadAt,
  };
}
