import ExcelJS from "exceljs";

import { writeAuditLog } from "@/lib/admin/audit";
import { systemIdentity } from "@/config/system-settings";
import { writeMappingAudit } from "@/lib/sales/mapping-audit";
import { loadMovedBricks } from "@/lib/sales/master-data/moved-bricks";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { customerDetailRow, type CustomerDetailRow } from "@/lib/sales/normalizer/customer-details";
import { RAW_DISTRIBUTOR_PROFILES } from "@/lib/sales/normalizer/profiles";
import { normalizeAliasKey, normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import { IGNORE_PRODUCT_CODE, type NormalizeException } from "@/lib/sales/normalizer/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { writeStoreSplitNetForBatch } from "@/lib/sales/attribution-store-split-refresh";
import { logError } from "@/lib/observability/log";

// Distributor code -> readable name, so a learned alias records WHICH distributor it came from
// (product aliases store it in source_labels[]; territory aliases store it in notes).
const DISTRIBUTOR_NAME_BY_CODE = new Map(RAW_DISTRIBUTOR_PROFILES.map((p) => [p.distributorCode.toUpperCase(), p.distributorName]));
function distributorLabel(code: string | undefined): string {
  const raw = String(code ?? "").trim();
  if (!raw) return "";
  return DISTRIBUTOR_NAME_BY_CODE.get(raw.toUpperCase()) ?? raw;
}

// Bulk mapping — turns a long "Needs mapping" list into a SHORT list of distinct unknown codes
// (one decision fixes every row that shares that code) with a suggested Phoenix match, and writes
// confirmed mappings into the alias tables that already exist (so they are remembered forever).

export type ProductRef = { code: string; family?: string; name: string };

export type DistinctUnknown = {
  count: number;
  raw: string; // the distinct raw key the user maps once
  rawName: string;
  // Customer-only mapping context lifted straight from the distributor sheet so the operator can pick
  // the right brick offline: the customer's postal address and the distributor's own area/governorate
  // text (when the sheet carries a territory column). Empty for product/territory unknowns.
  rawAddress?: string;
  rawTerritory?: string;
  suggestionCode: string | null;
  suggestionLabel: string | null;
};

export type DistinctUnknowns = {
  customers: DistinctUnknown[];
  products: DistinctUnknown[];
  territories: DistinctUnknown[];
  // Exceptions with reason "blank_customer" — not actionable by mapping, surfaced for reporting.
  blankCustomerErrors: number;
  // Exceptions that block import but have no rawTerritory or rawCustomerCode (column-mismatch ghost).
  darkCount: number;
  // Rows a mapping would unblock: an unknown product, territory or pharmacy stands on them. A row with
  // a BLANK product is not one of them — no mapping gives it a product — which is why a pharmacy-only
  // file used to show every one of its rows as "needs mapping", however many pharmacies were mapped.
  rowsNeedingMapping: number;
};

function tokens(value: string): Set<string> {
  return new Set(normalizeAliasKey(value).split(" ").filter((t) => t.length >= 2));
}

// Token-overlap fuzzy match of a raw item name against the Phoenix product names/families.
// "TEBOFORTIN FORTE 30TAB" → Tebofortin (TE…). Cheap and high hit-rate for English item names.
export function suggestProduct(rawName: string, products: ProductRef[]): { code: string; label: string } | null {
  const rawTokens = tokens(rawName);
  if (rawTokens.size === 0) return null;
  let best: { code: string; label: string; score: number } | null = null;
  for (const product of products) {
    const productTokens = tokens(`${product.name} ${product.family ?? ""}`);
    let overlap = 0;
    for (const token of productTokens) if (rawTokens.has(token)) overlap += 1;
    if (overlap > 0 && (!best || overlap > best.score)) best = { code: product.code, label: product.name, score: overlap };
  }
  return best ? { code: best.code, label: best.label } : null;
}

export function distinctUnknowns(exceptions: NormalizeException[], products: ProductRef[]): DistinctUnknowns {
  const productMap = new Map<string, DistinctUnknown>();
  const territoryMap = new Map<string, DistinctUnknown>();
  const customerMap = new Map<string, DistinctUnknown>();
  let rowsNeedingMapping = 0;
  for (const ex of exceptions) {
    const productGap = (ex.reason === "product" || ex.reason === "both") && !!ex.rawProduct;
    const placeGap = (ex.reason === "brick" || ex.reason === "both") && !!(ex.rawTerritory || ex.rawCustomerCode);
    if (productGap || placeGap) rowsNeedingMapping += 1;
    if ((ex.reason === "product" || ex.reason === "both") && ex.rawProduct) {
      let entry = productMap.get(ex.rawProduct);
      if (!entry) {
        const suggestion = suggestProduct(ex.rawProductName || ex.rawProduct, products);
        entry = { count: 0, raw: ex.rawProduct, rawName: ex.rawProductName, rawAddress: "", suggestionCode: suggestion?.code ?? null, suggestionLabel: suggestion?.label ?? null };
        productMap.set(ex.rawProduct, entry);
      }
      entry.count += 1;
      if (!entry.rawName && ex.rawProductName) entry.rawName = ex.rawProductName;
    }
    if (ex.reason === "brick" || ex.reason === "both") {
      if (ex.rawTerritory) {
        const key = normalizeAliasKey(ex.rawTerritory);
        let entry = territoryMap.get(key);
        if (!entry) { entry = { count: 0, raw: ex.rawTerritory, rawName: "", rawAddress: "", suggestionCode: null, suggestionLabel: null }; territoryMap.set(key, entry); }
        entry.count += 1;
      }
      // Per-pharmacy crosswalk — the reliable path when the distributor's area text is junk.
      if (ex.rawCustomerCode) {
        let entry = customerMap.get(ex.rawCustomerCode);
        if (!entry) { entry = { count: 0, raw: ex.rawCustomerCode, rawName: ex.rawCustomerName, rawAddress: ex.rawCustomerAddress, rawTerritory: ex.rawTerritory, suggestionCode: null, suggestionLabel: null }; customerMap.set(ex.rawCustomerCode, entry); }
        entry.count += 1;
        // Backfill name/address/area from any later row for the same code (the first row may be sparse).
        if (!entry.rawName && ex.rawCustomerName) entry.rawName = ex.rawCustomerName;
        if (!entry.rawAddress && ex.rawCustomerAddress) entry.rawAddress = ex.rawCustomerAddress;
        if (!entry.rawTerritory && ex.rawTerritory) entry.rawTerritory = ex.rawTerritory;
      }
    }
  }
  // Dark exceptions: brick-reason exceptions with no territory AND no customer code — these block
  // import but are invisible to the mapping UI (no actionable raw key). They indicate a column-name
  // mismatch that Change 1 (header validation) should have caught; kept as a backstop counter.
  const darkCount = exceptions.filter(
    (e) => (e.reason === "brick" || e.reason === "both") && !e.rawTerritory && !e.rawCustomerCode
  ).length;
  // Blank-customer exceptions (EG-BR with missing entity code): not fixable by adding to the map.
  const blankCustomerErrors = exceptions.filter((e) => e.reason === "blank_customer").length;

  const sorted = (m: Map<string, DistinctUnknown>) => [...m.values()].sort((a, b) => b.count - a.count);
  return { customers: sorted(customerMap), products: sorted(productMap), territories: sorted(territoryMap), darkCount, blankCustomerErrors, rowsNeedingMapping };
}

// ── write path (insert-if-absent, validated against the masters) ──

// name / address are customer-only: the pharmacy's name and postal address as the distributor sheet
// spells them. They never decide the mapping - they are stored so the free steps can learn from it.
// row is the sheet row a mapping was read from, when it came from a file (the unmapped list).
export type MappingInput = { code: string; distributorCode?: string; raw: string; type: "product" | "territory" | "customer"; confidence?: number; name?: string; address?: string; row?: number };
export type InvalidEntry = { raw: string; type: string; reason: string; row?: number };

// Writes the name / address of mappings that were just saved, into BLANK fields only. They cannot ride
// in the upsert: ON CONFLICT DO UPDATE would overwrite a name already on file (one code can name
// different pharmacies over time), and supabase-js sends one column list for a whole bulk upsert, so
// a row without a name would null out a stored one. Best-effort like the backfill: a missing RPC
// (pre-migration) or a failure never fails the save, whose mapping is already written.
export async function fillBlankCustomerDetails(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  rows: CustomerDetailRow[],
): Promise<number> {
  let filled = 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    try {
      const { data, error } = await supabase.rpc("sos_customer_map_fill_blanks", { p_rows: rows.slice(i, i + CHUNK) });
      // A failed call is the RPC not being there yet or the database struggling - more calls help
      // neither. The fill is idempotent, so the next save of the same mappings fills them.
      if (error) break;
      filled += Number(data ?? 0) || 0;
    } catch {
      break;
    }
  }
  return filled;
}

