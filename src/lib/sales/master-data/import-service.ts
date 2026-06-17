import type ExcelJS from "exceljs";

import { writeAuditLog } from "@/lib/admin/audit";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { excelCellText, loadExcelWorkbook } from "@/lib/uploads/exceljs-rows";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";

import {
  MASTER_DEFINITIONS,
  editableColumns,
  normalizeCode,
  normalizeDisplay,
  parseMasterNumber,
  type MasterColumn,
  type MasterDefinition,
  type MasterKey,
} from "./definitions";

export type MasterImportBlockedRow = { key: string; reason: string; row: number };

export type MasterImportResult = {
  blockedRows: MasterImportBlockedRow[];
  inserted: number;
  master: MasterKey;
  skipped: number;
  totalRead: number;
  updated: number;
};

// System sales distributors that live in CODE, not in the user's uploaded distributor master:
//   • "Direct" — the company-direct channel (region-only; sale value taken straight from the sheet's
//     Value column — see DIRECT_TEMPLATE in monthly-distributor-import.ts).
//   • "EP-R" — the EPDA Bulk (wholesale) branch (coded template + normalizer profile).
//   • "EGD-PH" — a branch of EGD (parent EG), coded template only.
// These are code-defined and are NOT in the user's distributor-master file, so the add-only master
// import + a data reset would silently drop them (exactly how "Direct" vanished from the Upload Sales
// dropdown after the 2026-06-08 reset). They are re-ensured after every distributor-master import.
// Idempotent; mirror of their seed migrations.
const SYSTEM_DISTRIBUTORS = [
  { distributor_code: "Direct", distributor_name: "Direct (Company)", normalized_distributor_name: "direct (company)" },
  { distributor_code: "EP-R", distributor_name: "EPDA Bulk", normalized_distributor_name: "epda bulk" },
  { distributor_code: "EGD-PH", distributor_name: "EGD-PH", normalized_distributor_name: "egd-ph" },
  // Tender channels — separate distributors so tender/hospital sales stay distinct from the
  // distributor's regular pharmacy file. Each has a code-defined raw profile in normalizer/profiles.ts.
  { distributor_code: "IS-T", distributor_name: "Ibn Sina Tender", normalized_distributor_name: "ibn sina tender" },
  { distributor_code: "PS-T", distributor_name: "Overseas Tender", normalized_distributor_name: "overseas tender" },
  { distributor_code: "RM-T", distributor_name: "Ramco Tender", normalized_distributor_name: "ramco tender" },
  { distributor_code: "SF-T", distributor_name: "Sofico Tender", normalized_distributor_name: "sofico tender" },
  { distributor_code: "EG-HOS", distributor_name: "EGD Hospital", normalized_distributor_name: "egd hospital" },
] as const;

// Re-ensure the code-defined system channels exist + are active. Non-fatal: a failure here must never
// block the user's master import (the channels are also restorable via their seed migration).
async function ensureSystemDistributors(supabase: ReturnType<typeof getSupabaseAdmin>): Promise<number> {
  let ensured = 0;
  for (const channel of SYSTEM_DISTRIBUTORS) {
    const { error } = await supabase
      .from("source_of_sales_distributors")
      .upsert({ ...channel, active: true }, { onConflict: "distributor_code" });
    if (!error) ensured += 1;
  }
  return ensured;
}

type ColumnMap = Map<number, string>; // 1-based column index -> DB column key

const HEADER_SCAN_ROWS = 12;
const INSERT_CHUNK = 500;

function normalizeHeader(value: unknown) {
  return excelCellText(value as ExcelJS.CellValue).toLowerCase();
}

function buildHeaderLookup(def: MasterDefinition) {
  const lookup = new Map<string, string>();
  for (const column of def.columns) {
    lookup.set(normalizeHeader(column.label), column.key);
    lookup.set(normalizeHeader(column.key), column.key);
  }
  return lookup;
}

function detectHeader(sheet: ExcelJS.Worksheet, def: MasterDefinition): { columnMap: ColumnMap; headerRow: number } | null {
  const lookup = buildHeaderLookup(def);
  const maxRow = Math.min(sheet.rowCount, HEADER_SCAN_ROWS);
  for (let rowNumber = 1; rowNumber <= maxRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const columnMap: ColumnMap = new Map();
    for (let column = 1; column <= sheet.columnCount; column += 1) {
      const key = lookup.get(normalizeHeader(row.getCell(column).value));
      if (key && ![...columnMap.values()].includes(key)) columnMap.set(column, key);
    }
    if (columnMap.size >= 2 && [...columnMap.values()].includes(def.keyColumn)) {
      return { columnMap, headerRow: rowNumber };
    }
  }
  return null;
}

