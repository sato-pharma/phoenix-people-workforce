import ExcelJS from "exceljs";

import { SalesWorkflowError } from "@/lib/sales/contracts";
import { canonicalWeeklyDistributorCode, weeklyDistributorOptions } from "@/lib/sales/weekly/distributors";
import { normalizeAlias, normalizeCode } from "@/lib/sales/weekly/mapping-normalize";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// Weekly Sales — product alias crosswalk service.
//
// Maps a distributor's own item code OR item name to a Source-of-Sales master product_code.
// The product master (code/name/line/factory_price) is owned by Source of Sales; this module only
// attaches aliases onto it. Distributor-tagged + alias_kind-tagged so codes/names never collide.
// ─────────────────────────────────────────────────────────────────────────────

export type WeeklyAliasKind = "code" | "name";

export type WeeklyMasterProduct = {
  code: string;
  name: string;
  line: string;
  factoryPrice: number;
  /** master price present and > 0 */
  priced: boolean;
  /** master line non-empty */
  lined: boolean;
};

export type WeeklyProductAliasRow = {
  id: string;
  distributorCode: string;
  alias: string;
  aliasKind: WeeklyAliasKind;
  productCode: string;
  productName: string;
  line: string;
  /** master is priced + lined (so this alias would not block an upload) */
  resolvable: boolean;
  updatedAt: string;
};

export type WeeklyProductAliasAdmin = {
  distributors: { code: string; name: string }[];
  products: WeeklyMasterProduct[];
  aliases: WeeklyProductAliasRow[];
};

export type WeeklyMappingImportResult = {
  inserted: number;
  updated: number;
  skipped: number;
  blockedRows: { rowNumber: number; reason: string; values: string }[];
};

/** Product alias resolution maps used by the upload parser. */
export type WeeklyProductAliasIndex = Map<string, { byCode: Map<string, string>; byName: Map<string, string> }>;

async function loadMasterProducts(): Promise<Map<string, WeeklyMasterProduct>> {
  const references = await loadSalesReferenceData({ includeCustomerBricks: false });
  const map = new Map<string, WeeklyMasterProduct>();
  for (const product of references.products) {
    const code = normalizeCode(product.productCode);
    if (!code || map.has(code)) continue;
    const factoryPrice = Number(product.factoryPrice);
    const safePrice = Number.isFinite(factoryPrice) ? factoryPrice : 0;
    const line = (product.line ?? "").trim();
    map.set(code, {
      code: product.productCode.trim(),
      name: (product.productName || product.productCode).trim(),
      line,
      factoryPrice: safePrice,
      priced: safePrice > 0,
      lined: line.length > 0,
    });
  }
  return map;
}

function aliasKindOf(value: unknown): WeeklyAliasKind {
  return String(value ?? "").trim().toLowerCase() === "name" ? "name" : "code";
}

export async function loadWeeklyProductAliasAdmin(distributorCode?: string): Promise<WeeklyProductAliasAdmin> {
  const supabase = getSupabaseAdmin();
  const products = await loadMasterProducts();

  let query = supabase
    .from("weekly_sales_product_aliases")
    .select("id, distributor_code, alias, alias_kind, product_code, updated_at")
    .order("distributor_code", { ascending: true })
    .order("alias", { ascending: true });
  if (distributorCode) query = query.eq("distributor_code", canonicalWeeklyDistributorCode(distributorCode));

  const { data, error } = await query;
  if (error) throw new SalesWorkflowError("load_failed", error.message, 500);

  const aliases: WeeklyProductAliasRow[] = (data ?? []).map((row) => {
    const product = products.get(normalizeCode(row.product_code));
    return {
      id: String(row.id),
      distributorCode: String(row.distributor_code ?? ""),
      alias: String(row.alias ?? ""),
      aliasKind: aliasKindOf(row.alias_kind),
      productCode: String(row.product_code ?? ""),
      productName: product?.name ?? String(row.product_code ?? ""),
      line: product?.line ?? "",
      resolvable: Boolean(product?.priced && product?.lined),
      updatedAt: String(row.updated_at ?? ""),
    };
  });

  return {
    distributors: weeklyDistributorOptions(),
    products: [...products.values()].sort((left, right) => left.name.localeCompare(right.name)),
    aliases,
  };
}

