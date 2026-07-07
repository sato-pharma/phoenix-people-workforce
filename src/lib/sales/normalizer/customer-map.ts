import type ExcelJS from "exceljs";

import { writeAuditLog } from "@/lib/admin/audit";
import { invalidateSalesDashboardCache } from "@/lib/dashboard/invalidation";
import { writeMappingAudit } from "@/lib/sales/mapping-audit";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { BACKFILL_MAX_MAPPINGS, backfillCustomerRows } from "@/lib/sales/normalizer/mapping";
import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import type { CustomerBrickCorrection } from "@/lib/sales/normalizer/types";
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
  // Provenance (phase-4 migration): how the mapping was created and, for auto-applied rows, the
  // geo-validated confidence. Defaults when the columns are not present yet.
  source: string;
  confidence: number | null;
};

export async function listCustomerMap(filter?: { distributorCode?: string }): Promise<CustomerMapRow[]> {
  const supabase = getSupabaseAdmin();
  const pageSize = 1000;
  const rows: CustomerMapRow[] = [];
  let from = 0;
  for (;;) {
    let query = supabase
      .from("source_of_sales_customer_map")
      .select("distributor_code,customer_code,customer_name,address,brick_id,area_code,region_code,source")
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
        confidence: null,
        customerCode: String(r.customer_code ?? ""),
        customerName: String(r.customer_name ?? ""),
        distributorCode: String(r.distributor_code ?? ""),
        regionCode: String(r.region_code ?? ""),
        source: String(r.source ?? ""),
      });
    }
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

// Clamp UI paging params into safe bounds (pure, unit-tested). Caps page size so a huge customer
// map (21k+ rows for PS) can never be pulled into the browser in one request.
export const CUSTOMER_MAP_PAGE_MAX = 200;
export function clampPageParams(input: { limit?: number; offset?: number }): { limit: number; offset: number } {
  const rawLimit = Number(input.limit);
  const rawOffset = Number(input.offset);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), CUSTOMER_MAP_PAGE_MAX) : 50;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  return { limit, offset };
}

export type CustomerMapPage = { rows: CustomerMapRow[]; total: number; limit: number; offset: number };

// Server-side paginated + searchable view for the Mapping Database UI. Search matches customer
// code / name / address (case-insensitive). Distributor is required (the page is distributor-first).
export async function listCustomerMapPage(input: {
  distributorCode: string;
  search?: string;
  limit?: number;
  offset?: number;
  source?: string;
}): Promise<CustomerMapPage> {
  const supabase = getSupabaseAdmin();
  const distributorCode = normalizeCodeKey(input.distributorCode);
  const { limit, offset } = clampPageParams(input);
  const sourceFilter = String(input.source ?? "").trim();
  const buildQuery = (withConfidence: boolean) => {
    let query = supabase
      .from("source_of_sales_customer_map")
      .select(
        withConfidence
          ? "distributor_code,customer_code,customer_name,address,brick_id,area_code,region_code,source,confidence"
          : "distributor_code,customer_code,customer_name,address,brick_id,area_code,region_code,source",
        { count: "exact" },
      )
      .eq("active", true)
      .eq("distributor_code", distributorCode);
    if (sourceFilter) query = query.eq("source", sourceFilter);
    const search = String(input.search ?? "").trim();
    if (search) {
      const safe = search.replace(/[%,]/g, " ");
      query = query.or(`customer_code.ilike.%${safe}%,customer_name.ilike.%${safe}%,address.ilike.%${safe}%`);
    }
    return query.order("customer_code", { ascending: true }).range(offset, offset + limit - 1);
  };
  // The confidence column lands with the phase-4 migration; fall back to the base select before it.
  let result = await buildQuery(true);
  if (result.error && /confidence/i.test(result.error.message ?? "")) result = await buildQuery(false);
  if (result.error) throw new SalesWorkflowError("customer_map_list_failed", result.error.message, 500);
  const rows = ((result.data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
    address: String(r.address ?? ""),
    areaCode: String(r.area_code ?? ""),
    brickId: String(r.brick_id ?? ""),
    confidence: typeof r.confidence === "number" ? Number(r.confidence) : null,
    customerCode: String(r.customer_code ?? ""),
    customerName: String(r.customer_name ?? ""),
    distributorCode: String(r.distributor_code ?? ""),
    regionCode: String(r.region_code ?? ""),
    source: String(r.source ?? ""),
  }));
  return { rows, total: result.count ?? rows.length, limit, offset };
}

