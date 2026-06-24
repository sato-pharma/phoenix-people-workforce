import ExcelJS from "exceljs";

import { getSupabaseAdmin } from "@/lib/supabase/server";

const PAGE_SIZE = 1000;

export type DataBackupScope = "all" | "sales" | "weekly" | "marketing";

type BackupTableConfig = {
  module: "sales" | "weekly" | "marketing";
  name: string;
  table: string;
  orderBy?: string;
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
  { module: "sales", name: "SoS Upload Batches", table: "source_of_sales_import_batches", orderBy: "created_at" },
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
  { module: "weekly", name: "Weekly Sales Batches", table: "weekly_sales_batches", orderBy: "created_at" },
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
  { module: "marketing", name: "Marketing Requests", table: "marketing_requests", orderBy: "created_at" },
  { module: "marketing", name: "Marketing Request Products", table: "marketing_request_products", orderBy: "id" },
  { module: "marketing", name: "Marketing Request Pharmacies", table: "marketing_request_pharmacies", orderBy: "id" },
  { module: "marketing", name: "Marketing Approval Steps", table: "marketing_request_approval_steps", orderBy: "id" },
  { module: "marketing", name: "Marketing Finance Requirements", table: "marketing_request_finance_requirements", orderBy: "id" },
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
  { module: "marketing", name: "Marketing Workflow Steps", table: "marketing_workflow_steps", orderBy: "sequence" },
  { module: "marketing", name: "Marketing Review Routing", table: "marketing_review_routing", orderBy: "id" },
  { module: "marketing", name: "Marketing Control Settings", table: "marketing_control_settings", orderBy: "id" },
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

async function fetchTableRows(table: string, orderBy?: string): Promise<Record<string, unknown>[]> {
  const supabase = getSupabaseAdmin();
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase.from(table).select("*").range(from, from + PAGE_SIZE - 1);
    if (orderBy) query = query.order(orderBy, { ascending: false });
    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to load ${table}: ${error.message}`);
    }
    const batch = (data ?? []) as Record<string, unknown>[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
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

// ─── Load ─────────────────────────────────────────────────────────────────────

export async function loadDataBackup(scope: DataBackupScope, generatedBy: string): Promise<DataBackupPayload> {
  const tables = listModules(scope);
  const datasets: DataBackupDataset[] = [];

  for (const table of tables) {
    const rows = await fetchTableRows(table.table, table.orderBy);
    const normalizedRows = rows.map((row) => {
      const normalized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        normalized[key] = safeToJsonValue(value);
      }
      return normalized;
    });

    datasets.push({
      module: table.module,
      name: table.name,
      rows: normalizedRows,
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
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date(payload.generatedAt);

  const usedSheetNames = new Set<string>();

  // Summary sheet
  const summary = workbook.addWorksheet(makeUniqueSheetName("Contents", usedSheetNames));
  summary.properties.tabColor = { argb: "FF1E293B" };

  summary.columns = [
    { header: "Module", key: "module", width: 22 },
    { header: "Table", key: "table", width: 42 },
    { header: "Row Count", key: "rows", width: 14 },
  ];

  // Metadata rows
  const metaRows = [
    { module: "Backup Scope", table: payload.scope, rows: "" },
    { module: "Generated At", table: payload.generatedAt, rows: "" },
    { module: "Generated By", table: payload.generatedBy, rows: "" },
  ];
  for (const meta of metaRows) {
    const r = summary.addRow(meta);
    r.font = { italic: true, color: { argb: "FF64748B" } };
  }

  summary.addRow([]);

  // Group by module
  let lastModule = "";
  for (const dataset of payload.datasets) {
    if (dataset.module !== lastModule) {
      const meta = MODULE_META[dataset.module as keyof typeof MODULE_META];
      const labelRow = summary.addRow({ module: meta?.label ?? dataset.module, table: "", rows: "" });
      labelRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
      labelRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${meta?.headerFill ?? "334155"}` } };
      lastModule = dataset.module;
    }
    summary.addRow({ module: dataset.module, table: dataset.name, rows: dataset.rows.length });
  }

  summary.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  summary.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E293B" } };
  summary.views = [{ state: "frozen", ySplit: 1 }];

  // Data sheets — one per table
  for (const dataset of payload.datasets) {
    const meta = MODULE_META[dataset.module as keyof typeof MODULE_META];
    const headerFill = meta?.headerFill ?? "334155";
    const tabColor = meta?.tabColor ?? "334155";

    const headers = collectHeaders(dataset.rows);
    const sheet = workbook.addWorksheet(makeUniqueSheetName(dataset.name, usedSheetNames));
    sheet.properties.tabColor = { argb: `FF${tabColor}` };

    if (headers.length === 0) {
      sheet.addRow(["No rows"]);
      continue;
    }

    // Header row
    sheet.addRow(headers);
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${headerFill}` } };
    headerRow.alignment = { vertical: "middle" };

    // Data rows
    for (const row of dataset.rows) {
      sheet.addRow(headers.map((h) => row[h] ?? ""));
    }

    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.autoFilter = {
      from: { column: 1, row: 1 },
      to: { column: headers.length, row: Math.max(1, dataset.rows.length + 1) },
    };
    sheet.columns = headers.map((header) => ({
      key: header,
      header,
      width: Math.max(12, Math.min(70, header.length + 4)),
    }));
  }

  return await workbook.xlsx.writeBuffer();
}