export type SaveMappingsOptions = {
  // Provenance for customer rows: 'auto' marks auto-applied mappings; default 'normalizer'.
  source?: string;
  // Login id recorded in mapped_by for customer rows (auto-apply records the clicking admin).
  mappedBy?: string;
  // Heal already-imported rows (brick_id IS NULL only) for each saved customer mapping via the
  // sos_backfill_import_rows_from_customer_map RPC. Best-effort: a missing RPC (pre-migration)
  // or per-row failure never fails the save.
  backfill?: boolean;
  // What an incoming CUSTOMER mapping does to a crosswalk row that already exists. The upsert below
  // is ON CONFLICT DO UPDATE, so without this every caller silently overwrites — which is how an
  // automated mine came to revert hand-made owner rulings to whatever the OLDEST historical sheet
  // happened to say. The default is the safe one on purpose: this was a FORGOTTEN option, not a
  // wrong one, so a caller must opt IN to destruction rather than opt out of it.
  //
  //   "correct" (default) — overwrite the existing row, EXCEPT an active owner ruling
  //                         (confidence=100), which is left alone and counted in skippedOwnerVerified.
  //   "force"             — overwrite everything, owner rulings included. For an explicit human
  //                         re-map only (the Super-Admin mapping screen), never for automation.
  //   "learn"             — insert only; every existing row is left exactly as it is, whatever its
  //                         provenance. This is what "bulk-bootstrap the dictionary" already claimed
  //                         to do in three separate comments across this module.
  onExistingCustomer?: "correct" | "force" | "learn";
};

// Hard cap: a bulk save larger than this skips backfill (run it separately) so one giant import
// can't hammer the DB with thousands of sequential UPDATEs.
export const BACKFILL_MAX_MAPPINGS = 2000;

// A batch whose totals did not rebuild after a backfill moved its rows. The mapping is saved and the
// healed rows stay, so the save itself succeeds — but the Monthly Closing, the dashboards and the
// exports keep that batch's OLD totals until a later rebuild, which is exactly what must never pass
// unseen. It lands in the app's error table (the Error Monitor), naming the batch and the step.
export type BackfillRollupFailure = (batchId: string, error: Error) => void;

const reportBackfillRollupFailure: BackfillRollupFailure = (batchId, error) => {
  logError("Sales mapping save: a batch's totals were not rebuilt after the mapping moved its rows", {
    labels: { event: "sos_mapping_backfill_rollup_failed", batchId },
    error,
  });
};

