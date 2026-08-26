import ExcelJS from "exceljs";

import { SalesWorkflowError } from "@/lib/sales/contracts";
import { canonicalWeeklyDistributorCode, weeklyDistributorByCode, weeklyDistributorOptions } from "@/lib/sales/weekly/distributors";
import { normalizeCode, normalizeKey, normalizeSoft } from "@/lib/sales/weekly/mapping-normalize";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { WeeklyMappingImportResult } from "@/lib/sales/weekly/product-aliases";

// ─────────────────────────────────────────────────────────────────────────────
// Weekly Sales — per-distributor branch/outlet -> master region map.
//
// The region target is a Source-of-Sales master region (controlled vocabulary, validated here).
// Template mirrors the owner's EGD example: BRANCH_NAME | BRANCH_CODE | REFERENCE REGION ID
// (PS stock additionally pins COLUMN_INDEX because its location headers can repeat).
//
// AREA is OPTIONAL and deliberately so. A branch is a distributor DEPOT, not a rep territory —
// "Tanta Branch" ships to customers across several areas — so an area may only be asserted where the
// branch genuinely belongs to one, and must sit inside the branch's own region. Left blank the branch
// stays region-only, which is exactly the pre-existing behaviour. This is what lets a District Manager
// be scoped by his real areas even when one of them sits in another region (CNS "Kafr El-Sheikh 1" is
// owned by the Alex-BHR DM but lives in Delta (1)) without exposing that region's other areas.
// ─────────────────────────────────────────────────────────────────────────────

export type WeeklyBranchFileType = "any" | "sales" | "stock";

/**
 * Value that means "this depot's rows never count" — weekly's counterpart of the product IGNORE.
 * Lives here, with the map it applies to, so the normalizer and this module can both use it without
 * an import cycle. Never a real region code: it sets the row's `excluded` flag instead.
 */
export const WEEKLY_BRANCH_EXCLUDE_CODE = "__EXCLUDE__";

export type WeeklyMasterRegion = { regionCode: string; regionName: string };

/** A selectable area target, carrying its region so the UI/import can enforce area-inside-region. */
export type WeeklyMasterArea = { areaCode: string; areaName: string; regionCode: string };

export type WeeklyBranchRegionRow = {
  id: string;
  distributorCode: string;
  rawBranch: string;
  sourceFileType: WeeklyBranchFileType;
  branchColumnIndex: number | null;
  branchHeaderRaw: string | null;
  regionCode: string;
  regionName: string;
  /** Optional area inside `regionCode`. null = region-only mapping (default). */
  areaCode: string | null;
  areaName: string | null;
  excluded: boolean;
  updatedAt: string;
};

export type WeeklyBranchRegionAdmin = {
  distributorCode: string;
  fileType: WeeklyBranchFileType;
  distributors: { code: string; name: string }[];
  masterRegions: WeeklyMasterRegion[];
  masterAreas: WeeklyMasterArea[];
  rows: WeeklyBranchRegionRow[];
};

export type WeeklyBranchRegionIndex = {
  /** key = `${sourceFileType}|${normalizedBranch}` */
  byBranch: Map<string, WeeklyBranchRegionEntry>;
  /** PS stock: keyed by column index */
  byColumnIndex: Map<number, WeeklyBranchRegionEntry & { headerRaw: string }>;
  /**
   * Soft/fuzzy fallback keyed by `${sourceFileType}|${normalizeSoft(normalizedBranch)}`.
   * Tolerates the weekly PS header drift pattern: trailing digit suffixes, _ك variants,
   * parenthetical qualifiers. Only consulted when the exact byBranch lookup fails.
   * First registered entry wins (avoids overwriting an exact match that also soft-matches).
   */
  bySoftName: Map<string, WeeklyBranchRegionEntry>;
};

