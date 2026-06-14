import ExcelJS from "exceljs";

import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type WeeklyPosRegionMappingReference = {
  distributorCode: string;
  normalizedColumnName: string;
  rawColumnName: string;
  regionCode: string;
};

export type WeeklyPosRegionMappingRow = WeeklyPosRegionMappingReference & {
  id: string;
  regionName: string;
  updatedAt: string;
};

export type WeeklyPosRegionMappingAdmin = {
  mappings: WeeklyPosRegionMappingRow[];
  regions: { regionCode: string; regionName: string }[];
};

export type WeeklyPosRegionMappingImportResult = {
  inserted: number;
  updated: number;
  skipped: number;
  blockedRows: { rowNumber: number; reason: string; rawColumnName: string; regionCode: string }[];
};

type MappingInput = { distributorCode?: string; rawColumnName: string; regionCode: string };

export function normalizeWeeklyPosColumnName(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[_\s]*\u0643$/u, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/&/g, " and ")
    .replace(/[.\-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const clean = (value: unknown) => String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
const code = (value: unknown) => clean(value).toUpperCase();

async function loadOfficialRegionMap(): Promise<Map<string, string>> {
  const references = await loadSalesReferenceData({ includeCustomerBricks: false });
  const regions = new Map<string, string>();
  for (const region of references.regions ?? []) {
    const regionCode = code(region.regionCode);
    const regionName = clean(region.regionName);
    if (regionCode && regionName && !regions.has(regionCode)) regions.set(regionCode, regionName);
  }
  return regions;
}

function isMissingTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? "");
  const codeValue = String((error as { code?: unknown })?.code ?? "");
  return codeValue === "42P01" || /weekly_sales_pos_region_mappings|does not exist|Could not find the table/i.test(message);
}

export async function listWeeklyPosRegionMappingReferences(
  distributorCode = "PS",
): Promise<WeeklyPosRegionMappingReference[]> {
  const supabase = getSupabaseAdmin();
  const result = await supabase
    .from("weekly_sales_pos_region_mappings")
    .select("distributor_code, raw_column_name, normalized_column_name, region_code")
    .eq("distributor_code", code(distributorCode))
    .order("raw_column_name", { ascending: true });
  if (result.error) {
    if (isMissingTable(result.error)) return [];
    throw result.error;
  }
  return (result.data ?? []).map((row) => ({
    distributorCode: String(row.distributor_code ?? ""),
    rawColumnName: String(row.raw_column_name ?? ""),
    normalizedColumnName: String(row.normalized_column_name ?? ""),
    regionCode: String(row.region_code ?? ""),
  }));
}

export async function loadWeeklyPosRegionMappingAdmin(distributorCode = "PS"): Promise<WeeklyPosRegionMappingAdmin> {
  const [regionsByCode, mappingRefs] = await Promise.all([
    loadOfficialRegionMap(),
    listWeeklyPosRegionMappingReferences(distributorCode),
  ]);
  const mappings: WeeklyPosRegionMappingRow[] = mappingRefs.map((mapping) => ({
    ...mapping,
    id: `${mapping.distributorCode}:${mapping.normalizedColumnName}`,
    regionName: regionsByCode.get(code(mapping.regionCode)) ?? "",
    updatedAt: "",
  }));
  return {
    mappings,
    regions: [...regionsByCode.entries()]
      .map(([regionCode, regionName]) => ({ regionCode, regionName }))
      .sort((left, right) => left.regionName.localeCompare(right.regionName) || left.regionCode.localeCompare(right.regionCode)),
  };
}

