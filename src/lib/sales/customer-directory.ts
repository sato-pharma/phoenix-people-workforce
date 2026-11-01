import type { PhoenixRole } from "@/lib/auth/permissions";
import { canViewRestrictedProducts, RESTRICTED_PRODUCT_CODES } from "@/lib/sales/access-scope";
import {
  classifyCustomerChannel,
  matchedChannelKeywords,
  storeOverrideReason,
  type CustomerChannel,
} from "@/lib/sales/customer-channel";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  listMonthlyClosingPeriods,
  loadSalesReferenceData,
} from "@/lib/sales/monthly-distributor-import";

// Confidential products (LA003/LA004/SS001) are stripped server-side inside the RPC for any
// caller who is not CEO / Super Admin (src/lib/sales/access-scope.ts). Every route calling into
// this module already gates the whole Customer Directory to Super Admin, so this is
// defense-in-depth: a future looser route gate still cannot leak the restricted products.
function excludeCodesFor(role: PhoenixRole): string[] {
  return canViewRestrictedProducts(role) ? [] : [...RESTRICTED_PRODUCT_CODES];
}

// Customer Directory — customers derived from the uploaded distributor sales rows.
// One entry per (customer code + distributor): same customer+distributor merges; the same
// pharmacy across different distributors stays separate. Value is ALWAYS recomputed in the
// RPC (Qty x live factory_price); the stored sheet value is never used, and since 2026-09-07
// neither is the discount column.

export type CustomerDirectoryFilters = {
  areaCodes?: string[];
  brickCodes?: string[];
  /** Restrict to one side of the Customers tab. Omitted / null = both channels. */
  channel?: CustomerChannel | null;
  distributorCodes?: string[];
  fromPeriod?: string | null;
  regionCodes?: string[];
  search?: string;
  toPeriod?: string | null;
};

export type CustomerDirectoryOption = {
  areaCode?: string;
  code: string;
  label: string;
  regionCode?: string;
};

export type CustomerDirectoryFilterOptions = {
  areas: CustomerDirectoryOption[];
  bricks: CustomerDirectoryOption[];
  distributors: CustomerDirectoryOption[];
  periods: string[];
  regions: CustomerDirectoryOption[];
};

export type CustomerDirectoryRow = {
  areaCode: string;
  areaName: string;
  brickId: string;
  brickName: string;
  /**
   * "hospital" when the name carries a hospital word, "store" when it carries one of the owner's
   * six store words, else "pharmacy".
   */
  channel: CustomerChannel;
  clientAddress: string;
  clientCode: string;
  clientName: string;
  distributorCode: string;
  distributorName: string;
  /**
   * Which words placed this customer in its channel — empty for a pharmacy. Shown so a false
   * positive is visible.
   */
  matchedKeywords: string[];
  regionCode: string;
  regionName: string;
  totalUnits: number;
  totalValue: number;
};

export type CustomerDirectoryListResult = {
  customers: CustomerDirectoryRow[];
  truncated: boolean;
};

// One side of the Customers tab. `customers` is capped for display, but every total is computed
// over the WHOLE filtered set — a channel's sales figure must never silently mean "the first
// 2000 rows of it".
export type CustomerChannelGroup = {
  customers: CustomerDirectoryRow[];
  totalCustomers: number;
  totalUnits: number;
  totalValue: number;
  truncated: boolean;
};

export type CustomerDirectoryChannelResult = {
  hospitals: CustomerChannelGroup;
  pharmacies: CustomerChannelGroup;
  stores: CustomerChannelGroup;
};

export type CustomerSalesLine = {
  brickId: string;
  invoicePeriod: string | null;
  officialLine: string;
  productCode: string;
  productName: string;
  qty: number;
  value: number;
};

export type CustomerSalesProductTotal = {
  officialLine: string;
  productCode: string;
  productName: string;
  totalUnits: number;
  totalValue: number;
};

