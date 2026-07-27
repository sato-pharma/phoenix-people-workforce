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
import { selectAllRows } from "./list";

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
//   • "EG-BR" — EGD Branch (parent EG), coded template only.
// These are code-defined and are NOT in the user's distributor-master file, so the add-only master
// import + a data reset would silently drop them (exactly how "Direct" vanished from the Upload Sales
// dropdown after the 2026-06-08 reset). They are re-ensured after every distributor-master import.
// Idempotent; mirror of their seed migrations.
const SYSTEM_DISTRIBUTORS = [
  { distributor_code: "Direct", distributor_name: "Direct (Company)", normalized_distributor_name: "direct (company)" },
  { distributor_code: "EG-BR", distributor_name: "EGD Branch", normalized_distributor_name: "egd branch" },
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
  // A blank percent stays "" (→ cleared/omitted) instead of becoming NaN. Unlike `number`, this
  // column is nullable, so an empty cell is a legitimate value, not a broken one.
  if (column.type === "percent") return normalizeDisplay(raw) === "" ? "" : parseMasterNumber(raw);
  if (column.type === "code") return normalizeCode(raw);
  return normalizeDisplay(raw);
}

/**
 * Range check for `percent` columns. Blank is allowed (the column is nullable); anything present
 * must be a fraction in 0..1. This is the guard that catches a whole-number percent — typing 3.41
 * instead of 0.0341 would otherwise store a 341% market share.
 */
function percentInvalidReason(column: MasterColumn, value: string | number): string | null {
  if (column.type !== "percent" || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `${column.label} must be a number.`;
  }
  if (value < 0 || value > 1) {
    return `${column.label} must be a fraction between 0 and 1 — enter 0.0341 for 3.41% (in Excel, a % -formatted cell does this for you).`;
  }
  return null;
}

/** Blank percent clears the column, rather than writing "" into a numeric field. */
function writableValue(column: MasterColumn, value: string | number): string | number | null {
  return column.type === "percent" && value === "" ? null : value;
}

/** Resolves a value against `column.allowedValues` (case/whitespace-insensitive), returning the
 *  allow-listed value's canonical casing on a match or `undefined` if unrecognized. Columns with
 *  no `allowedValues` are unrestricted (always undefined — caller should only treat that as a
 *  block when `allowedValues` was actually set). */
function matchAllowedValue(column: MasterColumn, value: string): string | undefined {
  if (!column.allowedValues) return undefined;
  const normalized = value.trim().toLowerCase();
  return column.allowedValues.find((allowed) => allowed.trim().toLowerCase() === normalized);
}

async function preloadKeyed(table: string, keyColumn: string) {
  const rows = await selectAllRows(table);
  const map = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const key = normalizeCode(row[keyColumn]);
    if (key) map.set(key, row);
  }
  return map;
}

/**
 * Resolves + FK-validates a row's parent code columns against preloaded parent maps, returning the
 * real CODE columns to copy onto the row (e.g. bricks.area_code/region_code from the parent block).
 * Shared by addSingleMasterRow and updateSingleMasterRow so the cascade logic (and its edge cases —
 * optional parents, composite copyCodes) lives in one place instead of drifting across call sites.
 */
function resolveParentValues(
  def: MasterDefinition,
  effective: Record<string, string>,
  parentMaps: Map<MasterKey, Map<string, Record<string, unknown>>>,
): { parentValues: Record<string, string | null> } | { error: string } {
  const parentValues: Record<string, string | null> = {};
  for (const parent of def.parents) {
    const code = normalizeCode(effective[parent.codeColumn]);
    const copyCodes = parent.copyCodes ?? {};
    if (!code) {
      if (parent.optional) {
        for (const targetColumn of Object.values(copyCodes)) parentValues[targetColumn] = null;
        continue;
      }
      return { error: `${columnLabel(def, parent.codeColumn)} is required.` };
    }
    const parentRow = parentMaps.get(parent.parentMaster)?.get(code);
    if (!parentRow) {
      return { error: `${columnLabel(def, parent.codeColumn)} "${code}" is not in ${MASTER_DEFINITIONS[parent.parentMaster].label}.` };
    }
    for (const [parentColumn, targetColumn] of Object.entries(copyCodes)) {
      parentValues[targetColumn] = normalizeCode(parentRow[parentColumn]);
    }
  }
  return { parentValues };
}

