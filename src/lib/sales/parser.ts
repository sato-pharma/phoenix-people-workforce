import ExcelJS from "exceljs";
import { createHash } from "crypto";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { periodLabel } from "@/lib/sales/format";
import { parseSalesRow } from "@/lib/sales/validation";
import type { SalesImportPayload } from "@/lib/sales/types";

export type UploadSchemaType = "closing_sheet" | "unsupported";

export type ParsedUploadRows = {
  headers: string[];
  rows: Record<string, unknown>[];
  schemaType: UploadSchemaType;
};

function sheetHeaders(sheet: ExcelJS.Worksheet) {
  const row = sheet.getRow(1);
  return Array.from({ length: row.cellCount }, (_, index) =>
    String(row.getCell(index + 1).text || "").trim()
  );
}

function readableCellValue(cell: ExcelJS.Cell) {
  const value = cell.value;
  if (value && typeof value === "object" && "result" in value) {
    return (value as { result?: unknown }).result ?? cell.text;
  }
  return value ?? cell.text;
}

function detectSchemaType(headers: string[]): UploadSchemaType {
  if (headers.includes("CRM Code") && headers.includes("Med. Rep. Name")) return "closing_sheet";
  return "unsupported";
}

function normalizeHeader(text: unknown) {
  return String(text ?? "").trim().toLowerCase();
}

function columnLabelToNumber(label: string) {
  let value = 0;
  for (const char of label.toUpperCase()) {
    value = value * 26 + (char.charCodeAt(0) - 64);
  }
  return value;
}

function parseCellRef(ref: string) {
  const match = /^([A-Z]+)(\d+)$/i.exec(ref.trim());
  if (!match) return null;
  return { col: columnLabelToNumber(match[1]), row: Number(match[2]) };
}

function resolveMergedCellText(sheet: ExcelJS.Worksheet, rowNumber: number, columnNumber: number) {
  const direct = String(readableCellValue(sheet.getRow(rowNumber).getCell(columnNumber)) ?? "").trim();
  if (direct) return direct;

  const merges = sheet.model?.merges ?? [];
  for (const merge of merges) {
    const [startRef, endRef] = String(merge).split(":");
    const start = parseCellRef(startRef);
    const end = parseCellRef(endRef ?? startRef);
    if (!start || !end) continue;
    if (
      rowNumber >= start.row &&
      rowNumber <= end.row &&
      columnNumber >= start.col &&
      columnNumber <= end.col
    ) {
      return String(readableCellValue(sheet.getRow(start.row).getCell(start.col)) ?? "").trim();
    }
  }

  return "";
}

function buildClosingFamilyLabel(product: string) {
  const normalized = product.trim().toLowerCase();
  if (normalized.startsWith("lacto")) return "Lacto Family";
  return product.trim();
}

function hasNonEmptyValue(value: unknown) {
  return String(value ?? "").trim() !== "";
}

function shouldImportClosingSheetPersonRow(values: {
  employeeHrId: unknown;
  managerHrId: unknown;
  employeeName: unknown;
  territory: unknown;
}) {
  const hasMrHrId = hasNonEmptyValue(values.employeeHrId);
  const hasManagerHrId = hasNonEmptyValue(values.managerHrId);

  const employeeName = String(values.employeeName ?? "").trim().toLowerCase();
  const territory = String(values.territory ?? "").trim().toLowerCase();

  if (!hasMrHrId && !hasManagerHrId) return false;
  if (!employeeName && !territory) return false;
  if (employeeName === "grand total" || territory === "grand total") return false;

  return true;
}

function deriveFactoryPrice(values: {
  salesUnits: unknown;
  salesValue: unknown;
  targetUnits: unknown;
  targetValue: unknown;
}) {
  const candidates = [
    { units: Number(values.salesUnits), value: Number(values.salesValue) },
    { units: Number(values.targetUnits), value: Number(values.targetValue) },
  ];

  for (const candidate of candidates) {
    if (Number.isFinite(candidate.units) && candidate.units > 0 && Number.isFinite(candidate.value)) {
      return candidate.value / candidate.units;
    }
  }

  return 0;
}

