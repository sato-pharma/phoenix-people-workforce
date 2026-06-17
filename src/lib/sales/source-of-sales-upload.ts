import { SalesWorkflowError } from "@/lib/sales/contracts";
import {
  createSourceOfSalesUpload,
  createSourceOfSalesUploadFromBuffer,
  type DistributorSalesAreaSummary,
  type DistributorSalesBrickSummary,
  type DistributorSalesLineSummary,
  type DistributorSalesProductSummary,
  type DistributorSalesRegionSummary,
  type DistributorSalesValidationIssue,
} from "@/lib/sales/monthly-distributor-import";
import { buildCodedBuffer } from "@/lib/sales/normalizer/service";
import type { NormalizeException } from "@/lib/sales/normalizer/types";

function exceptionToIssue(exc: NormalizeException): DistributorSalesValidationIssue {
  const rawItem = exc.rawProductName || exc.rawProduct || "";
  const rawArea = exc.rawTerritory || exc.rawCustomerCode || "";

  if (exc.reason === "product") {
    return {
      field: "Product",
      message: `"${rawItem}" is not mapped to a Phoenix product. Open the Mapping tab → Analyze raw sheet → map it → Save → re-upload.`,
      rowNumber: exc.rawRowNumber,
      severity: "failure",
      value: rawItem || null,
    };
  }
  if (exc.reason === "brick") {
    return {
      field: "Territory",
      message: `"${rawArea}" is not mapped to a Phoenix brick/area. Open the Mapping tab → Analyze raw sheet → map it → Save → re-upload.`,
      rowNumber: exc.rawRowNumber,
      severity: "failure",
      value: rawArea || null,
    };
  }
  return {
    field: "Product & Territory",
    message: `Both "${rawItem}" (product) and "${rawArea}" (territory) are unmapped. Open the Mapping tab → Analyze raw sheet → map them → Save → re-upload.`,
    rowNumber: exc.rawRowNumber,
    severity: "failure",
    value: rawItem || rawArea || null,
  };
}

// Single upload entry point for the "Upload Sales" screen. It accepts, for EVERY distributor,
// both a coded/hybrid sheet (the distributor's own template, or a raw export with hand-added
// coded columns) AND a plain raw export — so EGD/Ramco/Sofico/MEC/Chimipharm no longer get
// rejected for lacking a dedicated template.
//
// Flow:
//  1. Try the coded/hybrid path (createSourceOfSalesUpload). This path already gets the
//     customer-map brick auto-fill, so a hybrid sheet whose Brick/Area/Region come out blank or
//     #N/A still validates whenever the customer is mapped.
//  2. If the workbook matches NO coded template, parseDistributorSalesWorkbookBuffer throws
//     `unsupported_distributor_template` BEFORE any DB write (so there is no orphan batch). We then
//     fall back to the Normalizer: convert the raw export to a coded buffer (bricks resolved from
//     the customer map) and run it through the SAME validator + insert.
//     IMPORTANT: if the normalizer finds rows it cannot map (unknown product / territory), the
//     import is BLOCKED entirely — nothing is persisted and every unmapped row is surfaced in the
//     "Rows To Fix" table. This prevents silent qty drops.
//  3. If the raw layout also does not match, re-throw a clean 400 (never a 500).
//
// This module is the ONLY place that imports both the coded importer and the normalizer, which
// keeps the import graph acyclic (the normalizer already depends on monthly-distributor-import, so
// that file must not import the normalizer back).
export async function importSourceOfSalesFile(input: {
  distributorCode: string;
  file: File;
  uploadedBy: string;
  periodOverride?: string;
}) {
  try {
    return await createSourceOfSalesUpload(input);
  } catch (error) {
    if (!(error instanceof SalesWorkflowError) || error.code !== "unsupported_distributor_template") {
      throw error;
    }

    let coded: Awaited<ReturnType<typeof buildCodedBuffer>>;
    try {
      coded = await buildCodedBuffer(input.distributorCode, input.file);
    } catch {
      // Neither a coded template nor the raw layout matched — surface a clean 400, not a 500.
      throw new SalesWorkflowError(
        "unsupported_distributor_template",
        "This workbook matches neither a coded template nor the distributor's raw layout. Map the distributor's products/bricks first, then upload its raw export or a coded sheet.",
        400,
      );
    }

    const { result: normalizeResult, distributorName, period } = coded;
    const exceptions = normalizeResult.exceptions;

    // Block the entire import if any rows could not be mapped. Never silently drop rows.
    if (exceptions.length > 0) {
      const issues = exceptions.map(exceptionToIssue);
      const totalQty = normalizeResult.coded.reduce((sum, r) => sum + r.qty, 0);
      const totalBonusQty = normalizeResult.coded.reduce((sum, r) => sum + r.bonusQty, 0);
      const totalValue = normalizeResult.coded.reduce((sum, r) => sum + r.value, 0);
      const rowCount = normalizeResult.summary.totalRows - normalizeResult.summary.ignored;

      return {
        advisories: [] as string[],
        batchId: null as string | null,
        blockingReasons: [
          `${exceptions.length} row${exceptions.length === 1 ? "" : "s"} could not be imported — their product or territory is not yet mapped.`,
          `Go to the Mapping tab → click "Analyze raw sheet" → fix the unknowns → Save → re-upload this file.`,
        ],
        byArea: [] as DistributorSalesAreaSummary[],
        byBrick: [] as DistributorSalesBrickSummary[],
        byLine: [] as DistributorSalesLineSummary[],
        byProduct: [] as DistributorSalesProductSummary[],
        byRegion: [] as DistributorSalesRegionSummary[],
        createdAt: null as string | null,
        distributor: { code: input.distributorCode, name: distributorName },
        failedRows: exceptions.length,
        fileName: input.file.name,
        importableRows: normalizeResult.summary.fullyCoded,
        issues,
        period,
        rowCount,
        sheetName: input.file.name,
        status: "blocked" as const,
        templateKey: "normalizer",
        templateName: "Raw distributor sheet",
        totals: { rowCount, totalQty, totalBonusQty, totalValue },
        warningRows: 0,
      };
    }

    const persistResult = await createSourceOfSalesUploadFromBuffer({
      buffer: coded.buffer as ArrayBuffer,
      distributorCode: input.distributorCode,
      fileName: input.file.name,
      persistOnlyIfValidated: false,
      uploadedBy: input.uploadedBy,
      periodOverride: input.periodOverride,
    });

    // Surface ignored rows as an advisory so the user knows exactly how many units were excluded
    // and why — without blocking the import (the "ignore" mapping is intentional).
    const { ignoredRows } = normalizeResult;
    if (ignoredRows.length === 0) return persistResult;

    const totalIgnoredQty = ignoredRows.reduce((sum, r) => sum + r.qty, 0);
    const ignoredAdvisory =
      `${ignoredRows.length} row${ignoredRows.length === 1 ? "" : "s"} (${totalIgnoredQty} unit${totalIgnoredQty === 1 ? "" : "s"}) were skipped — ` +
      `their products are mapped as "ignore" in the Mapping tab. ` +
      `If this is unexpected, go to the Mapping tab → update those product mappings → Save → re-upload.`;
    return { ...persistResult, advisories: [...(persistResult.advisories ?? []), ignoredAdvisory] };
  }
}