async function preloadParentMaps(def: MasterDefinition) {
  const parentMaps = new Map<MasterKey, Map<string, Record<string, unknown>>>();
  for (const parent of def.parents) {
    if (!parentMaps.has(parent.parentMaster)) {
      const parentDef = MASTER_DEFINITIONS[parent.parentMaster];
      parentMaps.set(parent.parentMaster, await preloadKeyed(parentDef.table, parentDef.keyColumn));
    }
  }
  return parentMaps;
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
        const percentProblem = percentInvalidReason(column, value);
        if (percentProblem) {
          invalid = percentProblem;
          break;
        }
        if (column.required && (value === "" || value === null)) {
          invalid = `${column.label} is required.`;
          break;
        }
        if (column.allowedValues && typeof value === "string" && value !== "") {
          const canonical = matchAllowedValue(column, value);
          if (!canonical) {
            invalid = `${column.label} "${value}" is not a recognized value. Use one of: ${column.allowedValues.join(", ")}.`;
            break;
          }
          updatePayload[column.key] = canonical;
          continue;
        }
        updatePayload[column.key] = writableValue(column, value);
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
      // Range-checked even when optional — a new row may still carry a bad ratio.
      const percentProblem = percentInvalidReason(column, value);
      if (percentProblem) {
        invalid = percentProblem;
        break;
      }
      if (column.allowedValues && typeof value === "string" && value !== "") {
        const canonical = matchAllowedValue(column, value);
        if (!canonical) {
          invalid = `${column.label} "${value}" is not a recognized value. Use one of: ${column.allowedValues.join(", ")}.`;
          break;
        }
        payload[column.key] = canonical;
        continue;
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

  // Product Master is the source of truth for factory price. When prices change, resync the STORED
  // weekly sales values so raw/stored reads (e.g. the batch export route that bypasses the dashboard
  // service) match the live read-time recompute in loadWeeklyDashboard. Best-effort: never fail the
  // import if the resync function isn't present yet (migration pending) or errors.
  if (def.master === "products" && updated > 0) {
    try {
      await supabase.rpc("phx_recompute_weekly_sales_value" as never);
    } catch {
      // resync is best-effort; dashboards/exports already recompute value from current price at read time.
    }
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

export async function addSingleMasterRow(input: {
  actorLoginId: string;
  master: MasterKey;
  row: Record<string, string>;
}): Promise<{ success: boolean; error?: string; inserted?: boolean }> {
  const def = MASTER_DEFINITIONS[input.master];
  const existing = await preloadKeyed(def.table, def.keyColumn);
  const parentMaps = await preloadParentMaps(def);
  const supabase = getSupabaseAdmin();

  const key = normalizeCode(input.row[def.keyColumn] ?? "");
  if (!key) {
    return { success: false, error: `${columnLabel(def, def.keyColumn)} is required.` };
  }
  if (existing.has(key)) {
    return { success: false, error: `${columnLabel(def, def.keyColumn)} "${key}" already exists.` };
  }

  const resolvedParents = resolveParentValues(def, input.row, parentMaps);
  if ("error" in resolvedParents) {
    return { success: false, error: resolvedParents.error };
  }
  const { parentValues } = resolvedParents;

  const derived = def.derive(input.row);
  const payload: Record<string, unknown> = { ...parentValues, ...derived };
  let invalid: string | null = null;
  for (const column of def.columns) {
    const value = typeValue(column, input.row[column.key] ?? "");
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
    // Range-checked even when optional — a new row may still carry a bad ratio.
    const percentProblem = percentInvalidReason(column, value);
    if (percentProblem) {
      invalid = percentProblem;
      break;
    }
    if (column.allowedValues && typeof value === "string" && value !== "") {
      const canonical = matchAllowedValue(column, value);
      if (!canonical) {
        invalid = `${column.label} "${value}" is not a recognized value. Use one of: ${column.allowedValues.join(", ")}.`;
        break;
      }
      payload[column.key] = canonical;
      continue;
    }
    if (value !== "") payload[column.key] = value;
  }
  if (invalid) {
    return { success: false, error: invalid };
  }

  const { error } = await supabase.from(def.table).insert(payload);
  if (error) {
    const reason = error.code === "23505"
      ? `${columnLabel(def, def.keyColumn)} "${key}" already exists.`
      : error.message;
    return { success: false, error: reason };
  }

  let systemEnsured = 0;
  if (def.master === "distributors") {
    systemEnsured = await ensureSystemDistributors(supabase);
  }

  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: key,
    entityType: def.auditEntityType,
    newValues: {
      master: def.master,
      source: "database_mapping_single_add",
      systemEnsured,
    },
    summary: `Database Mapping single add — ${def.label}: ${key} added.`,
  });

  return { success: true, inserted: true };
}

/** Edits the editable columns of one existing row (locked columns — key + name — are never
 *  writable here; the key identifies the row and columns like brick_name are match-only, exactly
 *  as in bulk import). Re-validates + re-cascades parent FK columns the same way add/import do. */
export async function updateSingleMasterRow(input: {
  actorLoginId: string;
  master: MasterKey;
  key: string;
  patch: Record<string, string>;
}): Promise<{ success: boolean; error?: string }> {
  const def = MASTER_DEFINITIONS[input.master];
  const key = String(input.key ?? "").trim();
  if (!key) {
    return { success: false, error: `${columnLabel(def, def.keyColumn)} is required.` };
  }

  const supabase = getSupabaseAdmin();
  const { data: existingRow, error: fetchError } = await supabase
    .from(def.table)
    .select("*")
    .eq(def.keyColumn, key)
    .maybeSingle();
  if (fetchError) return { success: false, error: fetchError.message };
  if (!existingRow) {
    return { success: false, error: `${columnLabel(def, def.keyColumn)} "${key}" was not found.` };
  }

  const editable = editableColumns(def);
  if (editable.length === 0) {
    return { success: false, error: `${def.label} has no editable columns (add-only master).` };
  }

  // Effective row: existing values overlaid with any patched editable columns — same overlay
  // pattern importMasterWorkbook uses so parent-FK re-resolution sees the post-edit state.
  const existing = existingRow as Record<string, unknown>;
  const effective: Record<string, string> = {};
  for (const column of def.columns) {
    const edited = !column.locked && Object.prototype.hasOwnProperty.call(input.patch, column.key);
    effective[column.key] = edited ? (input.patch[column.key] ?? "") : normalizeDisplay(existing[column.key]);
  }

  const parentMaps = await preloadParentMaps(def);
  const resolvedParents = resolveParentValues(def, effective, parentMaps);
  if ("error" in resolvedParents) {
    return { success: false, error: resolvedParents.error };
  }

  const derived = def.derive(effective);
  const updatePayload: Record<string, unknown> = {
    ...resolvedParents.parentValues,
    ...derived,
    updated_at: new Date().toISOString(),
  };
  let changedColumns = 0;
  for (const column of editable) {
    if (!Object.prototype.hasOwnProperty.call(input.patch, column.key)) continue;
    const value = typeValue(column, effective[column.key]);
    if (column.type === "number" && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      return { success: false, error: `${column.label} must be a non-negative number.` };
    }
    const percentProblem = percentInvalidReason(column, value);
    if (percentProblem) {
      return { success: false, error: percentProblem };
    }
    if (column.required && (value === "" || value === null)) {
      return { success: false, error: `${column.label} is required.` };
    }
    if (column.allowedValues && typeof value === "string" && value !== "") {
      const canonical = matchAllowedValue(column, value);
      if (!canonical) {
        return {
          success: false,
          error: `${column.label} "${value}" is not a recognized value. Use one of: ${column.allowedValues.join(", ")}.`,
        };
      }
      updatePayload[column.key] = canonical;
    } else {
      updatePayload[column.key] = writableValue(column, value);
    }
    changedColumns += 1;
  }
  if (changedColumns === 0) {
    return { success: false, error: "No editable fields were changed." };
  }

  const { error } = await supabase.from(def.table).update(updatePayload).eq(def.keyColumn, key);
  if (error) return { success: false, error: error.message };

  // Product Master factory_price drives the stored weekly-sales value — resync it, same as bulk
  // import does. Best-effort: dashboards/exports recompute from the live price at read time anyway.
  if (def.master === "products" && Object.prototype.hasOwnProperty.call(updatePayload, "factory_price")) {
    try {
      await supabase.rpc("phx_recompute_weekly_sales_value" as never);
    } catch {
      // best-effort resync only
    }
  }

  const oldValues: Record<string, unknown> = { active: existing.active };
  for (const columnKey of Object.keys(updatePayload)) {
    if (columnKey === "updated_at") continue;
    oldValues[columnKey] = existing[columnKey] ?? null;
  }

  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: key,
    entityType: def.auditEntityType,
    newValues: { ...updatePayload, master: def.master, source: "database_mapping_single_edit" },
    oldValues,
    summary: `Database Mapping single edit — ${def.label}: ${key} updated.`,
  });

  return { success: true };
}

