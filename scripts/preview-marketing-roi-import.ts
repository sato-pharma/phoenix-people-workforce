// READ-ONLY dry-run preview for the historical ROI sheet importer.
//
// It loads the flattened ROI sheet, resolves every product / requester / request-type /
// pharmacy against the LIVE database (SELECT only — it never writes), recomputes
// expected ROI with the marketing catalog price, and prints what a real import would
// load plus every row a human must review first. Use it to sign off the mapping
// before the (separate, approval-gated) write importer runs against staging.
//
// Usage:
//   MARKETING_ROI_SHEET_XLSX="../ROIxx.xlsx" pnpm run marketing:roi-preview

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  buildRoiImportPreview,
  parseRoiSheetRows,
  type RoiImportLookups,
} from "@/lib/marketing-requests/roi-sheet-import";
import { readRoiSheet } from "./lib/read-roi-sheet.ts";

// Load Supabase env from .env.local the way the other read-only audit scripts do, so this
// runner works standalone. Looks in cwd, an optional MARKETING_ENV_FILE, and the primary
// repo (useful when run from a worktree). Never overwrites an env var already set.
function loadEnvLocal() {
  const candidates = [
    process.env.MARKETING_ENV_FILE,
    path.resolve(process.cwd(), ".env.local"),
    path.resolve(process.cwd(), "..", "phoenix-workforce", ".env.local"),
  ].filter((value): value is string => Boolean(value));
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvLocal();

const sheetPath = path.resolve(
  process.cwd(),
  process.env.MARKETING_ROI_SHEET_XLSX?.trim() || "ROIxx.xlsx",
);

async function loadLookups(): Promise<RoiImportLookups> {
  const supabase = getSupabaseAdmin();

  const { data: products, error: productError } = await supabase
    .from("marketing_products")
    .select("id, normalized_name, factory_price");
  if (productError) throw productError;
  const productByName = new Map<string, { id: number; factoryPrice: number }>();
  const productIdByNormalizedName = new Map<string, { id: number; factoryPrice: number }>();
  for (const product of products ?? []) {
    const name = String((product as { normalized_name: unknown }).normalized_name ?? "");
    if (!name) continue;
    const entry = {
      id: Number((product as { id: unknown }).id),
      factoryPrice: Number((product as { factory_price: unknown }).factory_price ?? 0),
    };
    productByName.set(name, entry);
    productIdByNormalizedName.set(name, entry);
  }

  // Bridge the sheet's clean Product_ID (a Source-of-Sales code like "RO001") to the
  // marketing catalog by normalized product name. This keeps the messy sheet display
  // names ("Royafloxacin 500 tab") from blocking resolution.
  const { data: sosProducts, error: sosError } = await supabase
    .from("source_of_sales_products")
    .select("product_code, product_name");
  if (sosError) throw sosError;
  const productByCode = new Map<string, { id: number; factoryPrice: number }>();
  for (const sos of sosProducts ?? []) {
    const code = String((sos as { product_code: unknown }).product_code ?? "").trim().toUpperCase();
    const name = String((sos as { product_name: unknown }).product_name ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    const marketing = productIdByNormalizedName.get(name);
    if (code && marketing) productByCode.set(code, marketing);
  }

  const { data: types, error: typeError } = await supabase
    .from("marketing_request_types")
    .select("id, code");
  if (typeError) throw typeError;
  const requestTypeIdByCode = new Map<string, number>();
  for (const type of types ?? []) {
    requestTypeIdByCode.set(
      String((type as { code: unknown }).code ?? ""),
      Number((type as { id: unknown }).id),
    );
  }

  // Paged, ordered by the key: a single read of a growing table stops silently at 1,000 rows.
  const employees = await fetchAllRows<{ hr_id: unknown }>(
    () => supabase.from("employees").select("hr_id"),
    "hr_id",
  );
  const employeeHrIds = new Set<string>();
  for (const employee of employees) {
    const hrId = String(employee.hr_id ?? "").trim().toUpperCase();
    if (hrId) employeeHrIds.add(hrId);
  }

  // Page through the pharmacy code crosswalk (read-only) and strip leading zeros
  // so the keys line up with the sheet's normalizeCustomerCode match keys.
  const knownPharmacyCodes = new Set<string>();
  const references = await fetchAllRows<{ raw_pharmacy_code: unknown }>(
    () => supabase.from("marketing_pharmacy_code_references").select("raw_pharmacy_code"),
    "id",
  );
  for (const ref of references) {
    const raw = String(ref.raw_pharmacy_code ?? "").trim();
    const key = raw.replace(/^0+/, "") || raw;
    if (key) knownPharmacyCodes.add(key);
  }

  return { productByCode, productByName, requestTypeIdByCode, employeeHrIds, knownPharmacyCodes };
}

const rawRows = await readRoiSheet(sheetPath);
const lines = parseRoiSheetRows(rawRows);
const lookups = await loadLookups();
const preview = buildRoiImportPreview(lines, lookups);

console.log("=== Marketing ROI sheet — DRY-RUN preview (no data written) ===");
console.log(`source: ${sheetPath}`);
console.log(JSON.stringify(preview.summary, null, 2));

const flagged = preview.lines.filter((line) => line.flags.length > 0);
console.log(`\n${flagged.length} line-items carry at least one flag. First 40:`);
for (const line of flagged.slice(0, 40)) {
  console.log(
    `  #${line.index} ${line.requestCode ?? "(no code)"} [${line.hrId ?? "?"}] ` +
      `sheetROI=${line.sheetRoi} computed=${line.computedExpectedRoi} ` +
      `→ ${line.flags.join(", ")}` +
      (line.unresolvedProducts.length ? ` | products: ${line.unresolvedProducts.join("; ")}` : ""),
  );
}

// Write the full preview (summary + every line) so it can be reviewed outside the console.
const outPath = path.resolve(
  process.cwd(),
  process.env.MARKETING_ROI_PREVIEW_OUT?.trim() || "roi-import-preview.json",
);
writeFileSync(outPath, JSON.stringify(preview, null, 2), "utf8");
console.log(`\nFull preview written to: ${outPath}`);