// Soft-delete a single customer→brick mapping (active=false, audited + reversible). loadCrosswalks
// and listCustomerMap both filter active=true, so the row immediately stops resolving everywhere.
export async function deleteCustomerMapRow(input: {
  actorLoginId: string;
  distributorCode: string;
  customerCode: string;
}): Promise<void> {
  const distributor_code = normalizeCodeKey(input.distributorCode);
  const customer_code = String(input.customerCode ?? "").trim();
  if (!distributor_code || !customer_code) {
    throw new SalesWorkflowError("invalid_customer_map_row", "Distributor and customer code are required.", 400);
  }
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("source_of_sales_customer_map")
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("distributor_code", distributor_code)
    .eq("customer_code", customer_code);
  if (error) throw new SalesWorkflowError("persist_failed", error.message, 500);

  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: "source_of_sales_customer_map",
    entityType: "sales_import_batch",
    newValues: { distributor_code, customer_code, source: "customer_map_delete" },
    summary: `Customer map delete — ${distributor_code} / ${customer_code} (deactivated).`,
  });
  await writeMappingAudit({ entityType: "customer_map", distributorCode: distributor_code, entityKey: customer_code, action: "delete", actor: input.actorLoginId });
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
  backfilled: number;
  backfillSkipped: boolean;
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

  // Truly-empty row → skip. The distributor is IGNORED here on purpose: the per-distributor templates
  // pre-stamp the (locked) Distrub ID on every spare row, so a blank spare row carries the distributor
  // but no customer data. Without this, each of those ~1000 spare rows would falsely block as
  // "Customer code is required" and could trip the route's hardFail (HTTP 400) on a valid upload.
  if (!custRaw && !brickKey && !name && !address) return { kind: "skip-blank" };
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

export async function importCustomerMap(input: { actorLoginId: string; file: File; defaultDistributorCode?: string; backfill?: boolean }): Promise<CustomerMapImportResult> {
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

  // Heal historical NULL-brick rows for the imported mappings. Skipped for very large imports —
  // thousands of sequential UPDATEs belong in a separate deliberate action, not an upload's tail.
  let backfilled = 0;
  const applied = upserts.length > 0 && inserted + updated > 0;
  const backfillSkipped = input.backfill === true && upserts.length > BACKFILL_MAX_MAPPINGS;
  if (input.backfill === true && applied && !backfillSkipped) {
    backfilled = await backfillCustomerRows(
      supabase,
      upserts.map((u) => ({ customer_code: u.payload.customer_code, distributor_code: u.payload.distributor_code })),
    );
  }

  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: "source_of_sales_customer_map",
    entityType: "sales_import_batch",
    newValues: { backfilled, blocked: blockedRows.length, inserted, skipped, source: "customer_map_import", totalRead, updated },
    summary: `Customer map import — ${inserted} added, ${updated} updated, ${skipped} skipped, ${blockedRows.length} blocked${backfilled ? `, ${backfilled} historical rows healed` : ""}.`,
  });

  return { backfillSkipped, backfilled, blockedRows, inserted, skipped, totalRead, updated };
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
  backfill?: boolean;
}): Promise<{ backfilled: number }> {
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
  await writeMappingAudit({
    entityType: "customer_map",
    distributorCode: String(result.payload.distributor_code),
    entityKey: String(result.payload.customer_code),
    action: "edit",
    after: { brick_id: result.payload.brick_id, area_code: result.payload.area_code, region_code: result.payload.region_code },
    actor: input.actorLoginId,
  });

  let backfilled = 0;
  if (input.backfill === true) {
    backfilled = await backfillCustomerRows(supabase, [
      { customer_code: result.payload.customer_code, distributor_code: result.payload.distributor_code },
    ]);
  }
  return { backfilled };
}

