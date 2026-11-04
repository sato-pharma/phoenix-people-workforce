import { SalesWorkflowError } from "@/lib/sales/contracts";
import { isOfficeDistributorCode } from "@/lib/sales/office-distributor";
import { repriceValue, type ProductPeriodPrices } from "@/lib/sales/product-period-price";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// Nothing compared an incoming distributor workbook against what was already loaded, so the same
// file could be committed twice under two different months.
//
// It happened. Measured on production 2026-09-05, IS-S:
//
//   2026-04  Monthly_Sales_by_Client_for_SATO_PHARMA_(PAS)20260603015619.xlsx  1,141 rows  349,266.46
//   2026-05  Monthly_Sales_by_Client_for_SATO_PHARMA_(PAS)20260603015619.xlsx  1,141 rows  349,266.46
//
// Byte-for-byte the same upload, both `validated`. One month is counted twice and the other was
// never loaded at all — and the filename's own timestamp (20260603) says it was downloaded in June,
// so it is one month's file wearing two months' labels. March (399,890.48) and June (396,038.78)
// are distinct files with distinct totals, which is what makes the pair stand out.
//
// WHAT COUNTS AS THE SAME FILE — owner decision, 2026-09-17: the name AND the figures. The same
// distributor, the same file name, the same total_rows, total_qty and total_value, under a
// DIFFERENT period.
//
// The first version of this guard matched the name alone, and that refuses real months:
//
//  - Distributors export every month under one fixed name. Measured on production 2026-09-17:
//    17 non-blocked batches share their name with another month, across 5 distributors, and only
//    the IS-S pair above shares its figures too. A name-only rule refuses the next month from each
//    of the other four.
//  - A workbook over ~4 MB travels through Storage, whose object name keeps only [A-Za-z0-9._-]
//    (sanitizeSalesImportFileName), and the server rebuilds the File from that object name. An
//    all-Arabic name arrives as `.xlsx`, so every month of a distributor's large Arabic workbook
//    carries the same name.
//
// The figures decide; the name stops two different files that happen to total the same from
// colliding.
//
// WHERE IT RUNS — inside the two save steps, just before the batch row is written, because only
// there are the figures known: persistDistributorSalesUpload (Monthly Import, Office, Direct, the
// Normalizer's validated import) and persistNormalizedBatch (Upload Sales, the Normalizer's raw
// import). It used to run in the Monthly Import commit route alone, which left every other monthly
// upload screen with no cross-month check at all.
//
// It does NOT catch the same content uploaded under a renamed file; that needs a content hash
// stored on the batch, and `source_of_sales_import_batches` has no hash column.
//
// Re-uploading the SAME period is untouched: that is the legitimate replace flow.

export type DuplicateUploadMatch = {
  id: string;
  period: string | null;
  fileName: string;
  totalRows: number;
  totalValue: number;
};

/** The batch a save step is about to write: its file name, its period and the figures it stores. */
export type DuplicateUploadCandidate = {
  fileName: string;
  period: string | null;
  totalRows: number;
  totalQty: number;
  totalValue: number;
  /**
   * What this file's value WOULD have been, stored under another month. Rows are valued at the price
   * of their own month (Saginko: 111.15 through 2026-09, 170.52 from 2026-10), so the same workbook
   * stored under September and again under October carries two different totals — and comparing it
   * with `totalValue` would let exactly the re-dated duplicate this guard exists for walk through.
   * Absent, the stored figure is compared as it always was.
   */
  totalValueAt?: (period: string | null) => number;
  /**
   * What this file's quantity WOULD have been, stored under another month. EPDA's bonus deduction
   * starts at 2026-10, so a September file loaded again as October stores fewer units than the same
   * file did in September. Absent, the stored quantity is compared as it always was.
   */
  totalQtyAt?: (period: string | null) => number;
};

/** One row of the file being saved, as totalValueAtPeriod re-prices it. */
export type RepriceableUploadRow = {
  /**
   * The row's value does not follow its month's price, so it never moves. A direct row is a deal at its
   * own price; an Office row is units × the MASTER price in every month (the owner's locked Office rule,
   * office-allocation.ts), so re-pricing it would make September's Office file, loaded again as
   * October, read as a different file.
   */
  keepsValue: boolean;
  period: string | null;
  productCode: string;
  value: number;
};

/** A row of the file being saved, as totalValueAtPeriod reads it: Direct and Office keep their value. */
export function repriceableUploadRow(row: {
  distributorCode: string | null | undefined;
  isDirect: boolean;
  period: string | null;
  productCode: string;
  value: number;
}): RepriceableUploadRow {
  return {
    keepsValue: row.isDirect || isOfficeDistributorCode(row.distributorCode),
    period: row.period,
    productCode: row.productCode,
    value: row.value,
  };
}

/**
 * The file's total if every row were dated `atPeriod`: each distributor row's stored value moved from
 * its own month's price to `atPeriod`'s (repriceValue). A row that keeps its value (Direct, Office)
 * never moves, and a product with the same price in both months adds its value untouched — so on any
 * file the reprice does not reach, this is exactly `totalValue`.
 */
