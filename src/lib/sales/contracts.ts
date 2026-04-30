export type RankedReason = {
  count: number;
  message: string;
};

export type UploadIssueRow = {
  messages: string[];
  rowNumber: number;
};

export type SalesActionResponse<TDetails = unknown> = {
  batchSummary?: unknown;
  details?: TDetails;
  message: string;
  previewUrl?: string;
  redirectTo?: string;
  success: boolean;
};

export class SalesWorkflowError<TDetails = unknown> extends Error {
  code: string;
  details?: TDetails;
  status: number;

  constructor(code: string, message: string, status = 400, details?: TDetails) {
    super(message);
    this.name = "SalesWorkflowError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function salesSuccess<TDetails>(
  response: Omit<SalesActionResponse<TDetails>, "success">,
): SalesActionResponse<TDetails> {
  return {
    ...response,
    success: true,
  };
}

export function makeBatchSummary(
  batch: {
    canApprove?: boolean;
    failedRecords?: number;
    fileName?: string;
    id?: string;
    line?: string;
    month?: number;
    period?: string;
    status?: string;
    totalRecords?: number;
    validRecords?: number;
    warningRecords?: number;
    year?: number;
  },
  extras: Record<string, unknown> = {},
) {
  const period =
    batch.period ??
    (batch.year && batch.month
      ? `${batch.year}-${String(batch.month).padStart(2, "0")}`
      : undefined);

  return {
    id: batch.id,
    fileName: batch.fileName,
    line: batch.line,
    period,
    status: batch.status,
    totalRecords: batch.totalRecords,
    validRecords: batch.validRecords,
    warningRecords: batch.warningRecords,
    failedRecords: batch.failedRecords,
    canApprove: batch.canApprove,
    ...extras,
  };
}
