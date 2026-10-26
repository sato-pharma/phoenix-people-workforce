import type ExcelJS from "exceljs";

import { writeAuditLog } from "@/lib/admin/audit";
import { invalidateSalesDashboardCache } from "@/lib/dashboard/invalidation";
import { logError, logWarning } from "@/lib/observability/log";
import { writeMappingAudit, writeMappingAuditBatch, type MappingAuditEntry } from "@/lib/sales/mapping-audit";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { BACKFILL_MAX_MAPPINGS, backfillCustomerRows } from "@/lib/sales/normalizer/mapping";
import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import type { CustomerBrickCorrection } from "@/lib/sales/normalizer/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { excelCellText, loadExcelWorkbook } from "@/lib/uploads/exceljs-rows";
import { ilikeAnyFilter } from "@/lib/supabase/search-filter";
import { spreadsheetTooLargeMessage, validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";
import { writeStoreSplitNetForBatch } from "@/lib/sales/attribution-store-split-refresh";

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

// Active customers per distributor, counted exactly as listCustomerMap filters them (active rows, the
// code as given). A count that fails to load is left out, never read as zero.
export async function countCustomerMapByDistributor(codes: string[]): Promise<Map<string, number>> {
  const supabase = getSupabaseAdmin();
  const counts = new Map<string, number>();
  await Promise.all(
    [...new Set(codes)].map(async (code) => {
      try {
        const { count, error } = await supabase
          .from("source_of_sales_customer_map")
          .select("*", { count: "exact", head: true })
          .eq("active", true)
          .eq("distributor_code", code);
        if (!error && count !== null) counts.set(code, count);
      } catch { /* left out: unknown, not zero */ }
    }),
  );
  return counts;
}

// The distributor the Database Mapping customer map opens on: the first, in the header grid's order,
// that has customers. Measured on production 2026-09-18, the grid's first distributor (chimipharm) had
// none, so the map opened empty on every visit. With no count loaded it opens on the first, as before.
export function pickOpeningCustomerDistributor(codes: string[], counts: Map<string, number>): string {
  return codes.find((code) => (counts.get(code) ?? 0) > 0) ?? codes[0] ?? "ALL";
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
      const filter = ilikeAnyFilter(["customer_code", "customer_name", "address"], search);
      if (filter) query = query.or(filter);
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
// Brick ID overwrites the existing row — unlike saveMappings() called by a MINING path, which is
// passed onExistingCustomer:"learn" and only inserts customers the crosswalk has never seen).

const KEY_SEP = "␟"; // unit-separator: cannot occur in a code, so a safe composite-key joiner
const IMPORT_CHUNK = 500;

export type CustomerMapImportBlockedRow = { key: string; reason: string; row: number };

// How many blocked rows one import's history record keeps. The largest import ever run blocked 969;
// the cap and the per-field lengths only bound a pathological sheet, so the record itself — which
// writeAuditLog sends with a 3-second timeout and drops silently on failure — always saves.
export const CUSTOMER_MAP_BLOCKED_ROWS_KEPT = 5000;
const BLOCKED_KEY_MAX = 200;
const BLOCKED_REASON_MAX = 400;

/**
 * Every import's blocked rows, kept on the import's own history record in row order. The screen
 * shows them only until the page reloads, and the record used to keep just the count, so the 969
 * rows the 6 July 2026 import blocked could never be read again. `blocked` on the record stays the
 * full count; the note says when a sheet blocked more rows than the record keeps.
 */
export function customerMapImportBlockedRecord(blockedRows: CustomerMapImportBlockedRow[]): {
  note: string;
  values: { blockedRows: CustomerMapImportBlockedRow[]; blockedRowsKept: number };
} {
  const kept = [...blockedRows]
    .sort((a, b) => a.row - b.row)
    .slice(0, CUSTOMER_MAP_BLOCKED_ROWS_KEPT)
    .map((b) => ({ key: b.key.slice(0, BLOCKED_KEY_MAX), reason: b.reason.slice(0, BLOCKED_REASON_MAX), row: b.row }));
  const note = blockedRows.length === 0
    ? ""
    : kept.length === blockedRows.length
      ? " (each listed in this record)"
      : ` (the first ${kept.length} listed in this record)`;
  return { note, values: { blockedRows: kept, blockedRowsKept: kept.length } };
}

export type CustomerMapImportResult = {
  /** How many of the landed rows reached the per-row mapping history. */
  audited: number;
  blockedRows: CustomerMapImportBlockedRow[];
  inserted: number;
  skipped: number;
  totalRead: number;
  updated: number;
  backfilled: number;
  backfillSkipped: boolean;
};

export type BrickRef = { areaCode: string; brickId: string; regionCode: string };
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

/** What the crosswalk already holds for a key, for deciding whether an upload is a real re-mapping. */
export type ExistingCustomerMapping = {
  address: string;
  areaCode: string;
  brickId: string;
  customerName: string;
  source: string;
};

/**
 * AN UPLOAD THAT MOVES NOTHING MUST NOT RELABEL WHERE THE MAPPING CAME FROM.
 *
 * `classifyCustomerMapRow` stamps every payload `admin-import`, which is right for a row this upload
 * actually maps. It was wrong for a row it merely re-states: the export → fix in Excel → re-upload
 * loop carries back every row the operator did not touch, so one upload rewrote the provenance of
 * thousands of rows that had not moved an inch — an owner ruling, a sheet-verified decision or a
 * geo-validated normalizer match, all reading "Admin import" afterwards in the Master Map's "Where
 * this came from" column.
 *
 * NOTHING CAUGHT IT. The bulk path writes ONE summary audit row (counts only, no before/after), and
 * The retired Mapping Guard's trigger deliberately ignored a write that left `brick_id` and `area_code`
 * alone — correctly, since 3,633 of 3,702 edits in a normal day are exactly that. So the erasure was
 * invisible at every layer. Its fingerprints are still in production: 121 rows carry a `confidence`
 * this path never writes and 32 name another writer in `mapped_by`, both left by whoever mapped the
 * row before the label was overwritten.
 *
 * So the rule is the guard's own rule: **if the mapping did not move, the provenance does not
 * change.** A row whose brick or area DOES change is a real re-mapping and is stamped `admin-import`
 * honestly — and if that overwrites a decision of his, the guard holds it for him to see.
 *
 * Name and address still update either way; correcting a spelling is not a re-mapping.
 */
export function customerMapUpsertPayload(
  payload: Record<string, unknown>,
  existing: ExistingCustomerMapping | undefined,
): Record<string, unknown> {
  if (!existing) return payload;
  const sameBrick = normalizeCodeKey(existing.brickId) === normalizeCodeKey(String(payload.brick_id ?? ""));
  const sameArea = normalizeCodeKey(existing.areaCode) === normalizeCodeKey(String(payload.area_code ?? ""));
  if (!sameBrick || !sameArea) return payload;
  // Drop `source` entirely rather than echoing the old value back: the column is NOT NULL, and an
  // upsert leaves a column it was not given alone. Callers must therefore keep these rows in their
  // own batch — PostgREST needs one consistent key set per request.
  const { source: _dropped, ...keepsItsProvenance } = payload;
  return keepsItsProvenance;
}

const asText = (value: unknown) => String(value ?? "").trim();

/**
 * One audit row per mapping the upload actually changed — or null for a row it merely carried back.
 *
 * THE BULK PATH HAD NO PER-ROW HISTORY AT ALL. It wrote a single summary line of counts, so an
 * upload that re-pointed 2,000 pharmacies left nothing saying WHICH 2,000 or what they were before.
 * Every by-hand edit beside it has been fully audited since C1. The database guard added on
 * 2026-09-10 closed part of this from below — it records every write that MOVES a customer, from any
 * writer — but it cannot name the person, because `phoenix.actor` is a session setting and this
 * application reaches Postgres over pooled HTTP requests that cannot carry one. So the two halves are
 * complementary and both are needed: the trigger says what moved, this says who uploaded it.
 *
 * SILENCE IS THE POINT FOR AN UNCHANGED ROW. The export → fix → re-upload loop returns every
 * untouched row, so auditing all of them would bury the handful that matter under fifteen thousand
 * that did not change — the same reasoning that makes the guard ignore a non-move.
 *
 * A NAME OR ADDRESS CORRECTION IS AUDITED THOUGH IT IS NOT A RE-MAPPING. It is still an edit someone
 * made to a row, it is still worth being able to see, and the guard deliberately never records it.
 */
export function customerMapAuditEntry(
  payload: Record<string, unknown>,
  existing: ExistingCustomerMapping | undefined,
  actor: string,
): MappingAuditEntry | null {
  const after = {
    address: asText(payload.address),
    area_code: asText(payload.area_code),
    brick_id: asText(payload.brick_id),
    customer_name: asText(payload.customer_name),
  };
  const entityKey = asText(payload.customer_code);
  const distributorCode = asText(payload.distributor_code);

  if (!existing) {
    return { action: "add", actor, after, distributorCode, entityKey, entityType: "customer_map" };
  }

  const before = {
    address: asText(existing.address),
    area_code: asText(existing.areaCode),
    brick_id: asText(existing.brickId),
    customer_name: asText(existing.customerName),
  };
  const unchanged = before.address === after.address
    && normalizeCodeKey(before.area_code) === normalizeCodeKey(after.area_code)
    && normalizeCodeKey(before.brick_id) === normalizeCodeKey(after.brick_id)
    && before.customer_name === after.customer_name;
  if (unchanged) return null;

  return { action: "edit", actor, after, before, distributorCode, entityKey, entityType: "customer_map" };
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

async function loadExistingCustomerMappings(
  supabase: ReturnType<typeof getSupabaseAdmin>,
): Promise<Map<string, ExistingCustomerMapping>> {
  const keys = new Map<string, ExistingCustomerMapping>();
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const result = await supabase
      .from("source_of_sales_customer_map")
      // The CURRENT row comes back too, not just its key: customerMapUpsertPayload needs the mapping
      // to tell a real re-mapping from a row the upload merely carried back, and customerMapAuditEntry
      // needs the name and address to write a before/after worth reading.
      .select("distributor_code,customer_code,brick_id,area_code,source,customer_name,address")
      // ORDER BY id: offset pages must be stably ordered or rows silently vanish (#1446).
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (result.error) break;
    const page = (result.data ?? []) as Array<{
      address?: string; area_code?: string; brick_id?: string; customer_code?: string;
      customer_name?: string; distributor_code?: string; source?: string;
    }>;
    for (const r of page) {
      keys.set(`${normalizeCodeKey(r.distributor_code)}${KEY_SEP}${String(r.customer_code ?? "").trim()}`, {
        address: String(r.address ?? ""),
        areaCode: String(r.area_code ?? ""),
        brickId: String(r.brick_id ?? ""),
        customerName: String(r.customer_name ?? ""),
        source: String(r.source ?? ""),
      });
    }
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
    tooLargeMessage: spreadsheetTooLargeMessage("The customer map file"),
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

  // Bricks and distributors only — the mappings already stored come from loadExistingCustomerMappings.
  const refs = await loadSalesReferenceData({ includeCustomerBricks: false });
  const brickById = new Map<string, BrickRef>(
    (refs.bricks ?? []).map((b) => [normalizeCodeKey(b.brickId), { areaCode: b.areaCode, brickId: b.brickId, regionCode: b.regionCode }]),
  );
  const distributorCodes = new Set(refs.distributors.map((d) => normalizeCodeKey(d.code)));

  const supabase = getSupabaseAdmin();
  const existing = await loadExistingCustomerMappings(supabase);
  const ctx: CustomerMapClassifyContext = { brickById, distributorCodes, seen: new Set() };

  const blockedRows: CustomerMapImportBlockedRow[] = [];
  const upserts: { audit: MappingAuditEntry | null; isUpdate: boolean; payload: Record<string, unknown>; row: number }[] = [];
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
    const before = existing.get(result.key);
    upserts.push({
      // Built from the CLASSIFIER's payload, before customerMapUpsertPayload strips `source` from an
      // unchanged row — the audit describes what the upload asked for, not the request shape.
      audit: customerMapAuditEntry(result.payload, before, input.actorLoginId),
      isUpdate: existing.has(result.key),
      payload: customerMapUpsertPayload(result.payload, before),
      row: rowNumber,
    });
  }

  let inserted = 0;
  let updated = 0;
  // Only rows that actually LANDED get a history entry. A row the database rejected did not happen.
  const auditEntries: MappingAuditEntry[] = [];
  const countOk = (entry: { audit: MappingAuditEntry | null; isUpdate: boolean }) => {
    if (entry.isUpdate) updated += 1; else inserted += 1;
    if (entry.audit) auditEntries.push(entry.audit);
  };

  // TWO BATCHES, NOT ONE. Rows that keep their provenance carry no `source` key, and PostgREST needs
  // one consistent key set per request — mixing the two shapes in a single call writes a null source
  // onto half of them, which the NOT NULL column would reject only if it noticed.
  const stamped = upserts.filter((entry) => "source" in entry.payload);
  const keepsProvenance = upserts.filter((entry) => !("source" in entry.payload));

  for (const batch of [stamped, keepsProvenance]) {
    for (let index = 0; index < batch.length; index += IMPORT_CHUNK) {
      const chunk = batch.slice(index, index + IMPORT_CHUNK);
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
  }

  // Heal historical NULL-brick rows for the imported mappings. Skipped for very large imports —
  // thousands of sequential UPDATEs belong in a separate deliberate action, not an upload's tail.
  let backfilled = 0;
  const applied = upserts.length > 0 && inserted + updated > 0;
  const backfillSkipped = input.backfill === true && upserts.length > BACKFILL_MAX_MAPPINGS;
  if (input.backfill === true && applied && !backfillSkipped) {
    backfilled = await backfillCustomerRows(
      supabase,
      upserts.map((u) => ({ brick_id: u.payload.brick_id, customer_code: u.payload.customer_code, distributor_code: u.payload.distributor_code })),
    );
  }

  // The per-row history, written AFTER the upserts so nothing is recorded that did not land. The
  // summary row below stays: it is the batch header this trail hangs from.
  const audited = await writeMappingAuditBatch(auditEntries);

  // The blocked rows ride on the summary record itself, so the list outlives the page that showed it.
  const blockedRecord = customerMapImportBlockedRecord(blockedRows);
  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: "source_of_sales_customer_map",
    entityType: "sales_import_batch",
    newValues: { audited, backfilled, blocked: blockedRows.length, ...blockedRecord.values, inserted, skipped, source: "customer_map_import", totalRead, updated },
    summary: `Customer map import — ${inserted} added, ${updated} updated, ${skipped} skipped, ${blockedRows.length} blocked${blockedRecord.note}${backfilled ? `, ${backfilled} historical rows healed` : ""}, ${audited} recorded in the mapping history.`,
  });

  return { audited, backfillSkipped, backfilled, blockedRows, inserted, skipped, totalRead, updated };
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
      { brick_id: result.payload.brick_id, customer_code: result.payload.customer_code, distributor_code: result.payload.distributor_code },
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
): Promise<{ applied: number; skipped: number; skippedOwnerVerified: number }> {
  if (corrections.length === 0) return { applied: 0, skipped: 0, skippedOwnerVerified: 0 };

  const refs = await loadSalesReferenceData({ includeCustomerBricks: false });
  const brickById = new Map<string, BrickRef>(
    (refs.bricks ?? []).map((b) => [normalizeCodeKey(b.brickId), { areaCode: b.areaCode, brickId: b.brickId, regionCode: b.regionCode }]),
  );

  const supabase = getSupabaseAdmin();
  const ownerVerifiedKeys = await loadOwnerVerifiedMapKeys(supabase, corrections);

  const { rows, skipped, skippedOwnerVerified } =
    selectCorrectionRows(corrections, brickById, ownerVerifiedKeys, options.actorLoginId);
  if (rows.length === 0) return { applied: 0, skipped, skippedOwnerVerified };

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
    summary: `Sheet-verified brick correction — ${rows.length} customer${rows.length === 1 ? "" : "s"} updated from live upload data`
      + (skippedOwnerVerified > 0 ? `; ${skippedOwnerVerified} left untouched (owner-verified, confidence=100).` : "."),
  });
  // Audit only what was actually written. A correction skipped as owner-verified changed nothing,
  // so recording an "edit" for it would put a change in the history that never happened.
  const writtenKeys = new Set(rows.map((r) => `${String(r.distributor_code)} ${String(r.customer_code)}`));
  for (const c of corrections) {
    const distributorCode = normalizeCodeKey(c.distributorCode);
    const customerCode = String(c.customerCode ?? "").trim();
    if (!writtenKeys.has(`${distributorCode} ${customerCode}`)) continue;
    await writeMappingAudit({
      entityType: "customer_map",
      distributorCode,
      entityKey: customerCode,
      action: "edit",
      before: c.previousBrickId ? { brick_id: c.previousBrickId } : null,
      after: { brick_id: c.brickId },
      actor: options.actorLoginId,
    });
  }

  // The address moved these pharmacies: their EARLIER sales follow them (owner, 2026-10-13 — "fix and
  // heal historical and future"). Best-effort: the map is already right, and a failure is logged.
  try {
    await healAddressCorrectionHistory(supabase, addressCorrectionsToHeal(corrections, writtenKeys));
  } catch (error) {
    logWarning("Address-moved pharmacies were re-mapped, but their earlier sales could not be re-pointed.", { error });
  }

  return { applied: rows.length, skipped, skippedOwnerVerified };
}

