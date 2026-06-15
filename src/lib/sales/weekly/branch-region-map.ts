import ExcelJS from "exceljs";

import { SalesWorkflowError } from "@/lib/sales/contracts";
import { canonicalWeeklyDistributorCode, weeklyDistributorByCode, weeklyDistributorOptions } from "@/lib/sales/weekly/distributors";
import { normalizeCode, normalizeKey } from "@/lib/sales/weekly/mapping-normalize";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { WeeklyMappingImportResult } from "@/lib/sales/weekly/product-aliases";

// ─────────────────────────────────────────────────────────────────────────────
// Weekly Sales — per-distributor branch/outlet -> master region map.
//
// The region target is a Source-of-Sales master region (controlled vocabulary, validated here).
// Template mirrors the owner's EGD example: BRANCH_NAME | BRANCH_CODE | REFERENCE REGION ID
// (PS stock additionally pins COLUMN_INDEX because its location headers can repeat).
// ─────────────────────────────────────────────────────────────────────────────

export type WeeklyBranchFileType = "any" | "sales" | "stock";

export type WeeklyMasterRegion = { regionCode: string; regionName: string };

export type WeeklyBranchRegionRow = {
  id: string;
  distributorCode: string;
  rawBranch: string;
  sourceFileType: WeeklyBranchFileType;
  branchColumnIndex: number | null;
  branchHeaderRaw: string | null;
  regionCode: string;
  regionName: string;
  excluded: boolean;
  updatedAt: string;
};

export type WeeklyBranchRegionAdmin = {
  distributorCode: string;
  fileType: WeeklyBranchFileType;
  distributors: { code: string; name: string }[];
  masterRegions: WeeklyMasterRegion[];
  rows: WeeklyBranchRegionRow[];
};

export type WeeklyBranchRegionIndex = {
  /** key = `${sourceFileType}|${normalizedBranch}` */
  byBranch: Map<string, { regionCode: string; regionName: string; excluded: boolean }>;
  /** PS stock: keyed by column index */
  byColumnIndex: Map<number, { regionCode: string; regionName: string; excluded: boolean; headerRaw: string }>;
};

function fileTypeOf(value: unknown): WeeklyBranchFileType {
  const key = String(value ?? "").trim().toLowerCase();
  return key === "sales" || key === "stock" ? key : "any";
}

export async function listMasterRegions(): Promise<WeeklyMasterRegion[]> {
  const references = await loadSalesReferenceData({ includeCustomerBricks: false });
  const byCode = new Map<string, string>();
  for (const region of references.regions ?? []) {
    const regionCode = normalizeCode(region.regionCode);
    const regionName = String(region.regionName ?? "").trim();
    if (regionCode && !byCode.has(regionCode)) byCode.set(regionCode, regionName || regionCode);
  }
  return [...byCode.entries()]
    .map(([regionCode, regionName]) => ({ regionCode, regionName }))
    .sort((left, right) => left.regionName.localeCompare(right.regionName) || left.regionCode.localeCompare(right.regionCode));
}

function mapRow(row: Record<string, unknown>): WeeklyBranchRegionRow {
  return {
    id: String(row.id),
    distributorCode: String(row.distributor_code ?? ""),
    rawBranch: String(row.raw_branch ?? ""),
    sourceFileType: fileTypeOf(row.source_file_type),
    branchColumnIndex: row.branch_column_index == null ? null : Number(row.branch_column_index),
    branchHeaderRaw: row.branch_header_raw == null ? null : String(row.branch_header_raw),
    regionCode: String(row.region_code ?? ""),
    regionName: String(row.region_name ?? ""),
    excluded: Boolean(row.excluded),
    updatedAt: String(row.updated_at ?? ""),
  };
}

export async function loadWeeklyBranchRegionAdmin(
  distributorCode: string,
  fileType: WeeklyBranchFileType = "any",
): Promise<WeeklyBranchRegionAdmin> {
  const code = canonicalWeeklyDistributorCode(distributorCode);
  const supabase = getSupabaseAdmin();
  const masterRegions = await listMasterRegions();

  let query = supabase
    .from("weekly_sales_branch_region_map")
    .select("id, distributor_code, raw_branch, source_file_type, branch_column_index, branch_header_raw, region_code, region_name, excluded, updated_at")
    .eq("distributor_code", code)
    .order("raw_branch", { ascending: true });
  if (fileType !== "any") query = query.in("source_file_type", [fileType, "any"]);

  const { data, error } = await query;
  if (error) throw new SalesWorkflowError("load_failed", error.message, 500);

  return {
    distributorCode: code,
    fileType,
    distributors: weeklyDistributorOptions(),
    masterRegions,
    rows: (data ?? []).map(mapRow),
  };
}