export async function backfillCustomerRows(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  rows: { distributor_code: unknown; customer_code: unknown }[],
  onRollupFailure: BackfillRollupFailure = reportBackfillRollupFailure,
): Promise<number> {
  let backfilled = 0;
  // Backfilling moves an import row's brick/area/region. The fact rollup is a materialised copy of
  // that geography, so without a refresh the corrected sale keeps its OLD owner indefinitely — the
  // mapping looks fixed on screen while every rollup-driven report still credits the wrong area.
  // Collected across the whole loop and refreshed once per batch: one bulk save commonly touches the
  // same batch hundreds of times.
  const affectedBatchIds = new Set<string>();

  for (const row of rows) {
    try {
      const { data, error } = await supabase.rpc("sos_backfill_import_rows_from_customer_map", {
        p_customer: String(row.customer_code ?? ""),
        p_distributor: String(row.distributor_code ?? ""),
      });
      if (error) continue;
      // Post-migration the RPC returns one row { updated_rows, affected_batch_ids }; before it is
      // applied it still returns a bare integer. Accept both, so a deploy landing ahead of the
      // migration degrades to the old behaviour instead of throwing.
      if (typeof data === "number") {
        backfilled += data;
        continue;
      }
      const record = (Array.isArray(data) ? data[0] : data) as
        | { updated_rows?: number; affected_batch_ids?: unknown }
        | null
        | undefined;
      if (!record) continue;
      backfilled += Number(record.updated_rows ?? 0);
      const batchIds = Array.isArray(record.affected_batch_ids) ? record.affected_batch_ids : [];
      for (const id of batchIds) {
        const value = String(id ?? "").trim();
        if (value) affectedBatchIds.add(value);
      }
    } catch {
      // RPC absent (pre-migration) or transient failure — the mapping itself is already saved.
    }
  }

  for (const batchId of affectedBatchIds) {
    // `rpc` never throws: a refresh that fails or times out (a rebuild now waits on its batch's lock)
    // RESOLVES with `{ error }`. Until 2026-10-23 every one of those results was dropped, so a failed
    // fact rollup let the channel, distributor×product and attribution rollups rebuild on the OLD fact
    // rows and the batch stayed wrong with no trace. Each step is now checked, the first failure stops
    // the chain (nothing downstream rebuilds on stale input), and the failure is reported.
    const step = (name: string, result: { error: { message?: unknown } | null }) => {
      if (result.error) throw new Error(`${name} failed for batch ${batchId}: ${String(result.error.message ?? result.error)}`);
    };
    try {
      // The same trio the reconcile path refreshes (applyHistoricalReconciliation in
      // normalizer/customer-map.ts). A refresh failure must not undo the mapping that already
      // saved, so the corrected rows stay and a later reconcile retries the refresh.
      const [fact, directory, roi] = await Promise.all([
        supabase.rpc("phx_refresh_sos_fact_rollup", { p_batch_id: batchId }),
        supabase.rpc("phx_refresh_sos_customer_directory_rollup", { p_batch_id: batchId }),
        supabase.rpc("phx_refresh_marketing_roi_facts", { p_batch_id: batchId }),
      ]);
      step("The fact rollup", fact);
      step("The customer directory rollup", directory);
      step("The marketing ROI facts", roi);
      // Channel totals rollup — reads the fact + directory rollups above, so after the trio.
      step("The channel rollup", await supabase.rpc("phx_refresh_sos_channel_rollup", { p_batch_id: batchId }));
      // Distributor×product rollup — after the fact rollup it reads.
      step(
        "The distributor x product rollup",
        await supabase.rpc("phx_refresh_sos_distributor_product_rollup", { p_batch_id: batchId }),
      );
      // The wholesaler city split net FIRST — au.f_monthly_attribution reads it.
      await writeStoreSplitNetForBatch(supabase, batchId);
      // Sales-vs-target attribution rollup — same site, after the fact rollup it reads.
      step("Monthly attribution", await supabase.rpc("phx_refresh_monthly_attribution", { p_batch_id: batchId }));
      // Import summaries — what the Source of Sales dashboard reads. Frozen at insert until
      // 2026-08-30, so a mapping backfill refreshed every rollup EXCEPT the one the executive
      // screen actually renders from.
      step("The import summaries", await supabase.rpc("phx_refresh_sos_import_summaries", { p_batch_id: batchId }));
    } catch (error) {
      // Not rethrown — see above — but never silent either.
      onRollupFailure(batchId, error instanceof Error ? error : new Error(String(error)));
    }
  }

  return backfilled;
}

// Identity of a crosswalk row, keyed exactly the way the upsert keys it. The distributor is
// normalized (saveMappings only ever WRITES it normalized) while the customer code is taken
// literally, because `onConflict: "distributor_code,customer_code"` compares the stored strings —
// so a literal match is precisely the row that would be overwritten. Same convention as
// loadOwnerVerifiedMapKeys in customer-map.ts; that one cannot be shared here, because
// customer-map.ts already imports THIS module and the reverse import would be a cycle.
function customerMapGuardKey(distributorCode: unknown, customerCode: unknown): string {
  return `${normalizeCodeKey(String(distributorCode ?? ""))} ${String(customerCode ?? "").trim()}`;
}

// Which crosswalk rows these customer mappings would collide with, and which of those are owner
// rulings. One query answers both: "learn" needs the existing set, "correct" needs the owner set.
//
// This THROWS rather than degrading to empty sets, unlike its counterpart in customer-map.ts. There
// an empty set only means "guard nothing extra"; here an empty `existing` set would mean "nothing is
// in the crosswalk", and "learn" would then write every row — reinstating the exact overwrite this
// guard exists to prevent. A save that fails loudly is recoverable; one that silently reverts the
// owner's rulings is not.
type GuardRow = { active?: unknown; confidence?: unknown; customer_code?: unknown; distributor_code?: unknown };