type ClosingBlock = {
  achievementColumn: number;
  product: string;
  salesUnitsColumn: number;
  salesValueColumn: number;
  targetUnitsColumn: number;
  targetValueColumn: number;
};

export function extractClosingSheetRows(sheet: ExcelJS.Worksheet) {
  const maxColumn = Math.max(sheet.getRow(1).cellCount, sheet.getRow(2).cellCount);
  const blocks: ClosingBlock[] = [];

  for (let column = 8; column <= maxColumn; column += 1) {
    const product = resolveMergedCellText(sheet, 1, column);
    const metric = normalizeHeader(resolveMergedCellText(sheet, 2, column));

    if (!product || metric !== "sales units") continue;

    const block: ClosingBlock = {
      product,
      salesUnitsColumn: column,
      salesValueColumn: column + 1,
      targetUnitsColumn: column + 2,
      targetValueColumn: column + 3,
      achievementColumn: column + 4,
    };

    const labels = [
      normalizeHeader(resolveMergedCellText(sheet, 2, block.salesUnitsColumn)),
      normalizeHeader(resolveMergedCellText(sheet, 2, block.salesValueColumn)),
      normalizeHeader(resolveMergedCellText(sheet, 2, block.targetUnitsColumn)),
      normalizeHeader(resolveMergedCellText(sheet, 2, block.targetValueColumn)),
      normalizeHeader(resolveMergedCellText(sheet, 2, block.achievementColumn)),
    ];

    if (
      labels[0] === "sales units" &&
      labels[1] === "sales value" &&
      labels[2] === "target units" &&
      labels[3] === "target value" &&
      labels[4] === "ach %"
    ) {
      blocks.push(block);
      column += 4;
    }
  }

  const rows: Record<string, unknown>[] = [];
  for (let rowNumber = 3; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const employeeCrmId = readableCellValue(row.getCell(1));
    const employeeHrId = readableCellValue(row.getCell(2));
    const managerHrId = readableCellValue(row.getCell(3));
    const month = readableCellValue(row.getCell(4));
    const year = readableCellValue(row.getCell(5));
    const employeeName = readableCellValue(row.getCell(6));
    const territory = readableCellValue(row.getCell(7));

    if (!shouldImportClosingSheetPersonRow({ employeeHrId, managerHrId, employeeName, territory })) continue;

    for (const block of blocks) {
      const salesUnits = readableCellValue(row.getCell(block.salesUnitsColumn));
      const salesValue = readableCellValue(row.getCell(block.salesValueColumn));
      const targetUnits = readableCellValue(row.getCell(block.targetUnitsColumn));
      const targetValue = readableCellValue(row.getCell(block.targetValueColumn));
      const achievement = readableCellValue(row.getCell(block.achievementColumn));

      const hasMeasures = [salesUnits, salesValue, targetUnits, targetValue, achievement].some(
        (value) => String(value ?? "").trim() !== ""
      );
      if (!hasMeasures) continue;

      rows.push({
        "CRM_ID": employeeCrmId,
        "HR_ID": employeeHrId,
        "Manager HR ID": managerHrId,
        "Employee Name": employeeName,
        "Territory": territory,
        "Month": month,
        "Year": year,
        "Line": null,
        "Type of Sales": "Closing Sheet",
        "Family": buildClosingFamilyLabel(block.product),
        "Product": block.product,
        "Factory Price": deriveFactoryPrice({ salesUnits, salesValue, targetUnits, targetValue }),
        "Sales Units": salesUnits,
        "Sales Value": salesValue,
        "Target Units": targetUnits,
        "Target Value": targetValue,
        "__sourceRowNumber": rowNumber,
      });
    }
  }

  return {
    headers: ["CRM Code", "Med. Rep. Name"],
    rows,
  };
}

