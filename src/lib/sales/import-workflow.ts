import { createSalesImport, createTargetBatch } from "@/lib/sales/service";
import {
  makeBatchSummary,
  salesSuccess,
  SalesWorkflowError,
  type RankedReason,
  type SalesActionResponse,
  type UploadIssueRow,
} from "@/lib/sales/contracts";
import { parseSalesUpload, parseTargetUpload } from "@/lib/sales/parser";
import type { SalesBatchReconciliation, SalesRecordInput } from "@/lib/sales/types";

type UploadSummaryDetails = {
  blockingReasons?: string[];
  topFailureReasons?: RankedReason[];
  topWarningReasons?: RankedReason[];
  reconciliation?: SalesBatchReconciliation;
  invalidRows?: UploadIssueRow[];
};

function cleanValidationMessage(message: string) {
  return message.replace(/^(FAIL:|WARN:)\s*/, "").trim();
}

function summarizeValidation(records: SalesRecordInput[]) {
  const failureCounts = new Map<string, number>();
  const warningCounts = new Map<string, number>();

  const invalidRows = records
    .filter((record) => record.validationNotes.some((note) => note.startsWith("FAIL:")))
    .slice(0, 12)
    .map<UploadIssueRow>((record) => ({
      rowNumber: record.rowNumber,
      messages: record.validationNotes
        .filter((note) => note.startsWith("FAIL:"))
        .map(cleanValidationMessage),
    }));

  records.forEach((record) => {
    record.validationNotes.forEach((note) => {
      const cleaned = cleanValidationMessage(note);
      if (!cleaned) return;
      if (note.startsWith("FAIL:")) {
        failureCounts.set(cleaned, (failureCounts.get(cleaned) ?? 0) + 1);
      } else if (note.startsWith("WARN:")) {
        warningCounts.set(cleaned, (warningCounts.get(cleaned) ?? 0) + 1);
      }
    });
  });

  const toRanked = (map: Map<string, number>) =>
    [...map.entries()]
      .sort((left, right) => {
        if (right[1] === left[1]) return left[0].localeCompare(right[0]);
        return right[1] - left[1];
      })
      .map(([message, count]) => ({ message, count }))
      .slice(0, 5);

  return {
    topFailureReasons: toRanked(failureCounts),
    topWarningReasons: toRanked(warningCounts),
    invalidRows,
  };
}

export async function runSalesImportWorkflow(input: {
  file: File;
  line: string;
  uploadedBy: string;
}): Promise<SalesActionResponse<UploadSummaryDetails>> {
  if (!(input.file instanceof File)) {
    throw new SalesWorkflowError("invalid_input", "Sales workbook is required.", 400);
  }
  if (!input.line) {
    throw new SalesWorkflowError("invalid_input", "Sales line is required.", 400);
  }

  const parsed = await parseSalesUpload(input.file, input.line, input.uploadedBy);
  const validationSummary = summarizeValidation(parsed.records);

  if (parsed.batch.failedRecords > 0) {
    throw new SalesWorkflowError(
      "validation_failed",
      `Upload blocked. Fix ${parsed.batch.failedRecords} row${parsed.batch.failedRecords === 1 ? "" : "s"} before importing this sales file.`,
      400,
      {
        blockingReasons: [
          "The upload was not saved because some rows would change the imported totals incorrectly.",
          ...validationSummary.topFailureReasons.map(
            (reason) => `${reason.count} row${reason.count === 1 ? "" : "s"}: ${reason.message}`
          ),
        ],
        topFailureReasons: validationSummary.topFailureReasons,
        topWarningReasons: validationSummary.topWarningReasons,
        invalidRows: validationSummary.invalidRows,
      }
    );
  }

  const result = await createSalesImport(parsed);
  const batchSummary = makeBatchSummary(result as Parameters<typeof makeBatchSummary>[0], {
    linkedRecords: result.linkedRecords,
    linkageRate: result.linkageRate,
    linkageRateLabel: `${Math.round(result.linkageRate * 100)}%`,
    canApprove: result.canApprove,
    blockedReason: result.approvalBlockedReason ?? null,
    previewUrl: result.previewUrl ?? undefined,
  });

  return salesSuccess({
    message: `Uploaded ${result.fileName}. ${result.totalRecords} rows processed, ${result.failedRecords} failed, ${result.warningRecords} warnings.`,
    details: {
      blockingReasons: result.blockingReasons,
      topFailureReasons: result.topFailureReasons,
      topWarningReasons: result.topWarningReasons,
      reconciliation: result.reconciliation ?? undefined,
      invalidRows: validationSummary.invalidRows,
    },
    redirectTo: result.previewUrl ?? undefined,
    previewUrl: result.previewUrl ?? undefined,
    batchSummary,
  });
}

export async function runTargetUploadWorkflow(input: {
  file: File;
}): Promise<SalesActionResponse<UploadSummaryDetails>> {
  if (!(input.file instanceof File)) {
    throw new SalesWorkflowError("invalid_input", "Target template file is required.", 400);
  }

  const parsed = await parseTargetUpload(input.file);
  const result = await createTargetBatch(parsed);

  return salesSuccess({
    message: `Uploaded ${result.fileName}. ${result.validRecords} valid target rows and ${result.failedRecords} failed rows.`,
    batchSummary: {
      id: result.id,
      fileName: result.fileName,
      line: "Targets",
      period: `${result.year}-${String(result.month).padStart(2, "0")}`,
      status: result.status,
      totalRecords: result.totalRecords,
      validRecords: result.validRecords,
      warningRecords: 0,
      failedRecords: result.failedRecords,
    },
    details: {
      blockingReasons: result.blockingReasons,
      topFailureReasons: result.topFailureReasons,
      topWarningReasons: result.topWarningReasons,
    },
  });
}