async function loadCustomerMapGuardKeys(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  rows: Record<string, unknown>[],
): Promise<{ existing: Set<string>; ownerVerified: Set<string> }> {
  const existing = new Set<string>();
  const ownerVerified = new Set<string>();
  const customerCodes = [...new Set(rows.map((r) => String(r.customer_code ?? "").trim()).filter(Boolean))];
  if (customerCodes.length === 0) return { existing, ownerVerified };

  // Chunked: PostgREST puts the `in` list in the URL and a history mine carries thousands of codes.
  const CHUNK = 200;
  for (let i = 0; i < customerCodes.length; i += CHUNK) {
    const slice = customerCodes.slice(i, i + CHUNK);
    const table = () => supabase.from("source_of_sales_customer_map");
    // No .eq("active", true): the upsert conflicts on (distributor_code, customer_code) whatever the
    // row's active flag, so an inactive row is still a row that would be overwritten.
    //
    // The two selects are kept in SEPARATE bindings rather than reassigning one. The client infers a
    // row type from the select string, so the narrower fallback shape is not assignable to the wider
    // one — reusing a single `data` is a TS2322, not a style preference.
    const withConfidence = await table().select("active,confidence,customer_code,distributor_code").in("customer_code", slice);
    let rows: GuardRow[] = (withConfidence.data ?? []) as unknown as GuardRow[];
    if (withConfidence.error) {
      if (!/confidence/i.test(withConfidence.error.message ?? "")) {
        throw new Error(`customer map guard: ${withConfidence.error.message ?? "lookup failed"}`);
      }
      // Pre-migration deployment with no `confidence` column: the existing-row half still answers
      // correctly, and only the owner-ruling half degrades — matching what the upsert already does.
      const withoutConfidence = await table().select("active,customer_code,distributor_code").in("customer_code", slice);
      if (withoutConfidence.error) throw new Error(`customer map guard: ${withoutConfidence.error.message ?? "lookup failed"}`);
      rows = (withoutConfidence.data ?? []) as unknown as GuardRow[];
    }
    for (const row of rows) {
      const key = customerMapGuardKey(row.distributor_code, row.customer_code);
      existing.add(key);
      if (Number(row.confidence) === 100 && row.active !== false) ownerVerified.add(key);
    }
  }
  return { existing, ownerVerified };
}

export type CustomerWriteMode = NonNullable<SaveMappingsOptions["onExistingCustomer"]>;

// Which of these customer rows may actually be written, given what the crosswalk already holds.
// Pure and exported so the rule can be tested without a database — the same reason
// selectCorrectionRows is pure over in customer-map.ts. Both sets are keyed by customerMapGuardKey.
export function selectCustomerRowsToWrite<T extends Record<string, unknown>>(
  rows: T[],
  existing: Set<string>,
  ownerVerified: Set<string>,
  mode: CustomerWriteMode,
): { rows: T[]; skippedOwnerVerified: number; skippedExisting: number } {
  if (mode === "force") return { rows, skippedExisting: 0, skippedOwnerVerified: 0 };
  let skippedOwnerVerified = 0;
  let skippedExisting = 0;
  const kept = rows.filter((row) => {
    const key = customerMapGuardKey(row.distributor_code, row.customer_code);
    // An owner ruling outranks the mode: it is the one mapping a person decided by hand, and it is
    // checked first so it is reported as a RULING skip rather than as an ordinary existing row.
    if (ownerVerified.has(key)) { skippedOwnerVerified += 1; return false; }
    if (mode === "learn" && existing.has(key)) { skippedExisting += 1; return false; }
    return true;
  });
  return { rows: kept, skippedExisting, skippedOwnerVerified };
}

