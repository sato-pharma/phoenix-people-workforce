import { SalesWorkflowError } from "@/lib/sales/contracts";
import { applyEpdaBonusDeduction } from "@/lib/sales/import-epda-bonus-deduction";
import { assertNotADuplicateUpload, repriceableUploadRow, totalValueAtPeriod } from "@/lib/sales/import-duplicate-guard";
import { loadProductPeriodPrices } from "@/lib/sales/product-period-price";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// ONE FRONT DOOR FOR THE MONEY RULES OF A SALES IMPORT (enterprise audit REC-008, F-SAL-003; 14 Nov 2026).
//
// Three screens load a distributor's sales: Monthly Import (/sales/import), the Sales Upload
// (/sales/upload) and the Source Normalizer (/sales/normalizer). They reach two writers —
// `persistDistributorSalesUpload` (monthly-distributor-import.ts; the Office upload and the
// Normalizer's one-click import land there too) and `persistNormalizedBatch` (normalizer/service.ts; the
// Sales Upload's commit lands there). Each writer used to apply the import's money rules itself, so a rule
// wired into one and missed in the other changed the figures of only some uploads — and one had been
// missed: the Normalizer writer never refused a LOCKED month before writing, so its rows were written and
// only the database's own lock caught them, leaving an orphaned pending batch.
//
// `applyImportStoreRules` is now the only place those rules run, in this order, before a batch row
// exists:
//   1. EPDA's bonus deduction (import-epda-bonus-deduction.ts) — only on a batch that will count as sales;
//      a blocked batch is kept as the sheet said.
//   2. A locked month is refused (`assertPeriodNotLocked`), and a month whose lock cannot be read too.
//   3. The same workbook already stored under another month is refused (import-duplicate-guard.ts), on
//      each stored batch's own month's price and deduction — only for a batch that will count as sales.
//      The same BYTES (the file's fingerprint, REC-069) under another month or another distributor are
//      refused first, whatever the file is called.
// Both writers store exactly the rows and totals it returns. A new money rule for imports goes HERE.
// ─────────────────────────────────────────────────────────────────────────────

/** The slice of the client the lock read uses — structural, so a test can hand it a fake. */
export type PeriodLockReader = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: unknown) => {
        eq: (column: string, value: unknown) => {
          maybeSingle: () => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
        };
      };
    };
  };
};

// PostgREST answers a missing table with PGRST205 and Postgres with 42P01 — the only two errors
// that mean "this deployment has no lock table", which is the one case read as "not locked".
const MISSING_TABLE_CODES = new Set(["PGRST205", "42P01"]);

// Period lock guard — once a Monthly Sales period is locked, all uploads/deletes for that period are
// rejected until it is re-opened. Tolerant of a missing lock table (pre-migration = not locked) so it
// never blocks a normal upload before the Monthly Sales migration is applied.
//
// 🔴 ANY OTHER READ ERROR REFUSES, with a 503 (audit S-SAL-09, 2026-10-23). It used to return as
// "not locked" on every error, so a timeout let an upload for a LOCKED month write its rows; the SQL
// lock caught it only after the rows were inserted, leaving an orphan pending batch behind. A month
// whose lock cannot be read is not a month known to be open.
export async function assertPeriodNotLocked(period: string | null, client?: PeriodLockReader): Promise<void> {
  if (!period) return;
  const supabase = client ?? (getSupabaseAdmin() as unknown as PeriodLockReader);
  const { data, error } = await supabase
    .from("monthly_sales_period_lock")
    .select("locked")
    .eq("period", period)
    .eq("locked", true)
    .maybeSingle();
  if (error) {
    if (MISSING_TABLE_CODES.has(String(error.code ?? ""))) return;
    throw new SalesWorkflowError(
      "period_lock_unreadable",
      `Could not check whether ${period} is locked, so nothing was changed. Try again in a minute.`,
      503,
    );
  }
  if (data) {
    throw new SalesWorkflowError(
      "period_locked",
      `${period} is locked. Re-open the Monthly Sales closing for ${period} before changing its uploads.`,
      409,
    );
  }
}


/** What every sales row must carry for the import's money rules. */
export type StoreRuleRow = {
  areaCode: string | null;
  distributorCode: string;
  isDirect?: boolean | null;
  productCode: string;
  qty: number;
  value: number;
};

