import ExcelJS from "exceljs";
import { once } from "node:events";
import { PassThrough } from "node:stream";

import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type DataBackupScope = "all" | "sales" | "weekly" | "marketing";

type BackupTableConfig = {
  module: "sales" | "weekly" | "marketing";
  name: string;
  table: string;
  orderBy?: string;
  /** A unique column to sort by LAST, when `orderBy` is not itself unique (created_at, sequence). */
  tiebreak?: string;
};

export type DataBackupDataset = {
  module: string;
  name: string;
  rows: Record<string, unknown>[];
};

export type DataBackupPayload = {
  generatedAt: string;
  generatedBy: string;
  scope: DataBackupScope;
  datasets: DataBackupDataset[];
};

// ─── Table lists ──────────────────────────────────────────────────────────────

const SALES_TABLES: BackupTableConfig[] = [
  // Transactional — uploaded data
  { module: "sales", name: "SoS Upload Batches", table: "source_of_sales_import_batches", orderBy: "created_at", tiebreak: "id" },
  { module: "sales", name: "SoS Uploaded Rows", table: "source_of_sales_import_rows", orderBy: "id" },
  { module: "sales", name: "SoS Import Summaries", table: "source_of_sales_import_summaries", orderBy: "id" },
  // Mapping & validation
  { module: "sales", name: "SoS Customer Map", table: "source_of_sales_customer_map", orderBy: "id" },
  { module: "sales", name: "SoS Distributor Profile", table: "source_of_sales_distributor_profile", orderBy: "distributor_code" },
  { module: "sales", name: "SoS Product Aliases", table: "source_of_sales_product_aliases", orderBy: "id" },
  // Reference / master data
  { module: "sales", name: "SoS Products", table: "source_of_sales_products", orderBy: "product_code" },
  { module: "sales", name: "SoS Distributors", table: "source_of_sales_distributors", orderBy: "distributor_code" },
  { module: "sales", name: "SoS Regions", table: "source_of_sales_regions", orderBy: "region_code" },
  { module: "sales", name: "SoS Areas", table: "source_of_sales_areas", orderBy: "area_code" },
  { module: "sales", name: "SoS Blocks", table: "source_of_sales_blocks", orderBy: "block_code" },
  { module: "sales", name: "SoS Bricks", table: "source_of_sales_bricks", orderBy: "brick_id" },
];

const WEEKLY_TABLES: BackupTableConfig[] = [
  // Transactional
  { module: "weekly", name: "Weekly Sales Batches", table: "weekly_sales_batches", orderBy: "created_at", tiebreak: "id" },
  { module: "weekly", name: "Weekly Sales Rows", table: "weekly_sales_rows", orderBy: "id" },
  // Config & mapping
  { module: "weekly", name: "Weekly Distributor Column Profile", table: "weekly_sales_distributor_column_profile", orderBy: "distributor_code" },
  { module: "weekly", name: "Weekly Branch Region Map", table: "weekly_sales_branch_region_map", orderBy: "id" },
  { module: "weekly", name: "Weekly POS Region Mappings", table: "weekly_sales_pos_region_mappings", orderBy: "id" },
  { module: "weekly", name: "Weekly Product Scope", table: "weekly_sales_product_scope", orderBy: "id" },
  { module: "weekly", name: "Weekly Product Aliases", table: "weekly_sales_product_aliases", orderBy: "id" },
];

