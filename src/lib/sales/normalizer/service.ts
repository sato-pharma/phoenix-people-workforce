import ExcelJS from "exceljs";

import { systemIdentity } from "@/config/system-settings";
import { invalidateSalesDashboardCache } from "@/lib/dashboard/invalidation";
import { logError } from "@/lib/observability/log";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { collectUnmappedProducts, computeBrickCoverage, countBrickDrift, saveBrickCoverageSnapshot } from "@/lib/sales/import-coverage";
import { assertNotADuplicateUpload, repriceableUploadRow, totalValueAtPeriod } from "@/lib/sales/import-duplicate-guard";
import { loadMovedBricks } from "@/lib/sales/master-data/moved-bricks";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { loadProductPeriodPrices } from "@/lib/sales/product-period-price";
import type { MappingReferences } from "@/lib/sales/normalizer/brick-area";
import { resolveDistributorProfile } from "@/lib/sales/normalizer/distributor-profile-store";
import { applyCustomerBrickCorrections } from "@/lib/sales/normalizer/customer-map";
import { pickBestSheet } from "@/lib/sales/normalizer/engine";
import { HEADER_SCAN_ROWS } from "@/lib/sales/normalizer/header-normalize";
import { saveMappings, type MappingInput } from "@/lib/sales/normalizer/mapping";
import { PHOENIX_TEMPLATE_CODE, PHOENIX_TEMPLATE_NAME } from "@/lib/sales/normalizer/phoenix-template-code";
import { RAW_DISTRIBUTOR_PROFILES } from "@/lib/sales/normalizer/profiles";
import { recognizeWorkbookFiles } from "@/lib/sales/normalizer/multi-file";
import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import type { CodedRow, NormalizeResult } from "@/lib/sales/normalizer/types";
import { RECOGNITION_ENGINE_VERSION, dominantPeriod, normalizeUploadedFile, recognitionErrorMessage, recognizeWorkbookParts, summarizePreview, type NormalizeFileResult, type NormalizePart, type NormalizePreview } from "@/lib/sales/recognize";
import { decodeFileRow } from "@/lib/sales/sales-upload-files";
import { finalizeSosBatchAndAuditSupersede } from "@/lib/sales/source-of-sales-batch-supersede";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { writeStoreSplitNetForBatch } from "@/lib/sales/attribution-store-split-refresh";
import { holdImportTailRepair, releaseImportTailRepair } from "@/lib/sales/import-tail-repair";

// Recognition lives in `@/lib/sales/recognize` (the single Sales recognition spine). Re-exported
// here so existing import sites (`@/lib/sales/normalizer/service`) keep working unchanged.
export { normalizeUploadedFile, recognitionErrorMessage, recognizeWorkbookParts, summarizePreview };
export type { NormalizeFileResult, NormalizePart, NormalizePreview };

export type { MappingBrickReference, MappingReferences } from "@/lib/sales/normalizer/brick-area";

const IMPORT_FINALIZING_REASON = "Import is still being finalized. Retry the upload if this remains blocked.";

