import {
  buildBrickSuggestions,
  type BrickSuggestionView,
  type MappedCustomer,
  type UnmappedCustomer,
} from "@/lib/sales/brick-suggestions";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import {
  buildImportPreviewDiff,
  customerMapKey,
  type ImportPreviewDiff,
  type ImportPreviewRow,
} from "@/lib/sales/import-preview";
import {
  createSourceOfSalesUpload,
  createSourceOfSalesUploadFromBuffer,
  loadSalesReferenceData,
  type DistributorSalesAreaSummary,
  type DistributorSalesBrickSummary,
  type DistributorSalesLineSummary,
  type DistributorSalesProductSummary,
  type DistributorSalesRegionSummary,
  type DistributorSalesValidationIssue,
  type DistributorSalesValidationResult,
  type ParsedDistributorRow,
} from "@/lib/sales/monthly-distributor-import";
import { buildImportSplitPlan } from "@/lib/sales/import-split-preview";
import { listCustomerMap } from "@/lib/sales/normalizer/customer-map";
import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import { describeRefusedRow, isRefusedRow, summarizeRefusedRows } from "@/lib/sales/normalizer/row-messages";
import { buildCodedBuffer } from "@/lib/sales/normalizer/service";
import { fileSha256 } from "@/lib/sales/upload-fingerprint";
import type { NormalizeException, NormalizeResult } from "@/lib/sales/normalizer/types";

// Stored map → composite-key brick lookup for the preview diff (mapping sheet = source of truth).
async function loadExistingBrickByKey(distributorCode: string): Promise<Map<string, string>> {
  const rows = await listCustomerMap({ distributorCode: normalizeCodeKey(distributorCode) });
  const map = new Map<string, string>();
  for (const row of rows) {
    if (!row.brickId) continue;
    map.set(customerMapKey(row.distributorCode, row.customerCode), row.brickId);
  }
  return map;
}

async function buildPreviewDiff(
  distributorCode: string,
  rows: ImportPreviewRow[],
  result: { importableRows: number; issues: DistributorSalesValidationIssue[]; rowCount: number },
): Promise<ImportPreviewDiff> {
  const existingBrickByKey = await loadExistingBrickByKey(distributorCode);
  return buildImportPreviewDiff({
    distributorCode,
    existingBrickByKey,
    importableRows: result.importableRows,
    issues: result.issues.map((i) => ({ field: i.field, value: i.value })),
    rows,
    totalRows: result.rowCount,
  });
}

/**
 * What the city split will do to this file — owner, 2026-09-07: "must in validation show the city
 * and show how it will be distributed".
 *
 * Built from the SAME parsed rows the preview diff reads, and from the SAME period the batch will
 * carry, so the plan shown at validation is the plan the closing will execute. It calls the split's
 * own functions rather than restating the rule; there is nothing here to drift.
 */
function buildSplitPlan(parsedRows: readonly ParsedDistributorRow[], period: string | null | undefined) {
  return buildImportSplitPlan({
    period,
    rows: parsedRows.map((r) => ({
      areaCode: r.areaCode,
      clientCode: r.clientCode,
      clientName: r.clientName,
      distributorCode: r.distributorCode,
      isDirect: r.isDirect,
      officialLine: r.officialLine,
      productCode: r.productCode,
      qty: r.qty,
    })),
  });
}

// Distinct unmapped customers (no brick yet) from the coded rows — carry name+address so the
// suggestion engine can match them to an already-mapped twin.
function unmappedFromRows(rows: Array<{ brickId: string; clientAddress: string | null; clientCode: string | null; clientName: string | null }>): UnmappedCustomer[] {
  const out: UnmappedCustomer[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const code = String(r.clientCode ?? "").trim();
    if (!code || r.brickId) continue; // a row WITH a brick is already mapped
    const key = code.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ address: String(r.clientAddress ?? ""), customerCode: code, customerName: String(r.clientName ?? "") });
  }
  return out;
}