export async function saveMappings(mappings: MappingInput[], options?: SaveMappingsOptions): Promise<{ saved: number; skipped: number; invalid: number; invalidEntries: InvalidEntry[]; backfilled: number; skippedOwnerVerified: number; detailsFilled: number }> {
  // Only the product + brick masters are needed to validate the mapping targets — NOT the (12k+ row)
  // customer→brick crosswalk, which loadSalesReferenceData() pages 1000-at-a-time by default. Skipping
  // it keeps a save fast + cold-start-safe (~2s → ~0.2s) instead of scaling with the customer map.
  const [refs, movedBricks] = await Promise.all([
    loadSalesReferenceData({ includeCustomerBricks: false }),
    loadMovedBricks(),
  ]);
  const productCodes = new Set(refs.products.map((p) => normalizeCodeKey(p.productCode)));
  productCodes.add(IGNORE_PRODUCT_CODE); // "neglect this item" is a valid product target
  const brickById = new Map((refs.bricks ?? []).map((b) => [normalizeCodeKey(b.brickId), b]));
  // A brick kept only as history after a move stays in the master, so published months resolve, but
  // no mapping may be saved onto it: its sales would credit the area it left. A screen opened before
  // the move can still offer it, so the save says where it went instead of writing it.
  const movedTo = new Map([...movedBricks].map(([from, to]) => [normalizeCodeKey(from), to]));
  const historyReason = (code: string): string | null => {
    const to = movedTo.get(code);
    if (!to) return null;
    const from = brickById.get(code)?.brickName ?? code;
    const successor = brickById.get(normalizeCodeKey(to))?.brickName ?? to;
    return `${from} is kept only as history: it moved to ${successor}. Pick ${successor} instead.`;
  };
  const supabase = getSupabaseAdmin();

  // Intra-batch dedup only — these sets prevent sending duplicate keys in a single upsert batch.
  // Product and territory aliases pre-load nothing: their upsert is ON CONFLICT DO UPDATE, so a
  // correction always takes effect rather than being silently skipped. CUSTOMER rows are the
  // exception — they carry the owner-ruling sentinel, so they get the guarded lookup below.
  const haveProd = new Set<string>();
  const haveTerr = new Set<string>();
  const haveCust = new Set<string>();

  const productRows: Record<string, unknown>[] = [];
  const territoryRows: Record<string, unknown>[] = [];
  const customerRows: Record<string, unknown>[] = [];
  // Each customer row's name / address, keyed by the row object itself: selectCustomerRowsToWrite
  // filters these same objects, so what survives the guard still finds its details.
  const detailsByRow = new Map<Record<string, unknown>, CustomerDetailRow>();
  const invalidEntries: InvalidEntry[] = [];
  let skipped = 0;
  let invalid = 0;
  for (const mapping of mappings) {
    // A mapping read from a file names its row, so a rejection can say which line to fix.
    const sheetRow = mapping.row ? { row: mapping.row } : {};
    const raw = String(mapping.raw ?? "").trim();
    const code = normalizeCodeKey(mapping.code);
    if (!raw || !code) {
      invalid += 1;
      invalidEntries.push({ ...sheetRow, raw: raw || "(empty)", type: mapping.type, reason: "Empty raw value or code" });
      continue;
    }
    if (mapping.type === "customer") {
      const dist = normalizeCodeKey(mapping.distributorCode);
      const brick = brickById.get(code);
      if (!dist) { invalid += 1; invalidEntries.push({ ...sheetRow, raw, type: "customer", reason: "Missing distributor code" }); continue; }
      if (!brick) { invalid += 1; invalidEntries.push({ ...sheetRow, raw, type: "customer", reason: `Brick ID "${code}" not found in master` }); continue; }
      const customerHistory = historyReason(code);
      if (customerHistory) { invalid += 1; invalidEntries.push({ ...sheetRow, raw, type: "customer", reason: customerHistory }); continue; }
      const ck = `${dist} ${normalizeCodeKey(raw)}`;
      if (haveCust.has(ck)) { skipped += 1; continue; }
      haveCust.add(ck);
      const confidence = typeof mapping.confidence === "number"
        ? Math.min(100, Math.max(0, Math.round(mapping.confidence)))
        : null;
      const customerRow: Record<string, unknown> = {
        active: true,
        area_code: brick.areaCode,
        brick_id: brick.brickId,
        confidence,
        customer_code: raw,
        distributor_code: dist,
        mapped_by: options?.mappedBy ?? null,
        region_code: brick.regionCode,
        source: options?.source ?? "normalizer",
      };
      customerRows.push(customerRow);
      const details = customerDetailRow(dist, raw, mapping.name, mapping.address);
      if (details) detailsByRow.set(customerRow, details);
      continue;
    }
    const key = normalizeAliasKey(raw);
    if (!key) { invalid += 1; invalidEntries.push({ ...sheetRow, raw, type: mapping.type, reason: "Raw value normalizes to empty string" }); continue; }
    const fromDistributor = distributorLabel(mapping.distributorCode);
    if (mapping.type === "product") {
      // Product aliases are PER-DISTRIBUTOR: the same raw code/name can mean different products for
      // different distributors, so a distributor is required and the dedup key is distributor-scoped.
      const dist = normalizeCodeKey(mapping.distributorCode);
      if (!dist) { invalid += 1; invalidEntries.push({ ...sheetRow, raw, type: "product", reason: "Missing distributor code" }); continue; }
      if (!productCodes.has(code)) { invalid += 1; invalidEntries.push({ ...sheetRow, raw, type: "product", reason: `Product code "${code}" not found in master` }); continue; }
      const pk = `${dist} ${key}`;
      if (haveProd.has(pk)) { skipped += 1; continue; }
      haveProd.add(pk);
      productRows.push({ alias: raw, normalized_alias: key, distributor_code: dist, product_code: code, active: true, source_file: "normalizer", source_labels: fromDistributor ? [fromDistributor] : [] });
    } else {
      if (!brickById.has(code)) { invalid += 1; invalidEntries.push({ ...sheetRow, raw, type: "territory", reason: `Brick ID "${code}" not found in master` }); continue; }
      const territoryHistory = historyReason(code);
      if (territoryHistory) { invalid += 1; invalidEntries.push({ ...sheetRow, raw, type: "territory", reason: territoryHistory }); continue; }
      if (haveTerr.has(key)) { skipped += 1; continue; }
      haveTerr.add(key);
      territoryRows.push({ alias: raw, normalized_alias: key, target_type: "brick", target_code: code, active: true, source_file: "normalizer", notes: fromDistributor });
    }
  }
  // Guard the crosswalk BEFORE the upsert, because ON CONFLICT DO UPDATE cannot be told to spare a
  // row once it runs. "force" skips the lookup entirely — a human re-map is allowed to land on
  // anything, and that path should not pay for a round trip it never uses.
  const onExistingCustomer = options?.onExistingCustomer ?? "correct";
  let skippedOwnerVerified = 0;
  let customerWriteRows = customerRows;
  if (customerRows.length > 0 && onExistingCustomer !== "force") {
    const { existing, ownerVerified } = await loadCustomerMapGuardKeys(supabase, customerRows);
    const guarded = selectCustomerRowsToWrite(customerRows, existing, ownerVerified, onExistingCustomer);
    customerWriteRows = guarded.rows;
    skippedOwnerVerified = guarded.skippedOwnerVerified;
    skipped += guarded.skippedOwnerVerified + guarded.skippedExisting;
  }

  // Upsert: ON CONFLICT DO UPDATE so corrections and re-mappings always overwrite the existing row.
  // .select("id") returns all affected rows (inserts + updates), giving an accurate saved count.
  const failed = (label: string, error: { message?: string; details?: string; hint?: string }) =>
    new Error(`${label}: ${[error.message, error.details, error.hint].filter(Boolean).join(" — ") || "insert failed"}`);
  let saved = 0;
  if (productRows.length) {
    const { data, error } = await supabase.from("source_of_sales_product_aliases").upsert(productRows, { onConflict: "distributor_code,normalized_alias" }).select("id");
    if (error) throw failed("product aliases", error);
    saved += data?.length ?? 0;
  }
  if (territoryRows.length) {
    // Re-pointing an alias must REPLACE its target, and the replacement has to happen BEFORE the
    // upsert. `source_of_sales_territory_aliases_one_active_target` is UNIQUE (normalized_alias,
    // target_type) WHERE active, while the upsert's conflict key includes target_code — so aiming an
    // existing alias at a different brick does not conflict, it INSERTS, and the partial index then
    // rejects it outright: "duplicate key value ... (beiala elhamol, brick) already exists". The
    // save fails wholesale and the mapping screen cannot be cleared at all.
    //
    // Deactivating every active row for these aliases first is safe because the upsert immediately
    // re-activates the one that matches (alias, type, code); only a genuinely superseded target is
    // left inactive. One extra round trip for the whole batch, not one per alias.
    const territoryKeys = [...haveTerr];
    const { error: supersedeError } = await supabase
      .from("source_of_sales_territory_aliases")
      .update({ active: false })
      .in("normalized_alias", territoryKeys)
      .eq("target_type", "brick")
      .eq("active", true);
    if (supersedeError) throw failed("territory aliases (superseding the previous target)", supersedeError);
    const { data, error } = await supabase.from("source_of_sales_territory_aliases").upsert(territoryRows, { onConflict: "normalized_alias,target_type,target_code" }).select("id");
    if (error) throw failed("territory aliases", error);
    saved += data?.length ?? 0;
  }
  let customerSaved = 0;
  let detailsFilled = 0;
  if (customerWriteRows.length) {
    let { data, error } = await supabase.from("source_of_sales_customer_map").upsert(customerWriteRows, { onConflict: "distributor_code,customer_code" }).select("id,distributor_code,customer_code");
    if (error && /confidence|mapped_by/i.test(error.message ?? "")) {
      // Pre-migration deployment: retry without the provenance columns rather than failing the save.
      const stripped = customerWriteRows.map(({ confidence: _c, mapped_by: _m, ...rest }) => rest);
      ({ data, error } = await supabase.from("source_of_sales_customer_map").upsert(stripped, { onConflict: "distributor_code,customer_code" }).select("id,distributor_code,customer_code"));
    }
    if (error) throw failed("customer map", error);
    customerSaved = data?.length ?? 0;
    saved += customerSaved;
    // Names and addresses go only to the rows this upsert actually WROTE. A move the mapping guard
    // held is not in `data` - its row still carries the old brick, and one code can name a different
    // pharmacy over time, so the sheet's name must not land beside a brick it never chose.
    const written = new Set((data ?? []).map((row) => `${String(row.distributor_code ?? "")} ${String(row.customer_code ?? "")}`));
    const details = customerWriteRows.flatMap((row) => {
      const detail = detailsByRow.get(row);
      return detail && written.has(`${detail.distributor_code} ${detail.customer_code}`) ? [detail] : [];
    });
    if (details.length) detailsFilled = await fillBlankCustomerDetails(supabase, details);
  }
  // Safety net: if any submitted row was not reflected in the select result, count it as skipped.
  // Counts the rows actually SENT — guard-skipped rows are already in `skipped` above, and counting
  // them twice would report more skips than there were mappings.
  skipped += productRows.length + territoryRows.length + customerWriteRows.length - saved;

  let backfilled = 0;
  // Backfill only what was actually written: healing import rows for a mapping this save deliberately
  // did NOT touch would re-point history at a brick the owner had already overruled.
  if (options?.backfill && customerSaved > 0 && customerWriteRows.length <= BACKFILL_MAX_MAPPINGS) {
    backfilled = await backfillCustomerRows(
      supabase,
      customerWriteRows.map((r) => ({ customer_code: r.customer_code, distributor_code: r.distributor_code })),
    );
  }
  return { saved, skipped, invalid, invalidEntries, backfilled, skippedOwnerVerified, detailsFilled };
}