function resolveRegion(
  regionCode: string,
  excluded: boolean,
  masterByCode: Map<string, string>,
): { regionCode: string; regionName: string } {
  if (excluded) return { regionCode: "", regionName: "" };
  const key = normalizeCode(regionCode);
  if (!key || !masterByCode.has(key)) {
    throw new SalesWorkflowError(
      "unknown_region",
      `Region ID "${String(regionCode ?? "").trim() || "(blank)"}" is not an official Source of Sales region.`,
      400,
    );
  }
  return { regionCode: key, regionName: masterByCode.get(key) ?? key };
}

async function findExistingRow(input: {
  distributorCode: string;
  sourceFileType: WeeklyBranchFileType;
  normalizedBranch: string;
  branchColumnIndex: number | null;
}): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("weekly_sales_branch_region_map")
    .select("id")
    .eq("distributor_code", input.distributorCode)
    .eq("source_file_type", input.sourceFileType);
  if (input.branchColumnIndex != null) query = query.eq("branch_column_index", input.branchColumnIndex);
  else query = query.eq("normalized_branch", input.normalizedBranch).is("branch_column_index", null);
  const { data, error } = await query.maybeSingle();
  if (error && error.code !== "PGRST116") throw new SalesWorkflowError("load_failed", error.message, 500);
  return data ? String(data.id) : null;
}

export async function upsertBranchRegionRow(input: {
  distributorCode: string;
  rawBranch: string;
  branchName?: string | null;
  regionCode: string;
  sourceFileType?: WeeklyBranchFileType;
  branchColumnIndex?: number | null;
  excluded?: boolean;
  actorId: string | null;
}): Promise<void> {
  const distributorCode = canonicalWeeklyDistributorCode(input.distributorCode);
  const sourceFileType = fileTypeOf(input.sourceFileType);
  const branchColumnIndex = input.branchColumnIndex == null ? null : Number(input.branchColumnIndex);
  const rawBranch = String(input.rawBranch ?? "").trim();
  const headerRaw = String(input.branchName ?? rawBranch).trim();
  if (!rawBranch && branchColumnIndex == null) {
    throw new SalesWorkflowError("invalid_request", "A branch key (or column index) is required.", 400);
  }
  const excluded = Boolean(input.excluded);
  const normalizedBranch = normalizeKey(rawBranch || headerRaw);

  const masterByCode = new Map((await listMasterRegions()).map((region) => [region.regionCode, region.regionName]));
  const region = resolveRegion(input.regionCode, excluded, masterByCode);

  const supabase = getSupabaseAdmin();
  const existingId = await findExistingRow({ distributorCode, sourceFileType, normalizedBranch, branchColumnIndex });

  const payload = {
    distributor_code: distributorCode,
    raw_branch: rawBranch || headerRaw,
    normalized_branch: normalizedBranch,
    source_file_type: sourceFileType,
    branch_column_index: branchColumnIndex,
    branch_header_raw: headerRaw || null,
    region_code: region.regionCode,
    region_name: region.regionName,
    excluded,
    updated_by: input.actorId,
    updated_at: new Date().toISOString(),
  };

  if (existingId) {
    const update = await supabase.from("weekly_sales_branch_region_map").update(payload).eq("id", existingId);
    if (update.error) throw new SalesWorkflowError("persist_failed", update.error.message, 500);
    return;
  }
  const insert = await supabase
    .from("weekly_sales_branch_region_map")
    .insert({ ...payload, created_by: input.actorId });
  if (insert.error) throw new SalesWorkflowError("persist_failed", insert.error.message, 500);
}

export async function deleteBranchRegionRow(id: string): Promise<void> {
  const rowId = String(id ?? "").trim();
  if (!rowId) throw new SalesWorkflowError("invalid_request", "A row id is required.", 400);
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("weekly_sales_branch_region_map").delete().eq("id", rowId);
  if (error) throw new SalesWorkflowError("delete_failed", error.message, 500);
}