export type CustomerSalesDetail = {
  areaCode: string;
  areaName: string;
  brickId: string;
  brickName: string;
  clientAddress: string;
  clientCode: string;
  clientName: string;
  distributorCode: string;
  distributorName: string;
  lines: CustomerSalesLine[];
  productTotals: CustomerSalesProductTotal[];
  regionCode: string;
  regionName: string;
  totalUnits: number;
  totalValue: number;
};

const DIRECTORY_RESULT_LIMIT = 2000;

// Above the function's own 45s statement_timeout, so the database's answer reaches the page before
// the client gives up. With nothing filtered this read returns about 59,000 customers in about 10s
// warm, and a database restart empties the cache it relies on; at the default 15s that cold read
// showed "Failed to load Customer Directory." while the query ran on with nobody waiting for it.
const DIRECTORY_REQUEST_TIMEOUT_MS = 50_000;

function normalizeCode(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

type NameMaps = {
  areaName: Map<string, string>;
  brickName: Map<string, string>;
  distributorName: Map<string, string>;
  regionName: Map<string, string>;
};

type DirectoryRpcRow = {
  area_code: string | null;
  brick_id: string | null;
  client_address: string | null;
  client_code: string | null;
  client_name: string | null;
  distributor_code: string | null;
  region_code: string | null;
  total_units: number | null;
  total_value: number | null;
};

// Pure: map the RPC's coded rows to display rows using the master name maps.
export function mapDirectoryRowsToNames(rows: DirectoryRpcRow[], maps: NameMaps): CustomerDirectoryRow[] {
  return rows.map((row) => {
    const brickId = String(row.brick_id ?? "");
    const areaCode = String(row.area_code ?? "");
    const regionCode = String(row.region_code ?? "");
    const distributorCode = String(row.distributor_code ?? "");
    const clientName = String(row.client_name ?? "");
    const overrideReason = storeOverrideReason(String(row.client_code ?? ""), distributorCode);
    return {
      areaCode,
      areaName: maps.areaName.get(normalizeCode(areaCode)) ?? areaCode,
      brickId,
      brickName: maps.brickName.get(normalizeCode(brickId)) ?? brickId,
      // Derived from the name on every read, so a newly uploaded sheet is classified the moment
      // it lands — no backfill, no stored column to drift.
      channel: classifyCustomerChannel(clientName, String(row.client_code ?? ""), distributorCode),
      clientAddress: String(row.client_address ?? ""),
      clientCode: String(row.client_code ?? ""),
      clientName,
      distributorCode,
      matchedKeywords: [
        ...matchedChannelKeywords(clientName),
        ...(overrideReason ? [overrideReason] : []),
      ],
      distributorName: maps.distributorName.get(normalizeCode(distributorCode)) ?? distributorCode,
      regionCode,
      regionName: maps.regionName.get(normalizeCode(regionCode)) ?? regionCode,
      totalUnits: Number(row.total_units ?? 0),
      totalValue: Number(row.total_value ?? 0),
    };
  });
}

// Pure: case-insensitive "contains" over customer name or code.
export function applyDirectorySearch(rows: CustomerDirectoryRow[], search: string | undefined): CustomerDirectoryRow[] {
  const needle = String(search ?? "").trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter(
    (row) =>
      row.clientName.toLowerCase().includes(needle) || row.clientCode.toLowerCase().includes(needle),
  );
}

type SalesRpcLine = {
  area_code: string | null;
  brick_id: string | null;
  client_address: string | null;
  client_name: string | null;
  invoice_period: string | null;
  line_value: number | null;
  official_line: string | null;
  product_code: string | null;
  product_name: string | null;
  qty: number | null;
  region_code: string | null;
};

// Pure: roll a customer's raw lines into per-product totals + grand totals.
export function rollUpCustomerSales(lines: CustomerSalesLine[]): {
  productTotals: CustomerSalesProductTotal[];
  totalUnits: number;
  totalValue: number;
} {
  const byProduct = new Map<string, CustomerSalesProductTotal>();
  let totalUnits = 0;
  let totalValue = 0;
  for (const line of lines) {
    totalUnits += Number.isFinite(line.qty) ? line.qty : 0;
    totalValue += Number.isFinite(line.value) ? line.value : 0;
    const key = `${line.productCode} ${line.officialLine}`;
    const current = byProduct.get(key) ?? {
      officialLine: line.officialLine,
      productCode: line.productCode,
      productName: line.productName,
      totalUnits: 0,
      totalValue: 0,
    };
    current.totalUnits += Number.isFinite(line.qty) ? line.qty : 0;
    current.totalValue += Number.isFinite(line.value) ? line.value : 0;
    byProduct.set(key, current);
  }
  const round = (value: number) => Number(value.toFixed(6));
  return {
    productTotals: [...byProduct.values()]
      .map((total) => ({ ...total, totalUnits: round(total.totalUnits), totalValue: round(total.totalValue) }))
      .sort((left, right) => right.totalValue - left.totalValue || left.productName.localeCompare(right.productName)),
    totalUnits: round(totalUnits),
    totalValue: round(totalValue),
  };
}

async function loadNameMaps(): Promise<{ maps: NameMaps; options: CustomerDirectoryFilterOptions }> {
  const supabase = getSupabaseAdmin();
  // Bricks are loaded directly with only the columns that exist in every Supabase project
  // (the shared loadSalesReferenceData brick query selects block_name/area_name/region_name,
  // which production's source_of_sales_bricks does not have, so it errors → empty list).
  const [references, periods, bricksResult] = await Promise.all([
    // includeCustomerBricks:false skips paging the ~19k-row customer->brick crosswalk,
    // which the directory never uses (it only needs region/area/distributor names). That
    // crosswalk paging (1000/req) was the dominant cost of the page render.
    loadSalesReferenceData({ includeCustomerBricks: false }),
    listMonthlyClosingPeriods(),
    supabase
      .from("source_of_sales_bricks")
      .select("brick_id,brick_name,area_code,region_code")
      .eq("active", true)
      .order("brick_id", { ascending: true }),
  ]);
  const brickRows = (bricksResult.error ? [] : bricksResult.data ?? []) as Array<Record<string, unknown>>;

  const areaName = new Map<string, string>();
  const regionName = new Map<string, string>();
  const brickName = new Map<string, string>();
  const distributorName = new Map<string, string>();

  references.regions.forEach((region) => {
    if (region.regionCode) regionName.set(normalizeCode(region.regionCode), region.regionName || region.regionCode);
  });
  (references.areas ?? []).forEach((area) => {
    if (area.areaCode) areaName.set(normalizeCode(area.areaCode), area.areaName || area.areaCode);
  });
  brickRows.forEach((brick) => {
    const id = String(brick.brick_id ?? "");
    if (id) brickName.set(normalizeCode(id), String(brick.brick_name ?? "") || id);
  });
  references.distributors.forEach((distributor) => {
    if (distributor.code) distributorName.set(normalizeCode(distributor.code), distributor.name || distributor.code);
  });

  const options: CustomerDirectoryFilterOptions = {
    regions: references.regions
      .filter((region) => region.regionCode)
      .map((region) => ({ code: region.regionCode, label: `${region.regionName || region.regionCode} (${region.regionCode})` }))
      .sort((left, right) => left.label.localeCompare(right.label)),
    areas: (references.areas ?? [])
      .filter((area) => area.areaCode)
      .map((area) => ({ code: area.areaCode, label: `${area.areaName || area.areaCode} (${area.areaCode})`, regionCode: area.regionCode }))
      .sort((left, right) => left.label.localeCompare(right.label)),
    bricks: brickRows
      .filter((brick) => brick.brick_id)
      .map((brick) => {
        const id = String(brick.brick_id ?? "");
        const name = String(brick.brick_name ?? "") || id;
        return { areaCode: String(brick.area_code ?? ""), code: id, label: `${name} (${id})`, regionCode: String(brick.region_code ?? "") };
      })
      .sort((left, right) => left.label.localeCompare(right.label)),
    distributors: references.distributors
      .filter((distributor) => distributor.code)
      .map((distributor) => ({ code: distributor.code, label: `${distributor.name || distributor.code} (${distributor.code})` }))
      .sort((left, right) => left.label.localeCompare(right.label)),
    periods,
  };

  return { maps: { areaName, brickName, distributorName, regionName }, options };
}

export async function loadCustomerDirectoryFilterOptions(): Promise<CustomerDirectoryFilterOptions> {
  const { options } = await loadNameMaps();
  return options;
}

function nonEmptyArray(values: string[] | undefined): string[] | null {
  return values && values.length > 0 ? values : null;
}

// Run the directory RPC and shape the rows using pre-loaded name maps. Kept separate so
// callers that already built the maps (e.g. the initial page load) don't rebuild them.
async function queryDirectoryRows(
  filters: CustomerDirectoryFilters,
  maps: NameMaps,
  role: PhoenixRole,
): Promise<CustomerDirectoryRow[]> {
  const supabase = getSupabaseAdmin({ requestTimeoutMs: DIRECTORY_REQUEST_TIMEOUT_MS });
  // Single execution: phx_customer_directory_json returns the whole result set as one
  // jsonb value, so the aggregation runs ONCE instead of being re-run per 1000-row page
  // (PostgREST's row cap previously forced ~28 re-executions = ~43s on the full directory).
  const { data, error } = await supabase.rpc("phx_customer_directory_json", {
    p_area_codes: nonEmptyArray(filters.areaCodes),
    p_brick_codes: nonEmptyArray(filters.brickCodes),
    p_distributor_codes: nonEmptyArray(filters.distributorCodes),
    p_exclude_codes: excludeCodesFor(role),
    p_from_period: filters.fromPeriod || null,
    p_region_codes: nonEmptyArray(filters.regionCodes),
    p_to_period: filters.toPeriod || null,
  });
  if (error) throw error;
  const rows = (data ?? []) as DirectoryRpcRow[];

  const mapped = mapDirectoryRowsToNames(rows, maps);
  const searched = applyDirectorySearch(mapped, filters.search).filter(
    (row) => !filters.channel || row.channel === filters.channel,
  );
  searched.sort(
    (left, right) =>
      right.totalValue - left.totalValue ||
      left.clientName.localeCompare(right.clientName) ||
      left.distributorCode.localeCompare(right.distributorCode),
  );
  return searched;
}

// All filtered customers (uncapped) — sorted, searched. Used by the list (which then
// caps for display) and by the XLSX export (which keeps the full filtered set).
export async function loadCustomerDirectoryRows(
  filters: CustomerDirectoryFilters,
  role: PhoenixRole,
): Promise<CustomerDirectoryRow[]> {
  const { maps } = await loadNameMaps();
  return queryDirectoryRows(filters, maps, role);
}

export async function listCustomerDirectory(
  filters: CustomerDirectoryFilters,
  role: PhoenixRole,
): Promise<CustomerDirectoryListResult> {
  const rows = await loadCustomerDirectoryRows(filters, role);
  return {
    customers: rows.slice(0, DIRECTORY_RESULT_LIMIT),
    truncated: rows.length > DIRECTORY_RESULT_LIMIT,
  };
}

// Initial page load: build the name maps ONCE and reuse them for both the filter
// options and the customer list (previously each path rebuilt the maps independently,
// doubling the reference-data round-trips on every render).
export async function loadCustomerDirectoryInitialData(
  filters: CustomerDirectoryFilters,
  role: PhoenixRole,
): Promise<{ options: CustomerDirectoryFilterOptions; result: CustomerDirectoryListResult }> {
  const { maps, options } = await loadNameMaps();
  const rows = await queryDirectoryRows(filters, maps, role);
  return {
    options,
    result: {
      customers: rows.slice(0, DIRECTORY_RESULT_LIMIT),
      truncated: rows.length > DIRECTORY_RESULT_LIMIT,
    },
  };
}

// Pure: split already-loaded directory rows into the three channels and total each side.
// Totals are summed BEFORE the display cap is applied, so "Stores: 125,440,939 EGP" means all
// stores — not the first page of them. Exported for direct testing.
export function splitDirectoryByChannel(rows: CustomerDirectoryRow[]): CustomerDirectoryChannelResult {
  const build = (channel: CustomerChannel): CustomerChannelGroup => {
    const all = rows.filter((row) => row.channel === channel);
    let totalUnits = 0;
    let totalValue = 0;
    for (const row of all) {
      totalUnits += Number.isFinite(row.totalUnits) ? row.totalUnits : 0;
      totalValue += Number.isFinite(row.totalValue) ? row.totalValue : 0;
    }
    return {
      customers: all.slice(0, DIRECTORY_RESULT_LIMIT),
      totalCustomers: all.length,
      totalUnits: Number(totalUnits.toFixed(6)),
      totalValue: Number(totalValue.toFixed(6)),
      truncated: all.length > DIRECTORY_RESULT_LIMIT,
    };
  };
  return { hospitals: build("hospital"), pharmacies: build("pharmacy"), stores: build("store") };
}

// The Customers tab: the same filtered directory, cut into Pharmacies and Stores.
export async function loadCustomerDirectoryByChannel(
  filters: CustomerDirectoryFilters,
  role: PhoenixRole,
): Promise<CustomerDirectoryChannelResult> {
  const rows = await loadCustomerDirectoryRows(filters, role);
  return splitDirectoryByChannel(rows);
}

export async function loadCustomerSales(
  input: {
    clientCode: string;
    distributorCode: string;
    fromPeriod?: string | null;
    toPeriod?: string | null;
  },
  role: PhoenixRole,
): Promise<CustomerSalesDetail | null> {
  const { maps } = await loadNameMaps();
  const supabase = getSupabaseAdmin();
  const result = await supabase.rpc("phx_customer_sales", {
    p_client_code: input.clientCode,
    p_distributor_code: input.distributorCode,
    p_exclude_codes: excludeCodesFor(role),
    p_from_period: input.fromPeriod || null,
    p_to_period: input.toPeriod || null,
  });

  if (result.error) throw result.error;

  const rpcLines = (result.data ?? []) as SalesRpcLine[];
  if (rpcLines.length === 0) return null;

  const lines: CustomerSalesLine[] = rpcLines.map((line) => ({
    brickId: String(line.brick_id ?? ""),
    invoicePeriod: line.invoice_period ?? null,
    officialLine: String(line.official_line ?? ""),
    productCode: String(line.product_code ?? ""),
    productName: String(line.product_name ?? ""),
    qty: Number(line.qty ?? 0),
    value: Number(line.line_value ?? 0),
  }));

  const header = rpcLines[0];
  const brickId = String(header.brick_id ?? "");
  const areaCode = String(header.area_code ?? "");
  const regionCode = String(header.region_code ?? "");
  const rolled = rollUpCustomerSales(lines);

  return {
    areaCode,
    areaName: maps.areaName.get(normalizeCode(areaCode)) ?? areaCode,
    brickId,
    brickName: maps.brickName.get(normalizeCode(brickId)) ?? brickId,
    clientAddress: String(header.client_address ?? ""),
    clientCode: input.clientCode,
    clientName: String(header.client_name ?? ""),
    distributorCode: input.distributorCode,
    distributorName: maps.distributorName.get(normalizeCode(input.distributorCode)) ?? input.distributorCode,
    lines,
    productTotals: rolled.productTotals,
    regionCode,
    regionName: maps.regionName.get(normalizeCode(regionCode)) ?? regionCode,
    totalUnits: rolled.totalUnits,
    totalValue: rolled.totalValue,
  };
}