export async function upsertWeeklyPosRegionMappings(input: {
  actorId: string;
  mappings: MappingInput[];
}): Promise<WeeklyPosRegionMappingImportResult> {
  const regionsByCode = await loadOfficialRegionMap();
  const supabase = getSupabaseAdmin();
  const blockedRows: WeeklyPosRegionMappingImportResult["blockedRows"] = [];
  const payload: {
    distributor_code: string;
    raw_column_name: string;
    normalized_column_name: string;
    region_code: string;
    created_by: string;
    updated_by: string;
    updated_at: string;
  }[] = [];
  let skipped = 0;

  input.mappings.forEach((mapping, index) => {
    const rawColumnName = clean(mapping.rawColumnName);
    const normalizedColumnName = normalizeWeeklyPosColumnName(rawColumnName);
    const regionCode = code(mapping.regionCode);
    const distributorCode = code(mapping.distributorCode || "PS");
    if (!rawColumnName && !regionCode) {
      skipped += 1;
      return;
    }
    if (!rawColumnName) {
      blockedRows.push({ rowNumber: index + 2, reason: "Raw POS column is required.", rawColumnName, regionCode });
      return;
    }
    if (!normalizedColumnName) {
      blockedRows.push({ rowNumber: index + 2, reason: "Raw POS column could not be normalized.", rawColumnName, regionCode });
      return;
    }
    if (!regionCode || !regionsByCode.has(regionCode)) {
      blockedRows.push({
        rowNumber: index + 2,
        reason: `Region ID "${regionCode || "(blank)"}" is not in the official Source of Sales region reference.`,
        rawColumnName,
        regionCode,
      });
      return;
    }
    payload.push({
      distributor_code: distributorCode,
      raw_column_name: rawColumnName,
      normalized_column_name: normalizedColumnName,
      region_code: regionCode,
      created_by: input.actorId,
      updated_by: input.actorId,
      updated_at: new Date().toISOString(),
    });
  });

  if (blockedRows.length > 0) return { inserted: 0, updated: 0, skipped, blockedRows };
  if (payload.length === 0) return { inserted: 0, updated: 0, skipped, blockedRows };

  const existing = await supabase
    .from("weekly_sales_pos_region_mappings")
    .select("distributor_code, normalized_column_name")
    .in("normalized_column_name", payload.map((row) => row.normalized_column_name));
  if (existing.error) throw existing.error;
  const existingKeys = new Set(
    (existing.data ?? []).map((row) => `${String(row.distributor_code ?? "")}:${String(row.normalized_column_name ?? "")}`),
  );

  const upsert = await supabase
    .from("weekly_sales_pos_region_mappings")
    .upsert(payload, { onConflict: "distributor_code,normalized_column_name" });
  if (upsert.error) throw upsert.error;

  let updated = 0;
  let inserted = 0;
  for (const row of payload) {
    if (existingKeys.has(`${row.distributor_code}:${row.normalized_column_name}`)) updated += 1;
    else inserted += 1;
  }
  return { inserted, updated, skipped, blockedRows };
}

function textCell(row: ExcelJS.Row, index: number): string {
  const value = row.getCell(index).value as unknown;
  if (value == null) return "";
  if (typeof value === "object" && "text" in value) return clean((value as { text?: unknown }).text);
  return clean(value);
}

export async function importWeeklyPosRegionMappingWorkbook(input: {
  actorId: string;
  file: File;
}): Promise<WeeklyPosRegionMappingImportResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await input.file.arrayBuffer() as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.getWorksheet("Mapping") ?? workbook.worksheets[0];
  if (!sheet) throw new SalesWorkflowError("invalid_mapping_template", "The mapping workbook has no sheets.", 400);

  const mappings: MappingInput[] = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const rawColumnName = textCell(row, 1);
    const regionCode = textCell(row, 2);
    if (!rawColumnName && !regionCode) continue;
    mappings.push({ rawColumnName, regionCode, distributorCode: "PS" });
  }
  return upsertWeeklyPosRegionMappings({ actorId: input.actorId, mappings });
}

export async function buildWeeklyPosRegionMappingTemplate(): Promise<ArrayBuffer> {
  const data = await loadWeeklyPosRegionMappingAdmin("PS");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  const mapping = workbook.addWorksheet("Mapping");
  mapping.columns = [
    { header: "Raw POS Column", key: "rawColumnName", width: 38 },
    { header: "Official Region ID", key: "regionCode", width: 20 },
    { header: "Official Region Name", key: "regionName", width: 28 },
    { header: "Notes", key: "notes", width: 40 },
  ];
  for (const row of data.mappings) {
    mapping.addRow({
      rawColumnName: row.rawColumnName,
      regionCode: row.regionCode,
      regionName: row.regionName,
      notes: "",
    });
  }
  if (data.mappings.length === 0) {
    mapping.addRow({ rawColumnName: "Paste POS column here", regionCode: "Use official ID", regionName: "", notes: "Example row; replace it." });
  }
  mapping.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  mapping.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF97316" } };
  mapping.views = [{ state: "frozen", ySplit: 1 }];

  const regions = workbook.addWorksheet("Official Regions");
  regions.columns = [
    { header: "Official Region ID", key: "regionCode", width: 20 },
    { header: "Official Region Name", key: "regionName", width: 32 },
  ];
  for (const region of data.regions) regions.addRow(region);
  regions.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  regions.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } };
  regions.views = [{ state: "frozen", ySplit: 1 }];

  const instructions = workbook.addWorksheet("Instructions");
  instructions.addRows([
    ["Purpose", "Map unstable overseas POS weekly columns to official Source of Sales regions."],
    ["Rule", "Only values from Official Region ID are accepted. Region names are derived by the system."],
    ["How to use", "Fill Mapping!A:B, save the workbook, then upload it in Weekly Sales Upload."],
    ["Do not", "Do not type invented region names. Do not change Official Regions."],
  ]);
  instructions.columns = [{ width: 18 }, { width: 90 }];
  instructions.getColumn(1).font = { bold: true };

  return workbook.xlsx.writeBuffer() as unknown as ArrayBuffer;
}
