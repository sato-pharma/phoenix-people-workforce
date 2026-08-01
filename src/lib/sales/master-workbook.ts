// Source of Sales — "Master Workbook" generator.
//
// Reconstructs the SATO master template (the 17-sheet workbook) and fills EVERY sheet from LIVE
// system data on each call. Because it reads the live tables every time, learned aliases, new
// customers, and freshly-imported sales are always reflected — the download is never stale.
//
// READ-ONLY: this module never writes to the database. It is the data source for the one-click
// "Download Master Workbook" button on /sales/database-mapping.
//
// Targets / Achievement % are intentionally left blank (no targets source in the system yet).

import ExcelJS from "exceljs";

import { systemIdentity } from "@/config/system-settings";
import { isRestrictedProductCode } from "@/lib/sales/access-scope";
import { listMasterRows } from "@/lib/sales/master-data/list";
import { listCustomerMap } from "@/lib/sales/normalizer/customer-map";
import { RAW_DISTRIBUTOR_PROFILES } from "@/lib/sales/normalizer/profiles";
import { normalizeAliasKey } from "@/lib/sales/normalizer/resolvers";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;
type SupabaseAdmin = ReturnType<typeof getSupabaseAdmin>;

const HEADER_FILL = "FF0B0B0B"; // sidebar-black header (matches the admin table design)
const NAV_COLOR = "FF1D4ED8";
const ORANGE_LINE = "FFF8B56B";
const ZEBRA_FILL = "FFFFF7ED";
const SLATE = "FF334155";

function gridBorder(): ExcelJS.Borders {
  const side = { style: "thin" as const, color: { argb: ORANGE_LINE } };
  return { top: side, left: side, bottom: side, right: side } as ExcelJS.Borders;
}

// ── live readers (all paginated past PostgREST's 1000-row cap) ──

async function selectAllOneBatch(
  supabase: SupabaseAdmin,
  table: string,
  columns: string,
  order: string,
  inFilter: { column: string; values: string[] } | undefined,
): Promise<Row[]> {
  const pageSize = 1000;
  // One exact-count head request, then fetch all pages CONCURRENTLY (bounded) — far faster than the
  // sequential cursor walk for big tables (import_rows can be tens of thousands of rows = dozens of pages).
  let headQuery = supabase.from(table).select(columns, { count: "exact", head: true });
  if (inFilter && inFilter.values.length > 0) headQuery = headQuery.in(inFilter.column, inFilter.values);
  const head = await headQuery;
  if (head.error) return []; // tolerate a missing/empty table
  const total = head.count ?? 0;
  if (total === 0) return [];

  const offsets: number[] = [];
  for (let from = 0; from < total; from += pageSize) offsets.push(from);

  const concurrency = 6;
  const pages: Row[][] = new Array(offsets.length);
  for (let i = 0; i < offsets.length; i += concurrency) {
    const slice = offsets.slice(i, i + concurrency);
    const fetched = await Promise.all(slice.map(async (from) => {
      // `order` is REQUIRED. It used to be optional, and six offset pages are fetched CONCURRENTLY —
      // without a total order Postgres may return any row in any page, so rows are both duplicated
      // and dropped between pages. Ordering is load-bearing here, not cosmetic.
      let query = supabase
        .from(table)
        .select(columns)
        .order(order, { ascending: true })
        .range(from, from + pageSize - 1);
      if (inFilter && inFilter.values.length > 0) query = query.in(inFilter.column, inFilter.values);
      const result = await query;
      // A failed page used to become `[]`, silently dropping up to 1,000 rows from an export that
      // still reported success. An export that cannot be complete must fail loudly.
      if (result.error) throw result.error;
      return (result.data ?? []) as unknown as Row[];
    }));
    fetched.forEach((page, j) => { pages[i + j] = page; });
  }
  return pages.flat();
}

