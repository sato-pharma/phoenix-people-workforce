import { createSalesImport } from "@/lib/sales/service";
import {
  makeBatchSummary,
  salesSuccess,
  SalesWorkflowError,
  type RankedReason,
  type SalesActionResponse,
  type UploadIssueRow,
} from "@/lib/sales/contracts";
import { parseSalesUpload } from "@/lib/sales/parser";
import { filterClosingSheetRollupRecords, linkSalesRecords, summarizeSalesLinkage } from "@/lib/sales/employees";
import type { SalesBatchReconciliation, SalesRecordInput } from "@/lib/sales/types";

type UploadSummaryDetails = {
  blockingReasons?: string[];
  topFailureReasons?: RankedReason[];
  topWarningReasons?: RankedReason[];
  reconciliation?: SalesBatchReconciliation;
  invalidRows?: UploadIssueRow[];
  validationTotals?: {
    dsmLinked: number;
    dsmLinkedNames: string[];
    dsmNotLinkedNames: string[];
    dsmTotal: number;
    failedRows: number;
    importableRows: number;
    managers: number;
    mrLinked: number;
    mrLinkedNames: string[];
    mrNotLinkedNames: string[];
    mrTotal: number;
    nsmLinked: number;
    nsmLinkedNames: string[];
    nsmNotLinkedNames: string[];
    nsmTotal: number;
    products: number;
    salesUnits: number;
    salesValue: number;
    targetUnits: number;
    targetValue: number;
    territories: number;
    totalRows: number;
    warningRows: number;
  };
  managerTotals?: Array<{
    manager: string;
    salesUnits: number;
    salesValue: number;
    targetUnits: number;
    targetValue: number;
    rows: number;
  }>;
};

function cleanValidationMessage(message: string) {
  return message
    .replace(/^(FAIL:|WARN:)\s*/, "")
    .replace(/^Row \d+,\s*/i, "")
    .trim();
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

function sum(records: SalesRecordInput[], mapper: (record: SalesRecordInput) => number) {
  return records.reduce((total, record) => {
    const value = mapper(record);
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);
}

function summarizeUploadTotals(records: SalesRecordInput[]) {
  const importableRecords = records.filter((record) => record.validationState !== "failed");

  return {
    dsmLinked: 0,
    dsmLinkedNames: [],
    dsmNotLinkedNames: [],
    dsmTotal: 0,
    failedRows: records.filter((record) => record.validationState === "failed").length,
    importableRows: importableRecords.length,
    managers: new Set(records.map((record) => record.managerHrId || record.employeeLookupKey || record.employeeName).filter(Boolean)).size,
    mrLinked: 0,
    mrLinkedNames: [],
    mrNotLinkedNames: [],
    mrTotal: new Set(importableRecords.map((record) => record.employeeHrId).filter(Boolean)).size,
    nsmLinked: 0,
    nsmLinkedNames: [],
    nsmNotLinkedNames: [],
    nsmTotal: 0,
    products: new Set(records.map((record) => record.product).filter(Boolean)).size,
    salesUnits: sum(importableRecords, (record) => record.salesUnits),
    salesValue: sum(importableRecords, (record) => record.salesValue),
    targetUnits: sum(importableRecords, (record) => record.targetUnits),
    targetValue: sum(importableRecords, (record) => record.targetValue),
    territories: new Set(records.map((record) => record.territory).filter(Boolean)).size,
    totalRows: records.length,
    warningRows: records.filter((record) => record.validationState === "warning").length,
  };
}

function summarizeManagerTotals(records: SalesRecordInput[]) {
  const groups = new Map<string, SalesRecordInput[]>();
  records
    .filter((record) => record.validationState !== "failed")
    .forEach((record) => {
      const manager = record.managerHrId
        ? `${record.employeeLookupKey || record.employeeName || "DSM"} [${record.managerHrId}]`
        : record.employeeLookupKey || record.employeeName || "Unassigned";
      groups.set(manager, [...(groups.get(manager) ?? []), record]);
    });

  return [...groups.entries()]
    .map(([manager, items]) => ({
      manager,
      rows: items.length,
      salesUnits: sum(items, (record) => record.salesUnits),
      salesValue: sum(items, (record) => record.salesValue),
      targetUnits: sum(items, (record) => record.targetUnits),
      targetValue: sum(items, (record) => record.targetValue),
    }))
    .sort((left, right) => right.salesValue - left.salesValue);
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
  if (parsed.batch.schemaType === "closing_sheet") {
    parsed.records = await filterClosingSheetRollupRecords(parsed.records);
    parsed.batch.totalRecords = parsed.records.length;
    parsed.batch.validRecords = parsed.records.filter((record) => record.validationState === "valid").length;
    parsed.batch.warningRecords = parsed.records.filter((record) => record.validationState === "warning").length;
    parsed.batch.failedRecords = parsed.records.filter((record) => record.validationState === "failed").length;
  }

  const validationSummary = summarizeValidation(parsed.records);
  const parsedLinkage = await summarizeSalesLinkage(await linkSalesRecords(parsed.records));
  const validationTotals = { ...summarizeUploadTotals(parsed.records), ...parsedLinkage };
  const managerTotals = summarizeManagerTotals(parsed.records);

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
        validationTotals,
        managerTotals,
      }
    );
  }

  const result = await createSalesImport(parsed);
  const linkageBreakdown = result.linkageBreakdown ?? validationTotals;
  const batchSummary = makeBatchSummary(result as Parameters<typeof makeBatchSummary>[0], {
    linkedRecords: linkageBreakdown.dsmLinked,
    linkageRate: linkageBreakdown.dsmTotal > 0 ? linkageBreakdown.dsmLinked / linkageBreakdown.dsmTotal : 0,
    linkageRateLabel: `${Math.round((linkageBreakdown.dsmTotal > 0 ? linkageBreakdown.dsmLinked / linkageBreakdown.dsmTotal : 0) * 100)}%`,
    canApprove: result.canApprove,
    blockedReason: result.approvalBlockedReason ?? null,
    previewUrl: result.previewUrl ?? undefined,
  });

  return salesSuccess({
    message: `Uploaded ${result.fileName}. ${result.totalRecords} rows processed, ${result.failedRecords} failed, ${result.warningRecords} warnings.`,
    details: {
      blockingReasons: result.blockingReasons,
      topFailureReasons: validationSummary.topFailureReasons,
      topWarningReasons: validationSummary.topWarningReasons,
      reconciliation: result.reconciliation ?? undefined,
      invalidRows: validationSummary.invalidRows,
      validationTotals: { ...validationTotals, ...linkageBreakdown },
      managerTotals,
    },
    redirectTo: result.previewUrl ?? undefined,
    previewUrl: result.previewUrl ?? undefined,
    batchSummary,
  });
}