function findSheet(workbook: ExcelJS.Workbook, def: MasterDefinition) {
  const wantedName = normalizeHeader(def.sheetName);
  const named = workbook.worksheets.find((sheet) => normalizeHeader(sheet.name) === wantedName);
  const ordered = named ? [named, ...workbook.worksheets.filter((sheet) => sheet !== named)] : workbook.worksheets;
  for (const sheet of ordered) {
    const detected = detectHeader(sheet, def);
    if (detected) return { sheet, ...detected };
  }
  return null;
}

function typeValue(column: MasterColumn, raw: string): string | number {
  if (column.type === "number") return parseMasterNumber(raw);
  if (column.type === "code") return normalizeCode(raw);
  return normalizeDisplay(raw);
}

async function preloadKeyed(table: string, keyColumn: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from(table).select("*");
  if (error) throw error;
  const map = new Map<string, Record<string, unknown>>();
  for (const row of data ?? []) {
    const key = normalizeCode((row as Record<string, unknown>)[keyColumn]);
    if (key) map.set(key, row as Record<string, unknown>);
  }
  return map;
}

export async function importMasterWorkbook(input: {
  actorLoginId: string;
  file: File;
  master: MasterKey;
}): Promise<MasterImportResult> {
  const def = MASTER_DEFINITIONS[input.master];

  const fileValidation = validateSpreadsheetFile(input.file, {
    ...xlsxSpreadsheetValidation,
    emptyError: "invalid_master_file",
    emptyMessage: "The master workbook is empty.",
    tooLargeError: "master_file_too_large",
    tooLargeMessage: "The master workbook exceeds the 10MB upload limit.",
    unsupportedError: "unsupported_master_file_type",
    unsupportedMessage: "Upload the master sheet in .xlsx format.",
  });
  if (!fileValidation.ok) {
    throw new SalesWorkflowError(fileValidation.error, fileValidation.message, fileValidation.status);
  }

  const workbook = await loadExcelWorkbook(await input.file.arrayBuffer());
  const located = findSheet(workbook, def);
  if (!located) {
    const headers = def.columns.map((column) => column.label).join(", ");
    throw new SalesWorkflowError(
      "unmatched_master_sheet",
      `No sheet matching the ${def.label} template was found. Expected headers include: ${headers}.`,
      400,
    );
  }

  const { sheet, columnMap, headerRow } = located;
  const existing = await preloadKeyed(def.table, def.keyColumn);

  // Preload parent tables once for FK validation + denormalized-name resolution.
  const parentMaps = new Map<MasterKey, Map<string, Record<string, unknown>>>();
  for (const parent of def.parents) {
    if (!parentMaps.has(parent.parentMaster)) {
      const parentDef = MASTER_DEFINITIONS[parent.parentMaster];
      parentMaps.set(parent.parentMaster, await preloadKeyed(parentDef.table, parentDef.keyColumn));
    }
  }

  const editable = editableColumns(def);
  const supabase = getSupabaseAdmin();

  const blockedRows: MasterImportBlockedRow[] = [];
  const inserts: { payload: Record<string, unknown>; row: number; key: string }[] = [];
  const processedKeys = new Set<string>();
  let totalRead = 0;
  let updated = 0;
  let skipped = 0;

  for (let rowNumber = headerRow + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const fileValues = new Map<string, string>();
    for (const [columnIndex, columnKey] of columnMap) {
      fileValues.set(columnKey, excelCellText(row.getCell(columnIndex).value));
    }
    if (![...fileValues.values()].some((value) => value !== "")) continue; // blank row

    totalRead += 1;
    const key = normalizeCode(fileValues.get(def.keyColumn) ?? "");
    if (!key) {
      blockedRows.push({ key: "", reason: `${columnLabel(def, def.keyColumn)} is required.`, row: rowNumber });
      continue;
    }
    if (processedKeys.has(key)) {
      blockedRows.push({ key, reason: "Duplicate key in file.", row: rowNumber });
      continue;
    }
    processedKeys.add(key);

    const existingRow = existing.get(key);

    // Build the effective row (string values per column): existing values
    // overlaid with edits for editable columns; locked columns are match-only.
    const effective: Record<string, string> = {};
    for (const column of def.columns) {
      if (existingRow) {
        const edited = !column.locked && fileValues.has(column.key);
        effective[column.key] = edited
          ? (fileValues.get(column.key) ?? "")
          : normalizeDisplay(existingRow[column.key]);
      } else {
        effective[column.key] = fileValues.get(column.key) ?? "";
      }
    }

    // Resolve parents (FK validation + denormalized names).
    const parentValues: Record<string, string | null> = {};
    let blockedReason: string | null = null;
    for (const parent of def.parents) {
      const code = normalizeCode(effective[parent.codeColumn]);
      const copyCodes = parent.copyCodes ?? {};
      if (!code) {
        if (parent.optional) {
          for (const targetColumn of Object.values(copyCodes)) parentValues[targetColumn] = null;
          continue;
        }
        blockedReason = `${columnLabel(def, parent.codeColumn)} is required.`;
        break;
      }
      const parentRow = parentMaps.get(parent.parentMaster)?.get(code);
      if (!parentRow) {
        blockedReason = `${columnLabel(def, parent.codeColumn)} "${code}" is not in ${MASTER_DEFINITIONS[parent.parentMaster].label}.`;
        break;
      }
      // Only real CODE columns are copied (e.g. blocks.region_code from area).
      for (const [parentColumn, targetColumn] of Object.entries(copyCodes)) {
        parentValues[targetColumn] = normalizeCode(parentRow[parentColumn]);
      }
    }
    if (blockedReason) {
      blockedRows.push({ key, reason: blockedReason, row: rowNumber });
      continue;
    }

    const derived = def.derive(effective);

    if (existingRow) {
      if (editable.length === 0) {
        skipped += 1; // nothing editable (e.g. distributors) → add-only master
        continue;
      }
      const updatePayload: Record<string, unknown> = { ...parentValues, ...derived, updated_at: new Date().toISOString() };
      let invalid: string | null = null;
      for (const column of editable) {
        const value = typeValue(column, effective[column.key]);
        if (column.type === "number" && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
          invalid = `${column.label} must be a non-negative number.`;
          break;
        }
        if (column.required && (value === "" || value === null)) {
          invalid = `${column.label} is required.`;
          break;
        }
        updatePayload[column.key] = value;
      }
      if (invalid) {
        blockedRows.push({ key, reason: invalid, row: rowNumber });
        continue;
      }
      const { error } = await supabase.from(def.table).update(updatePayload).eq(def.keyColumn, key);
      if (error) {
        blockedRows.push({ key, reason: error.message, row: rowNumber });
        continue;
      }
      updated += 1;
      continue;
    }

    // INSERT — require all required columns, then build the full payload.
    const payload: Record<string, unknown> = { ...parentValues, ...derived };
    let invalid: string | null = null;
    for (const column of def.columns) {
      const value = typeValue(column, effective[column.key]);
      if (column.required) {
        if (column.type === "number" && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
          invalid = `${column.label} must be a non-negative number.`;
          break;
        }
        if (value === "" || value === null) {
          invalid = `${column.label} is required to add a new row.`;
          break;
        }
      }
      // Omit empty optional columns so NOT NULL DEFAULT '' columns use their default.
      if (value !== "") payload[column.key] = value;
    }
    if (invalid) {
      blockedRows.push({ key, reason: invalid, row: rowNumber });
      continue;
    }
    inserts.push({ key, payload, row: rowNumber });
  }

  // Batch insert new rows; on chunk error retry per-row to attribute the failure.
  let inserted = 0;
  for (let index = 0; index < inserts.length; index += INSERT_CHUNK) {
    const chunk = inserts.slice(index, index + INSERT_CHUNK);
    const { error } = await supabase.from(def.table).insert(chunk.map((entry) => entry.payload));
    if (!error) {
      inserted += chunk.length;
      continue;
    }
    for (const entry of chunk) {
      const result = await supabase.from(def.table).insert(entry.payload);
      if (result.error) {
        const reason = result.error.code === "23505"
          ? `${columnLabel(def, def.keyColumn)} "${entry.key}" already exists.`
          : result.error.message;
        blockedRows.push({ key: entry.key, reason, row: entry.row });
      } else {
        inserted += 1;
      }
    }
  }

  // System channels (e.g. the company-direct "Direct" distributor) are not in the user's master file,
  // so an add-only re-import after a data reset would drop them. Re-ensure them on every distributor
  // import. Non-fatal — never blocks the user's import.
  let systemEnsured = 0;
  if (def.master === "distributors") {
    systemEnsured = await ensureSystemDistributors(supabase);
  }

  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: def.master,
    entityType: def.auditEntityType,
    newValues: {
      blocked: blockedRows.length,
      inserted,
      master: def.master,
      skipped,
      source: "database_mapping_import",
      systemEnsured,
      totalRead,
      updated,
    },
    summary: `Database Mapping import — ${def.label}: ${inserted} added, ${updated} updated, ${blockedRows.length} blocked.`,
  });

  return { blockedRows, inserted, master: def.master, skipped, totalRead, updated };
}

function columnLabel(def: MasterDefinition, key: string) {
  return def.columns.find((column) => column.key === key)?.label ?? key;
}
