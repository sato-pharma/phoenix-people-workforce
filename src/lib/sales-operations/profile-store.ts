// Sales Operations Module — DB-first distributor profile store.
//
// The sheet-style mapping editor saves per-distributor column mappings into the editable
// sales_ops_distributor_profile table. Resolution is DB-FIRST: a saved row wins; otherwise the code
// dictionary (DISTRIBUTOR_TEMPLATES) is the fallback. The table ships EMPTY, so behavior is identical
// to the code templates until an admin edits a mapping.
//
// Designs out the old module's issues: the editor shows the REAL saved values (DB-first, not code
// defaults), supports MULTI-COLUMN per field, and has NO dead branch columns. fingerprint columns and
// blankCustomerBehavior stay code-defined (not editable) and are merged from the code template.

import { getDistributorTemplate, listDistributorTemplates } from "@/lib/sales-operations/dictionary";
import type { BrickLookupStrategy, DistributorTemplate } from "@/lib/sales-operations/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const TABLE = "sales_ops_distributor_profile";

export type ProfileRow = {
  distributor_code: string;
  brick_lookup: string;
  customer_code_columns: string[] | null;
  customer_name_columns: string[] | null;
  customer_address_columns: string[] | null;
  brick_name_columns: string[] | null;
  product_name_columns: string[] | null;
  product_code_columns: string[] | null;
  qty_columns: string[] | null;
  date_columns: string[] | null;
  bonus_columns: string[] | null;
  region_only: boolean | null;
  date_format: string | null;
};

function arr(value: string[] | null | undefined): string[] {
  return (value ?? []).map((v) => String(v ?? "").trim()).filter(Boolean);
}

function optArr(value: string[] | null | undefined): string[] | undefined {
  const out = arr(value);
  return out.length > 0 ? out : undefined;
}

// Pure: a DB row → DistributorTemplate. Name, fingerprint columns and blankCustomerBehavior are NOT
// stored in the editable table, so they are merged from the code template (display + detection +
// EG-BR's hard blank-customer rule stay code-defined).
export function rowToTemplate(row: ProfileRow, codeTemplate?: DistributorTemplate): DistributorTemplate {
  const brickLookup = (["customer-code", "brick-name", "office-allocation"].includes(row.brick_lookup) ? row.brick_lookup : "customer-code") as BrickLookupStrategy;
  const dateHeaders = optArr(row.date_columns);
  return {
    code: row.distributor_code,
    name: codeTemplate?.name ?? row.distributor_code,
    brickLookup,
    customerCodeHeaders: optArr(row.customer_code_columns),
    customerNameHeaders: optArr(row.customer_name_columns),
    customerAddressHeaders: optArr(row.customer_address_columns),
    brickNameHeaders: optArr(row.brick_name_columns),
    productNameHeaders: optArr(row.product_name_columns),
    productCodeHeaders: optArr(row.product_code_columns),
    qtyHeaders: optArr(row.qty_columns),
    dateHeaders,
    bonusHeaders: optArr(row.bonus_columns),
    dateFormat: row.date_format === "month-first" ? "month-first" : "day-first",
    regionOnly: Boolean(row.region_only),
    fingerprintHeaders: codeTemplate?.fingerprintHeaders,
    blankCustomerBehavior: codeTemplate?.blankCustomerBehavior,
    hasDateColumn: Boolean(dateHeaders && dateHeaders.length > 0),
  };
}

// Pure: a DistributorTemplate → the editable DB row (for seeding / save).
export function templateToRow(template: DistributorTemplate): Omit<ProfileRow, never> {
  return {
    distributor_code: template.code,
    brick_lookup: template.brickLookup,
    customer_code_columns: arr(template.customerCodeHeaders),
    customer_name_columns: arr(template.customerNameHeaders),
    customer_address_columns: arr(template.customerAddressHeaders),
    brick_name_columns: arr(template.brickNameHeaders),
    product_name_columns: arr(template.productNameHeaders),
    product_code_columns: arr(template.productCodeHeaders),
    qty_columns: arr(template.qtyHeaders),
    date_columns: arr(template.dateHeaders),
    bonus_columns: arr(template.bonusHeaders),
    region_only: Boolean(template.regionOnly),
    date_format: template.dateFormat ?? "day-first",
  };
}

