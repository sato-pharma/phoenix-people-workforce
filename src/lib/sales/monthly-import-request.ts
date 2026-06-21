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

/** Best-effort delete of one or more large-file storage objects (no-op for the multipart path). */
export async function removeSalesUploadObjects(storagePaths: string[]): Promise<void> {
  const paths = storagePaths.filter((path) => Boolean(path));
  if (paths.length === 0) return;
  await getSupabaseAdmin().storage.from(SALES_IMPORT_BUCKET).remove(paths).catch(() => {});
}

export type ResolvedUploadedSpreadsheet =
  | { ok: true; file: File; field: (name: string) => string; storagePath: string | null }
  | { ok: false; error: string; status: number };

// Generic single-file upload resolver for the /sales/upload endpoints (analyze / commit / weekly
// validate). Like resolveSalesUploadRequest it accepts BOTH transport paths so large workbooks bypass
// Vercel's ~4.5MB serverless body cap, but it carries no domain-specific fields — the caller reads what
// it needs via field() (works identically for the JSON body and the multipart form) and applies its own
// spreadsheet validation. The caller owns the returned storagePath's lifecycle (delete via
// removeSalesUploadObject once processing is done).
export async function resolveUploadedSpreadsheet(request: Request): Promise<ResolvedUploadedSpreadsheet> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const path = String(body?.storagePath ?? "").trim();
    if (!path) return { error: "Uploaded file reference is missing.", ok: false, status: 400 };
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.storage.from(SALES_IMPORT_BUCKET).download(path);
    if (error || !data) {
      return { error: "Uploaded workbook was not found in storage. Please re-upload.", ok: false, status: 400 };
    }
    const buffer = Buffer.from(await data.arrayBuffer());
    const fileName = path.split("/").pop() ?? "upload.xlsx";
    const file = new File([buffer], fileName, {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    return { field: (name) => String(body?.[name] ?? "").trim(), file, ok: true, storagePath: path };
  }

  const formData = await request.formData();
  const formFile = formData.get("file");
  const file = formFile instanceof File ? formFile : null;
  if (!file) return { error: "Sales workbook file is required.", ok: false, status: 400 };
  return { field: (name) => String(formData.get(name) ?? "").trim(), file, ok: true, storagePath: null };
}

export type ResolvedWeeklyUpload =
  | { ok: true; storagePaths: string[]; distributorCode: string; periodDate: string | null; file: File | null; salesFile: File | null; stockFile: File | null }
  | { ok: false; storagePaths: string[]; code: string; error: string; status: number };

const WEEKLY_XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Weekly upload transport resolver. Like resolveUploadedSpreadsheet it accepts BOTH transport paths so
// large weekly workbooks bypass Vercel's ~4.5MB serverless body cap, but it additionally understands the
// PS / Overseas dual-file shape (a sales matrix + a stock matrix). For the JSON path the browser has
// already streamed the workbook(s) to the sales-imports bucket and sends only the reference(s):
//   • non-PS → { storagePath, distributorCode, periodDate }
//   • PS     → { salesStoragePath, stockStoragePath, distributorCode, periodDate }
// Files are returned UNVALIDATED — the caller applies its own validateSpreadsheetFile checks exactly as
// the multipart routes did, so error messaging stays identical across both transports. `storagePaths`
// is always returned (even on failure) so the caller can clean up via removeSalesUploadObjects.
export async function resolveWeeklyUploadRequest(request: Request): Promise<ResolvedWeeklyUpload> {
  const contentType = request.headers.get("content-type") ?? "";

  if (!contentType.includes("application/json")) {
    const formData = await request.formData();
    const distributorCode = String(formData.get("distributorCode") ?? "").trim();
    const periodDate = String(formData.get("periodDate") ?? "").trim() || null;
    const single = formData.get("file");
    const sales = formData.get("salesFile");
    const stock = formData.get("stockFile");
    return {
      distributorCode,
      file: single instanceof File ? single : null,
      ok: true,
      periodDate,
      salesFile: sales instanceof File ? sales : null,
      stockFile: stock instanceof File ? stock : null,
      storagePaths: [],
    };
  }

  const body = (await request.json().catch(() => ({}))) as {
    storagePath?: string;
    salesStoragePath?: string;
    stockStoragePath?: string;
    distributorCode?: string;
    periodDate?: string;
  };
  const distributorCode = String(body?.distributorCode ?? "").trim();
  const periodDate = String(body?.periodDate ?? "").trim() || null;

  const supabase = getSupabaseAdmin();
  const storagePaths: string[] = [];
  const downloadOne = async (path: string): Promise<File | null> => {
    const { data, error } = await supabase.storage.from(SALES_IMPORT_BUCKET).download(path);
    if (error || !data) return null;
    const buffer = Buffer.from(await data.arrayBuffer());
    const fileName = path.split("/").pop() ?? "upload.xlsx";
    return new File([buffer], fileName, { type: WEEKLY_XLSX_MIME });
  };

  if (distributorCode.toUpperCase() === "PS") {
    const salesPath = String(body?.salesStoragePath ?? "").trim();
    const stockPath = String(body?.stockStoragePath ?? "").trim();
    if (!salesPath || !stockPath) {
      return { code: "invalid_weekly_file", error: "Both Overseas POS file references are required.", ok: false, status: 400, storagePaths };
    }
    storagePaths.push(salesPath, stockPath);
    const [salesFile, stockFile] = await Promise.all([downloadOne(salesPath), downloadOne(stockPath)]);
    if (!salesFile || !stockFile) {
      return { code: "invalid_weekly_file", error: "Uploaded workbook was not found in storage. Please re-upload.", ok: false, status: 400, storagePaths };
    }
    return { distributorCode, file: null, ok: true, periodDate, salesFile, stockFile, storagePaths };
  }

  const path = String(body?.storagePath ?? "").trim();
  if (!path) {
    return { code: "invalid_weekly_file", error: "Uploaded file reference is missing.", ok: false, status: 400, storagePaths };
  }
  storagePaths.push(path);
  const file = await downloadOne(path);
  if (!file) {
    return { code: "invalid_weekly_file", error: "Uploaded workbook was not found in storage. Please re-upload.", ok: false, status: 400, storagePaths };
  }
  return { distributorCode, file, ok: true, periodDate, salesFile: null, stockFile: null, storagePaths };
}