// At most this many pharmacies per upload re-point their history inline; the rest wait for the next
// upload that names them. After the 13 Oct 2026 address remap the importer finds almost none.
export const ADDRESS_HEAL_MAX_PAIRS = 2000;

/**
 * Which written corrections re-point the customer's history: only those the ADDRESS decided, and
 * only those actually written (an owner ruling is never overwritten, so it never heals either). A
 * label-only correction keeps the old behaviour — the label is not geography (Ibn Sina's Brick Name
 * is a sales grouping), so it updates the map for the future and leaves history alone.
 */
export function addressCorrectionsToHeal(
  corrections: CustomerBrickCorrection[],
  writtenKeys: ReadonlySet<string>,
): CustomerBrickCorrection[] {
  const seen = new Set<string>();
  const out: CustomerBrickCorrection[] = [];
  for (const c of corrections) {
    if (c.source !== "address") continue;
    const key = `${normalizeCodeKey(c.distributorCode)} ${String(c.customerCode ?? "").trim()}`;
    if (!writtenKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= ADDRESS_HEAL_MAX_PAIRS) break;
  }
  return out;
}

/**
 * Re-point every earlier sales row of these pharmacies onto the brick the map now holds — every
 * month except a file touching a locked closing, which `sos_reconcile_import_rows_from_customer_map`
 * leaves whole — and hand each touched file to the brick-move queue. That queue's 20-minute clock
 * (`phoenix-brick-move-drain`) rebuilds the file's totals AND settles its months' store-split net,
 * which an inline rebuild here would make the upload wait for.
 */
