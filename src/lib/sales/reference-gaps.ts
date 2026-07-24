import { getSupabaseAdmin } from "@/lib/supabase/server";

// Source-of-Sales "Missing Data" gaps are computed live against the master tables.
// Validated monthly uploads can be large, so this loader reads compact import summaries
// first and falls back to raw-row scanning only for legacy batches with no summaries.

export type ReferenceGapKind = "product" | "brick" | "area" | "region" | "distributor";

export type ReferenceGap = {
  /** The orphan code exactly as used in the sheets (normalized for matching). */
  code: string;
  affectedRows: number;
  distributors: string[];
  periods: string[];
};

export type ReferenceGapGroup = {
  kind: ReferenceGapKind;
  label: string;
  description: string;
  fixHref: string;
  fixLabel: string;
  totalRows: number;
  gaps: ReferenceGap[];
};

export type SalesReferenceGaps = {
  generatedAtIso: string;
  scannedRows: number;
  validatedBatches: number;
  groups: ReferenceGapGroup[];
  hasGaps: boolean;
};

const norm = (value: unknown) => String(value ?? "").trim().toUpperCase();

/** Set of normalized codes from a small master table, paging past the 1000-row cap. */
async function masterCodeSet(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  table: string,
  column: string,
): Promise<Set<string>> {
  const codes = new Set<string>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase.from(table).select(column).order(column, { ascending: true }).range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
    for (const row of rows) codes.add(norm(row[column]));
    if (rows.length < pageSize) break;
  }
  codes.delete("");
  return codes;
}

const FIX_HREF = "/sales/database-mapping";
const META: Record<ReferenceGapKind, { label: string; description: string; fixLabel: string }> = {
  product: {
    label: "Missing Products",
    description:
      "Product codes used in the sheets that have no row in the Product master. Until the product (and its factory price) is added, these rows compute a sales value of 0.",
    fixLabel: "Add in Database Mapping → Products",
  },
  brick: {
    label: "Missing Bricks",
    description:
      "Brick IDs used in the sheets with no row in the Brick master. These rows won't roll up to the right brick / area / region until the brick is added.",
    fixLabel: "Add in Database Mapping → Bricks",
  },
  area: {
    label: "Missing Areas",
    description: "Area codes used in the sheets that have no row in the Area master.",
    fixLabel: "Add in Database Mapping → Areas",
  },
  region: {
    label: "Missing Regions",
    description: "Region codes used in the sheets that have no row in the Region master.",
    fixLabel: "Add in Database Mapping → Regions",
  },
  distributor: {
    label: "Missing Distributors",
    description: "Distributor codes used in the sheets that have no row in the Distributor master.",
    fixLabel: "Add in Database Mapping → Distributors",
  },
};
const GROUP_ORDER: ReferenceGapKind[] = ["product", "brick", "area", "region", "distributor"];

type Bucket = Map<string, { rows: number; distributors: Set<string>; periods: Set<string> }>;
type BatchInfo = { distributor: string; period: string; totalRows: number };
type ReferenceSets = {
  areaCodes: Set<string>;
  brickIds: Set<string>;
  distributorCodes: Set<string>;
  productCodes: Set<string>;
  regionCodes: Set<string>;
  regionNames: Set<string>;
};

function addGap(
  buckets: Record<ReferenceGapKind, Bucket>,
  kind: ReferenceGapKind,
  code: string,
  affectedRows: number,
  distributors: Iterable<string>,
  periods: Iterable<string>,
) {
  const normalizedCode = norm(code);
  if (!normalizedCode || affectedRows <= 0) return;
  let entry = buckets[kind].get(normalizedCode);
  if (!entry) {
    entry = { rows: 0, distributors: new Set(), periods: new Set() };
    buckets[kind].set(normalizedCode, entry);
  }
  entry.rows += affectedRows;
  for (const distributor of distributors) {
    if (distributor) entry.distributors.add(distributor);
  }
  for (const period of periods) {
    if (period) entry.periods.add(period);
  }
}

