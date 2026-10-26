import type { UnmappedCustomer } from "@/lib/sales/brick-suggestions";
import type { ImportPreviewDiff } from "@/lib/sales/import-preview";
import {
  isOwnSalesImportUploadPath,
  parseSalesImportUploadPath,
  SALES_UPLOAD_PATH_REFUSAL,
  type SalesImportUploadCaller,
} from "@/lib/sales/sales-import-upload-path";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { salesSpreadsheetValidation, spreadsheetTooLargeMessage, spreadsheetUploadLimitBytes, validateSpreadsheetFile } from "@/lib/uploads/spreadsheets";

// Shared request resolver for the Source of Sales monthly-import endpoints (preview / commit).
// Handles BOTH transport paths identically:
//   • Large file (JSON body with `storagePath`): the browser already uploaded the workbook straight
//     to the `sales-imports` Storage bucket (bypassing the ~4.5MB serverless body cap). We download it,
//     but only after matching the path to the caller: it must be an upload slot upload-url minted for
//     them (sales-import-upload-path.ts), or the request is refused with a 400 before any storage call.
//   • Small file (multipart body): the workbook arrives directly in the form.
// `storagePath` is returned so the caller decides its lifecycle — PREVIEW keeps it (so COMMIT can reuse
// the same object), COMMIT deletes it after persisting.

export const SALES_IMPORT_BUCKET = "sales-imports";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const SPREADSHEET_VALIDATION = {
  ...salesSpreadsheetValidation,
  emptyError: "invalid_sales_file",
  emptyMessage: "Sales workbook is empty.",
  tooLargeError: "sales_file_too_large",
  unsupportedError: "unsupported_sales_file_type",
  unsupportedMessage: "Upload a distributor monthly sales sheet in .xls or .xlsx format.",
} as const;

export type ResolvedSalesUpload =
  | { ok: true; distributorCode: string; file: File; period: string; previewDiff: ImportPreviewDiff | null; unmappedCustomers: UnmappedCustomer[]; storagePath: string | null }
  | { ok: false; code?: string; error: string; status: number };

export async function resolveSalesUploadRequest(request: Request, caller: SalesImportUploadCaller): Promise<ResolvedSalesUpload> {
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
    // Before it is returned for cleanup or downloaded: PREVIEW echoes it and COMMIT deletes it.
    if (!isOwnSalesImportUploadPath({ caller, storagePath: path })) return { ...SALES_UPLOAD_PATH_REFUSAL, ok: false, status: 400 };
    storagePath = path;
    file = await downloadSalesUploadFile(path);
    if (!file) {
      return { error: "Uploaded workbook was not found in storage. Please re-upload.", ok: false, status: 400 };
    }
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

  // A workbook that came through the bucket is held to the bucket's limit, not the direct path's:
  // the bucket path exists for the files over 4 MB (audit F-06).
  const maxBytes = spreadsheetUploadLimitBytes(storagePath !== null);
  const fileValidation = validateSpreadsheetFile(file, {
    ...SPREADSHEET_VALIDATION,
    maxBytes,
    tooLargeMessage: spreadsheetTooLargeMessage("The sales workbook", maxBytes),
  });
  if (!fileValidation.ok) {
    return { code: fileValidation.error, error: fileValidation.message, ok: false, status: fileValidation.status };
  }

  return { distributorCode, file, ok: true, period, previewDiff, unmappedCustomers, storagePath };
}

// The four service-role storage helpers below are the only storage calls for this bucket outside
// upload-url. Every route has already matched the path to its caller with isOwnSalesImportUploadPath;
// each helper still refuses anything that is not an upload slot, so none of them can ever be pointed
// at another object in the bucket.

/** Service-role download of a large-file upload slot, or null when it is not one or is not there. */
export async function downloadSalesUploadObject(storagePath: string): Promise<Blob | null> {
  if (!parseSalesImportUploadPath(storagePath)) return null;
  const { data, error } = await getSupabaseAdmin().storage.from(SALES_IMPORT_BUCKET).download(storagePath);
  return error || !data ? null : data;
}

/** The uploaded workbook as a File named after its slot, or null when it cannot be downloaded. */
export async function downloadSalesUploadFile(storagePath: string): Promise<File | null> {
  const data = await downloadSalesUploadObject(storagePath);
  if (!data) return null;
  const buffer = Buffer.from(await data.arrayBuffer());
  const fileName = storagePath.split("/").pop() ?? "upload.xlsx";
  return new File([buffer], fileName, { type: XLSX_MIME });
}

