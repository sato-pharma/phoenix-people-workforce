import {
  applyLineRegionScope,
  canonicalizeRegionName,
  stripRestrictedRows,
  type SalesAccessScope,
} from "@/lib/sales/access-scope";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// Sales Intelligence loaders — the single safe path from the phx_si_* RPCs to scoped,
// name-resolved rows. Every loader: (1) passes the scope's exclusion + line + region filters
// into SQL, (2) re-strips restricted product rows in TS (defense in depth), and (3) applies
// line/region scope again in TS for the distributor×product grain. Raw fact rows never leave
// the server — these aggregates are already grouped to a few hundred leaf rows.
// ─────────────────────────────────────────────────────────────────────────────

export type SiDistProductRow = {
  distributorCode: string;
  officialLine: string;
  regionCode: string;
  areaCode: string;
  productCode: string;
  productName: string;
  units: number;
  value: number;
};

export type SiBrickRow = {
  distributorCode: string;
  regionCode: string;
  areaCode: string;
  brickId: string;
  units: number;
  value: number;
};

export type SiCustomerRow = {
  clientCode: string;
  clientName: string;
  distributorCode: string;
  regionCode: string;
  areaCode: string;
  brickId: string;
  units: number;
  value: number;
};

export type SiReference = {
  /** region_code → display name */
  regionName: Map<string, string>;
  /** area_code → display name */
  areaName: Map<string, string>;
  /** distributor_code → display name */
  distributorName: Map<string, string>;
  /** brick_id → display name */
  brickName: Map<string, string>;
  /** canonical region name (incl. aliases) → region codes */
  regionCodesByCanonicalName: Map<string, string[]>;
};

const num = (value: unknown) => Number(value ?? 0);
const str = (value: unknown) => String(value ?? "");

/**
 * Load the reference name masters used to render everything BY NAME, plus the region
 * name→code index (master names + aliases) used to translate a viewer's region scope into
 * the region codes the fact rows carry. Skips the heavy customer→brick crosswalk.
 */
export async function loadSiReference(): Promise<SiReference> {
  const supabase = getSupabaseAdmin();
  const [references, brickResult, aliasResult, areaResult] = await Promise.all([
    loadSalesReferenceData({ includeCustomerBricks: false }),
    supabase.from("source_of_sales_bricks").select("brick_id,brick_name").eq("active", true),
    supabase
      .from("source_of_sales_region_aliases")
      .select("region_code,alias,normalized_alias")
      .eq("active", true),
    // The import rows stored the area CODE as the area_name (AB5 → "AB5"); the authoritative
    // human names (AB5 → "Behira 2", D14 → "Gharbia 1 (Tanta)") live in this master. Load it
    // directly so the dashboard never shows raw area codes.
    supabase.from("source_of_sales_areas").select("area_code,area_name").eq("active", true),
  ]);

  const regionName = new Map<string, string>();
  const areaName = new Map<string, string>();
  const distributorName = new Map<string, string>();
  const brickName = new Map<string, string>();
  const regionCodesByCanonicalName = new Map<string, string[]>();

  const addRegionAlias = (canonical: string, code: string) => {
    if (!canonical || !code) return;
    const list = regionCodesByCanonicalName.get(canonical) ?? [];
    if (!list.includes(code)) list.push(code);
    regionCodesByCanonicalName.set(canonical, list);
  };

  references.regions.forEach((region) => {
    if (!region.regionCode) return;
    const display = region.regionName || region.regionCode;
    regionName.set(region.regionCode, display);
    addRegionAlias(canonicalizeRegionName(display), region.regionCode);
    addRegionAlias(canonicalizeRegionName(region.regionCode), region.regionCode);
  });
  (references.areas ?? []).forEach((area) => {
    if (area.areaCode) areaName.set(area.areaCode, area.areaName || area.areaCode);
  });
  // Override with the authoritative area master — real human names, never the raw code.
  if (!areaResult.error) {
    for (const row of (areaResult.data ?? []) as Array<Record<string, unknown>>) {
      const code = str(row.area_code);
      const name = str(row.area_name);
      // Only take a name that is actually friendlier than the code itself.
      if (code && name && name.toUpperCase() !== code.toUpperCase()) areaName.set(code, name);
    }
  }
  // The Direct channel carries no area; phx_si_distributor_product buckets it under 'DIRECT'.
  areaName.set("DIRECT", "Direct (company)");
  references.distributors.forEach((distributor) => {
    if (distributor.code) distributorName.set(distributor.code, distributor.name || distributor.code);
  });

  if (!brickResult.error) {
    for (const row of (brickResult.data ?? []) as Array<Record<string, unknown>>) {
      const id = str(row.brick_id);
      if (id) brickName.set(id, str(row.brick_name) || id);
    }
  }
  if (!aliasResult.error) {
    for (const row of (aliasResult.data ?? []) as Array<Record<string, unknown>>) {
      const code = str(row.region_code);
      addRegionAlias(canonicalizeRegionName(str(row.alias)), code);
      addRegionAlias(canonicalizeRegionName(str(row.normalized_alias)), code);
    }
  }

  return { regionName, areaName, distributorName, brickName, regionCodesByCanonicalName };
}

