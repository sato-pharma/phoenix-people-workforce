import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import ExcelJS from "exceljs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  buildSourceOfSalesWarningExport,
  classifySourceOfSalesWarning,
  describeStoredValidationStates,
  explainNoStoredWarnings,
  normalizeSourceOfSalesCode,
  normalizeSourceOfSalesKey,
  revalidateSourceOfSalesWarningRow,
  summarizeRevalidation,
  type SourceOfSalesLeftOutTotals,
  type SourceOfSalesReferenceData,
  type SourceOfSalesValidationIssue,
  type SourceOfSalesWarningRow,
} from "../src/lib/sales/source-of-sales-warning-cleanup.ts";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "source-of-sales-warning-cleanup",
  entry: import.meta.url,
  known: ["--out", "--limit", "--corrections", "--backup-dir", "--apply", "--confirm-production-apply", "--help", "-h"],
});

type Options = Record<string, string | boolean>;
type PreviewCorrections = Pick<SourceOfSalesReferenceData, "areas" | "regions">;

const productionRef = "ozucdzovmcqvepbozvqf";

function usage(): never {
  console.log(`
Source of Sales warning cleanup

Commands:
  export      --out outputs/sos-warning-cleanup.xlsx [--limit 1000]
  dry-run     --corrections outputs/sos-warning-cleanup.xlsx [--out outputs/sos-warning-dry-run.xlsx]
  apply       --corrections outputs/sos-warning-cleanup.xlsx --backup-dir outputs/sos-warning-backup --apply --confirm-production-apply
  verify

Notes:
  - export, dry-run, and verify are read-only.
  - apply refuses to run without both --apply and --confirm-production-apply.
  - apply always writes a backup before any production mutation.
  - product-name differences are distributor aliases once product_code is trusted; the Product Name sheet is audit-only.
`);
  process.exit(1);
}

function parseArgs() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") usage();
  const options: Options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return { command, options };
}

function optionText(options: Options, key: string, fallback = "") {
  const value = options[key];
  return typeof value === "string" ? value : fallback;
}