// Distinct unmapped customers from the normalizer exceptions (brick/both reasons — not product-only).
function unmappedFromExceptions(exceptions: NormalizeException[]): UnmappedCustomer[] {
  const out: UnmappedCustomer[] = [];
  const seen = new Set<string>();
  for (const e of exceptions) {
    if (e.reason === "product") continue; // brick is fine for these — only the product is unknown
    const code = String(e.rawCustomerCode ?? "").trim();
    if (!code) continue;
    const key = code.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ address: String(e.rawCustomerAddress ?? ""), customerCode: code, customerName: String(e.rawCustomerName ?? "") });
  }
  return out;
}

const MAX_SUGGESTIONS = 200;
const MAX_UNMAPPED_DETAILS = 300;

// Match unmapped customers to a brick via an already-mapped customer with the same name(+address),
// across ALL distributors (cross-distributor carry-over). Loads the full customer map ONLY when there
// is something to match. The accepted mapping is written under the UPLOAD distributor.
async function buildSuggestions(distributorCode: string, unmapped: UnmappedCustomer[]): Promise<BrickSuggestionView[]> {
  if (unmapped.length === 0) return [];
  const [mapRows, refs] = await Promise.all([
    listCustomerMap(),
    loadSalesReferenceData({ includeCustomerBricks: false }),
  ]);
  const mapped: MappedCustomer[] = mapRows.map((r) => ({
    address: r.address,
    brickId: r.brickId,
    customerCode: r.customerCode,
    customerName: r.customerName,
    distributorCode: r.distributorCode,
  }));
  const brickNameById = new Map((refs.bricks ?? []).map((b) => [normalizeCodeKey(b.brickId), b.brickName]));
  return buildBrickSuggestions(unmapped, mapped)
    .slice(0, MAX_SUGGESTIONS)
    .map((s) => ({
      ...s,
      brickName: brickNameById.get(normalizeCodeKey(s.suggestedBrickId)) ?? s.suggestedBrickId,
      distributorCode,
    }));
}

// Advisories for the rows the recognizer skipped. TWO reasons, two sentences, never one — they have
// different causes and opposite fixes, and lumping them told a reader whose rows were free goods to
// go and change a product mapping that was perfectly correct. Free-goods rows also used to record 0
// units, so the single sentence reported "(0 units)" for them: an EPDA-BULK sheet carrying 6,736
// Ivyronc packs validated at 5,214 with nothing on the screen naming the missing 1,522.
export function skippedRowsAdvisories(normalizeResult: NormalizeResult): string[] {
  const { ignoredRows } = normalizeResult;
  const units = (rows: typeof ignoredRows) =>
    rows.reduce((sum, r) => sum + (Number.isFinite(r.qty) ? r.qty : 0), 0);

  const mapped = ignoredRows.filter((r) => r.reason !== "bonus");
  const freeGoods = ignoredRows.filter((r) => r.reason === "bonus");
  const advisories: string[] = [];

  if (mapped.length > 0) {
    const qty = units(mapped);
    advisories.push(
      `${mapped.length} row${mapped.length === 1 ? "" : "s"} (${qty} unit${qty === 1 ? "" : "s"}) were skipped — ` +
      `their products are mapped as "ignore" in the Mapping tab. ` +
      `If this is unexpected, go to the Mapping tab → update those product mappings → Save → re-upload.`,
    );
  }

  if (freeGoods.length > 0) {
    const qty = units(freeGoods);
    // Name the products, so the reader sees WHICH total on their sheet will not match the screen.
    const byProduct = new Map<string, number>();
    for (const row of freeGoods) {
      const name = row.productName || row.rawProductName || row.rawProduct || "—";
      byProduct.set(name, (byProduct.get(name) ?? 0) + (Number.isFinite(row.qty) ? row.qty : 0));
    }
    const named = [...byProduct.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, productQty]) => `${name} ${productQty}`)
      .join(", ");
    advisories.push(
      `${freeGoods.length} row${freeGoods.length === 1 ? "" : "s"} (${qty} unit${qty === 1 ? "" : "s"}) are free goods and are excluded from sales — ` +
      `the sheet flags them, and no distributor's bonus is ever counted. Excluded units by product: ${named}. ` +
      `Nothing is wrong with the file: its quantity for those products is the imported Qty plus these units.`,
    );
  }

  return advisories;
}