/**
 * Translate a scope's allowed region NAMES into the region CODES the fact rows carry.
 * Returns null (no region restriction — line scope still bounds the viewer) when the scope
 * is region-unbounded OR when the viewer's region name cannot be mapped to any known code.
 */
export function resolveAllowedRegionCodes(
  scope: SalesAccessScope,
  reference: SiReference,
): Set<string> | null {
  if (!scope.allowedRegionNames) return null;
  const codes = new Set<string>();
  for (const name of scope.allowedRegionNames) {
    for (const code of reference.regionCodesByCanonicalName.get(name) ?? []) codes.add(code);
  }
  return codes.size > 0 ? codes : null;
}

type SiRpcArgs = {
  p_exclude_codes: string[];
  p_lines: string[];
  p_regions: string[];
};

/** Build the SQL-side scope arguments shared by all three SI RPCs. */
export function buildSiRpcArgs(scope: SalesAccessScope, reference: SiReference): {
  args: SiRpcArgs;
  allowedRegionCodes: Set<string> | null;
} {
  const allowedRegionCodes = resolveAllowedRegionCodes(scope, reference);
  return {
    allowedRegionCodes,
    args: {
      p_exclude_codes: scope.excludedProductCodes,
      p_lines: scope.allowedLineNames ? [...scope.allowedLineNames] : [],
      p_regions: allowedRegionCodes ? [...allowedRegionCodes] : [],
    },
  };
}

export async function loadSiDistProduct(
  period: string | null,
  scope: SalesAccessScope,
  reference: SiReference,
): Promise<SiDistProductRow[]> {
  const supabase = getSupabaseAdmin({ requestTimeoutMs: 30000 });
  const { args, allowedRegionCodes } = buildSiRpcArgs(scope, reference);
  const data = await rpcAll(
    supabase,
    "phx_si_distributor_product",
    { p_period: period, ...args },
    ["distributor_code", "official_line", "region_code", "area_code", "product_code"],
  );
  const rows: SiDistProductRow[] = (data as Array<Record<string, unknown>>).map((row) => ({
    distributorCode: str(row.distributor_code),
    officialLine: str(row.official_line),
    regionCode: str(row.region_code),
    areaCode: str(row.area_code),
    productCode: str(row.product_code),
    productName: str(row.product_name) || str(row.product_code),
    units: num(row.units),
    value: num(row.value),
  }));
  // Defense in depth: re-strip restricted products and re-apply line/region scope in TS even
  // though the RPC already did both in SQL.
  return applyLineRegionScope(stripRestrictedRows(rows, scope.excludedProductCodes), {
    allowedLineNames: scope.allowedLineNames,
    allowedRegionCodes,
  });
}

export async function loadSiBrick(
  period: string | null,
  scope: SalesAccessScope,
  reference: SiReference,
): Promise<SiBrickRow[]> {
  const supabase = getSupabaseAdmin({ requestTimeoutMs: 30000 });
  const { args, allowedRegionCodes } = buildSiRpcArgs(scope, reference);
  const data = await rpcAll(
    supabase,
    "phx_si_brick",
    { p_period: period, ...args },
    ["distributor_code", "region_code", "area_code", "brick_id"],
  );
  const rows: SiBrickRow[] = (data as Array<Record<string, unknown>>).map((row) => ({
    distributorCode: str(row.distributor_code),
    regionCode: str(row.region_code),
    areaCode: str(row.area_code),
    brickId: str(row.brick_id),
    units: num(row.units),
    value: num(row.value),
  }));
  // Brick rows have no line/product dimension (line scope was enforced in SQL). Region scope
  // is re-applied here as defense in depth.
  return applyLineRegionScope(rows, { allowedLineNames: null, allowedRegionCodes });
}

export type SiPeriodTotalRow = {
  period: string;
  units: number;
  value: number;
  customerCount: number;
  productCount: number;
  areaCount: number;
};

/**
 * One grouped scan across ALL validated months: per-period totals + distinct customer/product/
 * area counts. Replaces the O(months) sequential trend loop and feeds headline MoM/YoY and every
 * KPI sparkline. Restricted-product exclusion and line/region scope are enforced in SQL.
 */
export async function loadSiPeriodTotals(
  scope: SalesAccessScope,
  reference: SiReference,
): Promise<SiPeriodTotalRow[]> {
  const supabase = getSupabaseAdmin({ requestTimeoutMs: 30000 });
  const { args } = buildSiRpcArgs(scope, reference);
  const data = await rpcAll(supabase, "phx_si_period_totals", { ...args }, ["period"]);
  return (data as Array<Record<string, unknown>>)
    .map((row) => ({
      period: str(row.period),
      units: num(row.units),
      value: num(row.value),
      customerCount: num(row.customer_count),
      productCount: num(row.product_count),
      areaCount: num(row.area_count),
    }))
    .filter((row) => row.period)
    .sort((left, right) => left.period.localeCompare(right.period));
}