export async function buildBranchRegionTemplate(
  distributorCode: string,
  fileType: WeeklyBranchFileType = "any",
): Promise<ArrayBuffer> {
  const code = canonicalWeeklyDistributorCode(distributorCode);
  const name = weeklyDistributorByCode(code)?.name ?? code;
  const isStock = fileType === "stock";
  const [{ rows }, masterRegions] = await Promise.all([
    loadWeeklyBranchRegionAdmin(code, fileType),
    listMasterRegions(),
  ]);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(`${name} ${isStock ? "Stock Locations" : "Branches"}`.slice(0, 31));
  const columns = [
    { header: "BRANCH_NAME", key: "branchName", width: 40 },
    { header: "BRANCH_CODE", key: "branchCode", width: 20 },
    { header: "REFERENCE REGION ID", key: "regionCode", width: 22 },
    { header: "EXCLUDED", key: "excluded", width: 12 },
  ];
  if (isStock) columns.splice(2, 0, { header: "COLUMN_INDEX", key: "columnIndex", width: 14 });
  sheet.columns = columns;

  for (const row of rows) {
    sheet.addRow({
      branchName: row.branchHeaderRaw ?? row.rawBranch,
      branchCode: row.branchColumnIndex != null ? "" : row.rawBranch,
      columnIndex: row.branchColumnIndex ?? "",
      regionCode: row.regionCode,
      excluded: row.excluded ? "yes" : "",
    });
  }
  if (rows.length === 0) {
    sheet.addRow({ branchName: "paste branch / outlet name", branchCode: "branch key", columnIndex: "", regionCode: "CA", excluded: "" });
  }
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF97316" } };
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  const reference = workbook.addWorksheet("Official Regions");
  reference.columns = [
    { header: "REFERENCE REGION ID", key: "regionCode", width: 22 },
    { header: "REGION NAME", key: "regionName", width: 32 },
  ];
  for (const region of masterRegions) reference.addRow({ regionCode: region.regionCode, regionName: region.regionName });
  reference.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  reference.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } };
  reference.views = [{ state: "frozen", ySplit: 1 }];

  return workbook.xlsx.writeBuffer() as unknown as ArrayBuffer;
}

function cellString(row: ExcelJS.Row, index: number): string {
  if (!index) return "";
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

/** Match a header by alphanumeric-only comparison so "REFERENCE REGION ID" == "REFERENCE_REGION_ID". */
function buildHeaderMap(sheet: ExcelJS.Worksheet): Map<string, number> {
  const headers = new Map<string, number>();
  const headerRow = sheet.getRow(1);
  headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
    const key = String((cell.value as { text?: unknown })?.text ?? cell.value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (key && !headers.has(key)) headers.set(key, col);
  });
  return headers;
}