export async function healAddressCorrectionHistory(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  corrections: CustomerBrickCorrection[],
): Promise<{ files: number; pairs: number; rows: number }> {
  // 🔴 EACH CORRECTION'S FILES ARE QUEUED THE MOMENT IT LANDS (audit P4-06, 2026-10-23). The queue
  // used to be written once, after the whole loop — up to 2,000 sequential re-points — so a crash,
  // a deploy or one failed call part-way left every re-pointed row already moved and NOT ONE file
  // queued: the totals kept crediting the old bricks and nothing ever rebuilt them, with no alarm.
  // Now a correction's re-point and its queue entries are written back to back, so whatever has
  // moved is always already queued, and a queue write that fails stops the loop loudly.
  // Since 20261026021700 the RPC itself queues every file it moved, in the same transaction as the
  // move, which closes the gap between the two calls. This write stays: the same idempotent upsert,
  // it lands on that row whenever the pharmacy's previous brick is the brick its rows left, and it
  // covers the files on any database the migration has not reached yet (a deploy applies none).
  const queued = new Map<string, { batch_id: string; moved_rows: number; old_brick_id: string }>();
  let rows = 0;
  for (const c of corrections) {
    const { data, error } = await supabase.rpc("sos_reconcile_import_rows_from_customer_map", {
      p_customer: String(c.customerCode ?? "").trim(),
      p_distributor: normalizeCodeKey(c.distributorCode),
    });
    if (error) throw error;
    const record = (Array.isArray(data) ? data[0] : data) as { affected_batch_ids?: unknown; updated_rows?: unknown } | null;
    const moved = Number(record?.updated_rows ?? 0) || 0;
    rows += moved;
    // The queue is keyed by a brick that must exist: the one the pharmacy left, else the one it joined.
    const oldBrickId = normalizeCodeKey(c.previousBrickId ?? "") || normalizeCodeKey(c.brickId);
    const touched: { batch_id: string; moved_rows: number; old_brick_id: string }[] = [];
    for (const id of Array.isArray(record?.affected_batch_ids) ? record.affected_batch_ids : []) {
      const batchId = String(id ?? "").trim();
      if (!batchId) continue;
      const key = `${oldBrickId} ${batchId}`;
      const entry = queued.get(key) ?? { batch_id: batchId, moved_rows: 0, old_brick_id: oldBrickId };
      // The RPC reports files, not rows per file; one per pharmacy is a lower bound and only labels the queue.
      entry.moved_rows += 1;
      queued.set(key, entry);
      touched.push(entry);
    }
    if (touched.length === 0) continue;
    // A fresh `moved_at` on every write: the drain finishes an entry only when the stamp it read is
    // still the stamp on the row, so a file re-touched while it was being rebuilt is rebuilt again.
    const { error: queueError } = await supabase
      .from("source_of_sales_brick_move_files")
      .upsert(
        touched.map((q) => ({ ...q, moved_at: new Date().toISOString(), refresh_started_at: null, refreshed_at: null })),
        { onConflict: "old_brick_id,batch_id" },
      );
    if (queueError) {
      logError("An address correction moved earlier sales but its files could not be queued for a rebuild.", {
        context: { batchIds: touched.map((q) => q.batch_id), customerCode: String(c.customerCode ?? ""), distributorCode: normalizeCodeKey(c.distributorCode) },
        error: queueError,
        labels: { event: "sos_address_correction_queue_failed" },
      });
      throw queueError;
    }
  }
  return { files: new Set([...queued.values()].map((q) => q.batch_id)).size, pairs: corrections.length, rows };
}