/** Insert/update one alias. Rejects re-mapping the same (distributor, kind, alias) to a different product. */
export async function upsertProductAlias(input: {
  distributorCode: string;
  alias: string;
  aliasKind: WeeklyAliasKind;
  productCode: string;
  actorId: string | null;
}): Promise<void> {
  const distributorCode = canonicalWeeklyDistributorCode(input.distributorCode);
  const alias = String(input.alias ?? "").trim();
  if (!alias) throw new SalesWorkflowError("invalid_request", "An alias value is required.", 400);
  const aliasKind: WeeklyAliasKind = input.aliasKind === "name" ? "name" : "code";
  const productKey = normalizeCode(input.productCode);

  const products = await loadMasterProducts();
  const master = products.get(productKey);
  if (!master) {
    throw new SalesWorkflowError(
      "unknown_product",
      `Product code "${String(input.productCode ?? "").trim()}" is not in the Source of Sales master.`,
      400,
    );
  }

  const normalizedAlias = normalizeAlias(alias, aliasKind);
  if (!normalizedAlias) throw new SalesWorkflowError("invalid_request", "Alias could not be normalized.", 400);

  const supabase = getSupabaseAdmin();
  const existing = await supabase
    .from("weekly_sales_product_aliases")
    .select("id, product_code")
    .eq("distributor_code", distributorCode)
    .eq("alias_kind", aliasKind)
    .eq("normalized_alias", normalizedAlias)
    .maybeSingle();
  if (existing.error && existing.error.code !== "PGRST116") {
    throw new SalesWorkflowError("load_failed", existing.error.message, 500);
  }

  if (existing.data) {
    if (normalizeCode(existing.data.product_code) !== productKey) {
      // Ambiguity guard: don't silently let one mapping win.
      throw new SalesWorkflowError(
        "alias_conflict",
        `This ${aliasKind} alias already maps to ${existing.data.product_code}. Delete or change that mapping first.`,
        409,
      );
    }
    const update = await supabase
      .from("weekly_sales_product_aliases")
      .update({ alias, product_code: master.code, updated_by: input.actorId, updated_at: new Date().toISOString() })
      .eq("id", existing.data.id);
    if (update.error) throw new SalesWorkflowError("persist_failed", update.error.message, 500);
    await healUnresolvedWeeklyRows({ distributorCode, alias, aliasKind, master });
    return;
  }

  const insert = await supabase.from("weekly_sales_product_aliases").insert({
    distributor_code: distributorCode,
    alias,
    alias_kind: aliasKind,
    normalized_alias: normalizedAlias,
    product_code: master.code,
    created_by: input.actorId,
    updated_by: input.actorId,
  });
  if (insert.error) throw new SalesWorkflowError("persist_failed", insert.error.message, 500);
  await healUnresolvedWeeklyRows({ distributorCode, alias, aliasKind, master });
}

export async function deleteProductAlias(id: string): Promise<void> {
  const aliasId = String(id ?? "").trim();
  if (!aliasId) throw new SalesWorkflowError("invalid_request", "An alias id is required.", 400);
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("weekly_sales_product_aliases").delete().eq("id", aliasId);
  if (error) throw new SalesWorkflowError("delete_failed", error.message, 500);
}

/**
 * After an alias is saved, find all stored warning rows whose item_code (or product_name for
 * name-kind aliases) matches and re-resolve them to the correct master product. This auto-heals
 * any upload that was stored with a "productCode" warning before the alias existed.
 */
