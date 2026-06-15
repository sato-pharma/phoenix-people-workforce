import type ExcelJS from "exceljs";

import { writeAuditLog } from "@/lib/admin/audit";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { excelCellText, loadExcelWorkbook } from "@/lib/uploads/exceljs-rows";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";

// The customer -> brick crosswalk (code / name / address -> brick), for the read-only "Database
// Validation" tab. Optionally filtered to one distributor. Fully paginated past PostgREST's 1000-row
// cap (the table can hold tens of thousands of rows).

export type CustomerMapRow = {
  address: string;
  areaCode: string;
  brickId: string;
  customerCode: string;
  customerName: string;
  distributorCode: string;
  regionCode: string;
};

export async function listCustomerMap(filter?: { distributorCode?: string }): Promise<CustomerMapRow[]> {
  const supabase = getSupabaseAdmin();
  const pageSize = 1000;
  const rows: CustomerMapRow[] = [];
  let from = 0;
  for (;;) {
    let query = supabase
      .from("source_of_sales_customer_map")
      .select("distributor_code,customer_code,customer_name,address,brick_id,area_code,region_code")
      .eq("active", true)
      .order("distributor_code", { ascending: true })
      .order("customer_code", { ascending: true });
    if (filter?.distributorCode) query = query.eq("distributor_code", filter.distributorCode);
    const result = await query.range(from, from + pageSize - 1);
    if (result.error) break; // tolerate (e.g. table absent pre-migration); return what we have
    const page = (result.data ?? []) as unknown as Array<Record<string, unknown>>;
    for (const r of page) {
      rows.push({
        address: String(r.address ?? ""),
        areaCode: String(r.area_code ?? ""),
        brickId: String(r.brick_id ?? ""),
        customerCode: String(r.customer_code ?? ""),
        customerName: String(r.customer_name ?? ""),
        distributorCode: String(r.distributor_code ?? ""),
        regionCode: String(r.region_code ?? ""),
      });
    }
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

// ── In-app import: download (export) → fix in Excel → re-upload to apply ──
// Mirrors the master-data import (app/api/sales/database-mapping/[master]/import) but for the
// customer→brick crosswalk: accepts the SAME sheet the export produces, validates every brick
// against the master (deriving area/region from it), and UPSERTS WITH UPDATE (so a corrected
// Brick ID overwrites the existing row — unlike saveMappings(), which only inserts new unknowns).

const KEY_SEP = "␟"; // unit-separator: cannot occur in a code, so a safe composite-key joiner
const IMPORT_CHUNK = 500;

export type CustomerMapImportBlockedRow = { key: string; reason: string; row: number };
export type CustomerMapImportResult = {
  blockedRows: CustomerMapImportBlockedRow[];
  inserted: number;
  skipped: number;
  totalRead: number;
  updated: number;
};

type BrickRef = { areaCode: string; brickId: string; regionCode: string };
export type CustomerMapClassifyContext = {
  brickById: Map<string, BrickRef>; // key = normalizeCodeKey(brickId)
  distributorCodes: Set<string>; // normalizeCodeKey(distributor code)
  seen: Set<string>; // composite key of rows already accepted/blocked this run
};
export type CustomerMapRawRow = {
  address?: string;
  brickId?: string;
  customerCode?: string;
  customerName?: string;
  distributorCode?: string;
};
export type CustomerMapClassification =
  | { kind: "skip-blank" }
  | { kind: "skipped"; reason: string }
  | { kind: "blocked"; key: string; reason: string }
  | { kind: "ok"; key: string; payload: Record<string, unknown> };

// Pure, unit-testable per-row classifier. Storage uses the canonical (uppercased) distributor code
// and the trimmed-raw customer code (so a clean round-trip of the export matches existing rows and
// updates them); area/region are ALWAYS taken from the resolved brick, never the sheet.
export function classifyCustomerMapRow(
  raw: CustomerMapRawRow,
  ctx: CustomerMapClassifyContext,
): CustomerMapClassification {
  const dist = normalizeCodeKey(raw.distributorCode);
  const custRaw = String(raw.customerCode ?? "").trim();
  const brickKey = normalizeCodeKey(raw.brickId);
  const name = String(raw.customerName ?? "").trim();
  const address = String(raw.address ?? "").trim();

  if (!dist && !custRaw && !brickKey && !name && !address) return { kind: "skip-blank" };
  if (!dist) return { kind: "blocked", key: "", reason: "Distrub ID is required." };
  if (!ctx.distributorCodes.has(dist)) {
    return { kind: "blocked", key: `${dist} / ${custRaw}`, reason: `Distributor "${dist}" is not in the distributors master.` };
  }
  if (!custRaw) return { kind: "blocked", key: `${dist} / `, reason: "Customer code is required." };

  const key = `${dist}${KEY_SEP}${custRaw}`;
  if (ctx.seen.has(key)) return { kind: "blocked", key: `${dist} / ${custRaw}`, reason: "Duplicate customer key in file." };
  ctx.seen.add(key);

  if (!brickKey) return { kind: "skipped", reason: "no brick yet" }; // legitimate not-yet-mapped row
  const brick = ctx.brickById.get(brickKey);
  if (!brick) return { kind: "blocked", key: `${dist} / ${custRaw}`, reason: `Brick ID "${String(raw.brickId ?? "").trim()}" not found in brick master.` };

  return {
    kind: "ok",
    key,
    payload: {
      active: true,
      address: address || null,
      area_code: brick.areaCode,
      brick_id: brick.brickId,
      customer_code: custRaw,
      customer_name: name || null,
      distributor_code: dist,
      region_code: brick.regionCode,
      source: "admin-import",
    },
  };
}

const HEADER_ALIASES: Record<string, string> = {
  // distributor_code
  "distrub id": "distributor_code", "distributor": "distributor_code", "distributor id": "distributor_code", "distributor_code": "distributor_code", "distrib id": "distributor_code",
  // customer_code
  "customer code": "customer_code", "customer_code": "customer_code", customer: "customer_code",
  // customer_name
  "customer name": "customer_name", "customer_name": "customer_name",
  address: "address",
  // brick_id
  "brick id": "brick_id", "brick_id": "brick_id", brick: "brick_id",
};

function locateCustomerMapSheet(
  workbook: ExcelJS.Workbook,
  distributorOptional = false,
): { columnMap: Map<string, number>; headerRow: number; sheet: ExcelJS.Worksheet } | null {
  for (const sheet of workbook.worksheets) {
    const maxRow = Math.min(sheet.rowCount, 12);
    for (let rowNumber = 1; rowNumber <= maxRow; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const columnMap = new Map<string, number>();
      for (let column = 1; column <= sheet.columnCount; column += 1) {
        const header = excelCellText(row.getCell(column).value).toLowerCase();
        const key = HEADER_ALIASES[header];
        if (key && !columnMap.has(key)) columnMap.set(key, column);
      }
      // When a default distributor is supplied, the Distrub ID column is optional (each row inherits the
      // default), so a sheet with just Customer code + Brick ID is still recognized.
      const hasDistributor = columnMap.has("distributor_code") || distributorOptional;
      if (hasDistributor && columnMap.has("customer_code") && columnMap.has("brick_id")) {
        return { columnMap, headerRow: rowNumber, sheet };
      }
    }
  }
  return null;
}

async function loadExistingCustomerKeys(supabase: ReturnType<typeof getSupabaseAdmin>): Promise<Set<string>> {
  const keys = new Set<string>();
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const result = await supabase
      .from("source_of_sales_customer_map")
      .select("distributor_code,customer_code")
      .range(from, from + pageSize - 1);
    if (result.error) break;
    const page = (result.data ?? []) as Array<{ customer_code?: string; distributor_code?: string }>;
    for (const r of page) keys.add(`${normalizeCodeKey(r.distributor_code)}${KEY_SEP}${String(r.customer_code ?? "").trim()}`);
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return keys;
}

export async function importCustomerMap(input: { actorLoginId: string; file: File; defaultDistributorCode?: string }): Promise<CustomerMapImportResult> {
  const validation = validateSpreadsheetFile(input.file, {
    ...xlsxSpreadsheetValidation,
    emptyError: "invalid_customer_map_file",
    emptyMessage: "The customer map file is empty.",
    tooLargeError: "customer_map_file_too_large",
    tooLargeMessage: "The customer map file exceeds the 10MB upload limit.",
    unsupportedError: "unsupported_customer_map_file_type",
    unsupportedMessage: "Upload the customer map in .xlsx format.",
  });
  if (!validation.ok) throw new SalesWorkflowError(validation.error, validation.message, validation.status);

  // When the caller selected a distributor (the per-distributor Customer/Brick template), every row that
  // leaves Distrub ID blank inherits it — so a sheet downloaded for "PS" doesn't need PS typed 15k times.
  const defaultDistributor = String(input.defaultDistributorCode ?? "").trim();

  const workbook = await loadExcelWorkbook(await input.file.arrayBuffer());
  const located = locateCustomerMapSheet(workbook, Boolean(defaultDistributor));
  if (!located) {
    throw new SalesWorkflowError(
      "unmatched_customer_map_sheet",
      "No sheet matching the customer map template was found. Required headers: Customer code and Brick ID (plus Distrub ID unless a distributor is selected).",
      400,
    );
  }
  const { sheet, columnMap, headerRow } = located;

  const refs = await loadSalesReferenceData();
  const brickById = new Map<string, BrickRef>(
    (refs.bricks ?? []).map((b) => [normalizeCodeKey(b.brickId), { areaCode: b.areaCode, brickId: b.brickId, regionCode: b.regionCode }]),
  );
  const distributorCodes = new Set(refs.distributors.map((d) => normalizeCodeKey(d.code)));

  const supabase = getSupabaseAdmin();
  const existing = await loadExistingCustomerKeys(supabase);
  const ctx: CustomerMapClassifyContext = { brickById, distributorCodes, seen: new Set() };

  const blockedRows: CustomerMapImportBlockedRow[] = [];
  const upserts: { isUpdate: boolean; payload: Record<string, unknown>; row: number }[] = [];
  let totalRead = 0;
  let skipped = 0;

  const cell = (row: ExcelJS.Row, key: string) => {
    const column = columnMap.get(key);
    return column ? excelCellText(row.getCell(column).value) : "";
  };

  for (let rowNumber = headerRow + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const result = classifyCustomerMapRow(
      {
        address: cell(row, "address"),
        brickId: cell(row, "brick_id"),
        customerCode: cell(row, "customer_code"),
        customerName: cell(row, "customer_name"),
        distributorCode: cell(row, "distributor_code") || defaultDistributor,
      },
      ctx,
    );
    if (result.kind === "skip-blank") continue;
    totalRead += 1;
    if (result.kind === "skipped") { skipped += 1; continue; }
    if (result.kind === "blocked") { blockedRows.push({ key: result.key, reason: result.reason, row: rowNumber }); continue; }
    upserts.push({ isUpdate: existing.has(result.key), payload: result.payload, row: rowNumber });
  }

  let inserted = 0;
  let updated = 0;
  const countOk = (entry: { isUpdate: boolean }) => { if (entry.isUpdate) updated += 1; else inserted += 1; };
  for (let index = 0; index < upserts.length; index += IMPORT_CHUNK) {
    const chunk = upserts.slice(index, index + IMPORT_CHUNK);
    const stamp = new Date().toISOString();
    const { error } = await supabase
      .from("source_of_sales_customer_map")
      .upsert(chunk.map((c) => ({ ...c.payload, updated_at: stamp })), { onConflict: "distributor_code,customer_code" });
    if (!error) { chunk.forEach(countOk); continue; }
    for (const entry of chunk) {
      const result = await supabase
        .from("source_of_sales_customer_map")
        .upsert({ ...entry.payload, updated_at: new Date().toISOString() }, { onConflict: "distributor_code,customer_code" });
      if (result.error) blockedRows.push({ key: String(entry.payload.distributor_code), reason: result.error.message, row: entry.row });
      else countOk(entry);
    }
  }

  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: "source_of_sales_customer_map",
    entityType: "sales_import_batch",
    newValues: { blocked: blockedRows.length, inserted, skipped, source: "customer_map_import", totalRead, updated },
    summary: `Customer map import — ${inserted} added, ${updated} updated, ${skipped} skipped, ${blockedRows.length} blocked.`,
  });

  return { blockedRows, inserted, skipped, totalRead, updated };
}

