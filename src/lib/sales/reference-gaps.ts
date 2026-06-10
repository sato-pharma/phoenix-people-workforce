import { getSupabaseAdmin } from "@/lib/supabase/server";

// Source-of-Sales "Missing Data" gaps — computed LIVE by diffing the reference codes used in
// validated import rows against the master tables. There is no stored "orphan" state: the moment
// a missing master row is added, the next scan no longer reports it (and the dashboards, which
// live-join the masters, reconcile automatically). Read-only.

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

/** Set of normalized codes from a (small) master table, paging past the 1000-row cap. */
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
    // `.select(<dynamic column>)` widens to GenericStringError[] in the supabase-js types; the
    // runtime shape is plain row objects, so narrow through unknown.
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

export async function loadSalesReferenceGaps(): Promise<SalesReferenceGaps> {
  // The row scan is many paged reads; give this client a longer per-request budget.
  const supabase = getSupabaseAdmin({ requestTimeoutMs: 30000 });

  const [regionCodes, areaCodes, brickIds, productCodes, distributorCodes, batchesResult] = await Promise.all([
    masterCodeSet(supabase, "source_of_sales_regions", "region_code"),
    masterCodeSet(supabase, "source_of_sales_areas", "area_code"),
    masterCodeSet(supabase, "source_of_sales_bricks", "brick_id"),
    masterCodeSet(supabase, "source_of_sales_products", "product_code"),
    masterCodeSet(supabase, "source_of_sales_distributors", "distributor_code"),
    supabase.from("source_of_sales_import_batches").select("id,distributor_code,period,status").eq("status", "validated"),
  ]);
  if (batchesResult.error) throw batchesResult.error;

  const batches = (batchesResult.data ?? []) as Array<Record<string, unknown>>;
  const batchInfo = new Map(batches.map((b) => [String(b.id), { distributor: String(b.distributor_code ?? ""), period: String(b.period ?? "") }]));
  const validatedIds = batches.map((b) => String(b.id));

  const buckets: Record<ReferenceGapKind, Bucket> = { product: new Map(), brick: new Map(), area: new Map(), region: new Map(), distributor: new Map() };
  const bump = (kind: ReferenceGapKind, code: string, info?: { distributor: string; period: string }) => {
    let entry = buckets[kind].get(code);
    if (!entry) { entry = { rows: 0, distributors: new Set(), periods: new Set() }; buckets[kind].set(code, entry); }
    entry.rows += 1;
    if (info?.distributor) entry.distributors.add(info.distributor);
    if (info?.period) entry.periods.add(info.period);
  };

  let scannedRows = 0;
  if (validatedIds.length > 0) {
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from("source_of_sales_import_rows")
        .select("batch_id,product_code,distributor_code,region_code,area_code,brick_id,is_direct")
        .in("batch_id", validatedIds)
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      for (const row of rows) {
        scannedRows += 1;
        const info = batchInfo.get(String(row.batch_id));
        const product = norm(row.product_code);
        const distributor = norm(row.distributor_code);
        if (product && !productCodes.has(product)) bump("product", product, info);
        if (distributor && !distributorCodes.has(distributor)) bump("distributor", distributor, info);
        // Direct-channel rows are bucketed under a synthetic 'DIRECT' area and have no real
        // brick geography — skip geography checks for them to avoid false positives.
        const area = norm(row.area_code);
        if (row.is_direct !== true && area && area !== "DIRECT") {
          if (!areaCodes.has(area)) bump("area", area, info);
          const brick = norm(row.brick_id);
          if (brick && !brickIds.has(brick)) bump("brick", brick, info);
          const region = norm(row.region_code);
          if (region && !regionCodes.has(region)) bump("region", region, info);
        }
      }
      if (rows.length < pageSize) break;
    }
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
