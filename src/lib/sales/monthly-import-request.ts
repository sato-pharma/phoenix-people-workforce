import type { UnmappedCustomer } from "@/lib/sales/brick-suggestions";
import type { ImportPreviewDiff } from "@/lib/sales/import-preview";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { salesSpreadsheetValidation, validateSpreadsheetFile } from "@/lib/uploads/spreadsheets";

// Shared request resolver for the Source of Sales monthly-import endpoints (preview / commit).
// Handles BOTH transport paths identically:
//   • Large file (JSON body with `storagePath`): the browser already uploaded the workbook straight
//     to the `sales-imports` Storage bucket (bypassing the ~4.5MB serverless body cap). We download it.
//   • Small file (multipart body): the workbook arrives directly in the form.
// `storagePath` is returned so the caller decides its lifecycle — PREVIEW keeps it (so COMMIT can reuse
// the same object), COMMIT deletes it after persisting.

export const SALES_IMPORT_BUCKET = "sales-imports";

const SPREADSHEET_VALIDATION = {
  ...salesSpreadsheetValidation,
  emptyError: "invalid_sales_file",
  emptyMessage: "Sales workbook is empty.",
  tooLargeError: "sales_file_too_large",
  tooLargeMessage: "Sales workbook exceeds the 10MB upload limit.",
  unsupportedError: "unsupported_sales_file_type",
  unsupportedMessage: "Upload a distributor monthly sales sheet in .xls or .xlsx format.",
} as const;

export type ResolvedSalesUpload =
  | { ok: true; distributorCode: string; file: File; period: string; previewDiff: ImportPreviewDiff | null; unmappedCustomers: UnmappedCustomer[]; storagePath: string | null }
  | { ok: false; code?: string; error: string; status: number };

export async function resolveSalesUploadRequest(request: Request): Promise<ResolvedSalesUpload> {
  let file: File | null = null;
  let distributorCode = "";
  let period = "";
  let storagePath: string | null = null;
  const contentType = request.headers.get("content-type") ?? "";

  let previewDiff: ImportPreviewDiff | null = null;
  let unmappedCustomers: UnmappedCustomer[] = [];

  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as {
      storagePath?: string;
      distributorCode?: string;
      period?: string;
      previewDiff?: ImportPreviewDiff;
      unmappedCustomers?: UnmappedCustomer[];
    };
    distributorCode = String(body?.distributorCode ?? "").trim();
    period = String(body?.period ?? "").trim();
    previewDiff = body?.previewDiff ?? null;
    unmappedCustomers = Array.isArray(body?.unmappedCustomers) ? body.unmappedCustomers : [];
    const path = String(body?.storagePath ?? "").trim();
    if (!path) return { error: "Uploaded file reference is missing.", ok: false, status: 400 };
    storagePath = path;
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.storage.from(SALES_IMPORT_BUCKET).download(path);
    if (error || !data) {
      return { error: "Uploaded workbook was not found in storage. Please re-upload.", ok: false, status: 400 };
    }
    const buffer = Buffer.from(await data.arrayBuffer());
    const fileName = path.split("/").pop() ?? "upload.xlsx";
    file = new File([buffer], fileName, {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  } else {
    const formData = await request.formData();
    const formFile = formData.get("file");
    file = formFile instanceof File ? formFile : null;
    distributorCode = String(formData.get("distributorCode") ?? "").trim();
    period = String(formData.get("period") ?? "").trim();
    // Small-file path also carries the reviewed diff + unmapped details (JSON strings) so a coverage
    // snapshot is recorded for these imports too.
    const rawDiff = formData.get("previewDiff");
    if (typeof rawDiff === "string" && rawDiff) {
      try { previewDiff = JSON.parse(rawDiff) as ImportPreviewDiff; } catch { previewDiff = null; }
    }
    const rawUnmapped = formData.get("unmappedCustomers");
    if (typeof rawUnmapped === "string" && rawUnmapped) {
      try {
        const parsed = JSON.parse(rawUnmapped) as unknown;
        unmappedCustomers = Array.isArray(parsed) ? (parsed as UnmappedCustomer[]) : [];
      } catch { unmappedCustomers = []; }
    }
  }

  if (!file) return { error: "Sales workbook file is required.", ok: false, status: 400 };
  if (!distributorCode) return { error: "Distributor is required.", ok: false, status: 400 };

  const fileValidation = validateSpreadsheetFile(file, SPREADSHEET_VALIDATION);
  if (!fileValidation.ok) {
    return { code: fileValidation.error, error: fileValidation.message, ok: false, status: fileValidation.status };
  }

  return { distributorCode, file, ok: true, period, previewDiff, unmappedCustomers, storagePath };
}

/** Best-effort delete of a large-file storage object (no-op for the small-file path). */
export async function removeSalesUploadObject(storagePath: string | null): Promise<void> {
  if (!storagePath) return;
  await getSupabaseAdmin().storage.from(SALES_IMPORT_BUCKET).remove([storagePath]).catch(() => {});
}