function optionNumber(options: Options, key: string) {
  const value = Number(optionText(options, key));
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  for (const raw of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function supabaseClient() {
  loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function currentProjectRef() {
  return (process.env.NEXT_PUBLIC_SUPABASE_URL?.match(/https:\/\/([^.]+)\.supabase\.co/) ?? [])[1] ?? "unknown";
}

async function fetchAll<T>(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  mutate?: (query: ReturnType<SupabaseClient["from"]> extends infer R ? R : never) => unknown,
): Promise<T[]> {
  const rows: T[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    let query = supabase.from(table).select(columns).range(from, from + pageSize - 1);
    if (mutate) query = mutate(query as never) as typeof query;
    const { data, error } = await query;
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

async function loadWarningRows(supabase: SupabaseClient, limit: number | null): Promise<SourceOfSalesWarningRow[]> {
  const columns = [
    "id",
    "row_number",
    "distributor_code",
    "invoice_period",
    "region_code",
    "region_name",
    "area_code",
    "area_name",
    "brick_id",
    "client_code",
    "client_name",
    "product_code",
    "product_name",
    "validation_issues",
    "raw_row",
  ].join(",");
  const rows: SourceOfSalesWarningRow[] = [];
  const pageSize = 1000;
  let lastId = 0;
  for (;;) {
    const remaining = limit == null ? pageSize : Math.min(pageSize, limit - rows.length);
    if (remaining <= 0) break;
    const { data, error } = await supabase
      .from("source_of_sales_import_rows")
      .select(columns)
      .eq("validation_state", "warning")
      .gt("id", lastId)
      .order("id", { ascending: true })
      .limit(remaining);
    if (error) throw new Error(`source_of_sales_import_rows: ${error.message}`);
    for (const row of data ?? []) {
      const mapped = mapWarningRow(row as unknown as Record<string, unknown>);
      rows.push(mapped);
      lastId = mapped.id;
    }
    if (!data || data.length < remaining) break;
  }
  return rows;
}

function mapWarningRow(row: Record<string, unknown>): SourceOfSalesWarningRow {
  return {
    areaCode: nullableText(row.area_code),
    areaName: nullableText(row.area_name),
    brickId: nullableText(row.brick_id),
    clientCode: nullableText(row.client_code),
    clientName: nullableText(row.client_name),
    distributorCode: String(row.distributor_code ?? ""),
    id: Number(row.id),
    invoicePeriod: nullableText(row.invoice_period),
    productCode: String(row.product_code ?? ""),
    productName: String(row.product_name ?? ""),
    rawRow: row.raw_row && typeof row.raw_row === "object" ? row.raw_row as Record<string, unknown> : {},
    regionCode: String(row.region_code ?? ""),
    regionName: String(row.region_name ?? ""),
    rowNumber: row.row_number == null ? null : Number(row.row_number),
    validationIssues: Array.isArray(row.validation_issues) ? row.validation_issues as SourceOfSalesValidationIssue[] : [],
  };
}

function nullableText(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

async function loadReferences(supabase: SupabaseClient): Promise<SourceOfSalesReferenceData> {
  const [products, distributors, regions, areas, bricks] = await Promise.all([
    fetchAll<Record<string, unknown>>(supabase, "source_of_sales_products", "product_code,product_name,line"),
    fetchAll<Record<string, unknown>>(supabase, "source_of_sales_distributors", "distributor_code,distributor_name"),
    fetchAll<Record<string, unknown>>(supabase, "source_of_sales_regions", "region_code,region_name"),
    fetchAll<Record<string, unknown>>(supabase, "source_of_sales_areas", "area_code,area_name,region_code"),
    fetchAll<Record<string, unknown>>(supabase, "source_of_sales_bricks", "brick_id,area_code,region_code"),
  ]);
  return {
    areas: areas.map((row) => ({
      areaCode: String(row.area_code ?? ""),
      areaName: String(row.area_name ?? ""),
      regionCode: String(row.region_code ?? ""),
    })),
    bricks: bricks.map((row) => ({
      areaCode: String(row.area_code ?? ""),
      brickId: String(row.brick_id ?? ""),
      regionCode: String(row.region_code ?? ""),
    })),
    distributors: distributors.map((row) => ({
      distributorCode: String(row.distributor_code ?? ""),
      distributorName: String(row.distributor_name ?? ""),
    })),
    products: products.map((row) => ({
      line: String(row.line ?? ""),
      productCode: String(row.product_code ?? ""),
      productName: String(row.product_name ?? ""),
    })),
    regions: regions.map((row) => ({
      regionCode: String(row.region_code ?? ""),
      regionName: String(row.region_name ?? ""),
    })),
  };
}

function addSheet(workbook: ExcelJS.Workbook, name: string, rows: Array<Record<string, string | number>>) {
  if (rows.length === 0) return;
  const sheet = workbook.addWorksheet(name.slice(0, 31));
  const headers = Object.keys(rows[0]);
  sheet.columns = headers.map((header) => ({ header, key: header, width: Math.max(14, Math.min(48, header.length + 4)) }));
  for (const row of rows) sheet.addRow(row);
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

async function exportWarnings(options: Options) {
  const supabase = supabaseClient();
  const out = optionText(options, "out", "outputs/sos-warning-cleanup.xlsx");
  const rows = await loadWarningRows(supabase, optionNumber(options, "limit"));
  // A workbook with no sheets and "Exported 0 warning rows" read as clean data. The importers
  // never store a warning row (see explainNoStoredWarnings), so say that instead of writing a file.
  if (rows.length === 0) {
    console.log(`Nothing exported: no stored row is marked warning, so ${out} was not written.`);
    for (const line of explainNoStoredWarnings(await loadLeftOutTotals(supabase))) console.log(line);
    return;
  }
  const grouped = buildSourceOfSalesWarningExport(rows);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();
  addSheet(workbook, "Summary", grouped.summaryRows.map((row) => ({
    category: row.category,
    count: row.count,
    distributor_code: row.distributorCode,
    field: row.field,
    invoice_period: row.invoicePeriod,
    message: row.message,
    sample_ids: row.sampleIds.join(", "),
  })));
  addSheet(workbook, "Product Name", grouped.productNameRows);
  addSheet(workbook, "Area", grouped.areaRows);
  addSheet(workbook, "Region", grouped.regionRows);
  addSheet(workbook, "Brick", grouped.brickRows);
  addSheet(workbook, "Distributor", grouped.distributorRows);
  addSheet(workbook, "Customer", grouped.customerRows);
  addSheet(workbook, "Raw Samples", grouped.rawSamples);
  mkdirSync(path.dirname(out), { recursive: true });
  await workbook.xlsx.writeFile(out);
  console.log(`Exported ${rows.length} warning rows to ${out}.`);
}

function cellText(row: ExcelJS.Row, header: Map<string, number>, key: string) {
  const index = header.get(key.toLowerCase());
  if (!index) return "";
  const value = row.getCell(index).value as unknown;
  if (value == null) return "";
  if (typeof value === "object" && "text" in value) return String((value as { text?: unknown }).text ?? "").trim();
  if (typeof value === "object" && "result" in value) return String((value as { result?: unknown }).result ?? "").trim();
  return String(value).trim();
}

async function readSheetRows(file: string, sheetName: string) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) return [];
  const header = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, col) => header.set(String(cell.value ?? "").trim().toLowerCase(), col));
  const rows: Record<string, string>[] = [];
  const keys = [...header.keys()];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const item: Record<string, string> = {};
    for (const key of keys) item[key] = cellText(row, header, key);
    if (Object.values(item).some(Boolean)) rows.push(item);
  }
  return rows;
}

async function backupRows(supabase: SupabaseClient, backupDir: string) {
  mkdirSync(backupDir, { recursive: true });
  const rows = await loadWarningRows(supabase, null);
  const out = path.join(backupDir, `source-of-sales-warning-rows-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(out, JSON.stringify(rows, null, 2), "utf8");
  console.log(`Backup written: ${out}`);
}

async function applyCorrections(options: Options, dryRun: boolean) {
  const corrections = optionText(options, "corrections");
  if (!corrections) throw new Error("--corrections is required.");
  const supabase = supabaseClient();
  const productRows = await readSheetRows(corrections, "Product Name");
  const areaRows = await readSheetRows(corrections, "Area");
  const regionRows = await readSheetRows(corrections, "Region");
  const actions: string[] = [];
  const previewCorrections: PreviewCorrections = { areas: [], regions: [] };
  const ignoredProductActions = productRows.filter((row) => normalizeAction(row.approved_action)).length;
  if (ignoredProductActions > 0) {
    actions.push(`ignored_product_name_actions ${ignoredProductActions}: product-name aliases are resolved by trusted product_code; source names are not overwritten.`);
  }

  if (!dryRun) {
    if (options.apply !== true || options["confirm-production-apply"] !== true) {
      throw new Error("apply requires both --apply and --confirm-production-apply.");
    }
    if (currentProjectRef() !== productionRef) {
      throw new Error(`Refusing apply because NEXT_PUBLIC_SUPABASE_URL is ${currentProjectRef()}, expected production ${productionRef}.`);
    }
    await backupRows(supabase, optionText(options, "backup-dir", "outputs/sos-warning-backup"));
  }

  for (const row of regionRows.filter((item) => normalizeAction(item.approved_action) === "insert_region")) {
    const regionCode = normalizeSourceOfSalesCode(row.region_code);
    const regionName = row.region_name || regionCode;
    actions.push(`insert_region ${regionCode} ${regionName}`);
    if (!dryRun) {
      const { error } = await supabase.from("source_of_sales_regions").upsert({
        active: true,
        normalized_region_name: normalizeSourceOfSalesKey(regionName),
        region_code: regionCode,
        region_name: regionName,
        source_file: "sos-warning-cleanup",
        source_sheet: "Region",
        updated_at: new Date().toISOString(),
      }, { onConflict: "region_code" });
      if (error) throw new Error(`insert_region ${row.region_code}: ${error.message}`);
    } else {
      previewCorrections.regions.push({ regionCode, regionName });
    }
  }

  for (const row of areaRows.filter((item) => normalizeAction(item.approved_action) === "insert_area")) {
    const areaCode = normalizeSourceOfSalesCode(row.area_code);
    const areaName = row.area_name || areaCode;
    const regionCode = normalizeSourceOfSalesCode(row.inferred_region_code);
    actions.push(`insert_area ${areaCode} -> ${regionCode}`);
    if (!dryRun) {
      const { error } = await supabase.from("source_of_sales_areas").upsert({
        active: true,
        area_code: areaCode,
        area_name: areaName,
        normalized_area_name: normalizeSourceOfSalesKey(areaName),
        region_code: regionCode,
        source_file: "sos-warning-cleanup",
        source_sheet: "Area",
        updated_at: new Date().toISOString(),
      }, { onConflict: "area_code" });
      if (error) throw new Error(`insert_area ${row.area_code}: ${error.message}`);
    } else {
      previewCorrections.areas.push({ areaCode, areaName, regionCode });
    }
  }

  const revalidation = await revalidateWarnings(supabase, dryRun, previewCorrections);
  const out = optionText(options, "out");
  if (out) await writeDryRunWorkbook(out, actions, revalidation);
  console.log(`${dryRun ? "Dry-run" : "Apply"} actions: ${actions.length}`);
  console.log(`Revalidation preview: ${JSON.stringify(revalidation.summary)}`);
}

function normalizeAction(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, "_");
}

async function revalidateWarnings(supabase: SupabaseClient, dryRun: boolean, previewCorrections?: PreviewCorrections) {
  const [rows, loadedReferences] = await Promise.all([loadWarningRows(supabase, null), loadReferences(supabase)]);
  const references = mergePreviewCorrections(loadedReferences, previewCorrections);
  const revalidated = rows.map((sourceRow) => ({
    ...revalidateSourceOfSalesWarningRow(sourceRow, references),
    sourceRow,
  }));
  if (!dryRun) {
    const groups = new Map<string, typeof revalidated>();
    for (const row of revalidated) {
      const key = JSON.stringify({ validationIssues: row.validationIssues, validationState: row.validationState });
      const existing = groups.get(key);
      if (existing) existing.push(row);
      else groups.set(key, [row]);
    }
    for (const group of groups.values()) {
      const first = group[0];
      for (let index = 0; index < group.length; index += 500) {
        const chunk = group.slice(index, index + 500);
        const ids = chunk.map((row) => row.id);
        const { error } = await supabase
          .from("source_of_sales_import_rows")
          .update({
            validation_issues: first.validationIssues,
            validation_state: first.validationState,
          })
          .in("id", ids);
        if (error) throw new Error(`revalidate rows ${ids[0]}..${ids[ids.length - 1]}: ${error.message}`);
      }
    }
  }
  return {
    rows: revalidated,
    summary: summarizeRevalidation(revalidated),
  };
}

function mergePreviewCorrections(
  references: SourceOfSalesReferenceData,
  previewCorrections?: PreviewCorrections,
): SourceOfSalesReferenceData {
  if (!previewCorrections) return references;
  return {
    ...references,
    areas: dedupeByCode([...references.areas, ...previewCorrections.areas], (area) => area.areaCode),
    regions: dedupeByCode([...references.regions, ...previewCorrections.regions], (region) => region.regionCode),
  };
}

function dedupeByCode<T>(items: T[], codeOf: (item: T) => unknown) {
  const output = new Map<string, T>();
  for (const item of items) output.set(normalizeSourceOfSalesCode(codeOf(item)), item);
  return [...output.values()];
}

async function writeDryRunWorkbook(
  out: string,
  actions: string[],
  revalidation: Awaited<ReturnType<typeof revalidateWarnings>>,
) {
  const workbook = new ExcelJS.Workbook();
  addSheet(workbook, "Actions", actions.map((action, index) => ({ action, sequence: index + 1 })));
  addSheet(workbook, "Revalidation", [
    { metric: "total", value: revalidation.summary.total },
    { metric: "valid_after_revalidation", value: revalidation.summary.valid },
    { metric: "warning_after_revalidation", value: revalidation.summary.warning },
  ]);
  addSheet(workbook, "Remaining Warning Samples", revalidation.rows
    .filter((row) => row.validationState === "warning")
    .slice(0, 1000)
    .flatMap((row) => row.validationIssues.map((issue) => ({
      area_code: row.sourceRow.areaCode || "",
      brick_id: row.sourceRow.brickId || "",
      category: classifySourceOfSalesWarning(issue),
      distributor_code: row.sourceRow.distributorCode,
      field: String(issue.field ?? ""),
      invoice_period: row.sourceRow.invoicePeriod || "Unassigned",
      message: String(issue.message ?? ""),
      product_code: row.sourceRow.productCode,
      region_code: row.sourceRow.regionCode,
      row_id: row.id,
      value: String(issue.value ?? ""),
    }))));
  mkdirSync(path.dirname(out), { recursive: true });
  await workbook.xlsx.writeFile(out);
}

async function verify() {
  const supabase = supabaseClient();
  const stateCounts = await countValidationStates(supabase);
  // Not the three counts alone: "warning: 0" is all this table can ever say, because the importers
  // store only the rows they keep, each marked valid. What they left out is counted on the batches.
  for (const line of describeStoredValidationStates(stateCounts, await loadLeftOutTotals(supabase))) console.log(line);
  const started = Date.now();
  const { data, error } = await supabase.rpc("phx_marketing_roi_customer_dashboard", {
    p_attribution_qualities: [],
    p_customer_search: null,
    p_distributor_codes: [],
    p_exclude_codes: [],
    p_from_month: null,
    p_limit: 10,
    p_lines: [],
    p_product_codes: [],
    p_regions: [],
    p_roi_statuses: [],
    p_to_month: null,
  });
  if (error) throw new Error(`Marketing ROI RPC failed: ${error.message}`);
  console.log(`marketing_roi_rpc_ms: ${Date.now() - started}`);
  console.log(`marketing_roi_request_count: ${data?.summary?.marketingRequestCount ?? 0}`);
}

async function loadLeftOutTotals(supabase: SupabaseClient): Promise<SourceOfSalesLeftOutTotals> {
  const totals: SourceOfSalesLeftOutTotals = { batches: 0, blankCustomer: 0, failed: 0, ignored: 0, warnings: 0 };
  const whole = (value: unknown) => Number(value ?? 0) || 0;
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    // Ordered by the primary key so no batch is skipped or read twice across pages.
    const { data, error } = await supabase
      .from("source_of_sales_import_batches")
      .select("id,rows_ignored,rows_blank,warning_rows,failed_rows")
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`left-out scan: ${error.message}`);
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      totals.batches += 1;
      totals.ignored += whole(row.rows_ignored);
      totals.blankCustomer += whole(row.rows_blank);
      totals.warnings += whole(row.warning_rows);
      totals.failed += whole(row.failed_rows);
    }
    if (!data || data.length < pageSize) break;
  }
  return totals;
}

async function countValidationStates(supabase: SupabaseClient) {
  const counts: Record<string, number> = {};
  const pageSize = 1000;
  let lastId = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("source_of_sales_import_rows")
      .select("id,validation_state")
      .gt("id", lastId)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (error) throw new Error(`verify validation_state scan: ${error.message}`);
    for (const row of data ?? []) {
      const typedRow = row as { id?: unknown; validation_state?: unknown };
      const state = String(typedRow.validation_state ?? "unknown");
      counts[state] = (counts[state] ?? 0) + 1;
      lastId = Number(typedRow.id);
    }
    if (!data || data.length < pageSize) break;
  }
  return counts;
}

const { command, options } = parseArgs();
if (command === "export") await exportWarnings(options);
else if (command === "dry-run") await applyCorrections(options, true);
else if (command === "apply") await applyCorrections(options, false);
else if (command === "verify") await verify();
else usage();