export function totalValueAtPeriod(
  rows: readonly RepriceableUploadRow[],
  prices: Pick<ProductPeriodPrices, "priceFor">,
  atPeriod: string | null,
): number {
  let total = 0;
  for (const row of rows) {
    const value = Number.isFinite(row.value) ? row.value : 0;
    total += row.keepsValue ? value : repriceValue(prices, row.productCode, value, row.period, atPeriod);
  }
  return total;
}

/** A stored batch as the lookup reads it. A numeric column can arrive as a string. */
export type StoredUploadBatch = {
  id: unknown;
  period: unknown;
  file_name: unknown;
  status: unknown;
  total_rows: unknown;
  total_qty: unknown;
  total_value: unknown;
};

// total_qty and total_value are numeric(18,6), and both save steps build them as float sums — one
// rounds to 6 places before the insert, the other leaves the rounding to Postgres. The same file
// can therefore come back a few millionths apart, never by a thousandth or by half a piastre, and
// two real months are never that close on rows, quantity and value at once.
const QTY_TOLERANCE = 0.0005;
const VALUE_TOLERANCE = 0.005;

/**
 * The first stored batch that is this same file under a different period, or null. Pure: the
 * database query only narrows the rows, this decides.
 */
export function pickDuplicateUploadClash(
  rows: readonly StoredUploadBatch[],
  candidate: DuplicateUploadCandidate,
): DuplicateUploadMatch | null {
  const fileName = candidate.fileName.trim();
  // An empty sheet matches every other empty sheet; that is never the same month loaded twice.
  if (!fileName || !(candidate.totalRows > 0)) return null;
  const period = candidate.period ?? null;

  const clash = rows.find((row) => {
    if (row.status === "blocked") return false;
    if (row.file_name !== fileName) return false;
    const rowPeriod = typeof row.period === "string" ? row.period : null;
    if (rowPeriod === period) return false;
    if (Number(row.total_rows) !== candidate.totalRows) return false;
    // On the stored batch's own price basis — see DuplicateUploadCandidate.totalValueAt.
    const candidateValue = candidate.totalValueAt ? candidate.totalValueAt(rowPeriod) : candidate.totalValue;
    const candidateQty = candidate.totalQtyAt ? candidate.totalQtyAt(rowPeriod) : candidate.totalQty;
    return (
      Math.abs(Number(row.total_qty) - candidateQty) < QTY_TOLERANCE &&
      Math.abs(Number(row.total_value) - candidateValue) < VALUE_TOLERANCE
    );
  });
  if (!clash) return null;

  return {
    fileName: String(clash.file_name),
    id: String(clash.id),
    period: typeof clash.period === "string" ? clash.period : null,
    totalRows: Number(clash.total_rows ?? 0),
    totalValue: Number(clash.total_value ?? 0),
  };
}

/**
 * Find a previously committed batch for this distributor that is the same file — same name, same
 * figures — under a different period. Blocked batches are ignored — they never became sales.
 */
export async function findDuplicateUploadBatch(
  input: DuplicateUploadCandidate & { distributorCode: string },
): Promise<DuplicateUploadMatch | null> {
  const fileName = input.fileName.trim();
  if (!fileName || !(input.totalRows > 0)) return null;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("source_of_sales_import_batches")
    .select("id,period,file_name,status,total_rows,total_qty,total_value")
    .eq("distributor_code", input.distributorCode)
    .eq("file_name", fileName)
    .eq("total_rows", input.totalRows)
    .neq("status", "blocked")
    .limit(50);

  // A guard that cannot read must not silently pass. But it must not block a legitimate import on
  // an unrelated outage either, so this surfaces as a workflow error the caller can see rather than
  // as a swallowed null.
  if (error) {
    throw new SalesWorkflowError(
      "duplicate_check_failed",
      `Could not check whether this file has already been imported: ${error.message}`,
      503,
    );
  }

  return pickDuplicateUploadClash(data ?? [], { ...input, fileName });
}

export function duplicateUploadMessage(match: DuplicateUploadMatch, period: string | null): string {
  const earlier = match.period ?? "that period";
  return (
    `This file has already been imported for ${match.period ?? "another period"} with the same name and the same figures ` +
    `(${match.totalRows.toLocaleString("en-GB")} rows, ` +
    `${match.totalValue.toLocaleString("en-GB", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} EGP). ` +
    `Importing it again as ${period ?? "this period"} would count the same sales twice and leave ` +
    `the other month unloaded. If this really is a different month's data, re-export it from the ` +
    `distributor. If you meant to replace ${earlier}, import it under that period instead; if ${earlier} ` +
    `was the wrong month for it, delete that upload first.`
  );
}

/**
 * Refuse a save that would load the same workbook into a second period.
 *
 * Called by the save steps just before the batch row is written, never on a dry run, so the
 * preview can still show the user what the file contains.
 */
export async function assertNotADuplicateUpload(
  input: DuplicateUploadCandidate & { distributorCode: string },
): Promise<void> {
  const match = await findDuplicateUploadBatch(input);
  if (!match) return;
  throw new SalesWorkflowError("duplicate_upload", duplicateUploadMessage(match, input.period), 409, {
    existingBatchId: match.id,
    existingPeriod: match.period,
  });
}