/** Soft delete / restore for a single master row — flips `active` rather than issuing a real
 *  DELETE. Master tables are referenced (as plain denormalized codes, not live FKs) from years of
 *  historical Source of Sales data; a hard delete would either be blocked by the block/area/region
 *  hierarchy's ON DELETE RESTRICT foreign keys or silently orphan that history. `active = false`
 *  already drives the authenticated-read RLS policy on every master table, so deactivating a row
 *  removes it from all live pickers/joins immediately without touching anything historical. */
export async function setMasterRowActive(input: {
  actorLoginId: string;
  master: MasterKey;
  key: string;
  active: boolean;
}): Promise<{ success: boolean; error?: string }> {
  const def = MASTER_DEFINITIONS[input.master];
  const key = String(input.key ?? "").trim();
  if (!key) {
    return { success: false, error: `${columnLabel(def, def.keyColumn)} is required.` };
  }

  if (
    input.master === "distributors" &&
    !input.active &&
    SYSTEM_DISTRIBUTORS.some((channel) => channel.distributor_code.toLowerCase() === key.toLowerCase())
  ) {
    return {
      success: false,
      error: `"${key}" is a system channel required for sales imports and cannot be deactivated.`,
    };
  }

  const supabase = getSupabaseAdmin();
  const { data: existingRow, error: fetchError } = await supabase
    .from(def.table)
    .select("*")
    .eq(def.keyColumn, key)
    .maybeSingle();
  if (fetchError) return { success: false, error: fetchError.message };
  if (!existingRow) {
    return { success: false, error: `${columnLabel(def, def.keyColumn)} "${key}" was not found.` };
  }
  const wasActive = (existingRow as Record<string, unknown>).active !== false;
  if (wasActive === input.active) {
    return { success: true }; // already in the requested state
  }

  const { error } = await supabase
    .from(def.table)
    .update({ active: input.active, updated_at: new Date().toISOString() })
    .eq(def.keyColumn, key);
  if (error) return { success: false, error: error.message };

  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: key,
    entityType: def.auditEntityType,
    newValues: { active: input.active, master: def.master, source: "database_mapping_single_toggle_active" },
    oldValues: { active: wasActive },
    summary: `Database Mapping row ${input.active ? "reactivated" : "deactivated"} — ${def.label}: ${key}.`,
  });

  return { success: true };
}