// PostgREST folds every .in() value into the request URL; an unbatched array of a few hundred
// values can push the URL past undici's ~16KB header limit and throw "TypeError: fetch failed" /
// HeadersOverflowError — inFilter.values (e.g. every validated import batch id) has no small fixed
// cap, so batch it and merge.
async function selectAll(
  supabase: SupabaseAdmin,
  table: string,
  columns: string,
  /** Required — see selectAllOneBatch. Concurrent offset pages without a total order lose rows. */
  order: string,
  inFilter?: { column: string; values: string[] },
): Promise<Row[]> {
  if (!inFilter || inFilter.values.length === 0) return selectAllOneBatch(supabase, table, columns, order, inFilter);
  // Accumulate as an array-of-batches and flatten once at the end — NOT `rows.push(...batch)`,
  // which spreads every element as an individual push() argument and throws "RangeError: Maximum
  // call stack size exceeded" once a single batch's row count crosses V8's argument-count ceiling
  // (confirmed: reproduced on source_of_sales_import_rows at ~218k rows / a single 89-batch group).
  const batches: Row[][] = [];
  for (let i = 0; i < inFilter.values.length; i += 100) {
    const batchValues = inFilter.values.slice(i, i + 100);
    batches.push(await selectAllOneBatch(supabase, table, columns, order, { column: inFilter.column, values: batchValues }));
  }
  return batches.flat();
}

// Module-level cache for alias maps — these are structurally stable (same column headers appear in
// every batch for the same distributor) so rebuilding on every workbook download wastes ~600ms.
let _aliasCache: { ts: number; product: Map<string, Set<string>>; territory: Map<string, Set<string>> } | null = null;
const _ALIAS_CACHE_TTL = 5 * 60 * 1000;

// Infer WHICH distributor each alias came from by matching the alias text against the original raw
// columns preserved in import_rows.raw_row (e.g. PS "Mat. Code"/"Sal. Dist. Desc.", IS "Item Code"/
// "Territory Name"). Read-only; pages with bounded memory via the shared selectAll() pager.
//
// Scoped to VALIDATED batches only (same set the rest of the workbook reads) — this used to scan
// every row ever imported, including drafts/rejected batches, which on a 300MB+ table pushed the
// export past its time budget and 500'd (see /sales/database-mapping export incident 2026-07-27).
async function buildAliasDistributorMaps(
  supabase: SupabaseAdmin,
  validatedBatchIds: string[],
): Promise<{ product: Map<string, Set<string>>; territory: Map<string, Set<string>> }> {
  if (_aliasCache && Date.now() - _aliasCache.ts < _ALIAS_CACHE_TTL) {
    return { product: _aliasCache.product, territory: _aliasCache.territory };
  }
  const product = new Map<string, Set<string>>();
  const territory = new Map<string, Set<string>>();
  const profileByCode = new Map(RAW_DISTRIBUTOR_PROFILES.map((p) => [p.distributorCode.toUpperCase(), p]));
  const add = (m: Map<string, Set<string>>, raw: string, dist: string) => {
    const key = normalizeAliasKey(raw);
    if (!key) return;
    let set = m.get(key);
    if (!set) { set = new Set<string>(); m.set(key, set); }
    set.add(dist);
  };

  if (validatedBatchIds.length === 0) {
    _aliasCache = { ts: Date.now(), product, territory };
    return { product, territory };
  }

  const rows = await selectAll(
    supabase,
    "source_of_sales_import_rows",
    "distributor_code,raw_row",
    "id",
    { column: "batch_id", values: validatedBatchIds },
  );
  for (const r of rows) {
    const rr = r.raw_row;
    if (!rr || typeof rr !== "object") continue;
    const profile = profileByCode.get(String(r.distributor_code ?? "").toUpperCase());
    if (!profile) continue;
    const lc: Record<string, string> = {};
    for (const k of Object.keys(rr as Record<string, unknown>)) lc[k.toLowerCase()] = String((rr as Record<string, unknown>)[k] ?? "");
    for (const col of profile.productColumns ?? []) { const v = lc[col.toLowerCase()]; if (v) add(product, v, profile.distributorName); }
    for (const col of profile.territoryColumns ?? []) { const v = lc[col.toLowerCase()]; if (v) add(territory, v, profile.distributorName); }
  }
  _aliasCache = { ts: Date.now(), product, territory };
  return { product, territory };
}