export async function importBranchRegionWorkbook(input: {
  distributorCode: string;
  fileType: WeeklyBranchFileType;
  file: File;
  actorId: string | null;
}): Promise<WeeklyMappingImportResult> {
  const distributorCode = canonicalWeeklyDistributorCode(input.distributorCode);
  const sourceFileType = fileTypeOf(input.fileType);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await input.file.arrayBuffer()) as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new SalesWorkflowError("invalid_mapping_template", "The mapping workbook has no sheets.", 400);

  const headers = buildHeaderMap(sheet);
  const colName = headers.get("BRANCHNAME") ?? 0;
  const colCode = headers.get("BRANCHCODE") ?? 0;
  const colRegion = headers.get("REFERENCEREGIONID") ?? headers.get("REGIONID") ?? headers.get("REGIONCODE") ?? 0;
  const colIndex = headers.get("COLUMNINDEX") ?? 0;
  const colExcluded = headers.get("EXCLUDED") ?? 0;
  if (!colRegion) {
    throw new SalesWorkflowError("invalid_mapping_template", 'The mapping sheet must have a "REFERENCE REGION ID" column.', 400);
  }

  const masterByCode = new Map((await listMasterRegions()).map((region) => [region.regionCode, region.regionName]));
  const blockedRows: WeeklyMappingImportResult["blockedRows"] = [];
  type Pending = {
    rawBranch: string;
    branchName: string;
    normalizedBranch: string;
    branchColumnIndex: number | null;
    regionCode: string;
    regionName: string;
    excluded: boolean;
  };
  const pending: Pending[] = [];
  let skipped = 0;

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const branchName = cellString(row, colName);
    const branchCode = cellString(row, colCode);
    const regionRaw = cellString(row, colRegion);
    const indexRaw = cellString(row, colIndex);
    const excludedRaw = cellString(row, colExcluded).toLowerCase();
    const excluded = excludedRaw === "yes" || excludedRaw === "true" || excludedRaw === "1" || excludedRaw === "y";

    const branchColumnIndex = indexRaw ? Number(indexRaw) : null;
    const rawBranch = branchColumnIndex != null ? branchName || branchCode : branchCode || branchName;

    if (!rawBranch && branchColumnIndex == null && !regionRaw) {
      skipped += 1;
      continue;
    }
    if (!rawBranch && branchColumnIndex == null) {
      blockedRows.push({ rowNumber, reason: "A branch name/code (or column index) is required.", values: regionRaw });
      continue;
    }
    if (branchColumnIndex != null && !Number.isInteger(branchColumnIndex)) {
      blockedRows.push({ rowNumber, reason: `COLUMN_INDEX "${indexRaw}" must be a whole number.`, values: branchName });
      continue;
    }
    const regionKey = normalizeCode(regionRaw);
    if (!excluded && (!regionKey || !masterByCode.has(regionKey))) {
      blockedRows.push({ rowNumber, reason: `Region ID "${regionRaw || "(blank)"}" is not an official Source of Sales region.`, values: rawBranch || branchName });
      continue;
    }
    pending.push({
      rawBranch: rawBranch || branchName,
      branchName: branchName || rawBranch,
      normalizedBranch: normalizeKey(rawBranch || branchName),
      branchColumnIndex,
      regionCode: excluded ? "" : regionKey,
      regionName: excluded ? "" : masterByCode.get(regionKey) ?? "",
      excluded,
    });
  }

  if (blockedRows.length > 0) return { inserted: 0, updated: 0, skipped, blockedRows };

  let inserted = 0;
  let updated = 0;
  const supabase = getSupabaseAdmin();
  for (const item of pending) {
    const existingId = await findExistingRow({
      distributorCode,
      sourceFileType,
      normalizedBranch: item.normalizedBranch,
      branchColumnIndex: item.branchColumnIndex,
    });
    const payload = {
      distributor_code: distributorCode,
      raw_branch: item.rawBranch,
      normalized_branch: item.normalizedBranch,
      source_file_type: sourceFileType,
      branch_column_index: item.branchColumnIndex,
      branch_header_raw: item.branchName || null,
      region_code: item.regionCode,
      region_name: item.regionName,
      excluded: item.excluded,
      updated_by: input.actorId,
      updated_at: new Date().toISOString(),
    };
    if (existingId) {
      const update = await supabase.from("weekly_sales_branch_region_map").update(payload).eq("id", existingId);
      if (update.error) throw new SalesWorkflowError("persist_failed", update.error.message, 500);
      updated += 1;
    } else {
      const insert = await supabase.from("weekly_sales_branch_region_map").insert({ ...payload, created_by: input.actorId });
      if (insert.error) throw new SalesWorkflowError("persist_failed", insert.error.message, 500);
      inserted += 1;
    }
  }
  return { inserted, updated, skipped, blockedRows };
}

/** Build the branch->region resolution index for the upload parser. */
export async function loadBranchRegionIndex(distributorCode: string): Promise<WeeklyBranchRegionIndex> {
  const code = canonicalWeeklyDistributorCode(distributorCode);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("weekly_sales_branch_region_map")
    .select("raw_branch, normalized_branch, source_file_type, branch_column_index, branch_header_raw, region_code, region_name, excluded")
    .eq("distributor_code", code);
  if (error) throw new SalesWorkflowError("load_failed", error.message, 500);

  const index: WeeklyBranchRegionIndex = { byBranch: new Map(), byColumnIndex: new Map() };
  for (const row of data ?? []) {
    const fileType = fileTypeOf(row.source_file_type);
    const normalized = String(row.normalized_branch ?? "");
    const entry = {
      regionCode: String(row.region_code ?? ""),
      regionName: String(row.region_name ?? ""),
      excluded: Boolean(row.excluded),
    };
    if (row.branch_column_index != null) {
      index.byColumnIndex.set(Number(row.branch_column_index), { ...entry, headerRaw: String(row.branch_header_raw ?? "") });
    }
    if (normalized) index.byBranch.set(`${fileType}|${normalized}`, entry);
  }
  return index;
}
