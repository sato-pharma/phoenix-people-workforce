type SpreadsheetValidationOptions = {
  allowedExtensions: readonly string[];
  allowedMimeTypes: readonly string[];
  maxBytes?: number;
  tooLargeError?: string;
  tooLargeMessage?: string;
  unsupportedError?: string;
  unsupportedMessage?: string;
  emptyError?: string;
  emptyMessage?: string;
};

type SpreadsheetValidationResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      message: string;
      status: number;
    };

/**
 * The limit for a spreadsheet POSTed straight to a route. The browser sends anything larger through
 * the `sales-imports` Storage bucket instead (the sales screens switch at this same 4 MB), so this is
 * the direct path's real ceiling.
 */
export const MAX_SPREADSHEET_UPLOAD_BYTES = 4 * 1024 * 1024;

/**
 * The limit for a workbook the browser first put in the `sales-imports` bucket — the bucket's own
 * `file_size_limit` (20 MB, 20260611053634_sales_imports_storage_bucket.sql). That path exists for
 * files over 4 MB, and until 2026-10-23 every route then checked the DOWNLOADED file against the 4 MB
 * direct limit, so the path that exists for big files refused every big file — under a message that
 * said 10 MB (audit F-06).
 */
export const MAX_STORED_SPREADSHEET_UPLOAD_BYTES = 20 * 1024 * 1024;

/** The ceiling for one upload, by the way it arrived. */
export function spreadsheetUploadLimitBytes(viaStorage: boolean): number {
  return viaStorage ? MAX_STORED_SPREADSHEET_UPLOAD_BYTES : MAX_SPREADSHEET_UPLOAD_BYTES;
}

function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return Number.isInteger(mb) ? String(mb) : mb.toFixed(1);
}

/**
 * "<subject> is larger than the 4 MB upload limit." — the figure always comes from the limit that is
 * enforced, never typed beside it. A typed "10MB" next to a 4 MB check is how 30 routes came to tell
 * people a limit they were not held to.
 */
export function spreadsheetTooLargeMessage(subject: string, maxBytes: number = MAX_SPREADSHEET_UPLOAD_BYTES): string {
  return `${subject} is larger than the ${megabytes(maxBytes)} MB upload limit.`;
}

export const excelSpreadsheetValidation = {
  allowedExtensions: [".xls", ".xlsx"],
  allowedMimeTypes: [
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
} as const;

export const xlsxSpreadsheetValidation = {
  allowedExtensions: [".xlsx"],
  allowedMimeTypes: [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
} as const;

export const salesSpreadsheetValidation = {
  allowedExtensions: [".xls", ".xlsx"],
  allowedMimeTypes: [
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
} as const;

function getFileExtension(fileName: string) {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex === -1 ? "" : fileName.slice(dotIndex).toLowerCase();
}

export function validateSpreadsheetFile(
  file: File,
  options: SpreadsheetValidationOptions,
): SpreadsheetValidationResult {
  if (file.size === 0) {
    return {
      ok: false,
      error: options.emptyError ?? "invalid_file",
      message: options.emptyMessage ?? "The uploaded file is empty.",
      status: 400,
    };
  }

  const maxBytes = options.maxBytes ?? MAX_SPREADSHEET_UPLOAD_BYTES;
  if (file.size > maxBytes) {
    return {
      ok: false,
      error: options.tooLargeError ?? "file_too_large",
      message:
        options.tooLargeMessage ?? spreadsheetTooLargeMessage("The uploaded file", maxBytes),
      status: 413,
    };
  }

  const extension = getFileExtension(file.name);
  const mimeType = file.type.trim().toLowerCase();
  const extensionAllowed = options.allowedExtensions.includes(extension);
  const mimeAllowed = mimeType.length > 0 && options.allowedMimeTypes.includes(mimeType);

  if (!extensionAllowed && !mimeAllowed) {
    return {
      ok: false,
      error: options.unsupportedError ?? "unsupported_file_type",
      message:
        options.unsupportedMessage ??
        "Unsupported spreadsheet file type. Upload a valid spreadsheet file.",
      status: 400,
    };
  }

  return { ok: true };
}