const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const yesNo = (v: unknown): string => (v === true || v === "true" || v === 1 ? "Yes" : v === false || v === "false" || v === 0 ? "No" : str(v));

// The 17 sheets, in the exact order/name of the SATO master template.
const SHEET_NAMES = [
  "Product_Master", "Product_Alias", "Region_Master", "Area_Master", "Block_Master", "Brick_Master",
  "Territory_Alias", "Customer_Master", "Distributor_Template_Rules", "Raw_Sales", "Normalized_Sales",
  "Exceptions", "Region_Summary", "Area_Summary", "Brick_Summary", "Product_Summary", "Dashboard",
] as const;

type SheetSpec = { name: string; description: string; headers: string[]; rows: Array<Array<string | number>> };

// ── workbook assembly ──

function addSheet(workbook: ExcelJS.Workbook, spec: SheetSpec): void {
  const ws = workbook.addWorksheet(spec.name, { views: [{ state: "frozen", ySplit: 3 }] });

  // row 1: cross-sheet navigation (internal hyperlinks), mirroring the template's tab row.
  const nav = ws.addRow(SHEET_NAMES as unknown as string[]);
  nav.eachCell((cell, col) => {
    const target = SHEET_NAMES[col - 1];
    cell.value = { text: target, hyperlink: `#'${target}'!A1` } as ExcelJS.CellHyperlinkValue;
    cell.font = { color: { argb: NAV_COLOR }, size: 9, underline: true };
  });

  // row 2: description.
  const desc = ws.addRow([spec.description]);
  desc.getCell(1).font = { italic: true, color: { argb: "FF6B7280" } };

  // row 3: headers (sidebar-black fill, white bold).
  const header = ws.addRow(spec.headers);
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { fgColor: { argb: HEADER_FILL }, pattern: "solid", type: "pattern" };
    cell.alignment = { vertical: "middle" };
    cell.border = gridBorder();
  });

  // rows 4+: data (thin orange grid + zebra striping, matching the rest of the sales export family).
  spec.rows.forEach((r, rowIndex) => {
    const row = ws.addRow(r);
    row.eachCell((cell) => {
      cell.font = { name: "Calibri", size: 10.5, color: { argb: SLATE } };
      cell.border = gridBorder();
      cell.alignment = { vertical: "middle" };
      if (rowIndex % 2 === 1) cell.fill = { fgColor: { argb: ZEBRA_FILL }, pattern: "solid", type: "pattern" };
    });
  });

  // column widths from header length (capped), with the Notes/description columns a bit wider.
  spec.headers.forEach((h, i) => {
    const wide = /note|description|address|name|column/i.test(h);
    ws.getColumn(i + 1).width = Math.min(wide ? 40 : 22, Math.max(12, h.length + 4));
  });
}