async function rowsFromWorkbook(file: File) {
  const workbook = new ExcelJS.Workbook();
  try {
    const buffer = await file.arrayBuffer();
    await workbook.xlsx.load(buffer as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    throw new SalesWorkflowError(
      "invalid_workbook",
      "The uploaded workbook could not be read. Please use a valid .xlsx file.",
      400
    );
  }

  const sheet =
    workbook.worksheets.find((worksheet) => detectSchemaType(sheetHeaders(worksheet)) !== "unsupported") ??
    workbook.worksheets[0];

  if (!sheet) {
    throw new SalesWorkflowError("invalid_workbook", "The uploaded workbook has no readable worksheets.", 400);
  }

  const headers = sheetHeaders(sheet);
  if (detectSchemaType(headers) !== "closing_sheet") {
    throw new SalesWorkflowError(
      "unsupported_schema",
      "The workbook schema is not supported. Upload the monthly closing sheet layout only.",
      400,
      { headers }
    );
  }

  return extractClosingSheetRows(sheet);
}

export async function readUploadRows(file: File): Promise<ParsedUploadRows> {
  const { headers, rows } = await rowsFromWorkbook(file);
  const schemaType = detectSchemaType(headers);

  if (rows.length === 0) {
    throw new SalesWorkflowError("invalid_workbook", "The uploaded workbook is empty.", 400);
  }

  return { headers, rows, schemaType };
}

function duplicateHash(line: string, month: number, year: number, rows: Record<string, unknown>[]) {
  const signature = JSON.stringify({
    line,
    month,
    year,
    headers: Object.keys(rows[0] ?? {}).sort(),
    sample: rows.slice(0, 5),
    count: rows.length,
  });
  return createHash("sha256").update(signature).digest("hex");
}

export async function parseSalesUpload(file: File, line: string, uploadedBy: string): Promise<SalesImportPayload> {
  const parsed = await readUploadRows(file);

  const parsedRecords = parsed.rows.map((row, index) =>
    parseSalesRow(row, line, Number(row.__sourceRowNumber) || index + 2)
  );
  const firstValid = parsedRecords.find((record) => record.month && record.year);
  const month = firstValid?.month || new Date().getMonth() + 1;
  const year = firstValid?.year || new Date().getFullYear();
  const periods = [
    ...new Set(
      parsedRecords
        .filter((record) => record.month && record.year)
        .map((record) => periodLabel(record.year, record.month))
    ),
  ].sort();
  const batchPeriod = periods.length > 1 ? `${periods[0]} to ${periods[periods.length - 1]}` : periodLabel(year, month);
  const validRecords = parsedRecords.filter((record) => record.validationState === "valid").length;
  const warningRecords = parsedRecords.filter((record) => record.validationState === "warning").length;
  const failedRecords = parsedRecords.filter((record) => record.validationState === "failed").length;

  return {
    batch: {
      id: crypto.randomUUID(),
      fileName: file.name,
      line,
      month,
      year,
      period: batchPeriod,
      status: failedRecords > 0 ? "needs_review" : "validated",
      schemaType: parsed.schemaType,
      totalRecords: parsedRecords.length,
      validRecords,
      warningRecords,
      failedRecords,
      linkedRecords: 0,
      linkageRate: 0,
      uploadedBy,
      createdAt: new Date().toISOString(),
      version: 1,
      duplicateHash: duplicateHash(line, month, year, parsed.rows),
      isDuplicate: false,
      canApprove: failedRecords === 0,
      replacementForBatchId: null,
      replacedByBatchId: null,
      approvedBy: null,
      approvedAt: null,
      rejectedBy: null,
      rejectedAt: null,
      previewUrl: null,
      approvalBlockedReason: failedRecords > 0 ? "This batch contains failed rows." : null,
    },
    records: parsedRecords,
  };
}