function sumOf<R extends StoreRuleRow>(rows: readonly R[], pick: (row: R) => number): number {
  return rows.reduce((sum, row) => {
    const value = pick(row);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
}

/**
 * What a test hands the door instead of the database. Every writer passes nothing, so the lock, the
 * prices and the duplicate lookup are the live ones.
 */
export type ImportStoreRuleSeams = {
  lockReader?: PeriodLockReader;
  loadPrices?: typeof loadProductPeriodPrices;
  assertNotADuplicate?: typeof assertNotADuplicateUpload;
};

/**
 * The money rules of one sales import, applied once for every screen (header above). Returns the rows to
 * store and their totals, rounded as the batch row stores them. Throws a `SalesWorkflowError` for a
 * locked or unreadable month, or the duplicate guard's refusal, before anything is written.
 */
export async function applyImportStoreRules<R extends StoreRuleRow>(input: {
  /** The month the batch is stored under. */
  period: string | null;
  distributorCode: string;
  fileName: string;
  /** The rows exactly as the sheet gave them. */
  sheetRows: R[];
  /** True when the batch will count as sales (validated); a blocked batch is kept as the sheet said. */
  countsAsSales: boolean;
  /** The month a row's EPDA deduction is judged by. */
  deductionMonthOf: (row: R) => string | null | undefined;
  /** The month a row is priced by when the stored batches are compared. */
  priceMonthOf: (row: R) => string | null;
  /** The distributor a row is priced as. */
  priceDistributorOf: (row: R) => string | null | undefined;
  /** The row count the batch row stores. */
  totalRows: number;
  /** The sheet's own totals, stored as they are when no deduction changed a row. */
  sheetTotals?: { totalQty: number; totalValue: number };
  /**
   * The fingerprint of the bytes the batch is read from (upload-fingerprint.ts, REC-069). The same bytes
   * under another month or distributor are refused in step 3; absent, only name and figures are compared.
   */
  fileSha256?: string | null;
}, seams: ImportStoreRuleSeams = {}): Promise<{ rows: R[]; deducted: boolean; totalQty: number; totalValue: number }> {
  // 1. EPDA's bonus deduction.
  const rows = input.countsAsSales ? applyEpdaBonusDeduction(input.sheetRows, input.deductionMonthOf) : input.sheetRows;
  const deducted = rows !== input.sheetRows;
  const totals =
    !deducted && input.sheetTotals
      ? input.sheetTotals
      : {
          totalQty: Number(sumOf(rows, (row) => row.qty).toFixed(6)),
          totalValue: Number(sumOf(rows, (row) => row.value).toFixed(6)),
        };

  // 2. A locked month.
  await assertPeriodNotLocked(input.period, seams.lockReader);

  // 3. The same workbook already stored under another month.
  if (input.countsAsSales) {
    const prices = await (seams.loadPrices ?? loadProductPeriodPrices)();
    // Each stored batch is compared as the file would have been stored in ITS month: on that month's
    // price, and with EPDA's deduction only if that month carries it.
    const rowsStoredAt = (atPeriod: string | null) => applyEpdaBonusDeduction(input.sheetRows, () => atPeriod);
    const repriceableAt = (atPeriod: string | null) =>
      rowsStoredAt(atPeriod).map((row) =>
        repriceableUploadRow({
          distributorCode: input.priceDistributorOf(row),
          isDirect: Boolean(row.isDirect),
          period: input.priceMonthOf(row),
          productCode: row.productCode,
          value: row.value,
        }),
      );
    await (seams.assertNotADuplicate ?? assertNotADuplicateUpload)({
      distributorCode: input.distributorCode,
      fileName: input.fileName,
      fileSha256: input.fileSha256 ?? null,
      period: input.period,
      totalRows: input.totalRows,
      totalQty: totals.totalQty,
      totalValue: totals.totalValue,
      totalValueAt: (atPeriod) => totalValueAtPeriod(repriceableAt(atPeriod), prices, atPeriod),
      totalQtyAt: (atPeriod) => sumOf(rowsStoredAt(atPeriod), (row) => row.qty),
    });
  }

  return { rows, deducted, totalQty: totals.totalQty, totalValue: totals.totalValue };
}