export type SiDailyRow = {
  /** ISO date, or null = the undated bucket (rows whose day could not be parsed). */
  invoiceDate: string | null;
  distributorCode: string;
  units: number;
  value: number;
  customerCount: number;
};

/**
 * Day grain for ONE month (sales + active customers per day, per distributor). The RPC returns
 * nothing for a null period (a day-grain scan across history is never allowed) and includes the
 * NULL-date bucket so undated residue is reported honestly.
 */
export async function loadSiDaily(
  period: string,
  scope: SalesAccessScope,
  reference: SiReference,
  filter?: { productCodes?: string[]; distributorCodes?: string[] },
): Promise<SiDailyRow[]> {
  const supabase = getSupabaseAdmin({ requestTimeoutMs: 30000 });
  const { args } = buildSiRpcArgs(scope, reference);
  // ≤ ~31 days × distributors + the undated bucket — bounded, single fetch.
  const { data, error } = await supabase.rpc("phx_si_daily", {
    p_period: period,
    ...args,
    p_product_codes: filter?.productCodes ?? [],
    p_distributor_codes: filter?.distributorCodes ?? [],
  });
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    invoiceDate: row.invoice_date === null || row.invoice_date === undefined ? null : str(row.invoice_date),
    distributorCode: str(row.distributor_code),
    units: num(row.units),
    value: num(row.value),
    customerCount: num(row.customer_count),
  }));
}

export type SiCustomerProductRow = {
  clientCode: string;
  clientName: string;
  distributorCode: string;
  regionCode: string;
  areaCode: string;
  productCode: string;
  productName: string;
  units: number;
  value: number;
};

/**
 * Bounded customer×product drill (the 28,877-pair grain). FAIL-CLOSED: callers MUST narrow by
 * product and/or client codes — with both empty this throws (and the SQL independently returns
 * zero rows). Output is value-ranked and LIMIT-clamped in SQL (≤500).
 */
export async function loadSiCustomerProduct(
  period: string,
  scope: SalesAccessScope,
  reference: SiReference,
  filter: { productCodes?: string[]; clientCodes?: string[]; limit?: number },
): Promise<SiCustomerProductRow[]> {
  const productCodes = (filter.productCodes ?? []).filter(Boolean);
  const clientCodes = (filter.clientCodes ?? []).filter(Boolean);
  if (productCodes.length === 0 && clientCodes.length === 0) {
    throw new Error("Customer×product drill requires a product or client filter.");
  }
  // Requesting a restricted product while the scope excludes it can never return data — short-
  // circuit so the answer is uniformly empty rather than RPC-dependent.
  const excluded = new Set(scope.excludedProductCodes.map((code) => code.trim().toUpperCase()));
  if (productCodes.some((code) => excluded.has(code.trim().toUpperCase()))) return [];

  const supabase = getSupabaseAdmin({ requestTimeoutMs: 30000 });
  const { args, allowedRegionCodes } = buildSiRpcArgs(scope, reference);
  const { data, error } = await supabase.rpc("phx_si_customer_product", {
    p_period: period,
    ...args,
    p_product_codes: productCodes,
    p_client_codes: clientCodes,
    p_limit: Math.max(1, Math.min(filter.limit ?? 100, 500)),
  });
  if (error) throw error;
  const rows: SiCustomerProductRow[] = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    clientCode: str(row.client_code),
    clientName: str(row.client_name) || str(row.client_code),
    distributorCode: str(row.distributor_code),
    regionCode: str(row.region_code),
    areaCode: str(row.area_code),
    productCode: str(row.product_code),
    productName: str(row.product_name) || str(row.product_code),
    units: num(row.units),
    value: num(row.value),
  }));
  // Defense in depth: re-strip restricted products and re-apply region scope in TS.
  return applyLineRegionScope(stripRestrictedRows(rows, scope.excludedProductCodes), {
    allowedLineNames: null,
    allowedRegionCodes,
  });
}

export async function loadSiCustomers(
  period: string | null,
  scope: SalesAccessScope,
  reference: SiReference,
): Promise<SiCustomerRow[]> {
  const supabase = getSupabaseAdmin({ requestTimeoutMs: 30000 });
  const { args, allowedRegionCodes } = buildSiRpcArgs(scope, reference);
  const data = await rpcAll(
    supabase,
    "phx_si_customers",
    { p_period: period, ...args },
    ["client_code", "distributor_code"],
  );
  const rows: SiCustomerRow[] = (data as Array<Record<string, unknown>>).map((row) => ({
    clientCode: str(row.client_code),
    clientName: str(row.client_name) || str(row.client_code),
    distributorCode: str(row.distributor_code),
    regionCode: str(row.region_code),
    areaCode: str(row.area_code),
    brickId: str(row.brick_id),
    units: num(row.units),
    value: num(row.value),
  }));
  return applyLineRegionScope(rows, { allowedLineNames: null, allowedRegionCodes });
}