export async function healUnresolvedWeeklyRows(input: {
  distributorCode: string;
  alias: string;
  aliasKind: WeeklyAliasKind;
  master: WeeklyMasterProduct;
}): Promise<number> {
  const supabase = getSupabaseAdmin();

  // Match column: code alias → item_code (raw distributor code from file);
  // name alias → product_name (stored as raw item name for unresolved rows).
  const matchColumn = input.aliasKind === "code" ? "item_code" : "product_name";

  const { data, error } = await supabase
    .from("weekly_sales_rows")
    .select("id, batch_id, net_qty, sales_value, validation_issues")
    .eq("distributor_code", input.distributorCode)
    .eq("validation_state", "warning")
    .ilike(matchColumn, input.alias);
  if (error || !data?.length) return 0;

  type RowShape = {
    id: number;
    batch_id: string;
    net_qty: number;
    sales_value: number | null;
    validation_issues: { field: string; severity: string }[];
  };
  const deltas = new Map<string, WeeklyBatchHeaderDelta>();
  let healed = 0;
  for (const row of data as RowShape[]) {
    const remaining = (row.validation_issues ?? []).filter((i) => i.field !== "productCode");
    const newState = remaining.some((i) => i.severity === "failure") ? "failed" : remaining.length > 0 ? "warning" : "valid";
    const netQty = Number(row.net_qty ?? 0);
    const salesValue = Number((netQty * input.master.factoryPrice).toFixed(6));
    const { error: updateError } = await supabase
      .from("weekly_sales_rows")
      .update({
        product_code: input.master.code,
        product_name: input.master.name,
        official_line: input.master.line,
        sales_value: salesValue,
        validation_state: newState,
        validation_issues: remaining,
      })
      .eq("id", row.id);
    if (updateError) continue;
    healed += 1;
    accumulateBatchHeaderDelta(deltas, String(row.batch_id ?? ""), Number(row.sales_value ?? 0), salesValue, newState);
  }
  await applyBatchHeaderDeltas(deltas);
  return healed;
}

/** How one healed row moves its batch's stored header aggregates. */
export type WeeklyBatchHeaderDelta = { salesValue: number; warningRows: number; failedRows: number };

/**
 * Fold one healed row into its batch's header delta. A healed row always LEAVES the `warning` state
 * it was selected on, so it always decrements `warning_rows`; it only lands in `failed` when a
 * non-product failure survives the heal.
 *
 * Exported for the unit test — the arithmetic is the part that was missing entirely, so it is worth
 * pinning without a database.
 */
export function accumulateBatchHeaderDelta(
  deltas: Map<string, WeeklyBatchHeaderDelta>,
  batchId: string,
  oldSalesValue: number,
  newSalesValue: number,
  newState: "valid" | "warning" | "failed",
): void {
  if (!batchId) return;
  const delta = deltas.get(batchId) ?? { salesValue: 0, warningRows: 0, failedRows: 0 };
  delta.salesValue = Number((delta.salesValue + (newSalesValue - oldSalesValue)).toFixed(6));
  if (newState !== "warning") delta.warningRows -= 1;
  if (newState === "failed") delta.failedRows += 1;
  deltas.set(batchId, delta);
}

/**
 * Healing rewrites stored rows, so the batch header they were summarised into at upload goes stale —
 * and that header is NOT cosmetic: `computeThisWeekOnly` de-cumulates every later week of the cycle
 * against the prior batch's `total_sales_value`, and the batch list reports these counts as fact.
 * Carry the same delta onto the header so the two can never diverge.
 *
 * Found 2026-08-15: four June Overseas batches understated sales by up to 4,738.50 (one Dopaminect
 * row healed a month after upload) and still claimed up to 261 warning rows that healing had already
 * cleared.
 */
async function applyBatchHeaderDeltas(deltas: Map<string, WeeklyBatchHeaderDelta>): Promise<void> {
  if (deltas.size === 0) return;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("weekly_sales_batches")
    .select("id, total_sales_value, warning_rows, failed_rows, importable_rows")
    .in("id", [...deltas.keys()]);
  if (error || !data?.length) return;

  type BatchShape = {
    id: string;
    total_sales_value: number | null;
    warning_rows: number | null;
    failed_rows: number | null;
    importable_rows: number | null;
  };
  for (const batch of data as BatchShape[]) {
    const delta = deltas.get(String(batch.id));
    if (!delta) continue;
    await supabase
      .from("weekly_sales_batches")
      .update({
        total_sales_value: Number((Number(batch.total_sales_value ?? 0) + delta.salesValue).toFixed(6)),
        warning_rows: Math.max(0, Number(batch.warning_rows ?? 0) + delta.warningRows),
        failed_rows: Math.max(0, Number(batch.failed_rows ?? 0) + delta.failedRows),
        // A row that heals into `failed` stops being importable; nothing else changes the count.
        importable_rows: Math.max(0, Number(batch.importable_rows ?? 0) - delta.failedRows),
      })
      .eq("id", batch.id);
  }
}