// ── Single-row mapping CRUD (Mapping Database page) ──
// Edit overwrites the existing alias→code mapping; delete soft-deactivates (active=false) so the
// row immediately stops resolving in loadCrosswalks but stays recoverable. All mutations audited.

export type ProductAliasRow = { alias: string; normalizedAlias: string; productCode: string };
export type TerritoryAliasRow = { alias: string; normalizedAlias: string; targetType: string; targetCode: string };

export async function listProductAliases(distributorCode: string): Promise<ProductAliasRow[]> {
  const supabase = getSupabaseAdmin();
  const dist = normalizeCodeKey(distributorCode);
  const { data, error } = await supabase
    .from("source_of_sales_product_aliases")
    .select("alias,normalized_alias,product_code")
    .eq("active", true)
    .eq("distributor_code", dist)
    .order("alias", { ascending: true });
  if (error) throw new Error(`Failed to list product aliases: ${error.message}`);
  return (data ?? []).map((r) => ({
    alias: String((r as Record<string, unknown>).alias ?? ""),
    normalizedAlias: String((r as Record<string, unknown>).normalized_alias ?? ""),
    productCode: String((r as Record<string, unknown>).product_code ?? ""),
  }));
}

export async function listTerritoryAliases(): Promise<TerritoryAliasRow[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("source_of_sales_territory_aliases")
    .select("alias,normalized_alias,target_type,target_code")
    .eq("active", true)
    .order("alias", { ascending: true });
  if (error) throw new Error(`Failed to list territory aliases: ${error.message}`);
  return (data ?? []).map((r) => ({
    alias: String((r as Record<string, unknown>).alias ?? ""),
    normalizedAlias: String((r as Record<string, unknown>).normalized_alias ?? ""),
    targetType: String((r as Record<string, unknown>).target_type ?? ""),
    targetCode: String((r as Record<string, unknown>).target_code ?? ""),
  }));
}

