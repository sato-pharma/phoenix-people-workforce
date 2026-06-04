import ExcelJS from "exceljs";

import { systemIdentity } from "@/config/system-settings";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { normalizeAliasKey, normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import { IGNORE_PRODUCT_CODE, type NormalizeException } from "@/lib/sales/normalizer/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// Bulk mapping — turns a long "Needs mapping" list into a SHORT list of distinct unknown codes
// (one decision fixes every row that shares that code) with a suggested Phoenix match, and writes
// confirmed mappings into the alias tables that already exist (so they are remembered forever).

export type ProductRef = { code: string; family?: string; name: string };

export type DistinctUnknown = {
  count: number;
  raw: string; // the distinct raw key the user maps once
  rawName: string;
  suggestionCode: string | null;
  suggestionLabel: string | null;
};

export type DistinctUnknowns = { products: DistinctUnknown[]; territories: DistinctUnknown[] };

function tokens(value: string): Set<string> {
  return new Set(normalizeAliasKey(value).split(" ").filter((t) => t.length >= 2));
}

// Token-overlap fuzzy match of a raw item name against the Phoenix product names/families.
// "TEBOFORTIN FORTE 30TAB" → Tebofortin (TE…). Cheap and high hit-rate for English item names.
export function suggestProduct(rawName: string, products: ProductRef[]): { code: string; label: string } | null {
  const rawTokens = tokens(rawName);
  if (rawTokens.size === 0) return null;
  let best: { code: string; label: string; score: number } | null = null;
  for (const product of products) {
    const productTokens = tokens(`${product.name} ${product.family ?? ""}`);
    let overlap = 0;
    for (const token of productTokens) if (rawTokens.has(token)) overlap += 1;
    if (overlap > 0 && (!best || overlap > best.score)) best = { code: product.code, label: product.name, score: overlap };
  }
  return best ? { code: best.code, label: best.label } : null;
}

export function distinctUnknowns(exceptions: NormalizeException[], products: ProductRef[]): DistinctUnknowns {
  const productMap = new Map<string, DistinctUnknown>();
  const territoryMap = new Map<string, DistinctUnknown>();
  for (const ex of exceptions) {
    if ((ex.reason === "product" || ex.reason === "both") && ex.rawProduct) {
      let entry = productMap.get(ex.rawProduct);
      if (!entry) {
        const suggestion = suggestProduct(ex.rawProductName || ex.rawProduct, products);
        entry = { count: 0, raw: ex.rawProduct, rawName: ex.rawProductName, suggestionCode: suggestion?.code ?? null, suggestionLabel: suggestion?.label ?? null };
        productMap.set(ex.rawProduct, entry);
      }
      entry.count += 1;
      if (!entry.rawName && ex.rawProductName) entry.rawName = ex.rawProductName;
    }
    if ((ex.reason === "brick" || ex.reason === "both") && ex.rawTerritory) {
      const key = normalizeAliasKey(ex.rawTerritory);
      let entry = territoryMap.get(key);
      if (!entry) { entry = { count: 0, raw: ex.rawTerritory, rawName: "", suggestionCode: null, suggestionLabel: null }; territoryMap.set(key, entry); }
      entry.count += 1;
    }
  }
  const sorted = (m: Map<string, DistinctUnknown>) => [...m.values()].sort((a, b) => b.count - a.count);
  return { products: sorted(productMap), territories: sorted(territoryMap) };
}

// ── write path (insert-if-absent, validated against the masters) ──

export type MappingInput = { code: string; raw: string; type: "product" | "territory" };

export async function saveMappings(mappings: MappingInput[]): Promise<{ saved: number; skipped: number; invalid: number }> {
  const refs = await loadSalesReferenceData();
  const productCodes = new Set(refs.products.map((p) => normalizeCodeKey(p.productCode)));
  productCodes.add(IGNORE_PRODUCT_CODE); // "neglect this item" is a valid product target
  const brickIds = new Set((refs.bricks ?? []).map((b) => normalizeCodeKey(b.brickId)));
  const supabase = getSupabaseAdmin();

  const [existProd, existTerr] = await Promise.all([
    supabase.from("source_of_sales_product_aliases").select("normalized_alias").eq("active", true),
    supabase.from("source_of_sales_territory_aliases").select("normalized_alias").eq("active", true),
  ]);
  const haveProd = new Set(((existProd.data ?? []) as Array<{ normalized_alias?: string }>).map((r) => normalizeAliasKey(r.normalized_alias)));
  const haveTerr = new Set(((existTerr.data ?? []) as Array<{ normalized_alias?: string }>).map((r) => normalizeAliasKey(r.normalized_alias)));

  const productRows: Record<string, unknown>[] = [];
  const territoryRows: Record<string, unknown>[] = [];
  let skipped = 0;
  let invalid = 0;
  for (const mapping of mappings) {
    const raw = String(mapping.raw ?? "").trim();
    const code = normalizeCodeKey(mapping.code);
    const key = normalizeAliasKey(raw);
    if (!raw || !code || !key) { invalid += 1; continue; }
    if (mapping.type === "product") {
      if (!productCodes.has(code)) { invalid += 1; continue; }
      if (haveProd.has(key)) { skipped += 1; continue; }
      haveProd.add(key);
      productRows.push({ alias: raw, normalized_alias: key, product_code: code, active: true, source_file: "normalizer" });
    } else {
      if (!brickIds.has(code)) { invalid += 1; continue; }
      if (haveTerr.has(key)) { skipped += 1; continue; }
      haveTerr.add(key);
      territoryRows.push({ alias: raw, normalized_alias: key, target_type: "brick", target_code: code, active: true, source_file: "normalizer" });
    }
  }
  if (productRows.length) { const { error } = await supabase.from("source_of_sales_product_aliases").insert(productRows); if (error) throw error; }
  if (territoryRows.length) { const { error } = await supabase.from("source_of_sales_territory_aliases").insert(territoryRows); if (error) throw error; }
  return { saved: productRows.length + territoryRows.length, skipped, invalid };
}

// ── Excel bulk round-trip ──

export function buildUnmappedWorkbook(distinct: DistinctUnknowns): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemIdentity.appName;
  const sheet = workbook.addWorksheet("Unmapped");
  const header = sheet.addRow(["Type", "Raw code", "Raw name", "Count", "Suggestion code", "Phoenix Code (fill)"]);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.eachCell((c) => { c.fill = { fgColor: { argb: "FF0B0B0B" }, pattern: "solid", type: "pattern" }; });
  distinct.products.forEach((u) => sheet.addRow(["product", u.raw, u.rawName, u.count, u.suggestionCode ?? "", u.suggestionCode ?? ""]));
  distinct.territories.forEach((u) => sheet.addRow(["territory", u.raw, u.rawName, u.count, "", ""]));
  [10, 24, 32, 8, 16, 20].forEach((w, i) => { sheet.getColumn(i + 1).width = w; });
  return workbook.xlsx.writeBuffer();
}

export async function learnFromUploadedMappings(buffer: ArrayBuffer | Buffer): Promise<{ saved: number; skipped: number; invalid: number }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { saved: 0, skipped: 0, invalid: 0 };
  const idx: Record<string, number> = {};
  sheet.getRow(1).eachCell({ includeEmpty: false }, (c, col) => { idx[String(c.text).trim().toLowerCase()] = col; });
  const typeCol = idx["type"]; const rawCol = idx["raw code"]; const fillCol = idx["phoenix code (fill)"];
  if (!typeCol || !rawCol || !fillCol) throw new Error("This is not a valid unmapped-list workbook (missing Type / Raw code / Phoenix Code columns).");
  const mappings: MappingInput[] = [];
  for (let r = 2; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const type = String(row.getCell(typeCol)?.text ?? "").trim().toLowerCase();
    const raw = String(row.getCell(rawCol)?.text ?? "").trim();
    const code = String(row.getCell(fillCol)?.text ?? "").trim();
    if ((type === "product" || type === "territory") && raw && code) mappings.push({ code, raw, type });
  }
  return saveMappings(mappings);
}