export async function buildMasterWorkbookBuffer(
  options?: { includeRestricted?: boolean },
): Promise<ArrayBuffer> {
  const includeRestricted = options?.includeRestricted ?? false;
  const supabase = getSupabaseAdmin();

  // Pre-fetch validated batch IDs so the heavy import_rows scan is restricted to validated batches
  // only (uses the existing batch_id B-tree index instead of a 410MB full table scan).
  const { data: batchIdData } = await supabase
    .from("source_of_sales_import_batches")
    .select("id")
    .eq("status", "validated");
  const validatedBatchIds = (batchIdData ?? []).map((b) => String(b.id));

  const [
    regions, areas, blocks, bricks, productsAll,
    productAliasesAll, territoryAliases, customerMap, importRowsAll, batches, aliasDist,
  ] = await Promise.all([
    listMasterRows("regions"),
    listMasterRows("areas"),
    listMasterRows("blocks"),
    listMasterRows("bricks"),
    listMasterRows("products"),
    selectAll(supabase, "source_of_sales_product_aliases", "alias,product_code,source_labels,active", "alias"),
    selectAll(supabase, "source_of_sales_territory_aliases", "alias,target_type,target_code,notes,active", "alias"),
    listCustomerMap(),
    selectAll(
      supabase,
      "source_of_sales_import_rows",
      "id,batch_id,distributor_code,invoice_period,region_code,region_name,area_code,area_name,block_code,brick_id,product_code,product_name,official_line,qty,bonus_qty,value,client_code,client_name,client_address,is_direct,validation_state,validation_issues",
      "id",
      validatedBatchIds.length > 0 ? { column: "batch_id", values: validatedBatchIds } : undefined,
    ),
    selectAll(supabase, "source_of_sales_import_batches", "id,file_name,distributor_name,period", "id"),
    buildAliasDistributorMaps(supabase, validatedBatchIds),
  ]);

  // Confidential products (LA003 / LA004) are included only for CEO / Super Admin. Filtering the
  // catalogue, aliases and raw import rows here keeps every downstream sheet (Raw_Sales,
  // Normalized_Sales, Exceptions, the four summaries and the Dashboard counts) consistent.
  const products = includeRestricted
    ? productsAll
    : productsAll.filter((p) => !isRestrictedProductCode(str(p.product_code)));
  const productAliases = includeRestricted
    ? productAliasesAll
    : productAliasesAll.filter((a) => !isRestrictedProductCode(str(a.product_code)));
  const importRows = includeRestricted
    ? importRowsAll
    : importRowsAll.filter((r) => !isRestrictedProductCode(str(r.product_code)));

  // lookups
  const brickName = new Map(bricks.map((b) => [str(b.brick_id), str(b.brick_name)]));
  const batchFile = new Map(batches.map((b) => [str(b.id), str(b.file_name)]));

  // Customer name + address are NOT stored on the customer_map — recover them from the imported rows
  // (keyed by distributor + customer code; first non-empty value wins).
  const customerInfo = new Map<string, { address: string; name: string }>();
  for (const r of importRows) {
    const code = str(r.client_code);
    if (!code) continue;
    const key = `${str(r.distributor_code)} ${code}`;
    const name = str(r.client_name);
    const address = str(r.client_address);
    const cur = customerInfo.get(key);
    if (!cur) customerInfo.set(key, { address, name });
    else { if (!cur.name && name) cur.name = name; if (!cur.address && address) cur.address = address; }
  }

  // ── aggregation for the four summary sheets (live, straight from the stored coded rows) ──
  type Agg = { qty: number; value: number; meta: Record<string, string> };
  const regionAgg = new Map<string, Agg>();
  const areaAgg = new Map<string, Agg>();
  const brickAgg = new Map<string, Agg>();
  const productAgg = new Map<string, Agg>();
  const bump = (m: Map<string, Agg>, key: string, qty: number, value: number, meta: Record<string, string>) => {
    const cur = m.get(key) ?? { qty: 0, value: 0, meta };
    cur.qty += qty; cur.value += value;
    m.set(key, cur);
  };

  for (const r of importRows) {
    const qty = num(r.qty);
    const value = num(r.value);
    const regionCode = str(r.region_code);
    const regionName = str(r.region_name);
    const areaCode = str(r.area_code);
    const areaName = str(r.area_name);
    const brickId = str(r.brick_id);
    const productCode = str(r.product_code);
    const productName = str(r.product_name);
    if (regionCode && productCode) bump(regionAgg, `${regionCode} ${productCode}`, qty, value, { regionCode, regionName, productCode, productName });
    if (areaCode && productCode) bump(areaAgg, `${areaCode} ${productCode}`, qty, value, { areaCode, areaName, regionCode, productCode, productName });
    if (brickId && productCode) bump(brickAgg, `${brickId} ${productCode}`, qty, value, { brickId, areaName, regionCode, productCode, productName });
    if (productCode) bump(productAgg, `${productCode} ${regionCode} ${areaCode}`, qty, value, { productCode, productName, regionCode, regionName, areaCode, areaName });
  }

  const sortRows = (rows: Array<Array<string | number>>) => rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));

  // ── build each sheet spec ──
  const specs: SheetSpec[] = [];

  specs.push({
    name: "Product_Master",
    description: "Official product catalogue (live).",
    headers: ["Product Code", "Product Name", "Family Code", "Family", "Source", "Line", "Factory Price", "Active"],
    rows: products.map((p) => [str(p.product_code), str(p.product_name), str(p.family_code), str(p.family), str(p.source), str(p.line), num(p.factory_price), yesNo(p.active)]),
  });

  specs.push({
    name: "Product_Alias",
    description: "Learned product name/code aliases -> Phoenix product code (live). Notes = the distributor(s) this alias came from.",
    headers: ["Alias", "Product Code", "Notes", "Active"],
    rows: productAliases.map((a) => {
      const fromSeed = Array.isArray(a.source_labels) ? (a.source_labels as unknown[]).map(str).filter(Boolean) : [];
      const fromUsage = [...(aliasDist.product.get(normalizeAliasKey(str(a.alias))) ?? [])];
      return [str(a.alias), str(a.product_code), [...new Set([...fromUsage, ...fromSeed])].join(", "), yesNo(a.active)];
    }),
  });

  specs.push({
    name: "Region_Master",
    description: "Top-level sales regions (live).",
    headers: ["Region Code", "Region Name", "Description", "Active", "Effective From", "Effective To"],
    rows: regions.map((r) => [str(r.region_code), str(r.region_name), str(r.description), yesNo(r.active), str(r.effective_from), str(r.effective_to)]),
  });

  specs.push({
    name: "Area_Master",
    description: "Areas mapped to their parent region (live).",
    headers: ["Area Code", "Region Code", "Area Name", "Description", "Active", "Effective From", "Effective To"],
    rows: areas.map((a) => [str(a.area_code), str(a.region_code), str(a.area_name), str(a.description), yesNo(a.active), str(a.effective_from), str(a.effective_to)]),
  });

  specs.push({
    name: "Block_Master",
    description: "Blocks within each area (live).",
    headers: ["Block Code", "Area Code", "Description", "Active", "Effective From", "Effective To"],
    rows: blocks.map((b) => [str(b.block_code), str(b.area_code), str(b.description), yesNo(b.active), str(b.effective_from), str(b.effective_to)]),
  });

  specs.push({
    name: "Brick_Master",
    description: "Bricks (smallest territory) with their block/area/region (live).",
    headers: ["Brick ID", "Brick Name", "Block Code", "Area Code", "Region Code", "Description", "Active", "Effective From", "Effective To"],
    rows: bricks.map((b) => [str(b.brick_id), str(b.brick_name), str(b.block_code), str(b.area_code), str(b.region_code), str(b.description), yesNo(b.active), str(b.effective_from), str(b.effective_to)]),
  });

  specs.push({
    name: "Territory_Alias",
    description: "Territory aliases (district/street) -> brick/area/block/region (live). Notes = the distributor(s) this alias came from.",
    headers: ["Alias", "Target Type", "Target Code", "Notes", "Active"],
    rows: territoryAliases.map((t) => {
      const fromUsage = [...(aliasDist.territory.get(normalizeAliasKey(str(t.alias))) ?? [])];
      return [str(t.alias), str(t.target_type), str(t.target_code), fromUsage.join(", ") || str(t.notes), yesNo(t.active)];
    }),
  });

  specs.push({
    name: "Customer_Master",
    description: "Known customers per distributor with their brick/area/region (live).",
    headers: ["Distributor", "Customer Code", "Customer Name", "Address", "Brick ID", "Area Code", "Region Code", "Notes", "Active"],
    rows: customerMap.map((c) => {
      const info = customerInfo.get(`${str(c.distributorCode)} ${str(c.customerCode)}`);
      return [
        str(c.distributorCode), str(c.customerCode),
        str(c.customerName) || (info?.name ?? ""),
        str(c.address) || (info?.address ?? ""),
        str(c.brickId), str(c.areaCode), str(c.regionCode), "", "Yes",
      ];
    }),
  });

  specs.push({
    name: "Distributor_Template_Rules",
    description: "How the Normalizer reads each distributor's raw sheet (from the system's column profiles).",
    headers: ["Distributor", "Area Column", "Product Column", "Quantity Column", "Value Column", "Customer Code Column", "Customer Name Column", "Address Column", "Date Column", "Notes"],
    rows: RAW_DISTRIBUTOR_PROFILES.map((p) => {
      const notes = [
        p.productColumns[1] ? `Product name col = "${p.productColumns[1]}"` : "",
        p.bonusColumns?.[0] ? `Bonus qty col = "${p.bonusColumns[0]}"` : "",
        p.valueSource === "sheet" ? "Value taken from the sheet (Direct)" : "Value recomputed = Qty x factory price x (1 - discount)",
        (p.territoryColumns?.length ?? 0) > 1 ? `Territory fallbacks: ${p.territoryColumns!.slice(1).map((c) => `"${c}"`).join(", ")}` : "",
        p.discountColumns?.[0] ? `Discount col = "${p.discountColumns[0]}"` : "",
        "Area & Region are derived from the Brick.",
      ].filter(Boolean).join(" | ");
      return [
        `${p.distributorCode} (${p.distributorName})`,
        p.territoryColumns?.[0] ?? "",
        p.productColumns[0] ?? "",
        p.qtyColumns[0] ?? "",
        p.valueColumns?.[0] ?? "",
        p.customerCodeColumns?.[0] ?? "",
        p.customerNameColumns?.[0] ?? "",
        "",
        p.dateColumns?.[0] ?? "",
        notes,
      ];
    }),
  });

  specs.push({
    name: "Raw_Sales",
    description: "Imported sales rows in raw-intake shape (live).",
    headers: ["Distributor", "Source File", "Invoice Date", "Customer Code", "Customer Name", "Address", "Area Text", "Product", "Quantity", "Net Value", "Currency", "Notes"],
    rows: importRows.map((r) => [
      str(r.distributor_code), batchFile.get(str(r.batch_id)) ?? "", str(r.invoice_period),
      str(r.client_code), str(r.client_name), str(r.client_address), str(r.area_name),
      str(r.product_name) || str(r.product_code), num(r.qty), num(r.value), "EGP", "",
    ]),
  });

  specs.push({
    name: "Normalized_Sales",
    description: "Coded sales after normalization (live).",
    headers: ["Normalized ID", "Distributor", "Date", "Customer Code", "Product Code", "Product Name", "Quantity", "Net Value", "Raw Area Text", "Normalized Brick ID", "Area Code", "Region Code", "Product Code (Mapped)", "Product Name (Mapped)", "Allocation Method", "Notes"],
    rows: importRows.map((r) => [
      str(r.id), str(r.distributor_code), str(r.invoice_period), str(r.client_code),
      str(r.product_code), str(r.product_name), num(r.qty), num(r.value),
      str(r.area_name), str(r.brick_id), str(r.area_code), str(r.region_code),
      str(r.product_code), str(r.product_name), r.is_direct ? "Direct" : "", "",
    ]),
  });

  const issueText = (v: unknown): string => {
    if (!Array.isArray(v)) return "";
    return v.map((i) => (i && typeof i === "object" ? str((i as Row).message) : str(i))).filter(Boolean).join(" | ");
  };
  specs.push({
    name: "Exceptions",
    description: "Imported rows that FAILED validation (genuine exceptions; soft warnings are not listed).",
    headers: ["Normalized ID", "Distributor", "Customer Code", "Customer Name", "Date", "Product", "Quantity", "Net Value", "Area Text", "Address", "Issue", "Suggested Action", "Status"],
    rows: importRows
      .filter((r) => str(r.validation_state) === "failed")
      .map((r) => [
        str(r.id), str(r.distributor_code), str(r.client_code), str(r.client_name), str(r.invoice_period),
        str(r.product_name) || str(r.product_code), num(r.qty), num(r.value), str(r.area_name), str(r.client_address),
        issueText(r.validation_issues), "", str(r.validation_state),
      ]),
  });

  specs.push({
    name: "Region_Summary",
    description: "Sales by region x product (live). Target / Achievement % are not modelled yet.",
    headers: ["Region Code", "Region Name", "Product Code", "Product Name", "Quantity", "Net Value", "Target", "Achievement %", "Performance Notes"],
    rows: sortRows([...regionAgg.values()].map((a) => [a.meta.regionCode, a.meta.regionName, a.meta.productCode, a.meta.productName, a.qty, a.value, "", "", ""])),
  });

  specs.push({
    name: "Area_Summary",
    description: "Sales by area x product (live). Target / Achievement % are not modelled yet.",
    headers: ["Area Code", "Area Name", "Region Code", "Product Code", "Product Name", "Quantity", "Net Value", "Target", "Achievement %", "Performance Notes"],
    rows: sortRows([...areaAgg.values()].map((a) => [a.meta.areaCode, a.meta.areaName, a.meta.regionCode, a.meta.productCode, a.meta.productName, a.qty, a.value, "", "", ""])),
  });

  specs.push({
    name: "Brick_Summary",
    description: "Sales by brick x product (live). Target / Achievement % are not modelled yet.",
    headers: ["Brick Code", "Brick Name", "Area Name", "Region Code", "Product Code", "Product Name", "Quantity", "Net Value", "Target", "Achievement %", "Performance Notes"],
    rows: sortRows([...brickAgg.values()].map((a) => [a.meta.brickId, brickName.get(a.meta.brickId) ?? "", a.meta.areaName, a.meta.regionCode, a.meta.productCode, a.meta.productName, a.qty, a.value, "", "", ""])),
  });

  specs.push({
    name: "Product_Summary",
    description: "Sales by product x region x area (live).",
    headers: ["Product Code", "Product Name", "Region Code", "Region Name", "Area Code", "Area Name", "Quantity", "Net Value"],
    rows: sortRows([...productAgg.values()].map((a) => [a.meta.productCode, a.meta.productName, a.meta.regionCode, a.meta.regionName, a.meta.areaCode, a.meta.areaName, a.qty, a.value])),
  });

  const totalQty = importRows.reduce((s, r) => s + num(r.qty), 0);
  const totalValue = importRows.reduce((s, r) => s + num(r.value), 0);
  const exceptionCount = importRows.filter((r) => str(r.validation_state) && str(r.validation_state) !== "valid").length;
  specs.push({
    name: "Dashboard",
    description: "Snapshot of the current system state (generated at download time).",
    headers: ["Metric", "Value"],
    rows: [
      ["Generated at (UTC)", new Date().toISOString()],
      ["Products in catalogue", products.length],
      ["Regions / Areas / Blocks / Bricks", `${regions.length} / ${areas.length} / ${blocks.length} / ${bricks.length}`],
      ["Product aliases", productAliases.length],
      ["Territory aliases", territoryAliases.length],
      ["Mapped customers", customerMap.length],
      ["Import batches", batches.length],
      ["Normalized sales rows", importRows.length],
      ["Exception rows", exceptionCount],
      ["Total quantity", totalQty],
      ["Total net value", totalValue],
    ],
  });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemIdentity.appName;
  workbook.created = new Date();
  for (const spec of specs) addSheet(workbook, spec);

  return workbook.xlsx.writeBuffer() as unknown as ArrayBuffer;
}