// The field each row no mapping can fix is reported under. Deliberately none of the labels the wizard's
// "map now" grouping reads (Product, Customer code, Territory), because mapping is not the fix.
const REFUSED_ISSUE_FIELD = {
  blank_customer: "Customer",
  unparseable_qty: "Quantity",
  unparseable_value: "Value",
  discount_out_of_range: "Discount",
} as const;

export function exceptionToIssue(exc: NormalizeException): DistributorSalesValidationIssue {
  const rawItem = exc.rawProductName || exc.rawProduct || "";
  const rawArea = exc.rawTerritory || exc.rawCustomerCode || "";

  // A cell the sheet got wrong, or a blank customer: said exactly, and fixed in the sheet, not in Mapping.
  // These used to fall through to "Both … are unmapped" below, naming a product and territory that
  // were perfectly well mapped.
  if (isRefusedRow(exc)) {
    return {
      field: REFUSED_ISSUE_FIELD[exc.reason],
      message: `${describeRefusedRow(exc)}. Mapping cannot fix this: correct the row in the distributor's sheet, then re-upload.`,
      rowNumber: exc.rawRowNumber,
      severity: "failure",
      value: exc.rawCell?.trim() || null,
    };
  }

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
    // When the distributor has no territory columns, the ONLY resolution path is the customer
    // map. Point the user directly to "add one by field" and tell them exactly what to type —
    // the territory label would send them to the wrong form field.
    if (exc.rawCustomerCode && !exc.rawTerritory) {
      return {
        field: "Customer code",
        message: `Customer code "${exc.rawCustomerCode}" has no brick assigned. In the Mapping tab → Customer / Brick Mapping → type "${exc.rawCustomerCode}" in the "Customer code" field → pick the brick → Add → re-upload.`,
        rowNumber: exc.rawRowNumber,
        severity: "failure",
        value: exc.rawCustomerCode,
      };
    }
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
  // Preview (dry run): validate and summarize WITHOUT persisting; attaches `previewDiff`. Used by the
  // mandatory preview step so nothing is written until the user confirms.
  dryRun?: boolean;
}) {
  try {
    const codedResult = await createSourceOfSalesUpload(input);
    if (!input.dryRun) return codedResult;
    // dryRun coded path: createSourceOfSalesUpload returns the parsed result WITH parsedRows.
    const { parsedRows, ...result } = codedResult as DistributorSalesValidationResult & {
      parsedRows: ParsedDistributorRow[];
    };
    const rows: ImportPreviewRow[] = parsedRows.map((r) => ({ brickId: r.brickId, clientCode: r.clientCode, value: r.value }));
    const previewDiff = await buildPreviewDiff(input.distributorCode, rows, result);
    const splitPlan = buildSplitPlan(parsedRows, result.period ?? input.periodOverride);
    const unmappedCustomers = unmappedFromRows(parsedRows);
    const suggestions = await buildSuggestions(input.distributorCode, unmappedCustomers);
    return { ...result, previewDiff, splitPlan, suggestions, unmappedCustomers: unmappedCustomers.slice(0, MAX_UNMAPPED_DETAILS) };
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

    // Every exception blocks — an unmapped product, brick, or customer/territory. Nothing here is
    // silently skipped: allocation would be unsafe with a row's qty/value dropped from the totals,
    // the same reason an unmapped brick/territory already blocked before this change.
    if (exceptions.length > 0) {
      const issues = exceptions.map(exceptionToIssue);
      const totalQty = normalizeResult.coded.reduce((sum, r) => sum + r.qty, 0);
      const totalBonusQty = normalizeResult.coded.reduce((sum, r) => sum + r.bonusQty, 0);
      const totalValue = normalizeResult.coded.reduce((sum, r) => sum + r.value, 0);
      const rowCount = normalizeResult.summary.totalRows - normalizeResult.summary.ignored;
      // Rows no mapping can fix are counted apart from the unmapped ones, so neither is told the other's fix.
      const refused = exceptions.filter(isRefusedRow);
      const unmapped = exceptions.length - refused.length;
      const blockingReasons = [
        ...(refused.length > 0
          ? [`${refused.length} row${refused.length === 1 ? "" : "s"} could not be imported because the sheet itself is wrong there (${summarizeRefusedRows(refused)}). Each is listed below with its row number — correct them in the distributor's sheet, then re-upload.`]
          : []),
        ...(unmapped > 0
          ? [
            `${unmapped} row${unmapped === 1 ? "" : "s"} could not be imported because customer, territory, branch, or product mapping is missing.`,
            `Go to the Mapping tab -> click "Analyze raw sheet" -> fix the unmapped items -> Save -> re-upload this file.`,
          ]
          : []),
      ];

      const blockedResult = {
        advisories: [] as string[],
        batchId: null as string | null,
        blockingReasons,
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

      if (!input.dryRun) return blockedResult;
      const rows: ImportPreviewRow[] = normalizeResult.coded.map((r) => ({ brickId: r.brickId, clientCode: r.clientCode, value: r.value }));
      const previewDiff = await buildPreviewDiff(input.distributorCode, rows, blockedResult);
      const unmappedCustomers = unmappedFromExceptions(exceptions);
      const suggestions = await buildSuggestions(input.distributorCode, unmappedCustomers);
      return { ...blockedResult, previewDiff, suggestions, unmappedCustomers: unmappedCustomers.slice(0, MAX_UNMAPPED_DETAILS) };
    }

    // dryRun validated normalizer path: parse the coded buffer for the validation result WITHOUT
    // persisting, then attach the preview diff.
    if (input.dryRun) {
      const parsed = await createSourceOfSalesUploadFromBuffer({
        buffer: coded.buffer as ArrayBuffer,
        distributorCode: input.distributorCode,
        fileName: input.file.name,
        dryRun: true,
        uploadedBy: input.uploadedBy,
        periodOverride: input.periodOverride,
      });
      const { parsedRows, ...result } = parsed as DistributorSalesValidationResult & {
        parsedRows: ParsedDistributorRow[];
      };
      const rows: ImportPreviewRow[] = parsedRows.map((r) => ({ brickId: r.brickId, clientCode: r.clientCode, value: r.value }));
      const previewDiff = await buildPreviewDiff(input.distributorCode, rows, result);
      const splitPlan = buildSplitPlan(parsedRows, result.period ?? input.periodOverride);
      const advisory = skippedRowsAdvisories(normalizeResult);
      return advisory.length > 0
        ? { ...result, advisories: [...(result.advisories ?? []), ...advisory], previewDiff, splitPlan }
        : { ...result, previewDiff, splitPlan };
    }

    const persistResult = await createSourceOfSalesUploadFromBuffer({
      buffer: coded.buffer as ArrayBuffer,
      distributorCode: input.distributorCode,
      fileName: input.file.name,
      persistOnlyIfValidated: false,
      uploadedBy: input.uploadedBy,
      periodOverride: input.periodOverride,
      // The bytes the person chose, never the coded copy built from them (REC-069).
      fileSha256: fileSha256(await input.file.arrayBuffer()),
    });

    // Surface ignored rows as an advisory so the user knows exactly how many units were excluded
    // and why — without blocking the import (the "ignore" mapping is intentional).
    const advisory = skippedRowsAdvisories(normalizeResult);
    if (advisory.length === 0) return persistResult;
    return { ...persistResult, advisories: [...(persistResult.advisories ?? []), ...advisory] };
  }
}