const MARKETING_TABLES: BackupTableConfig[] = [
  // Core requests & workflow
  { module: "marketing", name: "Marketing Requests", table: "marketing_requests", orderBy: "created_at", tiebreak: "id" },
  { module: "marketing", name: "Marketing Request Products", table: "marketing_request_products", orderBy: "id" },
  { module: "marketing", name: "Marketing Request Pharmacies", table: "marketing_request_pharmacies", orderBy: "id" },
  { module: "marketing", name: "Marketing Approval Steps", table: "marketing_request_approval_steps", orderBy: "id" },
  // PK is request_id — this table has no `id` column, and ordering by one made the whole
  // marketing backup throw ("Failed to load ...") rather than skip a single table.
  { module: "marketing", name: "Marketing Finance Requirements", table: "marketing_request_finance_requirements", orderBy: "request_id" },
  // Customers & pharmacies
  { module: "marketing", name: "Marketing Customers", table: "marketing_customers", orderBy: "id" },
  { module: "marketing", name: "Marketing Customer Contacts", table: "marketing_customer_contacts", orderBy: "id" },
  { module: "marketing", name: "Marketing Customer Pharmacies", table: "marketing_customer_pharmacies", orderBy: "id" },
  { module: "marketing", name: "Marketing Pharmacies", table: "marketing_pharmacies", orderBy: "id" },
  { module: "marketing", name: "Marketing Pharmacy Distributor Codes", table: "marketing_pharmacy_distributor_codes", orderBy: "id" },
  { module: "marketing", name: "Marketing Pharmacy Code References", table: "marketing_pharmacy_code_references", orderBy: "id" },
  { module: "marketing", name: "Marketing Evidence Files", table: "marketing_evidence_files", orderBy: "id" },
  // Master data & config
  { module: "marketing", name: "Marketing Request Types", table: "marketing_request_types", orderBy: "id" },
  { module: "marketing", name: "Marketing Distributors", table: "marketing_distributors", orderBy: "id" },
  { module: "marketing", name: "Marketing Products", table: "marketing_products", orderBy: "id" },
  { module: "marketing", name: "Marketing Workflow Steps", table: "marketing_workflow_steps", orderBy: "sequence", tiebreak: "id" },
  { module: "marketing", name: "Marketing Review Routing", table: "marketing_review_routing", orderBy: "id" },
  // PK is setting_key — no `id` column here either.
  { module: "marketing", name: "Marketing Control Settings", table: "marketing_control_settings", orderBy: "setting_key" },
  // ROI facts & analytics
  { module: "marketing", name: "Marketing ROI Request Facts", table: "marketing_roi_request_facts", orderBy: "id" },
  { module: "marketing", name: "Marketing ROI Product Facts", table: "marketing_roi_product_facts", orderBy: "id" },
  { module: "marketing", name: "Marketing ROI Trend Facts", table: "marketing_roi_trend_facts", orderBy: "id" },
  { module: "marketing", name: "Marketing ROI Line Facts", table: "marketing_roi_line_facts", orderBy: "id" },
  { module: "marketing", name: "Marketing ROI Region Facts", table: "marketing_roi_region_facts", orderBy: "id" },
  { module: "marketing", name: "Marketing ROI Distributor Facts", table: "marketing_roi_distributor_facts", orderBy: "id" },
  { module: "marketing", name: "Marketing ROI Customer Facts", table: "marketing_roi_customer_facts", orderBy: "id" },
  { module: "marketing", name: "Marketing ROI Distributor Rollup", table: "marketing_roi_distributor_rollup", orderBy: "sos_distributor_code" },
  { module: "marketing", name: "Marketing ROI Export Audit", table: "marketing_roi_export_audit", orderBy: "id" },
  { module: "marketing", name: "Marketing ROI Filter Presets", table: "marketing_roi_filter_presets", orderBy: "id" },
  { module: "marketing", name: "Marketing ROI Refresh Runs", table: "marketing_roi_refresh_runs", orderBy: "id" },
];

export const ALL_BACKUP_TABLES = [...SALES_TABLES, ...WEEKLY_TABLES, ...MARKETING_TABLES];

// ─── Module metadata ──────────────────────────────────────────────────────────

export const MODULE_META = {
  sales: { label: "Source of Sales", tabColor: "F97316", headerFill: "F97316" },
  weekly: { label: "Weekly Sales", tabColor: "3B82F6", headerFill: "3B82F6" },
  marketing: { label: "Marketing Requests", tabColor: "10B981", headerFill: "10B981" },
} as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function listModules(scope: DataBackupScope): BackupTableConfig[] {
  if (scope === "sales") return SALES_TABLES;
  if (scope === "weekly") return WEEKLY_TABLES;
  if (scope === "marketing") return MARKETING_TABLES;
  return ALL_BACKUP_TABLES;
}

function sanitizeSheetName(name: string) {
  const compact = name.replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31);
  return compact.length > 0 ? compact : "Data";
}

function safeToJsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return value;
}

function collectHeaders(rows: Record<string, unknown>[]) {
  const set = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      set.add(key);
    }
  }
  return [...set].sort();
}