export async function buildProductAliasTemplate(distributorCode: string): Promise<ArrayBuffer> {
  const code = canonicalWeeklyDistributorCode(distributorCode);
  const [{ aliases }, products] = await Promise.all([
    loadWeeklyProductAliasAdmin(code),
    loadMasterProducts(),
  ]);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Product Mapping");
  sheet.columns = [
    { header: "DISTRIBUTOR", key: "distributor", width: 14 },
    { header: "ALIAS", key: "alias", width: 40 },
    { header: "ALIAS_KIND", key: "aliasKind", width: 12 },
    { header: "PRODUCT_CODE", key: "productCode", width: 16 },
    { header: "PRODUCT_NAME", key: "productName", width: 40 },
  ];
  for (const row of aliases) {
    sheet.addRow({
      distributor: row.distributorCode,
      alias: row.alias,
      aliasKind: row.aliasKind,
      productCode: row.productCode,
      productName: row.productName,
    });
  }
  if (aliases.length === 0) {
    sheet.addRow({ distributor: code, alias: "paste distributor code or name", aliasKind: "code", productCode: "MASTER_CODE", productName: "(filled automatically)" });
  }
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF97316" } };
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  const reference = workbook.addWorksheet("Master Products");
  reference.columns = [
    { header: "PRODUCT_CODE", key: "code", width: 16 },
    { header: "PRODUCT_NAME", key: "name", width: 44 },
    { header: "LINE", key: "line", width: 22 },
    { header: "FACTORY_PRICE", key: "price", width: 16 },
  ];
  for (const product of [...products.values()].sort((left, right) => left.name.localeCompare(right.name))) {
    reference.addRow({ code: product.code, name: product.name, line: product.line, price: product.factoryPrice });
  }
  reference.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  reference.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } };
  reference.views = [{ state: "frozen", ySplit: 1 }];

  return workbook.xlsx.writeBuffer() as unknown as ArrayBuffer;
}

function cellString(row: ExcelJS.Row, index: number): string {
  const value = row.getCell(index).value as unknown;
  if (value == null) return "";
  if (typeof value === "object") {
    const obj = value as { text?: unknown; result?: unknown; richText?: { text?: string }[] };
    if (obj.richText) return obj.richText.map((part) => part.text).join("").trim();
    if (obj.result != null) return String(obj.result).trim();
    if (obj.text != null) return String(obj.text).trim();
  }
  return String(value).trim();
}

export async function importProductAliasWorkbook(input: {
  distributorCode: string;
  file: File;
  actorId: string | null;
}): Promise<WeeklyMappingImportResult> {
  const distributorCode = canonicalWeeklyDistributorCode(input.distributorCode);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await input.file.arrayBuffer()) as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.getWorksheet("Product Mapping") ?? workbook.worksheets[0];
  if (!sheet) throw new SalesWorkflowError("invalid_mapping_template", "The mapping workbook has no sheets.", 400);

  const products = await loadMasterProducts();
  const blockedRows: WeeklyMappingImportResult["blockedRows"] = [];
  type Pending = { alias: string; aliasKind: WeeklyAliasKind; normalizedAlias: string; productCode: string };
  const pending: Pending[] = [];
  const seen = new Map<string, string>(); // kind+normalized -> productCode (within-file dup guard)
  let skipped = 0;

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const alias = cellString(row, 2);
    const aliasKind = aliasKindOf(cellString(row, 3));
    const productCodeRaw = cellString(row, 4);
    if (!alias && !productCodeRaw) {
      skipped += 1;
      continue;
    }
    if (!alias) {
      blockedRows.push({ rowNumber, reason: "Alias is required.", values: `${productCodeRaw}` });
      continue;
    }
    const productKey = normalizeCode(productCodeRaw);
    if (!productKey || !products.has(productKey)) {
      blockedRows.push({ rowNumber, reason: `Product code "${productCodeRaw || "(blank)"}" is not in the Source of Sales master.`, values: alias });
      continue;
    }
    const normalizedAlias = normalizeAlias(alias, aliasKind);
    if (!normalizedAlias) {
      blockedRows.push({ rowNumber, reason: "Alias could not be normalized.", values: alias });
      continue;
    }
    const dupKey = `${aliasKind} ${normalizedAlias}`;
    const priorProduct = seen.get(dupKey);
    if (priorProduct && priorProduct !== productKey) {
      blockedRows.push({ rowNumber, reason: `Alias "${alias}" maps to two different products in this file.`, values: alias });
      continue;
    }
    seen.set(dupKey, productKey);
    pending.push({ alias, aliasKind, normalizedAlias, productCode: products.get(productKey)!.code });
  }

  if (blockedRows.length > 0) return { inserted: 0, updated: 0, skipped, blockedRows };

  let inserted = 0;
  let updated = 0;
  const supabase = getSupabaseAdmin();
  for (const item of pending) {
    const existing = await supabase
      .from("weekly_sales_product_aliases")
      .select("id, product_code")
      .eq("distributor_code", distributorCode)
      .eq("alias_kind", item.aliasKind)
      .eq("normalized_alias", item.normalizedAlias)
      .maybeSingle();
    if (existing.error && existing.error.code !== "PGRST116") throw new SalesWorkflowError("load_failed", existing.error.message, 500);

    const master = products.get(normalizeCode(item.productCode))!;
    if (existing.data) {
      const update = await supabase
        .from("weekly_sales_product_aliases")
        .update({ alias: item.alias, product_code: item.productCode, updated_by: input.actorId, updated_at: new Date().toISOString() })
        .eq("id", existing.data.id);
      if (update.error) throw new SalesWorkflowError("persist_failed", update.error.message, 500);
      updated += 1;
    } else {
      const insert = await supabase.from("weekly_sales_product_aliases").insert({
        distributor_code: distributorCode,
        alias: item.alias,
        alias_kind: item.aliasKind,
        normalized_alias: item.normalizedAlias,
        product_code: item.productCode,
        created_by: input.actorId,
        updated_by: input.actorId,
      });
      if (insert.error) throw new SalesWorkflowError("persist_failed", insert.error.message, 500);
      inserted += 1;
    }
    // Auto-heal any warning rows that were stored before this alias existed.
    await healUnresolvedWeeklyRows({ distributorCode, alias: item.alias, aliasKind: item.aliasKind, master });
  }
  return { inserted, updated, skipped, blockedRows };
}