// Self-heal the customer->brick crosswalk from a LIVE upload: the sheet itself just resolved a
// customer's brick directly (direct id or territory/brick-name text, never via the stored crosswalk —
// see engine.ts's customerBrickCorrections). When that disagrees with (or is missing from) the stored
// mapping, this keeps the crosswalk in sync so future rows for that customer resolve correctly even
// when the territory text is blank or not yet a known alias. Source is "sheet-verified" so it's
// distinguishable in the Mapping Database from manual/admin-import/normalizer/auto entries. Called
// only from a CONFIRMED import commit (persistNormalizedBatch), never from an Analyze/preview pass.
export async function applyCustomerBrickCorrections(
  corrections: CustomerBrickCorrection[],
  options: { actorLoginId: string },
): Promise<{ applied: number; skipped: number }> {
  if (corrections.length === 0) return { applied: 0, skipped: 0 };

  const refs = await loadSalesReferenceData({ includeCustomerBricks: false });
  const brickById = new Map<string, BrickRef>(
    (refs.bricks ?? []).map((b) => [normalizeCodeKey(b.brickId), { areaCode: b.areaCode, brickId: b.brickId, regionCode: b.regionCode }]),
  );

  const rows: Record<string, unknown>[] = [];
  let skipped = 0;
  for (const c of corrections) {
    const brick = brickById.get(normalizeCodeKey(c.brickId));
    const customerCode = String(c.customerCode ?? "").trim();
    const distributorCode = normalizeCodeKey(c.distributorCode);
    if (!brick || !customerCode || !distributorCode) { skipped += 1; continue; }
    rows.push({
      active: true,
      area_code: brick.areaCode,
      brick_id: brick.brickId,
      customer_code: customerCode,
      distributor_code: distributorCode,
      mapped_by: options.actorLoginId,
      region_code: brick.regionCode,
      source: "sheet-verified",
    });
  }
  if (rows.length === 0) return { applied: 0, skipped };

  const supabase = getSupabaseAdmin();
  const stamp = new Date().toISOString();
  let { error } = await supabase
    .from("source_of_sales_customer_map")
    .upsert(rows.map((r) => ({ ...r, updated_at: stamp })), { onConflict: "distributor_code,customer_code" });
  if (error && /confidence|mapped_by/i.test(error.message ?? "")) {
    // Pre-migration deployment: retry without the provenance columns rather than failing the save.
    const stripped = rows.map(({ mapped_by: _m, ...rest }) => rest);
    ({ error } = await supabase
      .from("source_of_sales_customer_map")
      .upsert(stripped.map((r) => ({ ...r, updated_at: stamp })), { onConflict: "distributor_code,customer_code" }));
  }
  if (error) throw new SalesWorkflowError("persist_failed", error.message, 500);

  await writeAuditLog({
    actorLoginId: options.actorLoginId,
    entityId: "source_of_sales_customer_map",
    entityType: "sales_import_batch",
    newValues: {
      source: "sheet_verified_correction",
      count: rows.length,
      corrections: corrections.slice(0, 50).map((c) => ({
        distributor: c.distributorCode,
        customer: c.customerCode,
        brick: c.brickId,
        previousBrick: c.previousBrickId,
      })),
    },
    summary: `Sheet-verified brick correction — ${rows.length} customer${rows.length === 1 ? "" : "s"} updated from live upload data.`,
  });
  for (const c of corrections) {
    await writeMappingAudit({
      entityType: "customer_map",
      distributorCode: normalizeCodeKey(c.distributorCode),
      entityKey: String(c.customerCode ?? "").trim(),
      action: "edit",
      before: c.previousBrickId ? { brick_id: c.previousBrickId } : null,
      after: { brick_id: c.brickId },
      actor: options.actorLoginId,
    });
  }

  return { applied: rows.length, skipped };
}

// ── Historical reconciliation (explicit, admin-triggered — never automatic) ──
// The self-heal above only ever corrects the STORED customer->brick mapping going forward; it never
// touches historical rows already sitting in source_of_sales_import_rows. These two functions are a
// SEPARATE, deliberate action for when an admin wants a customer's past rows brought in line with
// their now-corrected mapping too. Always per-customer, always explicit (preview first, then apply),
// never wired into a routine upload or run in bulk across the whole customer base.

export type ReconciliationBrickCount = { brickId: string; count: number };
export type ReconciliationPreview = {
  affectedRows: number;
  affectedBatchIds: string[];
  currentBricks: ReconciliationBrickCount[];
  targetBrickId: string | null;
};