async function loadSummaryRows(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  validatedIds: string[],
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  const pageSize = 1000;
  // PostgREST folds every .in() value into the request URL; validatedIds spans every validated
  // import batch ever (no `.limit()` upstream), so batch it (nested inside result-row pagination).
  for (let b = 0; b < validatedIds.length; b += 100) {
    const batchIdBatch = validatedIds.slice(b, b + 100);
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from("source_of_sales_import_summaries")
        .select("batch_id,group_type,group_code,group_label,row_count")
        .in("batch_id", batchIdBatch)
        .in("group_type", ["product", "brick", "area", "region"])
        .order("batch_id", { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      const page = (data ?? []) as Array<Record<string, unknown>>;
      rows.push(...page);
      if (page.length < pageSize) break;
    }
  }
  return rows;
}

function addSummaryGap(
  buckets: Record<ReferenceGapKind, Bucket>,
  refs: ReferenceSets,
  row: Record<string, unknown>,
  batchInfo: BatchInfo,
) {
  const kind = String(row.group_type ?? "") as ReferenceGapKind;
  if (!GROUP_ORDER.includes(kind) || kind === "distributor") return;
  const code = norm(row.group_code);
  if (!code) return;
  const affectedRows = Number(row.row_count ?? 0);
  if (affectedRows <= 0) return;

  if (kind === "product" && !refs.productCodes.has(code)) {
    addGap(buckets, kind, code, affectedRows, [batchInfo.distributor], [batchInfo.period]);
    return;
  }
  if (kind === "brick" && !refs.brickIds.has(code)) {
    addGap(buckets, kind, code, affectedRows, [batchInfo.distributor], [batchInfo.period]);
    return;
  }
  if (kind === "area" && code !== "DIRECT" && !refs.areaCodes.has(code)) {
    addGap(buckets, kind, code, affectedRows, [batchInfo.distributor], [batchInfo.period]);
    return;
  }
  if (kind === "region") {
    // Legacy summaries may carry an area code in group_code while group_label still names
    // the real region. Treat either a known code or known region label as resolved.
    const label = norm(row.group_label);
    if (!refs.regionCodes.has(code) && !refs.regionNames.has(label)) {
      addGap(buckets, kind, code, affectedRows, [batchInfo.distributor], [batchInfo.period]);
    }
  }
}

async function scanRawRowsForBatches(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  batchIds: string[],
  batchInfo: Map<string, BatchInfo>,
  refs: ReferenceSets,
  buckets: Record<ReferenceGapKind, Bucket>,
) {
  if (batchIds.length === 0) return;
  const pageSize = 1000;
  // PostgREST folds every .in() value into the request URL; batch batchIds (nested inside the
  // existing result-row pagination) since it can span the full unsummarized-batch backlog.
  for (let b = 0; b < batchIds.length; b += 100) {
    const batchIdBatch = batchIds.slice(b, b + 100);
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from("source_of_sales_import_rows")
        .select("batch_id,product_code,distributor_code,region_code,area_code,brick_id,is_direct")
        .in("batch_id", batchIdBatch)
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const info = batchInfo.get(String(row.batch_id));
        const distributors = [info?.distributor ?? ""];
        const periods = [info?.period ?? ""];
        const product = norm(row.product_code);
        const distributor = norm(row.distributor_code);
        if (product && !refs.productCodes.has(product)) addGap(buckets, "product", product, 1, distributors, periods);
        if (distributor && !refs.distributorCodes.has(distributor)) addGap(buckets, "distributor", distributor, 1, distributors, periods);

        const area = norm(row.area_code);
        if (row.is_direct !== true && area && area !== "DIRECT") {
          if (!refs.areaCodes.has(area)) addGap(buckets, "area", area, 1, distributors, periods);
          const brick = norm(row.brick_id);
          if (brick && !refs.brickIds.has(brick)) addGap(buckets, "brick", brick, 1, distributors, periods);
          const region = norm(row.region_code);
          if (region && !refs.regionCodes.has(region)) addGap(buckets, "region", region, 1, distributors, periods);
        }
      }
      if (rows.length < pageSize) break;
    }
  }
}

