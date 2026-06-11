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
  const [references, brickResult, aliasResult] = await Promise.all([
    loadSalesReferenceData({ includeCustomerBricks: false }),
    supabase.from("source_of_sales_bricks").select("brick_id,brick_name").eq("active", true),
    supabase
      .from("source_of_sales_region_aliases")
      .select("region_code,alias,normalized_alias")
      .eq("active", true),
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