/** What a branch resolves to: its region, and optionally the single area it belongs to. */
export type WeeklyBranchRegionEntry = {
  regionCode: string;
  regionName: string;
  areaCode: string | null;
  excluded: boolean;
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

/** Active Source-of-Sales areas, each carrying its region — the controlled vocabulary for the
 *  optional area target. Sorted by region then area so the admin picker groups naturally. */
export async function listMasterAreas(): Promise<WeeklyMasterArea[]> {
  const references = await loadSalesReferenceData({ includeCustomerBricks: false });
  const out: WeeklyMasterArea[] = [];
  const seen = new Set<string>();
  for (const area of references.areas ?? []) {
    const areaCode = normalizeCode(area.areaCode);
    const regionCode = normalizeCode(area.regionCode);
    if (!areaCode || seen.has(areaCode)) continue;
    seen.add(areaCode);
    out.push({ areaCode, areaName: String(area.areaName ?? "").trim() || areaCode, regionCode });
  }
  return out.sort(
    (left, right) => left.regionCode.localeCompare(right.regionCode) || left.areaCode.localeCompare(right.areaCode),
  );
}

/**
 * Validate an optional area target. Blank ⇒ null (region-only, the default). A non-blank value must be
 * a known active area AND sit inside the branch's mapped region — a branch cannot be attributed to an
 * area in a region it does not serve, which would silently mis-scope every manager downstream.
 */
export function resolveBranchArea(
  areaCodeRaw: string | null | undefined,
  regionCode: string,
  masterAreas: WeeklyMasterArea[],
): { areaCode: string | null; areaName: string | null } {
  const key = normalizeCode(areaCodeRaw ?? "");
  if (!key) return { areaCode: null, areaName: null };
  const match = masterAreas.find((area) => area.areaCode === key);
  if (!match) {
    throw new SalesWorkflowError(
      "unknown_area",
      `Area ID "${String(areaCodeRaw ?? "").trim()}" is not an official Source of Sales area.`,
      400,
    );
  }
  if (normalizeCode(regionCode) && match.regionCode !== normalizeCode(regionCode)) {
    throw new SalesWorkflowError(
      "area_region_mismatch",
      `Area "${match.areaCode}" belongs to region ${match.regionCode}, not the branch's region ${normalizeCode(regionCode)}.`,
      400,
    );
  }
  return { areaCode: match.areaCode, areaName: match.areaName };
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
    areaCode: row.area_code == null || String(row.area_code).trim() === "" ? null : String(row.area_code),
    areaName: row.area_name == null || String(row.area_name).trim() === "" ? null : String(row.area_name),
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
  const [masterRegions, masterAreas] = await Promise.all([listMasterRegions(), listMasterAreas()]);

  let query = supabase
    .from("weekly_sales_branch_region_map")
    .select("id, distributor_code, raw_branch, source_file_type, branch_column_index, branch_header_raw, region_code, region_name, area_code, area_name, excluded, updated_at")
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
    masterAreas,
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
  /** Optional area inside regionCode. Blank/undefined keeps the branch region-only. */
  areaCode?: string | null;
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

  const [regions, masterAreas] = await Promise.all([listMasterRegions(), listMasterAreas()]);
  const masterByCode = new Map(regions.map((region) => [region.regionCode, region.regionName]));
  const region = resolveRegion(input.regionCode, excluded, masterByCode);
  // An excluded branch contributes no rows, so it carries no area either.
  const area = excluded ? { areaCode: null, areaName: null } : resolveBranchArea(input.areaCode, region.regionCode, masterAreas);

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
    area_code: area.areaCode,
    area_name: area.areaName,
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
  const [{ rows }, masterRegions, masterAreas] = await Promise.all([
    loadWeeklyBranchRegionAdmin(code, fileType),
    listMasterRegions(),
    listMasterAreas(),
  ]);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(`${name} ${isStock ? "Stock Locations" : "Branches"}`.slice(0, 31));
  const columns = [
    { header: "BRANCH_NAME", key: "branchName", width: 40 },
    { header: "BRANCH_CODE", key: "branchCode", width: 20 },
    { header: "REFERENCE REGION ID", key: "regionCode", width: 22 },
    // Optional: leave blank to keep the branch region-only (the default).
    { header: "REFERENCE AREA ID", key: "areaCode", width: 22 },
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
      areaCode: row.areaCode ?? "",
      excluded: row.excluded ? "yes" : "",
    });
  }
  if (rows.length === 0) {
    sheet.addRow({ branchName: "paste branch / outlet name", branchCode: "branch key", columnIndex: "", regionCode: "CA", areaCode: "", excluded: "" });
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

  // Areas are optional, so they get their own reference sheet showing which region each belongs to —
  // an area may only be used on a branch mapped to that same region.
  const areaReference = workbook.addWorksheet("Official Areas");
  areaReference.columns = [
    { header: "REFERENCE AREA ID", key: "areaCode", width: 22 },
    { header: "AREA NAME", key: "areaName", width: 32 },
    { header: "REGION ID", key: "regionCode", width: 16 },
  ];
  for (const area of masterAreas) {
    areaReference.addRow({ areaCode: area.areaCode, areaName: area.areaName, regionCode: area.regionCode });
  }
  areaReference.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  areaReference.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } };
  areaReference.views = [{ state: "frozen", ySplit: 1 }];

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
  const colArea = headers.get("REFERENCEAREAID") ?? headers.get("AREAID") ?? headers.get("AREACODE") ?? 0;
  const colIndex = headers.get("COLUMNINDEX") ?? 0;
  const colExcluded = headers.get("EXCLUDED") ?? 0;
  if (!colRegion) {
    throw new SalesWorkflowError("invalid_mapping_template", 'The mapping sheet must have a "REFERENCE REGION ID" column.', 400);
  }

  const [regionsList, masterAreas] = await Promise.all([listMasterRegions(), listMasterAreas()]);
  const masterByCode = new Map(regionsList.map((region) => [region.regionCode, region.regionName]));
  const blockedRows: WeeklyMappingImportResult["blockedRows"] = [];
  type Pending = {
    rawBranch: string;
    branchName: string;
    normalizedBranch: string;
    branchColumnIndex: number | null;
    regionCode: string;
    regionName: string;
    areaCode: string | null;
    areaName: string | null;
    excluded: boolean;
  };
  const pending: Pending[] = [];
  let skipped = 0;

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const branchName = cellString(row, colName);
    const branchCode = cellString(row, colCode);
    const regionRaw = cellString(row, colRegion);
    const areaRaw = colArea ? cellString(row, colArea) : "";
    const indexRaw = cellString(row, colIndex);
    const excludedRaw = cellString(row, colExcluded).toLowerCase();
    const excluded = excludedRaw === "yes" || excludedRaw === "true" || excludedRaw === "1" || excludedRaw === "y";

    const branchColumnIndex = indexRaw ? Number(indexRaw) : null;
    const rawBranch = branchColumnIndex != null ? branchName || branchCode : branchCode || branchName;

    if (!rawBranch && branchColumnIndex == null && !regionRaw && !areaRaw) {
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
    // The optional area must be a real area inside this branch's region. A bad value BLOCKS the row
    // rather than being dropped silently — a wrong area mis-scopes a manager's dashboard invisibly.
    let area: { areaCode: string | null; areaName: string | null };
    try {
      area = excluded ? { areaCode: null, areaName: null } : resolveBranchArea(areaRaw, regionKey, masterAreas);
    } catch (error) {
      blockedRows.push({
        rowNumber,
        reason: error instanceof SalesWorkflowError ? error.message : `Area ID "${areaRaw}" could not be validated.`,
        values: rawBranch || branchName,
      });
      continue;
    }
    pending.push({
      rawBranch: rawBranch || branchName,
      branchName: branchName || rawBranch,
      normalizedBranch: normalizeKey(rawBranch || branchName),
      branchColumnIndex,
      regionCode: excluded ? "" : regionKey,
      regionName: excluded ? "" : masterByCode.get(regionKey) ?? "",
      areaCode: area.areaCode,
      areaName: area.areaName,
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
      area_code: item.areaCode,
      area_name: item.areaName,
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

/** One already-confirmed branch placement, in the shape the AI few-shot prompt wants. */
export type WeeklyBranchExample = { raw: string; code: string; distributorCode: string };

/**
 * Every branch already placed, as raw-branch → region-code examples for the AI.
 *
 * Excluded branches are returned pointing at the exclude sentinel rather than dropped — "this depot
 * never counts" is a decision the model should be able to repeat for a depot that looks like it.
 */
export async function listWeeklyBranchRegionExamples(distributorCode?: string | null, limit = 600): Promise<WeeklyBranchExample[]> {
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("weekly_sales_branch_region_map")
    .select("distributor_code, raw_branch, branch_header_raw, region_code, excluded")
    .order("updated_at", { ascending: false })
    .limit(Math.max(1, limit));
  if (distributorCode) query = query.eq("distributor_code", canonicalWeeklyDistributorCode(distributorCode));
  const { data, error } = await query;
  if (error) throw new SalesWorkflowError("load_failed", error.message, 500);

  const examples: WeeklyBranchExample[] = [];
  for (const row of data ?? []) {
    const raw = String(row.raw_branch ?? "").trim() || String(row.branch_header_raw ?? "").trim();
    const code = row.excluded ? WEEKLY_BRANCH_EXCLUDE_CODE : String(row.region_code ?? "").trim();
    if (!raw || !code) continue;
    examples.push({ raw, code, distributorCode: String(row.distributor_code ?? "").trim().toUpperCase() });
  }
  return examples;
}

/**
 * Every branch already placed on an AREA, as raw-branch → area-code examples for the AI.
 *
 * Separate from listWeeklyBranchRegionExamples because the two speak different vocabularies: that
 * one answers "which region", this one "which area", and feeding region examples to an area
 * suggestion teaches the model the wrong answer shape.
 *
 * Excluded branches and branches with no area are skipped rather than sent as a sentinel — unlike
 * the region case there is nothing to repeat, since "no area yet" is the state being fixed, not a
 * decision worth learning.
 */
export async function listWeeklyBranchAreaExamples(distributorCode?: string | null, limit = 600): Promise<WeeklyBranchExample[]> {
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("weekly_sales_branch_region_map")
    .select("distributor_code, raw_branch, branch_header_raw, area_code, excluded")
    .not("area_code", "is", null)
    .order("updated_at", { ascending: false })
    .limit(Math.max(1, limit));
  if (distributorCode) query = query.eq("distributor_code", canonicalWeeklyDistributorCode(distributorCode));
  const { data, error } = await query;
  if (error) throw new SalesWorkflowError("load_failed", error.message, 500);

  const examples: WeeklyBranchExample[] = [];
  for (const row of data ?? []) {
    if (row.excluded) continue;
    const raw = String(row.raw_branch ?? "").trim() || String(row.branch_header_raw ?? "").trim();
    const code = String(row.area_code ?? "").trim();
    if (!raw || !code) continue;
    examples.push({ raw, code, distributorCode: String(row.distributor_code ?? "").trim().toUpperCase() });
  }
  return examples;
}

/** Build the branch->region resolution index for the upload parser. */
export async function loadBranchRegionIndex(distributorCode: string): Promise<WeeklyBranchRegionIndex> {
  const code = canonicalWeeklyDistributorCode(distributorCode);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("weekly_sales_branch_region_map")
    .select("raw_branch, normalized_branch, source_file_type, branch_column_index, branch_header_raw, region_code, region_name, area_code, excluded")
    .eq("distributor_code", code);
  if (error) throw new SalesWorkflowError("load_failed", error.message, 500);

  const index: WeeklyBranchRegionIndex = { byBranch: new Map(), byColumnIndex: new Map(), bySoftName: new Map() };
  for (const row of data ?? []) {
    const fileType = fileTypeOf(row.source_file_type);
    const normalized = String(row.normalized_branch ?? "");
    const entry: WeeklyBranchRegionEntry = {
      regionCode: String(row.region_code ?? ""),
      regionName: String(row.region_name ?? ""),
      areaCode: row.area_code == null || String(row.area_code).trim() === "" ? null : String(row.area_code).trim().toUpperCase(),
      excluded: Boolean(row.excluded),
    };
    if (row.branch_column_index != null) {
      index.byColumnIndex.set(Number(row.branch_column_index), { ...entry, headerRaw: String(row.branch_header_raw ?? "") });
    }
    if (normalized) {
      index.byBranch.set(`${fileType}|${normalized}`, entry);
      // Soft fallback: strip _ك, parentheticals, trailing digit suffix so weekly PS name drift
      // ("Mansoura" → "Mansoura2") still resolves. First-registered wins (exact match takes
      // priority by being in byBranch; this only matters when the exact lookup already failed).
      const softKey = normalizeSoft(normalized);
      if (softKey && !index.bySoftName.has(`${fileType}|${softKey}`)) {
        index.bySoftName.set(`${fileType}|${softKey}`, entry);
      }
    }
  }
  return index;
}