export async function listMappingReferences(): Promise<MappingReferences> {
  // Only the product + brick name lists are needed for the mapping dropdowns — skip the (large)
  // customer->brick crosswalk that loadSalesReferenceData() pages by default.
  const [refs, movedBricks] = await Promise.all([
    loadSalesReferenceData({ includeCustomerBricks: false }),
    loadMovedBricks(),
  ]);
  return {
    // Every picker these feed maps something NEW, so a brick kept only as history after a move is
    // left out; movedBricks says where each one went, for a pick made before the move.
    bricks: (refs.bricks ?? [])
      .filter((b) => !movedBricks.has(b.brickId))
      .map((b) => ({ areaName: b.areaName ?? "", id: b.brickId, name: b.brickName, regionName: b.regionName ?? "" }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    movedBricks: Object.fromEntries(movedBricks),
    products: refs.products.map((p) => ({ code: p.productCode, name: p.productName })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// Bootstrap / self-service "Learn from a cleaned file": a previously hand-cleaned sheet carries the
// distributor's RAW columns AND the added Phoenix columns (Product ID, Brick ID) side by side. Using
// the distributor's profile to know which raw columns hold the item + territory, we mine every
// raw → Phoenix pair and write them as aliases (validated, insert-if-absent). One upload teaches the
// dictionary hundreds of mappings at once, so future raw files auto-code.
const PHOENIX_PRODUCT_COLUMNS = ["Product ID"];
const PHOENIX_BRICK_COLUMNS = ["Brick ID", "Brick ID2"];

export async function learnFromCleanedFile(distributorCode: string, file: File): Promise<{ saved: number; skipped: number; invalid: number; scannedRows: number }> {
  const profile = await resolveDistributorProfile(distributorCode);
  if (!profile) throw new Error(`No normalizer profile for distributor ${distributorCode}.`);
  const [refs, buffer] = await Promise.all([loadSalesReferenceData({ includeCustomerBricks: false }), file.arrayBuffer()]);
  const productCodes = new Set(refs.products.map((p) => normalizeCodeKey(p.productCode)));
  const brickIds = new Set((refs.bricks ?? []).map((b) => normalizeCodeKey(b.brickId)));

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  // Pick the richest worksheet (not just the first) and scan deep, consistent with the importer engine.
  const sheet = pickBestSheet(workbook, profile);
  if (!sheet) return { invalid: 0, saved: 0, scannedRows: 0, skipped: 0 };

  let headerRow = 1;
  for (let r = 1; r <= Math.min(sheet.rowCount, HEADER_SCAN_ROWS); r += 1) { let n = 0; sheet.getRow(r).eachCell({ includeEmpty: false }, () => { n += 1; }); if (n >= 3) { headerRow = r; break; } }
  const col = new Map<string, number>();
  sheet.getRow(headerRow).eachCell({ includeEmpty: false }, (cell, i) => { const k = String(cell.text ?? "").trim().toLowerCase(); if (k && !col.has(k)) col.set(k, i); });
  const colOf = (names: string[]) => { for (const n of names) { const i = col.get(n.trim().toLowerCase()); if (i) return i; } return 0; };
  const text = (row: ExcelJS.Row, i: number) => (i ? String(row.getCell(i)?.text ?? "").trim() : "");
  // The first non-empty value across a profile's columns, as the importer engine reads them (firstValue).
  const firstText = (row: ExcelJS.Row, cols: number[]) => { for (const i of cols) { const v = text(row, i); if (v) return v; } return ""; };

  const productIdCol = colOf(PHOENIX_PRODUCT_COLUMNS);
  const brickIdCol = colOf(PHOENIX_BRICK_COLUMNS);
  const rawProductCols = profile.productColumns.map((n) => colOf([n])).filter(Boolean); // code + name both → product
  const primaryTerritory = profile.territoryColumns?.[0] ? colOf([profile.territoryColumns[0]]) : 0; // most specific only
  const customerCol = profile.customerCodeColumns?.[0] ? colOf([profile.customerCodeColumns[0]]) : 0;
  const customerNameCols = (profile.customerNameColumns ?? []).map((n) => colOf([n])).filter(Boolean);
  const customerAddressCols = (profile.customerAddressColumns ?? []).map((n) => colOf([n])).filter(Boolean);

  const seen = new Set<string>();
  const mappings: MappingInput[] = [];
  let scannedRows = 0;
  for (let r = headerRow + 1; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    let any = false; row.eachCell({ includeEmpty: false }, () => { any = true; });
    if (!any) continue;
    scannedRows += 1;
    const pid = normalizeCodeKey(text(row, productIdCol));
    if (pid && productCodes.has(pid)) {
      for (const ci of rawProductCols) { const raw = text(row, ci); const key = `p:${raw.toLowerCase()}`; if (raw && !seen.has(key)) { seen.add(key); mappings.push({ code: pid, distributorCode, raw, type: "product" }); } }
    }
    const bid = normalizeCodeKey(text(row, brickIdCol));
    if (bid && brickIds.has(bid)) {
      if (primaryTerritory) {
        const raw = text(row, primaryTerritory); const key = `t:${raw.toLowerCase()}`;
        if (raw && !seen.has(key)) { seen.add(key); mappings.push({ code: bid, raw, type: "territory" }); }
      }
      if (customerCol) {
        const raw = text(row, customerCol); const key = `c:${raw.toLowerCase()}`;
        // The pharmacy's name and address travel with its mapping, stored only where blank.
        if (raw && !seen.has(key)) { seen.add(key); mappings.push({ address: firstText(row, customerAddressCols), code: bid, distributorCode, name: firstText(row, customerNameCols), raw, type: "customer" }); }
      }
    }
  }
  // "learn": this is a teaching upload, and its own contract above says insert-if-absent. A sheet
  // cleaned weeks ago must not silently overrule a mapping corrected since — correcting one is what
  // the mapping screen is for.
  const result = await saveMappings(mappings, { onExistingCustomer: "learn" });
  return { ...result, scannedRows };
}

// Read EVERY matching import row, paging past PostgREST's 1000-row default cap. Without this, a mine
// over 84k rows silently truncates to the first 1000 — only a handful of distributors learned anything.
async function selectAllImportRows(columns: string, distributorCode: string | undefined, notNull: string[]): Promise<Array<Record<string, unknown>>> {
  const supabase = getSupabaseAdmin();
  const pageSize = 1000;
  const rows: Array<Record<string, unknown>> = [];
  let from = 0;
  for (;;) {
    let q = supabase.from("source_of_sales_import_rows").select(columns).order("id", { ascending: true }).range(from, from + pageSize - 1);
    for (const col of notNull) q = q.not(col, "is", null);
    if (distributorCode) q = q.eq("distributor_code", distributorCode);
    const result = await q;
    if (result.error) throw new Error(`Failed to read import rows: ${result.error.message}`);
    const page = (result.data ?? []) as unknown as Array<Record<string, unknown>>;
    rows.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

// Mine every import_rows record for product_name→product_code and client_code→brick_id pairs and
// write them as aliases. Runs per-distributor or across all distributors. Fully paginated (reads all
// rows, not just the first 1000) and the upserts are chunked so a large distributor never sends one
// oversized request.
//
// TEACHES, NEVER RE-TEACHES. This fires unattended after every validated import, so it must only
// ever fill gaps: customer mappings go in with onExistingCustomer "learn", which leaves every row
// already in the crosswalk exactly as it is. Until 2026-08-30 it upserted ON CONFLICT DO UPDATE
// instead, and since a customer's FIRST historical row won the scan, each import quietly rewound
// hand-made owner rulings to whatever the oldest sheet had said — 417 of 418 owner-verified
// mappings, 4 of them onto a different brick. Bringing history INTO line with a corrected mapping is
// a separate, explicit, preview-then-apply action (applyHistoricalReconciliation), never a
// side effect of an upload.
export async function learnFromImportHistory(distributorCode?: string): Promise<{ saved: number; skipped: number; invalid: number; scannedRows: number }> {
  const [productRows, customerRows] = await Promise.all([
    selectAllImportRows("distributor_code,product_name,product_code", distributorCode, ["product_name", "product_code"]),
    selectAllImportRows("distributor_code,client_code,brick_id,client_name,client_address", distributorCode, ["client_code", "brick_id"]),
  ]);

  const seenProd = new Set<string>();
  const custByKey = new Map<string, MappingInput>();
  const mappings: MappingInput[] = [];
  let scannedRows = 0;

  for (const row of productRows) {
    scannedRows += 1;
    const raw = String(row.product_name ?? "").trim();
    const code = String(row.product_code ?? "").trim();
    const dist = String(row.distributor_code ?? "").trim();
    if (!raw || !code || !dist || code.toUpperCase() === "IGNORE") continue;
    const key = `${dist}\x00${raw.toLowerCase()}\x00${code}`;
    if (!seenProd.has(key)) { seenProd.add(key); mappings.push({ type: "product", raw, code, distributorCode: dist }); }
  }
  for (const row of customerRows) {
    scannedRows += 1;
    const clientCode = String(row.client_code ?? "").trim();
    const brick = String(row.brick_id ?? "").trim();
    const dist = String(row.distributor_code ?? "").trim();
    if (!clientCode || !brick || !dist) continue;
    // LAST row wins, not first. selectAllImportRows pages in ascending `id` order and `id` is a
    // bigint identity, so the last row a customer appears in is genuinely the most recent sheet that
    // named them — the one that reflects where they sit now. Only ever reached for a customer with
    // no crosswalk row at all, so this decides how an UNKNOWN customer is first learned, never how a
    // known one is revised. The pharmacy's name and address come from that SAME row, never an earlier
    // one: EP-PHS sends one client code for different pharmacies at once, so a name taken from another
    // row can belong to another business. They are stored only where the new mapping's fields are blank.
    custByKey.set(`${dist}\x00${clientCode}`, {
      type: "customer",
      raw: clientCode,
      code: brick,
      distributorCode: dist,
      name: String(row.client_name ?? "").trim(),
      address: String(row.client_address ?? "").trim(),
    });
  }
  mappings.push(...custByKey.values());

  if (mappings.length === 0) return { saved: 0, skipped: 0, invalid: 0, scannedRows };
  // Chunk the upserts so one big distributor never sends a single oversized request.
  const CHUNK = 1000;
  let saved = 0, skipped = 0, invalid = 0;
  for (let i = 0; i < mappings.length; i += CHUNK) {
    const r = await saveMappings(mappings.slice(i, i + CHUNK), { onExistingCustomer: "learn" });
    saved += r.saved; skipped += r.skipped; invalid += r.invalid;
  }
  return { saved, skipped, invalid, scannedRows };
}

export type NormalizerDistributorOption = { code: string; name: string };

export function listNormalizerDistributors(): NormalizerDistributorOption[] {
  return RAW_DISTRIBUTOR_PROFILES.map((p) => ({ code: p.distributorCode, name: p.distributorName }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The Source Normalizer's picker: the Phoenix template first, then every distributor by name.
 *
 * Deliberately separate from listNormalizerDistributors(), whose other caller (the Sales Upload
 * page) feeds the list straight into `profiledDistributorCodes` — the template sentinel is not a
 * profiled distributor and must never appear there.
 */
export function listNormalizerSourceOptions(): NormalizerDistributorOption[] {
  return [{ code: PHOENIX_TEMPLATE_CODE, name: PHOENIX_TEMPLATE_NAME }, ...listNormalizerDistributors()];
}

// ── Coded XLSX (the format the user produces by hand today; Phoenix-branded) ──

// "Discount%" carries the discount fraction the engine read off the raw sheet. It is CARRIED, not
// applied: since 2026-09-07 both the engine and the Source-of-Sales importer value a row at
// Qty x factory_price, so the two agree without either multiplying by it. It maps to the
// NORMALIZER_TEMPLATE.discountField in monthly-distributor-import.ts.
export const CODED_HEADERS = [
  "Distrub ID", "Region ID", "Area ID", "Brick ID", "Product ID", "Product Name",
  "Qty", "B. Qty", "Value", "Discount%", "Invoice Date", "Customer", "Customer Name", "Customer Address", "Official Line",
] as const;

// Takes only what it writes, so the Source Normalizer can hand it the rows of SEVERAL distributors
// at once for one downloadable coded sheet. Every coded row carries its own "Distrub ID", so a
// mixed sheet is as readable as a single-distributor one — the IMPORT still runs per distributor.
//
// `fileNames` is every sheet the rows were read from, when several were chosen together: their row
// numbers are shifted per file (sales-upload-files.ts), so the "Needs mapping" tab then names the file
// beside each row's own number instead of printing the shifted one.
export function buildCodedWorkbook(result: Pick<NormalizeResult, "coded" | "exceptions">, fileNames: readonly string[] = []): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemIdentity.appName;
  const sheet = workbook.addWorksheet("Coded");
  const header = sheet.addRow(CODED_HEADERS as unknown as string[]);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.eachCell((cell) => { cell.fill = { fgColor: { argb: "FF0B0B0B" }, pattern: "solid", type: "pattern" }; });
  result.coded.forEach((r) => {
    sheet.addRow([
      r.distributorCode, r.regionCode, r.areaCode, r.brickId, r.productCode, r.productName,
      r.qty, r.bonusQty, r.value, r.discount,
      // THE "Invoice Date" COLUMN MUST CARRY THE DAY, NOT THE PERIOD.
      //
      // Two fields one letter apart, meaning different things, and the names are INVERTED between
      // the two modules — which is what hid this:
      //   normalizer  `invoiceDate` = periodFrom(...) -> "2026-04"   `invoiceDay` = dateFrom(...) -> "2026-04-17"
      //   importer    `invoicePeriod` = the period                   `invoiceDate` = the DAY
      //
      // This cell was written with `r.invoiceDate`, the PERIOD. `buildCodedBuffer` feeds this sheet
      // straight back into the Source-of-Sales validator for the one-click "Import (validated)"
      // path, and that importer derives BOTH values from this single column. Measured:
      // `resolveInvoiceDate("2026-04", …, "2026-04")` returns **"2026-04-01"** — its ISO branch
      // needs three groups so the period falls through, and the row lands stamped on the FIRST OF
      // THE MONTH. Every row. A whole month of invoices collapsing onto day 1 is not a visible
      // error; it is a plausible-looking date that silently destroys day-level attribution.
      //
      // ⚠ THIS IS A LATENT DEFECT, NOT THE ONE THAT DAMAGED APRIL–JUNE. Do not conflate them.
      // The 126,321 rows across 2026-04..06 with a NULL invoice_date came from the OTHER path
      // (`buildNormalizedImportRows`) before it was fixed on 2026-08-05 in c6a39cbd3 — their
      // `raw_row` is `{}`, which this round-trip could never produce. That fix holds: July and
      // August carry 33 and 31 distinct days with only 5.2%/3.1% on the 1st. This path is simply
      // not the one currently in use — but it is still reachable, and it would stamp day 1.
      //
      // Writing the DAY fixes it with no schema, template or parser change: the column is matched
      // by NAME and its meaning is unchanged — it is finally given the value its own heading
      // promises, and `invoicePeriod("2026-04-17")` still yields the same period as before.
      //
      // The fallback preserves behaviour for a row whose source had no usable date: the period is
      // written, and the importer resolves day 1 from it exactly as it does today.
      r.invoiceDay ?? r.invoiceDate,
      r.clientCode ?? "", r.clientName ?? "", r.clientAddress ?? "", r.officialLine,
    ]);
  });
  // Second sheet: the unmapped rows the user still needs to map once.
  if (result.exceptions.length > 0) {
    const ex = workbook.addWorksheet("Needs mapping");
    if (fileNames.length > 1) {
      ex.addRow(["File", "Row", "Reason", "Raw product", "Raw territory", "Raw customer"]).font = { bold: true };
      result.exceptions.forEach((e) => {
        const { fileIndex, rawRowNumber } = decodeFileRow(e.rawRowNumber);
        ex.addRow([fileNames[fileIndex] ?? `File ${fileIndex + 1}`, rawRowNumber, e.reason, e.rawProduct, e.rawTerritory, e.rawCustomerCode]);
      });
    } else {
      ex.addRow(["Row", "Reason", "Raw product", "Raw territory", "Raw customer"]).font = { bold: true };
      result.exceptions.forEach((e) => ex.addRow([e.rawRowNumber, e.reason, e.rawProduct, e.rawTerritory, e.rawCustomerCode]));
    }
  }
  for (let c = 1; c <= CODED_HEADERS.length; c += 1) sheet.getColumn(c).width = 16;
  return workbook.xlsx.writeBuffer();
}

// Normalize a raw distributor file and return its coded XLSX as an in-memory buffer — used by the
// one-click "Import (validated)" path so the coded sheet can be fed straight into the Source-of-Sales
// validator without writing a temp file.
// `distributorCode` comes back RESOLVED: for a Phoenix-template upload the caller passed a sentinel
// and the sheet named the real distributor, so the caller must use the returned code (never the one
// it passed) when it files the batch.
export async function buildCodedBuffer(distributorCode: string, file: File): Promise<CodedPart> {
  const normalized = await normalizeUploadedFile(distributorCode, file);
  if (normalized.status !== "ok") throw new SalesWorkflowError("normalizer_unreadable", recognitionErrorMessage(normalized), 422);
  const buffer = await buildCodedWorkbook(normalized.result);
  return {
    buffer,
    distributorCode: normalized.distributorCode,
    distributorName: normalized.distributorName,
    period: normalized.period,
    result: normalized.result,
  };
}

export type CodedPart = { buffer: ExcelJS.Buffer; distributorCode: string; distributorName: string; period: string | null; result: NormalizeResult };

/**
 * The same thing, one entry per distributor and month — what the Source Normalizer uses.
 *
 * A distributor's own export yields exactly one; a Phoenix template can yield several, and so can
 * several sheets of one distributor chosen together when they span months (multi-file.ts) — each is a
 * batch of its own, carrying the sheets it was read from. Built one after another rather than all at
 * once: a month can be a hundred thousand rows, and holding every part's workbook in memory together
 * is how a 16 GB machine runs out of it.
 */
export async function buildCodedFileParts(distributorCode: string, files: readonly File[]): Promise<{ fileNames: string[]; parts: Array<CodedPart & { fileNames: string[] }> }> {
  const recognized = await recognizeWorkbookFiles(distributorCode, files);
  if (recognized.status !== "ok") throw new SalesWorkflowError("normalizer_unreadable", recognitionErrorMessage(recognized), 422);
  const parts: Array<CodedPart & { fileNames: string[] }> = [];
  for (const part of recognized.parts) {
    parts.push({
      buffer: await buildCodedWorkbook(part.result, recognized.fileNames),
      distributorCode: part.distributorCode,
      distributorName: part.distributorName,
      fileNames: part.fileNames,
      period: part.period,
      result: part.result,
    });
  }
  return { fileNames: recognized.fileNames, parts };
}

// ── Direct import of coded rows (bypasses templates — rows are already coded + validated) ──

// Build the row objects persisted to source_of_sales_import_rows. Kept pure (no DB) so the column
// shape can be unit-tested against the live schema. It MUST mirror insertSourceOfSalesRows in
// monthly-distributor-import.ts: only block_code + brick_id are stored, never block_name/brick_name —
// the table has no such columns (they live on source_of_sales_bricks), and brick display names are
// resolved live from the master in loadSourceOfSalesDashboard. Writing them made PostgREST reject
// (or silently drop) the entire "Import (validated)" batch.
export function buildNormalizedImportRows(rows: CodedRow[], batchId: string) {
  return rows.map((r, index) => ({
    area_code: r.areaCode,
    area_name: r.areaName,
    batch_id: batchId,
    block_code: "",
    brick_id: r.brickId,
    // The engine already resolved this from the profile's address columns. It used to be written as
    // a literal null, which discarded it — and made client_address null on 100% of 294,445 rows for
    // all 15 distributors, while client_name (one line down, same mechanism) was 100% populated.
    // The emptiness read as "the distributors do not send an address"; it was never stored.
    //
    // This branch fixed the same bug independently, as `r.clientAddress ?? null`. Resolved to main's
    // form: CodedRow.clientAddress is `string | null` and never undefined, so the two are identical
    // in behaviour, and this spelling is the one insertSourceOfSalesRows in
    // monthly-distributor-import.ts already uses — the two persist paths must agree.
    client_address: r.clientAddress,
    client_code: r.clientCode,
    client_name: r.clientName,
    row_number: index + 1,
    distributor_code: r.distributorCode,
    invoice_period: r.invoiceDate,
    // The real date, not just the month. Omitting it left 96% of production rows dateless and made
    // a mislabelled source file (an "April" folder holding May invoices) invisible in the data.
    invoice_date: r.invoiceDay ?? null,
    region_name: r.regionName,
    region_code: r.regionCode,
    product_name: r.productName,
    product_code: r.productCode,
    official_line: r.officialLine,
    qty: Number.isFinite(r.qty) ? r.qty : 0,
    bonus_qty: Number.isFinite(r.bonusQty) ? r.bonusQty : 0,
    discount: Number.isFinite(r.discount) ? r.discount : 0,
    value: Number.isFinite(r.value) ? r.value : 0,
    is_direct: r.isDirect,
    validation_state: "valid",
    validation_issues: [],
    // The source row, keyed by the file's own headings — the audit trail this column exists for.
    // It was a literal {} here while the other import path (insertSourceOfSalesRows) stored the real
    // thing, so 282,215 of 294,445 rows carry no record of what their distributor actually sent.
    // Kept tolerant of a row built before rawRow existed rather than writing undefined, which
    // PostgREST would reject for a NOT NULL jsonb column and fail the whole batch.
    raw_row: r.rawRow ?? {},
  }));
}

type NormalizedSummaryRow = {
  batch_id: string;
  group_type: "line" | "region" | "area" | "product" | "brick";
  group_key: string;
  group_label: string;
  group_code: string | null;
  official_line: string | null;
  row_count: number;
  total_qty: number;
  total_bonus_qty: number;
  total_value: number;
};

type SummaryAccumulator = Omit<NormalizedSummaryRow, "batch_id">;

function addSummary(
  summaries: Map<string, SummaryAccumulator>,
  key: string,
  shape: Pick<SummaryAccumulator, "group_type" | "group_key" | "group_label" | "group_code" | "official_line">,
  row: CodedRow,
) {
  const existing = summaries.get(key) ?? {
    ...shape,
    row_count: 0,
    total_qty: 0,
    total_bonus_qty: 0,
    total_value: 0,
  };
  existing.row_count += 1;
  existing.total_qty += Number.isFinite(row.qty) ? row.qty : 0;
  existing.total_bonus_qty += Number.isFinite(row.bonusQty) ? row.bonusQty : 0;
  existing.total_value += Number.isFinite(row.value) ? row.value : 0;
  summaries.set(key, existing);
}

export function buildNormalizedSummaryRows(rows: CodedRow[], batchId: string): NormalizedSummaryRow[] {
  const summaries = new Map<string, SummaryAccumulator>();

  for (const row of rows) {
    const line = row.officialLine || "";
    addSummary(summaries, `line:${line}`, { group_code: null, group_key: line, group_label: line, group_type: "line", official_line: line }, row);

    addSummary(
      summaries,
      `region:${row.regionCode}|${row.regionName}`,
      { group_code: row.regionCode, group_key: `${row.regionCode}|${row.regionName}`, group_label: row.regionName, group_type: "region", official_line: null },
      row,
    );

    addSummary(
      summaries,
      `product:${row.productCode}|${row.productName}|${line}`,
      { group_code: row.productCode, group_key: `${row.productCode}|${row.productName}|${line}`, group_label: row.productName, group_type: "product", official_line: line },
      row,
    );

    if (row.isDirect) continue;

    addSummary(
      summaries,
      `area:${row.areaCode}|${row.areaName}|${row.regionCode}`,
      { group_code: row.areaCode, group_key: `${row.areaCode}|${row.areaName}|${row.regionCode}`, group_label: row.areaName, group_type: "area", official_line: row.regionName || row.regionCode },
      row,
    );

    addSummary(
      summaries,
      `brick:${row.brickId}|${row.brickName}|${row.areaCode}|${row.regionCode}`,
      { group_code: row.brickId, group_key: `${row.brickId}|${row.brickName}|${row.areaCode}|${row.regionCode}`, group_label: row.brickName, group_type: "brick", official_line: row.areaName || row.areaCode },
      row,
    );
  }

  return [...summaries.values()].map((summary) => ({
    ...summary,
    batch_id: batchId,
    total_bonus_qty: Number(summary.total_bonus_qty.toFixed(6)),
    total_qty: Number(summary.total_qty.toFixed(6)),
    total_value: Number(summary.total_value.toFixed(6)),
  }));
}

export async function persistNormalizedBatch(input: {
  distributorCode: string;
  distributorName: string;
  fileName: string;
  result: NormalizeResult;
  uploadedBy: string;
  // Explicit period (the caller's single source of truth). When omitted, falls back to the dominant
  // period (legacy callers). The new Sales Upload commit ALWAYS passes this so a user-picked period
  // is honored and replace/insert target the same month.
  period?: string;
}): Promise<{ batchId: string; period: string | null; importedRows: number }> {
  const supabase = getSupabaseAdmin();
  const { coded } = input.result;
  const period = input.period ?? dominantPeriod(coded);
  // only rows in the chosen period are imported (one batch = one month, like the importer)
  const rows = coded.filter((r) => r.invoiceDate === period);
  const totalQty = rows.reduce((s, r) => s + (Number.isFinite(r.qty) ? r.qty : 0), 0);
  const totalBonus = rows.reduce((s, r) => s + (Number.isFinite(r.bonusQty) ? r.bonusQty : 0), 0);
  const totalValue = rows.reduce((s, r) => s + (Number.isFinite(r.value) ? r.value : 0), 0);

  // The same workbook already loaded under another period: refuse before the batch row exists, with
  // exactly the figures the insert below stores (see import-duplicate-guard.ts). Each stored batch is
  // compared on its own month's price basis, so a file re-dated across a reprice still matches.
  const prices = await loadProductPeriodPrices();
  const repriceable = rows.map((r) =>
    repriceableUploadRow({
      distributorCode: input.distributorCode,
      isDirect: r.isDirect,
      period: r.invoiceDate,
      productCode: r.productCode,
      value: r.value,
    }),
  );
  await assertNotADuplicateUpload({
    distributorCode: input.distributorCode,
    fileName: input.fileName,
    period,
    totalRows: rows.length,
    totalQty: Number(totalQty.toFixed(6)),
    totalValue: Number(totalValue.toFixed(6)),
    totalValueAt: (atPeriod) => totalValueAtPeriod(repriceable, prices, atPeriod),
  });

  const batchInsert = await supabase
    .from("source_of_sales_import_batches")
    .insert({
      distributor_code: input.distributorCode,
      distributor_name: input.distributorName,
      template_key: "normalizer",
      file_name: input.fileName,
      sheet_name: "Coded",
      period,
      status: "pending",
      total_rows: rows.length,
      importable_rows: rows.length,
      failed_rows: 0,
      warning_rows: input.result.exceptions.length,
      total_qty: Number(totalQty.toFixed(6)),
      total_bonus_qty: Number(totalBonus.toFixed(6)),
      total_value: Number(totalValue.toFixed(6)),
      // C3 reconciliation breakdown + C5 lineage (coded = importable_rows, blocked = failed_rows).
      rows_ignored: input.result.summary.ignored,
      rows_blank: input.result.summary.blankCustomerSkipped,
      recognition_engine_version: RECOGNITION_ENGINE_VERSION,
      blocking_reasons: [IMPORT_FINALIZING_REASON],
      uploaded_by: input.uploadedBy,
    })
    .select("id")
    .single();
  if (batchInsert.error) throw batchInsert.error;
  const batchId = String(batchInsert.data.id);

  const inserts = buildNormalizedImportRows(rows, batchId);
  for (let i = 0; i < inserts.length; i += 500) {
    const { error } = await supabase.from("source_of_sales_import_rows").insert(inserts.slice(i, i + 500));
    if (error) throw error;
  }

  // RECONCILIATION GATE: what we meant to write must equal what is actually there.
  //
  // The chunked inserts above throw on error, which catches a failed chunk — but not a chunk that
  // succeeds while landing fewer rows than it was given (a policy filter, a partial write, a
  // silently-dropped row). Nothing downstream would notice: the batch records `total_rows` from the
  // in-memory array, so a short table still reports a full, healthy import. Every sales figure
  // derived from it would then be quietly low, exactly like the 2026-06 mapping loss.
  //
  // Counting is cheap next to the insert we just did, and this is the last moment the intended
  // number is still known.
  const { count: persistedRows, error: persistedError } = await supabase
    .from("source_of_sales_import_rows")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", batchId);
  if (persistedError) throw persistedError;
  if ((persistedRows ?? 0) !== inserts.length) {
    // Leave the batch pending + blocked rather than deleting anything: the rows stay on disk for
    // diagnosis, and a blocked batch cannot be superseded into the live rollups.
    await supabase
      .from("source_of_sales_import_batches")
      .update({
        status: "blocked",
        blocking_reasons: [
          `Row reconciliation failed — ${inserts.length} row(s) sent, ${persistedRows ?? 0} stored. The import was NOT applied.`,
        ],
      })
      .eq("id", batchId);
    logError("SoS import row reconciliation failed", {
      labels: {
        event: "sos_import_row_reconciliation_failed",
        batchId,
        distributorCode: input.distributorCode,
        sentRows: String(inserts.length),
        storedRows: String(persistedRows ?? 0),
      },
    });
    throw new Error(
      `Import blocked: ${inserts.length} row(s) were sent but ${persistedRows ?? 0} were stored. Nothing was applied — re-run the upload.`,
    );
  }

  const summaries = buildNormalizedSummaryRows(rows, batchId);
  for (let i = 0; i < summaries.length; i += 500) {
    const { error } = await supabase.from("source_of_sales_import_summaries").insert(summaries.slice(i, i + 500));
    if (error) throw error;
  }

  // 🔴 THE REPAIR NOTE GOES IN BEFORE FINALIZE (audit P4-03; src/lib/sales/import-tail-repair.ts).
  // Finalize commits this batch live, and the tail below runs outside that transaction, so a process
  // that died between the two used to leave a live batch built on the previous import's split net
  // with nothing that would ever rebuild it. The note is a claimed row in the brick-move queue: the
  // 20-minute drain rebuilds the file only if the tail never crosses it off, so the normal path
  // still does the work once. Written here, after the rows and before finalize, so a finalize that
  // commits after this process is gone is covered too.
  const tailRepair = await holdImportTailRepair(supabase, batchId, inserts.map((row) => row.brick_id));

  // Promote this batch to validated, supersede any other batch for this distributor + period, and
  // refresh every dependent rollup — all inside ONE atomic transaction (phx_finalize_sos_batch), so
  // a failure anywhere leaves the previous good batch untouched instead of deleting it up front.
  if (period) {
    await finalizeSosBatchAndAuditSupersede({
      batchId,
      distributorCode: input.distributorCode,
      period,
      actorLoginId: input.uploadedBy,
    });
  } else {
    // Defensive fallback when no single period could be resolved — nothing sensible to
    // dedupe/lock on without a period key, so promote directly and refresh individually.
    const finalized = await supabase
      .from("source_of_sales_import_batches")
      .update({ status: "validated", blocking_reasons: [] })
      .eq("id", batchId);
    if (finalized.error) throw finalized.error;
    const rollupRefresh = await supabase.rpc("phx_refresh_sos_fact_rollup", { p_batch_id: batchId });
    if (rollupRefresh.error) throw rollupRefresh.error;
    const customerRollupRefresh = await supabase.rpc("phx_refresh_sos_customer_directory_rollup", { p_batch_id: batchId });
    if (customerRollupRefresh.error) throw customerRollupRefresh.error;
    const roiRefresh = await supabase.rpc("phx_refresh_marketing_roi_facts", { p_batch_id: batchId });
    if (roiRefresh.error) throw roiRefresh.error;
    // Channel totals rollup — after fact+directory, which it reads. The main (period-known) path
    // gets this inside phx_finalize_sos_batch; this fallback refreshes each rollup individually.
    const channelRollupRefresh = await supabase.rpc("phx_refresh_sos_channel_rollup", { p_batch_id: batchId });
    if (channelRollupRefresh.error) throw channelRollupRefresh.error;
    // Distributor×product rollup — after the fact rollup it reads, same fallback site.
    const distProductRollupRefresh = await supabase.rpc("phx_refresh_sos_distributor_product_rollup", { p_batch_id: batchId });
    if (distProductRollupRefresh.error) throw distProductRollupRefresh.error;
  }

  // ── THE SPLIT NET, THEN ATTRIBUTION — ONE SHARED TAIL, OUTSIDE BOTH BRANCHES ────────────
  //
  // 🔴 THIS USED TO SIT INSIDE THE FALLBACK ABOVE, and that is the whole defect. The period-known
  // path calls phx_finalize_sos_batch, which refreshes the attribution rollup INSIDE its own SQL
  // transaction and knows nothing about au.monthly_store_split_net — so every real upload rebuilt
  // achievement from fresh sales against the PREVIOUS import's split, with no error anywhere.
  //
  // It cannot run BEFORE finalize either: writeStoreSplitNetForBatch resolves the batch's periods
  // from source_of_sales_fact_rollup, which finalize is what populates. Called earlier it finds no
  // periods and silently does nothing — the same failure, one step to the left.
  //
  // So it lives here, after the whole if/else, where BOTH paths reach it and the fact rows are
  // current either way: write the net, then refresh attribution on top of it. On the finalize path
  // that is a second attribution refresh, which is the price of keeping finalize atomic.
  await writeStoreSplitNetForBatch(supabase, batchId);
  const attributionAfterNet = await supabase.rpc("phx_refresh_monthly_attribution", { p_batch_id: batchId });
  if (attributionAfterNet.error) throw attributionAfterNet.error;
  // Import summaries beside it, so "every site that refreshes the rollups also refreshes the
  // summaries" holds with no exceptions. See tests/sos-import-summaries-refresh.test.ts.
  const summariesAfterNet = await supabase.rpc("phx_refresh_sos_import_summaries", { p_batch_id: batchId });
  if (summariesAfterNet.error) throw summariesAfterNet.error;
  // The cache bust belongs LAST, for the same reason the net does. Both paths busted it too
  // early: the fallback did it before this tail existed, and the finalize path does it inside
  // finalizeSosBatchAndAuditSupersede — in both cases before the net is written, so the very next
  // dashboard read re-cached the attribution the net had not reached yet and held it for the
  // full TTL. Those earlier busts are harmless and stay; this one is the one that matters.
  invalidateSalesDashboardCache("source of sales import — split net written, attribution refreshed");
  // The tail landed: cross the repair note off, so the drain never rebuilds this file again.
  await releaseImportTailRepair(supabase, tailRepair);

  // Self-heal the customer->brick crosswalk from what this CONFIRMED import's sheet itself resolved
  // (see engine.ts's customerBrickCorrections) — only after the batch is validated, never on a preview.
  if (input.result.customerBrickCorrections.length > 0) {
    await applyCustomerBrickCorrections(input.result.customerBrickCorrections, { actorLoginId: input.uploadedBy });
  }

  // Record REAL brick coverage for this batch and warn when it is poor.
  //
  // This path wrote no coverage snapshot at all until now — the newest row in the table predated
  // the June 2026 import entirely — and the metric it would have written (`importable_rows /
  // total_rows`) is 100% by construction here, since both are set to `rows.length` above. So the
  // one mechanism that could have caught June's 3,184 brick-less rows was simultaneously not
  // running and incapable of failing. Best-effort: a coverage record must never fail an import
  // that already committed successfully.
  try {
    const coverage = computeBrickCoverage(rows);

    // MAPPING HEALTH — the two columns the Coverage tab exists to show.
    //
    // These were written as the literals 0 and [] here, so the tab was structurally incapable of
    // reporting a mapping problem: 134 production snapshots, not one non-zero value, while 20 of
    // them recorded fewer importable rows than total rows (5,005 rows in all). Both figures were
    // already sitting in `input.result`; nothing had to be recomputed, only passed.
    //
    // Both are defined in import-coverage.ts, next to the writer and to the same definitions
    // buildImportPreviewDiff uses, so the two writers of this table cannot disagree about what a
    // column means. They are pure and unit-tested — see tests/coverage-mapping-health.test.ts.
    const brickDriftCount = countBrickDrift(input.result.customerBrickCorrections);
    const unmapped = collectUnmappedProducts(input.result.exceptions);

    await saveBrickCoverageSnapshot({
      batchId,
      brickDriftCount,
      coverage,
      details: rows
        .filter((r) => String(r.brickId ?? "").trim() === "" && !r.isDirect && r.clientCode)
        .map((r) => ({ address: r.clientAddress ?? "", code: String(r.clientCode), name: r.clientName ?? "" })),
      distributorCode: input.distributorCode,
      period,
      totalRows: rows.length,
      unmappedProducts: unmapped.products,
      unmappedProductsCount: unmapped.count,
    });
  } catch (error) {
    logError("Failed to record SoS brick coverage for batch", {
      labels: { event: "sos_coverage_record_failed", batchId, distributorCode: input.distributorCode },
      error,
    });
  }

  return { batchId, period, importedRows: rows.length };
}