export async function loadSalesReferenceGaps(): Promise<SalesReferenceGaps> {
  const supabase = getSupabaseAdmin({ requestTimeoutMs: 30000 });

  const [regionCodes, regionNames, areaCodes, brickIds, productCodes, distributorCodes, batchesResult] = await Promise.all([
    masterCodeSet(supabase, "source_of_sales_regions", "region_code"),
    masterCodeSet(supabase, "source_of_sales_regions", "region_name"),
    masterCodeSet(supabase, "source_of_sales_areas", "area_code"),
    masterCodeSet(supabase, "source_of_sales_bricks", "brick_id"),
    masterCodeSet(supabase, "source_of_sales_products", "product_code"),
    masterCodeSet(supabase, "source_of_sales_distributors", "distributor_code"),
    supabase.from("source_of_sales_import_batches").select("id,distributor_code,period,status,total_rows").eq("status", "validated"),
  ]);
  if (batchesResult.error) throw batchesResult.error;

  const refs: ReferenceSets = { areaCodes, brickIds, distributorCodes, productCodes, regionCodes, regionNames };
  const batches = (batchesResult.data ?? []) as Array<Record<string, unknown>>;
  const batchInfo = new Map<string, BatchInfo>(
    batches.map((b) => [
      String(b.id),
      { distributor: String(b.distributor_code ?? ""), period: String(b.period ?? ""), totalRows: Number(b.total_rows ?? 0) },
    ]),
  );
  const validatedIds = batches.map((b) => String(b.id));
  const buckets: Record<ReferenceGapKind, Bucket> = { product: new Map(), brick: new Map(), area: new Map(), region: new Map(), distributor: new Map() };
  const scannedRows = [...batchInfo.values()].reduce((sum, batch) => sum + batch.totalRows, 0);

  if (validatedIds.length > 0) {
    for (const batch of batchInfo.values()) {
      const distributor = norm(batch.distributor);
      if (distributor && !distributorCodes.has(distributor)) {
        addGap(buckets, "distributor", distributor, batch.totalRows, [batch.distributor], [batch.period]);
      }
    }

    const summaryRows = await loadSummaryRows(supabase, validatedIds);
    const summarizedBatchIds = new Set<string>();
    for (const row of summaryRows) {
      const id = String(row.batch_id);
      const info = batchInfo.get(id);
      if (!info) continue;
      summarizedBatchIds.add(id);
      addSummaryGap(buckets, refs, row, info);
    }

    const unsummarizedIds = validatedIds.filter((id) => !summarizedBatchIds.has(id));
    await scanRawRowsForBatches(supabase, unsummarizedIds, batchInfo, refs, buckets);
  }

  const groups: ReferenceGapGroup[] = GROUP_ORDER.map((kind) => {
    const gaps: ReferenceGap[] = [...buckets[kind].entries()]
      .map(([code, entry]) => ({ code, affectedRows: entry.rows, distributors: [...entry.distributors].sort(), periods: [...entry.periods].sort() }))
      .sort((left, right) => right.affectedRows - left.affectedRows);
    return {
      kind,
      label: META[kind].label,
      description: META[kind].description,
      fixHref: FIX_HREF,
      fixLabel: META[kind].fixLabel,
      totalRows: gaps.reduce((sum, gap) => sum + gap.affectedRows, 0),
      gaps,
    };
  }).filter((group) => group.gaps.length > 0);

  return {
    generatedAtIso: new Date().toISOString(),
    scannedRows,
    validatedBatches: batches.length,
    groups,
    hasGaps: groups.length > 0,
  };
}