// Decide which self-heal corrections actually get written. Pure, so the guard below is testable
// without a database: given the resolved bricks and the set of owner-verified keys, it returns the
// upsert payload plus why anything was left out.
export function selectCorrectionRows(
  corrections: CustomerBrickCorrection[],
  brickById: Map<string, BrickRef>,
  ownerVerifiedKeys: ReadonlySet<string>,
  actorLoginId: string,
): { rows: Record<string, unknown>[]; skipped: number; skippedOwnerVerified: number } {
  const rows: Record<string, unknown>[] = [];
  let skipped = 0;
  let skippedOwnerVerified = 0;
  for (const c of corrections) {
    const brick = brickById.get(normalizeCodeKey(c.brickId));
    const customerCode = String(c.customerCode ?? "").trim();
    const distributorCode = normalizeCodeKey(c.distributorCode);
    if (!brick || !customerCode || !distributorCode) { skipped += 1; continue; }
    // An owner ruling (confidence=100) is absolute and must outlive the monthly upload.
    // resolvers.ts already lets such a mapping win at RESOLVE time, but this self-heal writes
    // straight to the crosswalk, and its upsert payload carries brick/area/region but NOT
    // confidence — so it would swap the owner's brick for the sheet's while LEAVING confidence=100
    // in place: a row that still claims to be owner-verified but no longer is. Skip those outright.
    if (ownerVerifiedKeys.has(`${distributorCode} ${customerCode}`)) { skippedOwnerVerified += 1; continue; }
    rows.push({
      active: true,
      area_code: brick.areaCode,
      brick_id: brick.brickId,
      customer_code: customerCode,
      distributor_code: distributorCode,
      mapped_by: actorLoginId,
      region_code: brick.regionCode,
      source: "sheet-verified",
    });
  }
  return { rows, skipped, skippedOwnerVerified };
}

