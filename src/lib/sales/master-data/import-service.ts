import type ExcelJS from "exceljs";

import { writeAuditLog } from "@/lib/admin/audit";
import { invalidatePriceDependentSalesCaches } from "@/lib/dashboard/invalidation";
import { errorMessageOf, isStatementTimeoutError } from "@/lib/http/api-errors";
import { logError } from "@/lib/observability/log";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { IMS_OTHERS_REGION_CODE } from "@/lib/sales/ims-ratio";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { excelCellText, loadExcelWorkbook } from "@/lib/uploads/exceljs-rows";
import { spreadsheetTooLargeMessage, validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";

import {
  MASTER_DEFINITIONS,
  editableColumns,
  normalizeCode,
  normalizeDisplay,
  normalizeKey,
  parseMasterNumber,
  type MasterColumn,
  type MasterDefinition,
  type MasterKey,
} from "./definitions";
import { brickSwitchOffRefusal, historicalNameCandidates, parseBrickRelocation, type BrickRelocation } from "./brick-move-result";
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
//   • "DIRECT" — the company-direct channel (region-only; sale value taken straight from the sheet's
//     Value column — see DIRECT_TEMPLATE in monthly-distributor-import.ts). Must stay uppercase: the
//     upload pipeline always writes rows as normalizeCode(...)'d uppercase, so a mixed-case registry
//     value here is an attractive nuisance for any manual/ad hoc insert that copies it verbatim
//     (that's exactly how 35 July-2026 rows landed as 'Direct' instead of 'DIRECT' and silently
//     dropped out of phx_direct_sales_reconciliation — see the 2026-08-10 case-insensitivity migration).
//   • "EG-BR" — EGD Branch (parent EG), coded template only.
// These are code-defined and are NOT in the user's distributor-master file, so the add-only master
// import + a data reset would silently drop them (exactly how "Direct" vanished from the Upload Sales
// dropdown after the 2026-06-08 reset). They are re-ensured after every distributor-master import.
// Idempotent; mirror of their seed migrations.
const SYSTEM_DISTRIBUTORS = [
  { distributor_code: "DIRECT", distributor_name: "Direct (Company)", normalized_distributor_name: "direct (company)" },
  { distributor_code: "EG-BR", distributor_name: "EGD Branch", normalized_distributor_name: "egd branch" },
  // Tender channels — separate distributors so tender/hospital sales stay distinct from the
  // distributor's regular pharmacy file. Each has a code-defined raw profile in normalizer/profiles.ts.
  { distributor_code: "IS-T", distributor_name: "Ibn Sina Tender", normalized_distributor_name: "ibn sina tender" },
  { distributor_code: "PS-T", distributor_name: "Overseas Tender", normalized_distributor_name: "overseas tender" },
  { distributor_code: "RM-T", distributor_name: "Ramco Tender", normalized_distributor_name: "ramco tender" },
  { distributor_code: "SF-T", distributor_name: "Sofico Tender", normalized_distributor_name: "sofico tender" },
  { distributor_code: "EG-HOS", distributor_name: "EGD Hospital", normalized_distributor_name: "egd hospital" },
  // "IS-L" — Ibn Sina Lacto, the third Ibn Sina feed (owner's ruling 2026-10-13). Ibn Sina exports one
  // workbook per SUPPLIER, so LACTO MISR EG arrives as its own channel. Unlike IS and IS-S, which the
  // owner's distributor-master file carries, IS-L exists only in code and in its seed migration
  // (20261013012846_sos_ibn_sina_lacto_channel_seed.sql) — so without this line the next master import
  // plus a data reset would drop it out of the Upload Sales dropdown.
  { distributor_code: "IS-L", distributor_name: "Ibn Sina-Lacto", normalized_distributor_name: "ibn sina-lacto" },
  // "EZB" — El Ezaby, the pharmacy chain (owner, 2026-11-10: "add El Ezaby as a distributor"). Not in
  // the owner's distributor-master file, so it lives here and in its seed migration
  // (20261109232133_sos_el_ezaby_distributor_seed.sql). Never "EZ": that is the EZ warehouse customer.
  { distributor_code: "EZB", distributor_name: "El Ezaby", normalized_distributor_name: "el ezaby" },
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

/**
 * THE OTHERS RULE (see src/lib/sales/ims-ratio.ts): the OT ("Others") region's IMS share is one
 * indivisible figure on the REGION row, and every OT *area* must keep `ims_ratio` NULL — OT's area
 * list is volatile (3 areas → 9 in a single day), so a per-area split would have to be re-derived
 * every time that set changes.
 *
 * Nothing in the schema ties the region figure to the area figures, so `percentInvalidReason`'s
 * 0..1 bound is not enough: typing a perfectly valid 0.02 into an OT area silently pushes the model
 * past 1. This is the only write-time guard on that invariant.
 */
export function othersRuleInvalidReason(
  def: MasterDefinition,
  column: MasterColumn,
  value: string | number,
  row: Record<string, string>,
): string | null {
  if (def.master !== "areas" || column.key !== "ims_ratio") return null;
  if (value === "" || value === null) return null;
  if (normalizeCode(row.region_code ?? "") !== IMS_OTHERS_REGION_CODE) return null;
  return `${column.label} must stay empty for ${IMS_OTHERS_REGION_CODE} ("Others") areas — the Others share is held once on the ${IMS_OTHERS_REGION_CODE} region row, never split across its areas.`;
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
  // Ordered by the key we are about to index on — unordered paging silently drops rows (see list.ts).
  const rows = await selectAllRows(table, keyColumn);
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
    tooLargeMessage: spreadsheetTooLargeMessage("The master workbook"),
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
        const percentProblem = percentInvalidReason(column, value) ?? othersRuleInvalidReason(def, column, value, effective);
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
      const percentProblem = percentInvalidReason(column, value) ?? othersRuleInvalidReason(def, column, value, effective);
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

  // NO stored-value resync happens here, and none is needed. `phx_recompute_weekly_sales_value` has
  // never existed in production (checked 2026-09-06: zero matching rows in pg_proc, and no
  // `%recompute%` or `%weekly%sales%` function at all), so the call that used to sit here did
  // nothing on every single run. It could not even report that: `supabase.rpc()` RESOLVES with
  // `{ data, error }` rather than throwing, so the `try/catch` wrapped around it caught nothing and
  // the error object was discarded — a resync that was impossible, invisible, and documented as
  // done.
  //
  // Removing it changes no number. Product Master factory_price is read-time authoritative:
  // `loadWeeklyDashboard` recomputes every non-Direct row's value from the CURRENT master price
  // (see the "Live price sync" block in weekly/service.ts), so a price edit already reflects
  // everywhere without a stored-value pass. If a stored resync is ever genuinely wanted, it needs
  // the function to exist first, and its failure must be logged rather than swallowed.

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

  // A price, product or brick changed: the store split and the achievement figures must not wait out
  // their cache time to show it (invalidatePriceDependentSalesCaches).
  if (inserted + updated > 0) invalidatePriceDependentSalesCaches(`master import: ${def.master}`);

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
    const percentProblem = percentInvalidReason(column, value) ?? othersRuleInvalidReason(def, column, value, input.row);
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

  invalidatePriceDependentSalesCaches(`master add: ${def.master}`);
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
    const percentProblem = percentInvalidReason(column, value) ?? othersRuleInvalidReason(def, column, value, effective);
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

  // No stored-value resync on a factory_price edit either, for the same reason as the bulk path
  // above: `phx_recompute_weekly_sales_value` does not exist, `supabase.rpc()` would not have
  // thrown if it failed, and the weekly surfaces recompute from the live master price at read time.

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

  invalidatePriceDependentSalesCaches(`master edit: ${def.master}`);
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
  // A brick kept as history after a move stays switched on (owner rule: never deactivate the old
  // brick): published months still read their pharmacies and sales through it.
  if (
    input.master === "bricks" &&
    !input.active &&
    normalizeDisplay((existingRow as Record<string, unknown>).superseded_by_brick_id) !== ""
  ) {
    return {
      success: false,
      error: "This brick is kept as history after it moved to another area, so published months keep their numbers. It stays switched on.",
    };
  }
  const wasActive = (existingRow as Record<string, unknown>).active !== false;
  if (wasActive === input.active) {
    return { success: true }; // already in the requested state
  }
  // A brick with active pharmacies on it stays switched on: they would keep pointing at a brick the
  // pickers and the map no longer show. Combining two bricks starts by moving the pharmacies.
  if (input.master === "bricks" && !input.active) {
    const activePharmacies = await supabase
      .from("source_of_sales_customer_map")
      .select("id", { count: "exact", head: true })
      .eq("brick_id", key)
      .eq("active", true);
    const refusal = brickSwitchOffRefusal(activePharmacies);
    if (refusal) return { success: false, error: refusal };
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

  invalidatePriceDependentSalesCaches(`master ${input.active ? "reactivate" : "deactivate"}: ${def.master}`);
  return { success: true };
}

/**
 * Moves a brick to the block it really belongs to ("Correct in database"), in ONE database
 * transaction: sos_relocate_brick (20260918150000).
 *
 * The brick gets a fresh "{block}-{n}" id in the target block (owner preference 2026-07-23: a
 * brick's id follows its block). The old brick is never switched off: it stays active in its old
 * area as history, renamed "<name> - <old area>" and pointing at its successor, so published months
 * keep resolving. The pharmacies, territory names, direct-order pharmacies and codes and the saved
 * AI answers move with it; a pharmacy the mapping guard holds waits for the owner on the Mapping
 * guard (owner decision 2026-09-18). The sales rows of every pharmacy that moved follow it in every
 * file that touches no locked month; the files' totals are rebuilt afterwards, one at a time
 * (brick-moves.ts), because one request cannot rebuild them all.
 *
 * The database's refusals are written for the owner (SQLSTATE P0001), so they are passed through as
 * they are. Anything else is logged and answered with a plain "nothing was moved".
 */
export async function relocateBrick(input: {
  actorLoginId: string;
  brickId: string;
  newBlockCode: string;
  /** Optional rename applied with the move (the Database Mapping screen offers both in one save). */
  newBrickName?: string;
}): Promise<{ success: true; result: BrickRelocation } | { success: false; error: string }> {
  const def = MASTER_DEFINITIONS.bricks;
  const brickId = String(input.brickId ?? "").trim();
  const newBlockCode = normalizeCode(input.newBlockCode);
  const newBrickName = typeof input.newBrickName === "string" ? input.newBrickName.trim().replace(/\s+/g, " ") : "";
  if (!brickId) return { success: false, error: "Pick the brick to move." };
  if (!newBlockCode) return { success: false, error: "Pick the block the brick belongs to." };

  const supabase = getSupabaseAdmin();
  const { data: brickRow, error: brickError } = await supabase
    .from(def.table)
    .select("brick_id, brick_name, area_code")
    .eq(def.keyColumn, brickId)
    .maybeSingle();
  if (brickError) return relocateFailure(brickError, brickId);
  if (!brickRow) return { success: false, error: "That brick is no longer in the brick master. Reload the page and try again." };
  const brick = brickRow as { area_code: string | null; brick_id: string; brick_name: string | null };
  const oldName = normalizeDisplay(brick.brick_name).replace(/\s+/g, " ");

  const { data: areaRow, error: areaError } = await supabase
    .from("source_of_sales_areas")
    .select("area_name")
    .eq("area_code", normalizeCode(brick.area_code))
    .maybeSingle();
  if (areaError) return relocateFailure(areaError, brickId);
  const oldAreaName = normalizeDisplay((areaRow as { area_name?: string | null } | null)?.area_name);

  const brickName = newBrickName || oldName;
  const candidates = historicalNameCandidates({
    brickName: oldName,
    fromAreaName: oldAreaName,
    movedOn: cairoDateLabel(new Date()),
    newBrickName: brickName,
  });
  // Brick names are unique (owner rule 2026-09-11), so the history keeps the first name no other
  // brick holds.
  const { data: takenRows, error: takenError } = await supabase
    .from(def.table)
    .select("normalized_brick_name")
    .neq(def.keyColumn, brickId)
    .in("normalized_brick_name", candidates.map((candidate) => normalizeKey(candidate)));
  if (takenError) return relocateFailure(takenError, brickId);
  const taken = new Set(((takenRows ?? []) as Array<{ normalized_brick_name: string | null }>).map((row) => row.normalized_brick_name ?? ""));
  const historicalName = candidates.find((candidate) => !taken.has(normalizeKey(candidate)));
  if (!historicalName) {
    return { success: false, error: `Every history name for ${oldName} is already taken by another brick. Rename one of them, then move it.` };
  }

  const { data, error } = await supabase.rpc("sos_relocate_brick", {
    p_actor: input.actorLoginId,
    p_block_code: newBlockCode,
    p_brick_id: brickId,
    p_brick_name: brickName,
    p_historical_name: historicalName,
    p_normalized_brick_name: normalizeKey(brickName),
    p_normalized_historical_name: normalizeKey(historicalName),
  });
  if (error) return relocateFailure(error, brickId);
  const result = parseBrickRelocation(data);
  if (!result) {
    logError("Brick move returned no result", { labels: { event: "brick_move_no_result" }, context: { brickId } });
    return { success: false, error: "The database did not say what it moved. Reload the page to see where the brick is now." };
  }

  const auditValues = { ...result, master: "bricks", source: "database_mapping_brick_move" };
  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: brickId,
    entityType: def.auditEntityType,
    newValues: { ...auditValues, brick_name: historicalName, superseded_by_brick_id: result.newBrickId },
    oldValues: { area_code: brick.area_code, brick_name: oldName },
    summary: `Database Mapping brick move — ${oldName} moved from ${result.fromAreaName} to ${result.toAreaName}; the old brick stays as history under ${historicalName}.`,
  });
  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: result.newBrickId,
    entityType: def.auditEntityType,
    newValues: { ...auditValues, moved_from_brick_id: brickId },
    summary: `Database Mapping brick move — ${result.newBrickName} created in ${result.toAreaName} (block ${result.toBlockLabel}), replacing ${oldName}.`,
  });

  invalidatePriceDependentSalesCaches("master brick move");
  return { result, success: true };
}

function relocateFailure(error: unknown, brickId: string): { success: false; error: string } {
  // The database's own refusals name the brick and say what to do; nothing else is safe to show.
  if ((error as { code?: unknown } | null)?.code === "P0001") {
    return { success: false, error: errorMessageOf(error) || "The database refused the move. Nothing was moved." };
  }
  if (isStatementTimeoutError(error)) {
    return {
      success: false,
      error: "The move took too long and was cancelled by the database. Nothing was moved. Try again in a minute.",
    };
  }
  logError("Brick move failed", { context: { brickId }, error, labels: { event: "brick_move_failed" } });
  return { success: false, error: "The brick could not be moved. Nothing was moved; try again, and if it keeps failing, report it." };
}

function cairoDateLabel(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "Africa/Cairo", year: "numeric" }).format(date);
}

function columnLabel(def: MasterDefinition, key: string) {
  return def.columns.find((column) => column.key === key)?.label ?? key;
}