/**
 * Moves a brick to a different block by creating a fresh "{newBlockCode}-{n}" brick and
 * deactivating the old one, rather than editing block_code on the existing row in place.
 *
 * Why not a plain in-place edit (which updateSingleMasterRow already supports generically): this
 * dataset's brick IDs consistently encode their block as a display convention (e.g. "B1-2" under
 * block "B1" — verified 100% consistent across all 439 live bricks on 2026-07-23), even though
 * nothing in the app parses that string to derive geography (block_code is what actually drives
 * area/region everywhere). Owner preference (2026-07-23): moving a brick should keep that
 * convention intact rather than leave a brick's ID visually mismatched with its block, so relocate
 * spawns a new correctly-prefixed ID and retires the old one (soft — same as setMasterRowActive,
 * so historical Source of Sales rows that already reference the old brick_id keep resolving).
 */
export async function relocateBrick(input: {
  actorLoginId: string;
  brickId: string;
  newBlockCode: string;
  /** Optional rename applied atomically with the move (the UI lets both be edited in one save). */
  newBrickName?: string;
}): Promise<{ customersCascaded?: number; customersCascadeError?: string; error?: string; newBrickId?: string; success: boolean }> {
  const def = MASTER_DEFINITIONS.bricks;
  const brickId = String(input.brickId ?? "").trim();
  const newBlockCode = normalizeCode(input.newBlockCode);
  const newBrickName = typeof input.newBrickName === "string" ? input.newBrickName.trim() : "";
  if (!brickId) return { success: false, error: "Brick ID is required." };
  if (!newBlockCode) return { success: false, error: "Block Code is required." };

  const supabase = getSupabaseAdmin();

  const { data: existingRow, error: fetchError } = await supabase
    .from(def.table)
    .select("*")
    .eq(def.keyColumn, brickId)
    .maybeSingle();
  if (fetchError) return { success: false, error: fetchError.message };
  if (!existingRow) return { success: false, error: `Brick ID "${brickId}" was not found.` };
  const existing = existingRow as Record<string, unknown>;
  if (existing.active === false) {
    return { success: false, error: `Brick "${brickId}" is inactive — reactivate it before relocating.` };
  }
  const currentBlockCode = normalizeCode(existing.block_code);
  if (currentBlockCode === newBlockCode) {
    return { success: false, error: `"${brickId}" is already in block "${newBlockCode}".` };
  }

  const blocksDef = MASTER_DEFINITIONS.blocks;
  const { data: blockRow, error: blockError } = await supabase
    .from(blocksDef.table)
    .select("*")
    .eq(blocksDef.keyColumn, newBlockCode)
    .maybeSingle();
  if (blockError) return { success: false, error: blockError.message };
  if (!blockRow) return { success: false, error: `Block Code "${newBlockCode}" is not in ${blocksDef.label}.` };
  const block = blockRow as Record<string, unknown>;
  if (block.active === false) {
    return { success: false, error: `Block "${newBlockCode}" is inactive — reactivate it before moving a brick there.` };
  }

  // Allocate the next "{block}-{n}" id under the target block — purely cosmetic (see comment
  // above); collisions are still caught below by the table's primary key on insert.
  const prefix = `${newBlockCode}-`;
  const { data: siblings, error: siblingsError } = await supabase.from(def.table).select("brick_id").ilike("brick_id", `${prefix}%`);
  if (siblingsError) return { success: false, error: siblingsError.message };
  let nextSeq = 1;
  for (const row of (siblings ?? []) as Array<{ brick_id: string }>) {
    const parsed = Number(row.brick_id.slice(prefix.length));
    if (Number.isInteger(parsed) && parsed >= nextSeq) nextSeq = parsed + 1;
  }
  const newBrickId = `${prefix}${nextSeq}`;

  const effectiveBrickName = newBrickName || String(existing.brick_name ?? "");
  const derived = def.derive({ brick_name: effectiveBrickName });
  const newRow: Record<string, unknown> = {
    active: true,
    area_code: normalizeCode(block.area_code),
    block_code: newBlockCode,
    brick_id: newBrickId,
    brick_name: effectiveBrickName,
    description: existing.description ?? "",
    normalized_description: existing.normalized_description ?? "",
    region_code: normalizeCode(block.region_code),
    ...derived,
  };

  const { error: insertError } = await supabase.from(def.table).insert(newRow);
  if (insertError) {
    const reason = insertError.code === "23505" ? `Brick ID "${newBrickId}" already exists.` : insertError.message;
    return { success: false, error: reason };
  }

  const { error: deactivateError } = await supabase
    .from(def.table)
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq(def.keyColumn, brickId);
  if (deactivateError) {
    // The move only half-happened — remove the new row rather than leave two active bricks
    // representing the same territory.
    await supabase.from(def.table).delete().eq(def.keyColumn, newBrickId);
    return {
      success: false,
      error: `Created "${newBrickId}" but failed to deactivate "${brickId}": ${deactivateError.message}`,
    };
  }

  // The customer -> brick crosswalk (source_of_sales_customer_map) has no FK to bricks — it's a
  // plain denormalized brick_id/area_code/region_code copy. The monthly import pipeline only loads
  // ACTIVE bricks into its lookup map (see monthly-distributor-import.ts, .eq("active", true)), so
  // without this cascade every customer still pointing at the now-deactivated old brickId would
  // silently fail to resolve on the next import — not an error, just quietly unmapped. This must
  // run in the same operation as the relocation, not as a separate step someone could forget.
  let customersCascaded: number | undefined;
  let customersCascadeError: string | undefined;
  const { data: cascaded, error: cascadeError } = await supabase
    .from("source_of_sales_customer_map")
    .update({
      area_code: normalizeCode(block.area_code),
      brick_id: newBrickId,
      region_code: normalizeCode(block.region_code),
      updated_at: new Date().toISOString(),
    })
    .eq("brick_id", brickId)
    .select("id");
  if (cascadeError) {
    customersCascadeError = cascadeError.message;
  } else {
    customersCascaded = cascaded?.length ?? 0;
  }

  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: brickId,
    entityType: def.auditEntityType,
    newValues: {
      active: false,
      customersCascadeError,
      customersCascaded,
      master: "bricks",
      relocatedTo: newBrickId,
      source: "database_mapping_brick_relocate",
    },
    oldValues: { active: true, block_code: currentBlockCode },
    summary: `Database Mapping brick relocated — ${brickId} (block ${currentBlockCode}) deactivated, replaced by ${newBrickId} (block ${newBlockCode}). Customer mappings updated: ${customersCascaded ?? "FAILED — " + customersCascadeError}.`,
  });
  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: newBrickId,
    entityType: def.auditEntityType,
    newValues: { ...newRow, master: "bricks", relocatedFrom: brickId, source: "database_mapping_brick_relocate" },
    summary:
      newBrickName && newBrickName !== String(existing.brick_name ?? "")
        ? `Database Mapping brick relocated — ${newBrickId} created in block ${newBlockCode} as "${newBrickName}", replacing ${brickId}.`
        : `Database Mapping brick relocated — ${newBrickId} created in block ${newBlockCode}, replacing ${brickId}.`,
  });

  return { customersCascaded, customersCascadeError, newBrickId, success: true };
}

function columnLabel(def: MasterDefinition, key: string) {
  return def.columns.find((column) => column.key === key)?.label ?? key;
}