/**
 * Every row of one table, for the backup. Walked by the shared pager with a UNIQUE last sort key: the
 * old walk ordered by `orderBy` alone, and two rows sharing a created_at (or a table with no order at
 * all) can swap places between pages, so a backup could repeat one row and silently leave another out.
 */
async function fetchTableRows(table: string, orderBy?: string, tiebreak?: string): Promise<Record<string, unknown>[]> {
  const supabase = getSupabaseAdmin();
  try {
    return await fetchAllRows<Record<string, unknown>>(() => {
      const query = supabase.from(table).select("*");
      return orderBy ? query.order(orderBy, { ascending: false }) : query;
    }, tiebreak ?? orderBy ?? "id");
  } catch (error) {
    throw new Error(`Failed to load ${table}: ${(error as { message?: string } | null)?.message ?? "read failed"}`);
  }
}

function makeUniqueSheetName(base: string, used: Set<string>) {
  let candidate = sanitizeSheetName(base);
  let index = 1;
  const baseBase = candidate;
  while (used.has(candidate)) {
    const suffix = `-${index}`;
    const maxBaseLength = Math.max(1, 31 - suffix.length);
    candidate = `${baseBase.slice(0, maxBaseLength)}${suffix}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

// ─── One backup at a time ─────────────────────────────────────────────────────

// The tail of the queue. Every caller chains onto it, so backups run strictly one after another.
let backupChain: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` only after every backup started before it has SETTLED — one backup at a time, per process.
 *
 * WHY (PERF-009). A backup holds every row of every table it covers in memory, then a workbook built
 * from them; an "all"-scope run is the heaviest thing this app does. The download route and the
 * background worker could each start one, and two admins could start one each, so two or three ran
 * side by side on the single production container and stacked their peaks. Queuing them costs the
 * second caller some waiting and nothing else.
 *
 * A failure releases the chain — the next caller runs regardless — and reaches only its own caller.
 * Results are NEVER shared between callers: each payload carries its own Generated At / Generated By
 * on the Contents sheet, so a second admin must get a backup of their own, not a copy of the first.
 */
export function runBackupExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = backupChain.then(() => fn());
  // The chain waits for this run to settle either way, and never carries its value or its error.
  backupChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ─── Load ─────────────────────────────────────────────────────────────────────

export async function loadDataBackup(scope: DataBackupScope, generatedBy: string): Promise<DataBackupPayload> {
  const tables = listModules(scope);
  const datasets: DataBackupDataset[] = [];

  for (const table of tables) {
    const rows = await fetchTableRows(table.table, table.orderBy, table.tiebreak);
    // Normalised IN PLACE (PERF-009). These rows were fetched for this backup alone and nothing
    // else holds them, so copying each into a fresh object only doubled the peak heap of an
    // "all"-scope export for the length of the loop. Re-assigning an existing key keeps the key
    // order, so the values and the headers the workbook reads are identical to the copy's.
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        row[key] = safeToJsonValue(row[key]);
      }
    }

    datasets.push({
      module: table.module,
      name: table.name,
      rows,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    generatedBy,
    scope,
    datasets,
  };
}

// ─── XLSX builder ─────────────────────────────────────────────────────────────

export async function buildBackupWorkbook(payload: DataBackupPayload): Promise<ArrayBuffer> {
  // STREAMED, and that is not an optimisation — the in-memory writer CANNOT produce this workbook.
  //
  // `workbook.xlsx.writeBuffer()` renders a whole sheet into one `XmlStream`, whose `_xml` is a
  // plain JS array holding ~15 string tokens per cell. V8 caps an array at 2^27 = 134,217,728
  // entries, so a 28-column sheet dies at ~312,861 rows with a bare `RangeError: Invalid array
  // length` thrown from `Array.push` inside `XmlStream.openNode`. `source_of_sales_import_rows`
  // was past that line already (317,801 rows on staging, 2026-09-11), which took out `sales` AND
  // the default `all` scope while `weekly` and `marketing` kept working. Raising the heap does not
  // help: the cap is on the array, not on memory. The same sheet's XML is ~532MB, so the `join('')`
  // that follows is itself within a rounding error of V8's 536,870,888-char string limit.
  //
  // The streaming writer serialises each row on its own and flushes it into the zip, so neither
  // limit is ever approached: the full staging `sales` scope (10.08M cells) builds in ~60s at
  // ~900MB RSS. Its cost is that sheets commit in order and cannot be revisited — hence columns
  // and views are set before the first row, and the Contents sheet is still written first.
  const chunks: Buffer[] = [];
  const sink = new PassThrough();
  sink.on("data", (chunk: Buffer) => chunks.push(chunk));
  // Attached before anything is written so the listener cannot miss the event: `workbook.commit()`
  // resolves on the writable side finishing, which is not proof the readable side has been drained.
  const drained = once(sink, "end");

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: sink,
    useSharedStrings: false,
    useStyles: true,
  });
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date(payload.generatedAt);

  const usedSheetNames = new Set<string>();

  // Summary sheet
  const summary = workbook.addWorksheet(makeUniqueSheetName("Contents", usedSheetNames), {
    properties: { tabColor: { argb: "FF1E293B" } },
    views: [{ state: "frozen", ySplit: 1 }],
  });

  summary.columns = [
    { header: "Module", key: "module", width: 22 },
    { header: "Table", key: "table", width: 42 },
    { header: "Row Count", key: "rows", width: 14 },
  ];

  // Setting `columns` writes the header text into row 1; style it before it is committed away.
  const summaryHeader = summary.getRow(1);
  summaryHeader.font = { bold: true, color: { argb: "FFFFFFFF" } };
  summaryHeader.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E293B" } };
  summaryHeader.commit();

  // Metadata rows
  const metaRows = [
    { module: "Backup Scope", table: payload.scope, rows: "" },
    { module: "Generated At", table: payload.generatedAt, rows: "" },
    { module: "Generated By", table: payload.generatedBy, rows: "" },
  ];
  for (const meta of metaRows) {
    const r = summary.addRow(meta);
    r.font = { italic: true, color: { argb: "FF64748B" } };
    r.commit();
  }

  summary.addRow([]).commit();

  // Group by module
  let lastModule = "";
  for (const dataset of payload.datasets) {
    if (dataset.module !== lastModule) {
      const meta = MODULE_META[dataset.module as keyof typeof MODULE_META];
      const labelRow = summary.addRow({ module: meta?.label ?? dataset.module, table: "", rows: "" });
      labelRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
      labelRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${meta?.headerFill ?? "334155"}` } };
      labelRow.commit();
      lastModule = dataset.module;
    }
    summary.addRow({ module: dataset.module, table: dataset.name, rows: dataset.rows.length }).commit();
  }

  summary.commit();

  // Data sheets — one per table
  for (const dataset of payload.datasets) {
    const meta = MODULE_META[dataset.module as keyof typeof MODULE_META];
    const headerFill = meta?.headerFill ?? "334155";
    const tabColor = meta?.tabColor ?? "334155";

    const headers = collectHeaders(dataset.rows);
    const sheet = workbook.addWorksheet(makeUniqueSheetName(dataset.name, usedSheetNames), {
      properties: { tabColor: { argb: `FF${tabColor}` } },
      // A placeholder sheet has no header row to freeze, matching the pre-streaming output.
      ...(headers.length === 0 ? {} : { views: [{ state: "frozen" as const, ySplit: 1 }] }),
    });

    if (headers.length === 0) {
      sheet.addRow(["No rows"]).commit();
      sheet.commit();
      continue;
    }

    sheet.columns = headers.map((header) => ({
      key: header,
      header,
      width: Math.max(12, Math.min(70, header.length + 4)),
    }));

    // Header row
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${headerFill}` } };
    headerRow.alignment = { vertical: "middle" };
    headerRow.commit();

    // Data rows — committed one at a time so the sheet never holds more than the row being written.
    for (const row of dataset.rows) {
      sheet.addRow(headers.map((h) => row[h] ?? "")).commit();
    }

    sheet.autoFilter = {
      from: { column: 1, row: 1 },
      to: { column: headers.length, row: Math.max(1, dataset.rows.length + 1) },
    };
    sheet.commit();
  }

  await workbook.commit();
  await drained;

  // A Node Buffer, exactly as `writeBuffer()` returned before: both callers hand it straight to a
  // NextResponse body or to Supabase Storage, which take it as-is.
  return Buffer.concat(chunks) as unknown as ArrayBuffer;
}
