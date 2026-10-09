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
// is staring at: distributor rows are valued effective_units × the factory price OF THEIR MONTH and
// Direct rows at their submitted direct_value, confidential products (LA003/LA004/SS001) are
// skipped — exactly the phx_monthly_closing_matrix / phx_monthly_closing_direct predicates.
//
// This is COVERAGE, not blame: a source can be legitimately absent (no business that month, or a
// merged file — July's EPDA-Pharmacies file already carried roughly June's PHS+BULK combined).
// The output states what is absent and how big it was last month; deciding why is the owner's.
//
// `import-coverage.ts` next door answers a different question — how well one upload's rows mapped
// to bricks. This module answers whether the upload happened at all.

import { normalizeLineKey } from "@/lib/sales/access-scope";
import { maskSourceCoverage, type SourceMaskViewer } from "@/lib/sales/closing-source-mask";
import { DIRECT_CHANNEL_CODE, canonicalDistributorKey } from "@/lib/sales/direct-channel";
import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import { loadProductPeriodPrices, type ProductPeriodPrices } from "@/lib/sales/product-period-price";
import { sourceQuietIn } from "@/lib/sales/source-quiet-periods";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** Mirrors the confidential exclusion baked into both closing RPCs. */
const CONFIDENTIAL_PRODUCT_CODES = new Set(["LA003", "LA004", "SS001"]);

const PAGE = 1000;

/**
 * The Direct channel changed SOURCE, not identity — so both codes share ONE coverage key.
 *
 * Until 2026-07 direct sales arrived as an uploaded "Direct (Company)" sheet under distributor
 * code DIRECT. From 2026-08 they come from the Direct Request module and land under DirectReq.
 * Owner, 2026-09-04: "no more direct that will be uploaded like this — the source of direct sales
 * is the direct request module."
 *
 * Without this alias the comparison reads the retired upload as a source that vanished, so EVERY
 * month from August 2026 onward warns "is missing 1 of the 4 sources that fed <last month> —
 * Direct (Company) … Totals are understated until these arrive", naming a file that will never
 * arrive again, on a closing that is in fact complete. Anti Infective August 2026 was the first:
 * flagged incomplete while holding all four of its sources.
 *
 * The alias set itself now lives in `direct-channel.ts`, shared. It had already drifted into three
 * independent copies of the same two strings, and the SoS dashboard held a fourth that matched the
 * literal "direct" alone — which reported every DirectReq sale as a distributor.
 */
const DIRECT_CHANNEL_KEY = DIRECT_CHANNEL_CODE;

/**
 * Coverage key for a distributor code: the import normalization, plus the Direct-channel fold.
 * Exported so the tests pin the fold rather than re-deriving it.
 */
export const canonicalSourceKey = canonicalDistributorKey;