/** Best-effort delete of a large-file storage object (no-op for the small-file path). */
export async function removeSalesUploadObject(storagePath: string | null): Promise<void> {
  if (!storagePath || !parseSalesImportUploadPath(storagePath)) return;
  await getSupabaseAdmin().storage.from(SALES_IMPORT_BUCKET).remove([storagePath]).catch(() => {});
}

/** Best-effort delete of one or more large-file storage objects (no-op for the multipart path). */
export async function removeSalesUploadObjects(storagePaths: string[]): Promise<void> {
  const paths = storagePaths.filter((path) => Boolean(path) && parseSalesImportUploadPath(path) !== null);
  if (paths.length === 0) return;
  await getSupabaseAdmin().storage.from(SALES_IMPORT_BUCKET).remove(paths).catch(() => {});
}

export type ResolvedUploadedSpreadsheet =
  // files: every workbook sent, in the order chosen (Sales Upload takes several sheets of one
  // distributor at once); file is the first. storagePaths: every bucket reference to delete afterwards.
  | { ok: true; file: File; files: File[]; field: (name: string) => string; storagePath: string | null; storagePaths: string[] }
  | { ok: false; code?: string; error: string; status: number; storagePaths: string[] };

// Generic upload resolver for the /sales/upload endpoints (analyze / commit / weekly validate). Like
// resolveSalesUploadRequest it accepts BOTH transport paths so large workbooks bypass Vercel's ~4.5MB
// serverless body cap, but it carries no domain-specific fields — the caller reads what it needs via
// field() (works identically for the JSON body and the multipart form) and applies its own spreadsheet
// validation. One workbook or several: a multipart form may repeat "file", a JSON body may send
// storagePaths[] instead of storagePath. The caller owns every returned storage path's lifecycle (delete
// via removeSalesUploadObjects once processing is done, failure included), so a path joins the list
// only after it has been matched to the caller.
export async function resolveUploadedSpreadsheet(request: Request, caller: SalesImportUploadCaller): Promise<ResolvedUploadedSpreadsheet> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const listed = Array.isArray(body?.storagePaths) ? body.storagePaths : [body?.storagePath];
    const requested = listed.map((path) => String(path ?? "").trim()).filter(Boolean);
    const storagePaths: string[] = [];
    if (requested.length === 0) return { error: "Uploaded file reference is missing.", ok: false, status: 400, storagePaths };
    for (const path of requested) {
      if (!isOwnSalesImportUploadPath({ caller, storagePath: path })) return { ...SALES_UPLOAD_PATH_REFUSAL, ok: false, status: 400, storagePaths };
      storagePaths.push(path);
    }
    const files: File[] = [];
    for (const path of storagePaths) {
      const file = await downloadSalesUploadFile(path);
      if (!file) return { error: "Uploaded workbook was not found in storage. Please re-upload.", ok: false, status: 400, storagePaths };
      files.push(file);
    }
    return { field: (name) => String(body?.[name] ?? "").trim(), file: files[0], files, ok: true, storagePath: storagePaths[0], storagePaths };
  }

  const formData = await request.formData();
  const files = formData.getAll("file").filter((entry): entry is File => entry instanceof File);
  if (files.length === 0) return { error: "Sales workbook file is required.", ok: false, status: 400, storagePaths: [] };
  return { field: (name) => String(formData.get(name) ?? "").trim(), file: files[0], files, ok: true, storagePath: null, storagePaths: [] };
}

export type ResolvedWeeklyUpload =
  | { ok: true; storagePaths: string[]; distributorCode: string; periodDate: string | null; weekNumber: number | null; cycleMonth: string | null; notify: boolean; file: File | null; salesFile: File | null; stockFile: File | null }
  | { ok: false; storagePaths: string[]; code: string; error: string; status: number };