// DB-first template resolution for the recognizer. A saved active row wins; else the code template.
export async function resolveSalesOpsTemplate(code: string): Promise<DistributorTemplate | undefined> {
  const codeTemplate = getDistributorTemplate(code);
  const key = codeTemplate?.code ?? String(code ?? "").trim().toUpperCase();
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.from(TABLE).select("*").eq("distributor_code", key).eq("active", true).maybeSingle();
    if (!error && data) return rowToTemplate(data as ProfileRow, codeTemplate);
  } catch {
    // fall through to the code template
  }
  return codeTemplate;
}

export type EditableTemplate = { template: DistributorTemplate; isCustom: boolean };

// Every distributor with its CURRENT effective mapping: the saved DB row when present (isCustom=true),
// otherwise the code template. This is what the editor renders — real saved values, not code defaults.
export async function listEditableTemplates(): Promise<EditableTemplate[]> {
  const codeTemplates = listDistributorTemplates();
  let dbRows: ProfileRow[] = [];
  try {
    const supabase = getSupabaseAdmin();
    const { data } = await supabase.from(TABLE).select("*").eq("active", true);
    dbRows = (data ?? []) as ProfileRow[];
  } catch {
    dbRows = [];
  }
  const byCode = new Map(dbRows.map((r) => [String(r.distributor_code ?? "").trim().toUpperCase(), r]));
  return codeTemplates.map((ct) => {
    const row = byCode.get(ct.code.trim().toUpperCase());
    return row ? { template: rowToTemplate(row, ct), isCustom: true } : { template: ct, isCustom: false };
  });
}

export type SaveTemplateInput = {
  distributorCode: string;
  brickLookup: BrickLookupStrategy;
  customerCodeHeaders?: string[];
  customerNameHeaders?: string[];
  customerAddressHeaders?: string[];
  brickNameHeaders?: string[];
  productNameHeaders?: string[];
  productCodeHeaders?: string[];
  qtyHeaders?: string[];
  dateHeaders?: string[];
  bonusHeaders?: string[];
  regionOnly?: boolean;
  dateFormat?: "day-first" | "month-first";
  updatedBy: string;
};

// Upsert one distributor's editable mapping. Keyed on the canonical distributor code.
export async function saveSalesOpsTemplate(input: SaveTemplateInput): Promise<void> {
  const codeTemplate = getDistributorTemplate(input.distributorCode);
  const key = codeTemplate?.code ?? String(input.distributorCode ?? "").trim().toUpperCase();
  if (!key) throw new Error("A distributor code is required.");
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from(TABLE).upsert(
    {
      distributor_code: key,
      brick_lookup: input.brickLookup,
      customer_code_columns: arr(input.customerCodeHeaders),
      customer_name_columns: arr(input.customerNameHeaders),
      customer_address_columns: arr(input.customerAddressHeaders),
      brick_name_columns: arr(input.brickNameHeaders),
      product_name_columns: arr(input.productNameHeaders),
      product_code_columns: arr(input.productCodeHeaders),
      qty_columns: arr(input.qtyHeaders),
      date_columns: arr(input.dateHeaders),
      bonus_columns: arr(input.bonusHeaders),
      region_only: Boolean(input.regionOnly),
      date_format: input.dateFormat ?? "day-first",
      active: true,
      updated_by: input.updatedBy,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "distributor_code" },
  );
  if (error) throw error;
}

// Reset one distributor back to the code default (delete the override row).
export async function resetSalesOpsTemplate(distributorCode: string): Promise<void> {
  const codeTemplate = getDistributorTemplate(distributorCode);
  const key = codeTemplate?.code ?? String(distributorCode ?? "").trim().toUpperCase();
  if (!key) return;
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from(TABLE).delete().eq("distributor_code", key);
  if (error) throw error;
}