export async function upsertProductAlias(input: { actorLoginId: string; distributorCode: string; raw: string; productCode: string }): Promise<void> {
  const dist = normalizeCodeKey(input.distributorCode);
  const raw = String(input.raw ?? "").trim();
  const code = normalizeCodeKey(input.productCode);
  const key = normalizeAliasKey(raw);
  if (!dist) throw new Error("Distributor code is required.");
  if (!raw || !key) throw new Error("Alias is required.");
  const refs = await loadSalesReferenceData({ includeCustomerBricks: false });
  const productCodes = new Set(refs.products.map((p) => normalizeCodeKey(p.productCode)));
  productCodes.add(IGNORE_PRODUCT_CODE);
  if (!productCodes.has(code)) throw new Error(`Product code "${code}" not found in master.`);
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("source_of_sales_product_aliases").upsert(
    { alias: raw, normalized_alias: key, distributor_code: dist, product_code: code, active: true, source_file: "mapping-database" },
    { onConflict: "distributor_code,normalized_alias" },
  );
  if (error) throw new Error(`Failed to save product alias: ${error.message}`);
  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: "source_of_sales_product_aliases",
    entityType: "sales_import_batch",
    newValues: { distributor_code: dist, normalized_alias: key, product_code: code, source: "product_alias_upsert" },
    summary: `Product alias upsert — ${dist} / ${raw} -> ${code}.`,
  });
  await writeMappingAudit({ entityType: "product_alias", distributorCode: dist, entityKey: key, action: "edit", after: { alias: raw, product_code: code }, actor: input.actorLoginId });
}

export async function deleteProductAlias(input: { actorLoginId: string; distributorCode: string; normalizedAlias: string }): Promise<void> {
  const dist = normalizeCodeKey(input.distributorCode);
  const key = String(input.normalizedAlias ?? "").trim();
  if (!dist || !key) throw new Error("Distributor and alias are required.");
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("source_of_sales_product_aliases")
    .update({ active: false })
    .eq("distributor_code", dist)
    .eq("normalized_alias", key);
  if (error) throw new Error(`Failed to delete product alias: ${error.message}`);
  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: "source_of_sales_product_aliases",
    entityType: "sales_import_batch",
    newValues: { distributor_code: dist, normalized_alias: key, source: "product_alias_delete" },
    summary: `Product alias delete — ${dist} / ${key} (deactivated).`,
  });
  await writeMappingAudit({ entityType: "product_alias", distributorCode: dist, entityKey: key, action: "delete", actor: input.actorLoginId });
}

export async function upsertTerritoryAlias(input: { actorLoginId: string; raw: string; brickId: string }): Promise<void> {
  const raw = String(input.raw ?? "").trim();
  const code = normalizeCodeKey(input.brickId);
  const key = normalizeAliasKey(raw);
  if (!raw || !key) throw new Error("Territory text is required.");
  const refs = await loadSalesReferenceData({ includeCustomerBricks: false });
  const brickIds = new Set((refs.bricks ?? []).map((b) => normalizeCodeKey(b.brickId)));
  if (!brickIds.has(code)) throw new Error(`Brick ID "${code}" not found in master.`);
  const supabase = getSupabaseAdmin();

  // Re-pointing an alias must REPLACE it, not add a second target — and the replacement has to
  // happen BEFORE the upsert.
  //
  // The upsert's conflict key includes target_code, so aiming an existing alias at a different brick
  // does not conflict: it INSERTS. That used to leave the alias with two active rows, which
  // buildAliasIndex drops as ambiguous — the edit silently made the alias resolve to NOTHING. The
  // partial unique index `one_active_target` UNIQUE (normalized_alias, target_type) WHERE active now
  // prevents that second row, so the same insert fails loudly instead. Superseding afterwards can
  // therefore never run: the statement it was meant to follow has already errored.
  //
  // Deactivating first opens a sub-second window where the alias resolves to nothing, which is why
  // this deliberately deactivates ONLY the targets being replaced, and does it immediately before
  // the upsert that restores one.
  const { error: supersedeError } = await supabase
    .from("source_of_sales_territory_aliases")
    .update({ active: false })
    .eq("normalized_alias", key)
    .eq("target_type", "brick")
    .eq("active", true)
    .neq("target_code", code);
  if (supersedeError) {
    throw new Error(`Failed to supersede the previous territory alias target: ${supersedeError.message}`);
  }

  const { error } = await supabase.from("source_of_sales_territory_aliases").upsert(
    { alias: raw, normalized_alias: key, target_type: "brick", target_code: code, active: true, source_file: "mapping-database" },
    { onConflict: "normalized_alias,target_type,target_code" },
  );
  if (error) throw new Error(`Failed to save territory alias: ${error.message}`);

  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: "source_of_sales_territory_aliases",
    entityType: "sales_import_batch",
    newValues: { normalized_alias: key, target_code: code, source: "territory_alias_upsert" },
    summary: `Territory alias upsert — ${raw} -> ${code}.`,
  });
  await writeMappingAudit({ entityType: "territory_alias", entityKey: key, action: "edit", after: { alias: raw, target_code: code }, actor: input.actorLoginId });
}

export async function deleteTerritoryAlias(input: { actorLoginId: string; normalizedAlias: string; targetCode: string }): Promise<void> {
  const key = String(input.normalizedAlias ?? "").trim();
  const code = normalizeCodeKey(input.targetCode);
  if (!key || !code) throw new Error("Territory alias and target are required.");
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("source_of_sales_territory_aliases")
    .update({ active: false })
    .eq("normalized_alias", key)
    .eq("target_type", "brick")
    .eq("target_code", code);
  if (error) throw new Error(`Failed to delete territory alias: ${error.message}`);
  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: "source_of_sales_territory_aliases",
    entityType: "sales_import_batch",
    newValues: { normalized_alias: key, target_code: code, source: "territory_alias_delete" },
    summary: `Territory alias delete — ${key} -> ${code} (deactivated).`,
  });
  await writeMappingAudit({ entityType: "territory_alias", entityKey: key, action: "delete", after: { target_code: code }, actor: input.actorLoginId });
}

// ── Excel bulk round-trip ──