// Week-of-month is a 1–4 selector from the upload wizard; anything else is treated as "unset" (the
// service then falls back to the date-derived suggestion). cycleMonth is an optional YYYY-MM-DD override.
function parseWeekNumber(value: unknown): number | null {
  const n = Number(String(value ?? "").trim());
  return n === 1 || n === 2 || n === 3 || n === 4 ? n : null;
}
function parseCycleMonth(value: unknown): string | null {
  const v = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
// "Notify the line managers about this upload" — on unless the wizard explicitly turns it off, so a
// caller that says nothing (an older client, a script) keeps the owner's asked-for behaviour. Only
// the literal false / "false" suppresses; anything else, including an absent field, notifies.
function parseNotifyFlag(value: unknown): boolean {
  if (value === false) return false;
  return String(value ?? "").trim().toLowerCase() !== "false";
}

// Weekly upload transport resolver. Like resolveUploadedSpreadsheet it accepts BOTH transport paths so
// large weekly workbooks bypass Vercel's ~4.5MB serverless body cap, but it additionally understands the
// PS / Overseas dual-file shape (a sales matrix + a stock matrix). For the JSON path the browser has
// already streamed the workbook(s) to the sales-imports bucket and sends only the reference(s):
//   • non-PS → { storagePath, distributorCode, periodDate }
//   • PS     → { salesStoragePath, stockStoragePath, distributorCode, periodDate }
// Files are returned UNVALIDATED — the caller applies its own validateSpreadsheetFile checks exactly as
// the multipart routes did, so error messaging stays identical across both transports. `storagePaths`
// is always returned (even on failure) so the caller can clean up via removeSalesUploadObjects — which
// is why a reference joins it only after it has been matched to the caller.
export async function resolveWeeklyUploadRequest(request: Request, caller: SalesImportUploadCaller): Promise<ResolvedWeeklyUpload> {
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
      weekNumber: parseWeekNumber(formData.get("weekNumber")),
      cycleMonth: parseCycleMonth(formData.get("cycleMonth")),
      notify: parseNotifyFlag(formData.get("notify")),
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
    weekNumber?: number | string;
    cycleMonth?: string;
    notify?: boolean | string;
  };
  const distributorCode = String(body?.distributorCode ?? "").trim();
  const periodDate = String(body?.periodDate ?? "").trim() || null;
  const weekNumber = parseWeekNumber(body?.weekNumber);
  const cycleMonth = parseCycleMonth(body?.cycleMonth);
  const notify = parseNotifyFlag(body?.notify);

  const storagePaths: string[] = [];

  if (distributorCode.toUpperCase() === "PS") {
    const salesPath = String(body?.salesStoragePath ?? "").trim();
    const stockPath = String(body?.stockStoragePath ?? "").trim();
    if (!salesPath || !stockPath) {
      return { code: "invalid_weekly_file", error: "Both Overseas POS file references are required.", ok: false, status: 400, storagePaths };
    }
    if (
      !isOwnSalesImportUploadPath({ caller, storagePath: salesPath }) ||
      !isOwnSalesImportUploadPath({ caller, storagePath: stockPath })
    ) {
      return { ...SALES_UPLOAD_PATH_REFUSAL, ok: false, status: 400, storagePaths };
    }
    storagePaths.push(salesPath, stockPath);
    const [salesFile, stockFile] = await Promise.all([downloadSalesUploadFile(salesPath), downloadSalesUploadFile(stockPath)]);
    if (!salesFile || !stockFile) {
      return { code: "invalid_weekly_file", error: "Uploaded workbook was not found in storage. Please re-upload.", ok: false, status: 400, storagePaths };
    }
    return { distributorCode, file: null, ok: true, periodDate, weekNumber, cycleMonth, notify, salesFile, stockFile, storagePaths };
  }

  const path = String(body?.storagePath ?? "").trim();
  if (!path) {
    return { code: "invalid_weekly_file", error: "Uploaded file reference is missing.", ok: false, status: 400, storagePaths };
  }
  if (!isOwnSalesImportUploadPath({ caller, storagePath: path })) {
    return { ...SALES_UPLOAD_PATH_REFUSAL, ok: false, status: 400, storagePaths };
  }
  storagePaths.push(path);
  const file = await downloadSalesUploadFile(path);
  if (!file) {
    return { code: "invalid_weekly_file", error: "Uploaded workbook was not found in storage. Please re-upload.", ok: false, status: 400, storagePaths };
  }
  return { distributorCode, file, ok: true, periodDate, weekNumber, cycleMonth, notify, salesFile: null, stockFile: null, storagePaths };
}