/** True when this month's direct rows come from the module rather than an uploaded sheet. */
export function isDirectModuleSourced(rows: readonly CoverageFactRow[], period: string): boolean {
  let sawDirect = false;
  for (const row of rows) {
    if (!row.isDirect || row.period !== period) continue;
    sawDirect = true;
    if (normalizeCodeKey(row.distributorCode) !== DIRECT_CHANNEL_KEY) return false;
  }
  return sawDirect;
}

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
  /**
   * Derived: sources with rows last month and none this month, biggest first — MINUS the ones the
   * owner has declared quiet for this period, which are in `quietSources` instead.
   */
  missingSources: SourceCoverageEntry[];
  /**
   * Absent because the OWNER said so, not because an upload is owed — see `source-quiet-periods.ts`.
   *
   * Held apart rather than dropped: the month really is lighter than the one before it, and a
   * reader comparing the two deserves to know which books are not coming. What it must NOT do is
   * read as a hole that will be filled. Same shape as the Direct-region suppression below — the
   * per-source table keeps every row, only the alarm that promises an arrival goes.
   */
  quietSources: SourceCoverageEntry[];
  missingDirectRegions: SourceCoverageEntry[];
  /**
   * True when this month's direct rows come from the Direct Request module. The per-region
   * drop-out warning is meaningless then — see the suppression in loadMonthlySourceCoverage.
   */
  directModuleSourced: boolean;
  prevSourceCount: number;
  /**
   * Last-month value of everything currently missing — the scale of the hole.
   *
   * Counts `missingSources` only. A declared-quiet source contributes nothing, because the sentence
   * this number is rendered inside says value is absent UNTIL IT ARRIVES, and that is the claim the
   * owner struck out.
   */
  missingPrevValue: number;
  /** Last-month value of the declared-quiet sources — the honest size of the difference. */
  quietPrevValue: number;
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
 * Direct rows carry their submitted value; distributor rows are effective_units × the factory price
 * of the row's OWN month (a product with no price contributes 0, the same as the matrix RPC's
 * coalesce). Confidential products are skipped on both sides so the totals here relate to the
 * published headline.
 *
 * 🔴 PRICED PER MONTH, because the two columns can straddle a reprice. Saginko is 111.15 through
 * 2026-09 and 170.52 from 2026-10 while the product master stays 111.15, and the Matrix prices each
 * month through `phx_factory_price(code, f.period)`. One flat master-price map, as this took until
 * 2026-10-01, would have shown October's Saginko at 111.15 beside a Matrix at 170.52 — and November's
 * "last month" column the same way. `row.period` is the rollup's own month, the Matrix's `f.period`.
 */
export function aggregateCoverage(
  rows: readonly CoverageFactRow[],
  input: { period: string; prevPeriod: string; prices: Pick<ProductPeriodPrices, "priceFor"> },
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
      : row.effectiveUnits * (input.prices.priceFor(productCode, row.period) ?? 0);

    // Normalized the same way resolvers.ts keys a distributor code during import — case (and
    // Arabic-digit) drift between periods must not read as two different sources. This is the
    // exact shape of the 2026-07 bug: "DIRECT" fed Anti Infective while "Direct" fed Pedia that
    // same month, and the un-normalized key made each look like it vanished while a stranger
    // "arrived" in its place, on a line that had not actually lost anything.
    const sourceKey = canonicalSourceKey(row.distributorCode) || "(unknown source)";
    bump(isCurrent ? aggregates.sourcesCur : aggregates.sourcesPrev, sourceKey, row.totalQty, value);

    if (row.isDirect) {
      const regionKey = row.regionCode.trim().toUpperCase() || "(no region)";
      bump(isCurrent ? aggregates.directCur : aggregates.directPrev, regionKey, row.totalQty, value);
    }
  }

  return aggregates;
}

/**
 * Split the sources absent this month into the ones still OWED and the ones the owner has declared
 * quiet — `source-quiet-periods.ts`.
 *
 * 🔴 WHY THIS IS A FUNCTION AND NOT THREE LINES IN THE LOADER. The loader needs a database, so a
 * rule living inside it can only ever be pinned by reading the source — and this one decides
 * whether a complete month announces itself as incomplete. Here it can be executed.
 *
 * Entries that are not `missing` are in neither list: a source that FILED is present, whatever any
 * declaration says, so the data always outvotes the owner's word in the direction that matters.
 */