// 🔴 THE LIST MUST CARRY EVERY UNKNOWN THE SCREEN SHOWS — SoS audit, confirmed high. It used to write
// products and territories only, and the upload read back only those two types, so an unknown
// pharmacy (the per-customer crosswalk, the reliable path when a distributor's area text is junk)
// could not be mapped offline at all: it was absent from the file, and a customer row typed into it
// by hand was dropped on upload. Customer rows now go out with the name, address and area text the
// screen shows, and their Phoenix Code is a Brick ID, learned under the list's distributor.
export function buildUnmappedWorkbook(distinct: DistinctUnknowns): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemIdentity.appName;
  const sheet = workbook.addWorksheet("Unmapped");
  const header = sheet.addRow(["Type", "Raw code", "Raw name", "Count", "Suggestion code", "Phoenix Code (fill)", "Raw address", "Raw area"]);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.eachCell((c) => { c.fill = { fgColor: { argb: "FF0B0B0B" }, pattern: "solid", type: "pattern" }; });
  distinct.products.forEach((u) => sheet.addRow(["product", u.raw, u.rawName, u.count, u.suggestionCode ?? "", u.suggestionCode ?? ""]));
  distinct.territories.forEach((u) => sheet.addRow(["territory", u.raw, u.rawName, u.count, "", ""]));
  distinct.customers.forEach((u) => sheet.addRow(["customer", u.raw, u.rawName, u.count, "", "", u.rawAddress ?? "", u.rawTerritory ?? ""]));
  [10, 24, 32, 8, 16, 20, 40, 20].forEach((w, i) => { sheet.getColumn(i + 1).width = w; });
  return workbook.xlsx.writeBuffer();
}

const UNMAPPED_LIST_TYPES = new Set<MappingInput["type"]>(["product", "territory", "customer"]);

/** The mappings a filled unmapped list carries: every row whose Phoenix Code was filled in. */
export async function parseUnmappedWorkbook(buffer: ArrayBuffer | Buffer, distributorCode?: string): Promise<MappingInput[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  const idx: Record<string, number> = {};
  sheet.getRow(1).eachCell({ includeEmpty: false }, (c, col) => { idx[String(c.text).trim().toLowerCase()] = col; });
  const typeCol = idx["type"]; const rawCol = idx["raw code"]; const fillCol = idx["phoenix code (fill)"];
  if (!typeCol || !rawCol || !fillCol) throw new Error("This is not a valid unmapped-list workbook (missing Type / Raw code / Phoenix Code columns).");
  const mappings: MappingInput[] = [];
  for (let r = 2; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const type = String(row.getCell(typeCol)?.text ?? "").trim().toLowerCase() as MappingInput["type"];
    const raw = String(row.getCell(rawCol)?.text ?? "").trim();
    const code = String(row.getCell(fillCol)?.text ?? "").trim();
    if (UNMAPPED_LIST_TYPES.has(type) && raw && code) mappings.push({ code, distributorCode, raw, row: r, type });
  }
  return mappings;
}

// How many rejected rows one upload's history record keeps, and how long each cell may run — the
// customer map import's bounds (customer-map.ts), for its reason: writeAuditLog sends with a
// 3-second timeout and drops a failed write silently, so only a pathological sheet is ever cut and
// the record itself always saves.
export const UNMAPPED_LIST_REJECTED_ROWS_KEPT = 5000;
const REJECTED_RAW_MAX = 200;
const REJECTED_REASON_MAX = 400;

/**
 * The rejected rows of one "Upload filled list", in the shape its history record keeps them. The
 * upload used to report only "N invalid": which rows and why reached the browser once, the notice
 * printed the count alone, and no record held them — a mistyped Brick ID could not be found again.
 */
export function unmappedListRejectedRecord(entries: InvalidEntry[]): {
  note: string;
  values: { rejectedRows: InvalidEntry[]; rejectedRowsKept: number };
} {
  const kept = [...entries]
    .sort((a, b) => (a.row ?? 0) - (b.row ?? 0))
    .slice(0, UNMAPPED_LIST_REJECTED_ROWS_KEPT)
    .map((e) => ({ ...(e.row ? { row: e.row } : {}), raw: e.raw.slice(0, REJECTED_RAW_MAX), reason: e.reason.slice(0, REJECTED_REASON_MAX), type: e.type }));
  const note = entries.length === 0
    ? ""
    : kept.length === entries.length
      ? " (each listed in this record)"
      : ` (the first ${kept.length} listed in this record)`;
  return { note, values: { rejectedRows: kept, rejectedRowsKept: kept.length } };
}

export async function learnFromUploadedMappings(buffer: ArrayBuffer | Buffer, distributorCode?: string, actorLoginId = "system"): Promise<{ saved: number; skipped: number; invalid: number }> {
  const mappings = await parseUnmappedWorkbook(buffer, distributorCode);
  if (mappings.length === 0) return { saved: 0, skipped: 0, invalid: 0 };
  // Customer rows keep saveMappings' protective default: an existing crosswalk row is corrected, but
  // an owner ruling (confidence 100) is never overwritten from a file.
  const result = await saveMappings(mappings);
  // The rejected rows ride on the upload's own history record, so the list outlives the notice that
  // counted them — the record the customer map import keeps for its blocked rows.
  const rejectedRecord = unmappedListRejectedRecord(result.invalidEntries);
  const from = distributorLabel(distributorCode);
  await writeAuditLog({
    actorLoginId,
    entityId: "source_of_sales_unmapped_list",
    entityType: "sales_import_batch",
    newValues: { distributor_code: normalizeCodeKey(distributorCode) || null, filled: mappings.length, invalid: result.invalid, ...rejectedRecord.values, saved: result.saved, skipped: result.skipped, skippedOwnerVerified: result.skippedOwnerVerified, source: "unmapped_list_upload" },
    summary: `Unmapped list upload${from ? ` for ${from}` : ""} — ${mappings.length} filled rows: ${result.saved} learned, ${result.skipped} already known, ${result.invalid} rejected${rejectedRecord.note}.`,
  });
  return result;
}