// Pure transform of the RPC's row shape — kept separate from the DB call so it's unit-testable
// without a live database, matching classifyCustomerMapRow's pattern elsewhere in this file.
export function parseReconciliationPreviewRow(row: Record<string, unknown> | null | undefined): ReconciliationPreview {
  const currentBricksObj = (row?.current_bricks ?? {}) as Record<string, unknown>;
  const currentBricks = Object.entries(currentBricksObj)
    .map(([brickId, count]) => ({ brickId, count: Number(count) }))
    .filter((entry) => Number.isFinite(entry.count))
    .sort((a, b) => b.count - a.count);
  const rawBatchIds = row?.affected_batch_ids;
  const affectedBatchIds = Array.isArray(rawBatchIds) ? rawBatchIds.map((id) => String(id)) : [];
  return {
    affectedRows: Number(row?.affected_rows ?? 0) || 0,
    affectedBatchIds,
    currentBricks,
    targetBrickId: row?.target_brick_id ? String(row.target_brick_id) : null,
  };
}

// Read-only dry-run — safe to call any time, no mutation. Shows an admin exactly what a reconcile
// would change before they commit to it: how many rows, which bricks they're currently coded to, and
// how many distinct historical batches (months) would be touched.
export async function previewHistoricalReconciliation(input: {
  distributorCode: string;
  customerCode: string;
}): Promise<ReconciliationPreview> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("sos_count_reconcilable_import_rows", {
    p_distributor: normalizeCodeKey(input.distributorCode),
    p_customer: String(input.customerCode ?? "").trim(),
  });
  if (error) throw new SalesWorkflowError("reconcile_preview_failed", error.message, 500);
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
  return parseReconciliationPreviewRow(row);
}

// The actual mutation: overwrites brick/area/region on every historical row for this customer that
// disagrees with the ACTIVE customer->brick mapping (not just NULL ones — see the migration comment).
// Refreshes every affected batch's rollups so dashboards never go stale, and audits the correction
// with a full before/after trail. Throws if any rollup refresh fails, so a partial, inconsistent
// state is never silently left in place.
export async function applyHistoricalReconciliation(input: {
  distributorCode: string;
  customerCode: string;
  actorLoginId: string;
}): Promise<{ updatedRows: number; refreshedBatches: number }> {
  const distributorCode = normalizeCodeKey(input.distributorCode);
  const customerCode = String(input.customerCode ?? "").trim();
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase.rpc("sos_reconcile_import_rows_from_customer_map", {
    p_distributor: distributorCode,
    p_customer: customerCode,
  });
  if (error) throw new SalesWorkflowError("reconcile_apply_failed", error.message, 500);
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
  const updatedRows = Number(row?.updated_rows ?? 0) || 0;
  const rawBatchIds = row?.affected_batch_ids;
  const affectedBatchIds = Array.isArray(rawBatchIds) ? rawBatchIds.map((id) => String(id)) : [];

  let refreshedBatches = 0;
  for (const batchId of affectedBatchIds) {
    const [fact, directory, roi] = await Promise.all([
      supabase.rpc("phx_refresh_sos_fact_rollup", { p_batch_id: batchId }),
      supabase.rpc("phx_refresh_sos_customer_directory_rollup", { p_batch_id: batchId }),
      supabase.rpc("phx_refresh_marketing_roi_facts", { p_batch_id: batchId }),
    ]);
    const rollupError = fact.error ?? directory.error ?? roi.error;
    if (rollupError) {
      throw new SalesWorkflowError(
        "reconcile_rollup_refresh_failed",
        `${updatedRows} historical row(s) were corrected, but rollup refresh failed for batch ${batchId}: ${rollupError.message}. Re-run the reconcile to retry the refresh.`,
        500,
      );
    }
    refreshedBatches += 1;
  }

  if (updatedRows > 0) {
    invalidateSalesDashboardCache(`historical reconciliation — ${distributorCode}/${customerCode}`);
    await writeAuditLog({
      actorLoginId: input.actorLoginId,
      entityId: "source_of_sales_import_rows",
      entityType: "sales_import_batch",
      newValues: { distributor_code: distributorCode, customer_code: customerCode, updated_rows: updatedRows, affected_batch_ids: affectedBatchIds },
      summary: `Historical reconciliation — ${updatedRows} row(s) corrected for ${distributorCode} / ${customerCode} across ${affectedBatchIds.length} batch(es).`,
    });
    await writeMappingAudit({
      entityType: "customer_map",
      distributorCode,
      entityKey: customerCode,
      action: "edit",
      after: { historical_rows_reconciled: updatedRows, batches_refreshed: affectedBatchIds.length },
      actor: input.actorLoginId,
    });
  }

  return { updatedRows, refreshedBatches };
}