// Add/update ONE customer->brick mapping from the inline "add by field" form (vs the bulk upload).
// Validates the brick + distributor via the shared classifier, then upserts (with name/address) and audits.
export async function addCustomerMapRow(input: {
  actorLoginId: string;
  distributorCode: string;
  customerCode: string;
  customerName?: string;
  address?: string;
  brickId: string;
}): Promise<void> {
  const refs = await loadSalesReferenceData({ includeCustomerBricks: false });
  const brickById = new Map<string, BrickRef>(
    (refs.bricks ?? []).map((b) => [normalizeCodeKey(b.brickId), { areaCode: b.areaCode, brickId: b.brickId, regionCode: b.regionCode }]),
  );
  const distributorCodes = new Set(refs.distributors.map((d) => normalizeCodeKey(d.code)));
  const ctx: CustomerMapClassifyContext = { brickById, distributorCodes, seen: new Set() };
  const result = classifyCustomerMapRow(
    {
      address: input.address,
      brickId: input.brickId,
      customerCode: input.customerCode,
      customerName: input.customerName,
      distributorCode: input.distributorCode,
    },
    ctx,
  );
  if (result.kind === "skip-blank" || result.kind === "skipped") {
    throw new SalesWorkflowError("invalid_customer_map_row", "Customer code and a valid Brick ID are required.", 400);
  }
  if (result.kind === "blocked") throw new SalesWorkflowError("invalid_customer_map_row", result.reason, 400);

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("source_of_sales_customer_map")
    .upsert({ ...result.payload, updated_at: new Date().toISOString() }, { onConflict: "distributor_code,customer_code" });
  if (error) throw new SalesWorkflowError("persist_failed", error.message, 500);

  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: "source_of_sales_customer_map",
    entityType: "sales_import_batch",
    newValues: { ...result.payload, source: "customer_map_add" },
    summary: `Customer map add — ${String(result.payload.distributor_code)} / ${String(result.payload.customer_code)} -> ${String(result.payload.brick_id)}.`,
  });
}