export function partitionAbsentSources(
  sources: readonly SourceCoverageEntry[],
  period: string,
): { missing: SourceCoverageEntry[]; quiet: SourceCoverageEntry[] } {
  const missing: SourceCoverageEntry[] = [];
  const quiet: SourceCoverageEntry[] = [];
  for (const entry of sources) {
    if (entry.status !== "missing") continue;
    if (sourceQuietIn(entry.key, period)) quiet.push(entry);
    else missing.push(entry);
  }
  return { missing, quiet };
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
  // REQUIRED: every source is listed by distributor name, and El Qema's must reach nobody but Super
  // Admin (owner, 2026-09-14). The entry keeps its figures; only the name is relabelled.
  viewer: SourceMaskViewer,
): Promise<MonthlySourceCoverage | null> {
  const selectedLine = String(line ?? "").trim();
  const selectedPeriod = String(period ?? "").trim();
  const prevPeriod = previousPeriod(selectedPeriod);
  if (!selectedLine || !selectedPeriod || !prevPeriod) return null;

  const supabase = getSupabaseAdmin();
  const [rows, batchesResult, prices, regionsResult] = await Promise.all([
    readCoverageRows(selectedLine, [selectedPeriod, prevPeriod]),
    supabase
      .from("source_of_sales_import_batches")
      .select("distributor_code,distributor_name,period,created_at")
      .eq("status", "validated")
      .in("period", [selectedPeriod, prevPeriod]),
    // Each month's own price, never the product master's flat one — see aggregateCoverage.
    loadProductPeriodPrices(),
    supabase.from("source_of_sales_regions").select("region_code,region_name"),
  ]);
  if (batchesResult.error) throw batchesResult.error;
  if (regionsResult.error) throw regionsResult.error;

  // Latest human-entered name per distributor code, and the freshness stamp for this month.
  const sourceNameByCode = new Map<string, string>();
  let hasPrevData = false;
  let latestUploadAt: string | null = null;
  for (const row of batchesResult.data ?? []) {
    const typed = row as { distributor_code?: unknown; distributor_name?: unknown; period?: unknown; created_at?: unknown };
    // Same normalization as the sourceKey above, so a name registered under one case of a code
    // (e.g. a batch stamped "Direct") is still found when the aggregate key is "DIRECT".
    const code = canonicalSourceKey(typed.distributor_code);
    const name = String(typed.distributor_name ?? "").trim();
    const batchPeriod = String(typed.period ?? "");
    // The CURRENT month's name wins. Two codes now fold onto one key (DIRECT + DirectReq), and
    // first-seen would label the live channel with the retired sheet's name at random.
    if (code && name && (batchPeriod === selectedPeriod || !sourceNameByCode.has(code))) {
      sourceNameByCode.set(code, name);
    }
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
    prices,
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

  // 🔴 A SOURCE THE OWNER SAYS IS NOT FILING THIS MONTH IS NOT A HOLE (owner, 2026-10-09: "fix the
  // closing banner that still calls epda and mec a hole"). September CNS read "missing 2 of the 13
  // sources that fed 2026-08 — epda, mec … Totals are understated until these arrive" on a month he
  // had already declared complete, promising two books that are never going to come. Exactly the
  // false alarm the Direct-module suppression below removes, and answered the same way: the entries
  // stay in `sources` and in the per-source table, so nothing is hidden — they just stop being
  // counted as owed. `sourceQuietIn` is period-scoped, so October expects both again, and the data
  // still outvotes it: a book that arrives is `present` and never reaches this branch at all.
  const { missing: missingSources, quiet: quietSources } = partitionAbsentSources(sources, selectedPeriod);
  // A region that raised no direct request this month is business reality, not a missing upload —
  // and every consumer of missingDirectRegions renders it as "The Direct sheet has nothing yet
  // from X. Totals are understated until these arrive", which is false once the module is the
  // source. The per-region table (directRegions) is untouched, so nothing is hidden, only the
  // alarm that promises an arrival.
  const directModuleSourced = isDirectModuleSourced(rows, selectedPeriod);
  const missingDirectRegions = directModuleSourced
    ? []
    : directRegions.filter((entry) => entry.status === "missing");

  // 🔒 Masked on the way out, after missingPrevValue has summed the real entries.
  return maskSourceCoverage({
    line: selectedLine,
    period: selectedPeriod,
    prevPeriod,
    hasPrevData,
    sources,
    directRegions,
    missingSources,
    quietSources,
    missingDirectRegions,
    directModuleSourced,
    prevSourceCount: aggregates.sourcesPrev.size,
    missingPrevValue: Number(
      missingSources.reduce((sum, entry) => sum + entry.prevValue, 0).toFixed(2),
    ),
    quietPrevValue: Number(
      quietSources.reduce((sum, entry) => sum + entry.prevValue, 0).toFixed(2),
    ),
    latestUploadAt,
  }, viewer);
}
