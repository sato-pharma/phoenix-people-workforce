import { SalesWorkflowError } from "@/lib/sales/contracts";
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
// SCOPE OF THIS GUARD — stated plainly, because the gap matters.
// It refuses a commit when the SAME distributor already has a batch with the SAME file name in a
// DIFFERENT period. That is exactly the shape above, and it works retroactively against every batch
// already in the table, with no schema change and no backfill.
//
// It does NOT catch the same content uploaded under a renamed file. Catching that needs a content
// hash stored on the batch, which needs a new column and a change to the batch insert; the insert
// has nine call sites in a 4,000-line module, so that is deliberately left as a follow-up rather
// than threaded through at speed. `source_of_sales_import_batches` has no hash column today —
// verified against information_schema, not assumed.
//
// Re-uploading the SAME period is untouched: that is the legitimate replace flow.

export type DuplicateUploadMatch = {
  id: string;
  period: string | null;
  fileName: string;
  totalRows: number;
  totalValue: number;
};

/**
 * Find a previously committed batch for this distributor that used the same file name under a
 * different period. Blocked batches are ignored — they never became sales.
 */
export async function findDuplicateUploadBatch(input: {
  distributorCode: string;
  fileName: string;
  period: string | null;
}): Promise<DuplicateUploadMatch | null> {
  const fileName = input.fileName.trim();
  if (!fileName) return null;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("source_of_sales_import_batches")
    .select("id,period,file_name,total_rows,total_value,status")
    .eq("distributor_code", input.distributorCode)
    .eq("file_name", fileName)
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

  const clash = (data ?? []).find((row) => {
    const rowPeriod = typeof row.period === "string" ? row.period : null;
    return rowPeriod !== (input.period ?? null);
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

export function duplicateUploadMessage(match: DuplicateUploadMatch, period: string | null): string {
  return (
    `This file has already been imported for ${match.period ?? "another period"} ` +
    `(${match.totalRows.toLocaleString("en-GB")} rows, ` +
    `${match.totalValue.toLocaleString("en-GB", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} EGP). ` +
    `Importing it again as ${period ?? "this period"} would count the same sales twice and leave ` +
    `the other month unloaded. If this really is a different month's data, re-export it from the ` +
    `distributor; if you meant to replace ${match.period ?? "that period"}, import it under that period instead.`
  );
}

/**
 * Refuse a commit that would load the same workbook into a second period.
 *
 * Call before persisting, never on a dry run — the preview must still be able to show the user what
 * the file contains.
 */
export async function assertNotADuplicateUpload(input: {
  distributorCode: string;
  fileName: string;
  period: string | null;
}): Promise<void> {
  const match = await findDuplicateUploadBatch(input);
  if (!match) return;
  throw new SalesWorkflowError("duplicate_upload", duplicateUploadMessage(match, input.period), 409, {
    existingBatchId: match.id,
    existingPeriod: match.period,
  });
}