// Which (distributor, customer) pairs among these corrections are owner-verified (confidence=100)?
// Keyed exactly as the upsert keys them, so the guard and the write agree on identity.
//
// 🔴 IT FAILS CLOSED. An empty set means "nobody is owner-verified", so `selectCorrectionRows` skips
// nothing and every sheet correction lands — overwriting the owner's own area rulings while
// reporting `skippedOwnerVerified: 0`, which reads exactly like "there were no rulings to protect".
// Until 2026-09-30 ANY read error returned that empty set, so one timeout, one network blip or one
// slow chunk of the 200-code `in` list was enough to switch the guard off for a whole run, silently.
// Measured on production that day: 6,944 active rows across 6,357 customers sit at confidence 100,
// and this runs ONLY from a confirmed import commit — so it was live exactly when real sales were
// being written. An owner ruling binds at confidence 100; losing that guard is not a degradation the
// caller may take without being told.
//
// The ONE tolerated failure is the degradation this function was written for: a deployment whose
// `customer_map` predates the `confidence` column, which never could tell an owner ruling from
// anything else. That is matched on an error naming that column — the same test the upsert below
// already uses to retry without the provenance columns — and it is dead on production, where
// `confidence` exists. Every other error throws.
export async function loadOwnerVerifiedMapKeys(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  corrections: CustomerBrickCorrection[],
): Promise<Set<string>> {
  const keys = new Set<string>();
  const customerCodes = [...new Set(
    corrections.map((c) => String(c.customerCode ?? "").trim()).filter(Boolean),
  )];
  if (customerCodes.length === 0) return keys;

  // Chunked: the correction list can be in the thousands and PostgREST puts the `in` list in the URL.
  const CHUNK = 200;
  for (let i = 0; i < customerCodes.length; i += CHUNK) {
    const { data, error } = await supabase
      .from("source_of_sales_customer_map")
      .select("distributor_code,customer_code,confidence")
      .eq("active", true)
      .eq("confidence", 100)
      .in("customer_code", customerCodes.slice(i, i + CHUNK));
    if (error) {
      if (/confidence/i.test(error.message ?? "")) return new Set<string>();
      throw new SalesWorkflowError(
        "owner_ruling_guard_unavailable",
        `Could not read the owner-verified mappings, so the sheet's corrections were not applied — `
          + `applying them blind would overwrite area rulings made at confidence 100. ${error.message}`,
        500,
      );
    }
    for (const row of (data ?? []) as { distributor_code?: unknown; customer_code?: unknown }[]) {
      keys.add(`${normalizeCodeKey(String(row.distributor_code ?? ""))} ${String(row.customer_code ?? "").trim()}`);
    }
  }
  return keys;
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

// Rebuilds every total one sales file feeds, each after the totals it reads. Shared by the history
// correction below and by a brick move (src/lib/sales/master-data/brick-moves.ts), so the two can
// never rebuild different sets. `failure` turns a failed step into the caller's own error; the
// steps name themselves ("channel rollup refresh failed") so each caller keeps its own wording.
export async function refreshBatchRollups(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  batchId: string,
  failure: (step: string, message: string) => Error,
): Promise<void> {
  const [fact, directory, roi] = await Promise.all([
    supabase.rpc("phx_refresh_sos_fact_rollup", { p_batch_id: batchId }),
    supabase.rpc("phx_refresh_sos_customer_directory_rollup", { p_batch_id: batchId }),
    supabase.rpc("phx_refresh_marketing_roi_facts", { p_batch_id: batchId }),
  ]);
  const rollupError = fact.error ?? directory.error ?? roi.error;
  if (rollupError) throw failure("rollup refresh failed", rollupError.message);
  // The Monthly-Closing channel totals rollup rides the same trio — it reads the fact + directory
  // rollups just refreshed above, so it must run AFTER them, never inside the Promise.all.
  const channel = await supabase.rpc("phx_refresh_sos_channel_rollup", { p_batch_id: batchId });
  if (channel.error) throw failure("channel rollup refresh failed", channel.error.message);
  // The distributor×product rollup rides the same trio — after the fact rollup it reads.
  const distProduct = await supabase.rpc("phx_refresh_sos_distributor_product_rollup", { p_batch_id: batchId });
  if (distProduct.error) throw failure("distributor-product rollup refresh failed", distProduct.error.message);
  // The wholesaler city split net FIRST — au.f_monthly_attribution reads it, and a correction or a
  // brick move that shifted rows between areas is exactly when it goes stale.
  try {
    await writeStoreSplitNetForBatch(supabase, batchId);
  } catch (splitError) {
    const message = splitError instanceof Error ? splitError.message : String(splitError);
    throw failure("the wholesaler split net failed to rebuild", message);
  }
  // The sales-vs-target attribution rollup rides the same trio — after the fact rollup it reads.
  const attribution = await supabase.rpc("phx_refresh_monthly_attribution", { p_batch_id: batchId });
  if (attribution.error) throw failure("attribution rollup refresh failed", attribution.error.message);
  // The import summaries — what the Source of Sales DASHBOARD reads. Until 2026-08-30 no
  // refresh for them existed: they were written once at insert and never again, so the correction
  // rebuilt every number the Monthly Closing reads and none of the numbers the dashboard reads.
  // Correcting a row left the executive screen permanently stale with no marker anywhere
  // (July 2026 was 653,299.13 EGP short), while the correction's own comment claimed "dashboards
  // never go stale".
  const summaries = await supabase.rpc("phx_refresh_sos_import_summaries", { p_batch_id: batchId });
  if (summaries.error) throw failure("import summary refresh failed", summaries.error.message);
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
    await refreshBatchRollups(
      supabase,
      batchId,
      (step, message) =>
        new SalesWorkflowError(
          "reconcile_rollup_refresh_failed",
          `${updatedRows} historical row(s) were corrected, but ${step} for batch ${batchId}: ${message}. Re-run the reconcile to retry the refresh.`,
          500,
        ),
    );
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