/** One already-confirmed mapping, in the shape the AI few-shot prompt wants. */
export type WeeklyAliasExample = { raw: string; code: string; distributorCode: string };

/**
 * Every product mapping already confirmed, as raw-text → product-code examples for the AI.
 *
 * The RAW alias is returned, not the normalized one: normalization uppercases and strips, which is
 * right for exact lookups and wrong as a worked example — the model learns more from the spelling a
 * distributor actually uses. IGNORE mappings are kept: "this raw text is something we don't sell" is
 * one of the most useful patterns the dictionary holds.
 */
export async function listWeeklyProductAliasExamples(distributorCode?: string | null, limit = 600): Promise<WeeklyAliasExample[]> {
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("weekly_sales_product_aliases")
    .select("distributor_code, alias, product_code")
    .order("updated_at", { ascending: false })
    .limit(Math.max(1, limit));
  if (distributorCode) query = query.eq("distributor_code", canonicalWeeklyDistributorCode(distributorCode));
  const { data, error } = await query;
  if (error) throw new SalesWorkflowError("load_failed", error.message, 500);

  const examples: WeeklyAliasExample[] = [];
  for (const row of data ?? []) {
    const raw = String(row.alias ?? "").trim();
    const code = String(row.product_code ?? "").trim();
    if (!raw || !code) continue;
    examples.push({ raw, code, distributorCode: String(row.distributor_code ?? "").trim().toUpperCase() });
  }
  return examples;
}

/** Build the per-distributor alias resolution index for the upload parser. */
export async function loadProductAliasIndex(): Promise<WeeklyProductAliasIndex> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("weekly_sales_product_aliases")
    .select("distributor_code, alias_kind, normalized_alias, product_code");
  if (error) throw new SalesWorkflowError("load_failed", error.message, 500);

  const index: WeeklyProductAliasIndex = new Map();
  for (const row of data ?? []) {
    const distributor = String(row.distributor_code ?? "").trim().toUpperCase();
    const productCode = String(row.product_code ?? "").trim();
    const normalized = String(row.normalized_alias ?? "");
    if (!distributor || !productCode || !normalized) continue;
    const bucket = index.get(distributor) ?? { byCode: new Map<string, string>(), byName: new Map<string, string>() };
    if (aliasKindOf(row.alias_kind) === "name") bucket.byName.set(normalized, productCode);
    else bucket.byCode.set(normalized, productCode);
    index.set(distributor, bucket);
  }
  return index;
}
