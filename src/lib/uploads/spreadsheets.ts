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

export const MAX_SPREADSHEET_UPLOAD_BYTES = 10 * 1024 * 1024;

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
        options.tooLargeMessage ??
        `The uploaded file exceeds the ${Math.round(maxBytes / (1024 * 1024))}MB limit.`,
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
