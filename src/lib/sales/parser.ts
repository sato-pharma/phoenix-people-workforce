import ExcelJS from "exceljs";
import { createHash } from "crypto";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { periodLabel } from "@/lib/sales/format";
import { parseSalesRow, parseTargetRow } from "@/lib/sales/validation";
import type { SalesImportPayload, TargetUploadPayload } from "@/lib/sales/types";

export type UploadSchemaType = "raw_sales" | "pivot_summary" | "unsupported";

export type ParsedUploadRows = {
  headers: string[];
  rows: Record<string, unknown>[];
  schemaType: UploadSchemaType;
};

function detectDelimiter(line: string) {
  const delimiters = [",", "\t", ";"];
  return (
    delimiters
      .map((delimiter) => ({ delimiter, count: line.split(delimiter).length }))
      .sort((left, right) => right.count - left.count)[0]?.delimiter || ","
  );
}

function rowsFromDelimited(text: string) {
  const lines = text
    .replace(/^ï»¿/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return { headers: [], rows: [] };

  const delimiter = detectDelimiter(lines[0]);
  const headers = lines[0].split(delimiter).map((header) => header.trim());
  const rows = lines.slice(1).map((line) => {
    const values = line.split(delimiter);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });

  return { headers, rows };
}

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
  if (headers.includes("D.M.") && headers.includes("Sales Value")) return "raw_sales";
  if (headers.includes("Row Labels")) return "pivot_summary";
  return "unsupported";
}

async function rowsFromWorkbook(file: File) {
  if (file.name.toLowerCase().endsWith(".csv") || file.name.toLowerCase().endsWith(".tsv")) {
    return rowsFromDelimited(await file.text());
  }

  const workbook = new ExcelJS.Workbook();
  try {
    const buffer = await file.arrayBuffer();
    await workbook.xlsx.load(buffer as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    throw new SalesWorkflowError(
      "invalid_workbook",
      "The uploaded workbook could not be read. Please use a valid .xlsx, .csv, or .tsv file.",
      400
    );
  }

  const sheet =
    workbook.worksheets.find((worksheet) => {
      const headers = sheetHeaders(worksheet);
      return detectSchemaType(headers) !== "unsupported";
    }) ?? workbook.worksheets[0];

  if (!sheet) {
    throw new SalesWorkflowError("invalid_workbook", "The uploaded workbook has no readable worksheets.", 400);
  }

  const headers = sheetHeaders(sheet);
  const rows: Record<string, unknown>[] = [];
  for (let rowIndex = 2; rowIndex <= sheet.rowCount; rowIndex += 1) {
    const row = sheet.getRow(rowIndex);
    const record = Object.fromEntries(
      headers.map((header, index) => [header, readableCellValue(row.getCell(index + 1))])
    );
    const hasValue = Object.values(record).some((value) => String(value ?? "").trim() !== "");
    if (hasValue) rows.push(record);
  }

  return { headers, rows };
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
  if (parsed.schemaType === "unsupported") {
    throw new SalesWorkflowError(
      "unsupported_schema",
      "The workbook schema is not supported. Use a sales export with columns like D.M. and Sales Value.",
      400,
      { headers: parsed.headers }
    );
  }

  const parsedRecords = parsed.rows.map((row, index) => parseSalesRow(row, line, index + 2));
  const firstValid = parsedRecords.find((record) => record.month && record.year);
  const month = firstValid?.month || new Date().getMonth() + 1;
  const year = firstValid?.year || new Date().getFullYear();
  const normalizedRecords = parsedRecords;
  const periods = [
    ...new Set(
      normalizedRecords
        .filter((record) => record.month && record.year)
        .map((record) => periodLabel(record.year, record.month))
    ),
  ].sort();
  const batchPeriod = periods.length > 1 ? `${periods[0]} to ${periods[periods.length - 1]}` : periodLabel(year, month);
  const validRecords = normalizedRecords.filter((record) => record.validationState === "valid").length;
  const warningRecords = normalizedRecords.filter((record) => record.validationState === "warning").length;
  const failedRecords = normalizedRecords.filter((record) => record.validationState === "failed").length;

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
      totalRecords: normalizedRecords.length,
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
    records: normalizedRecords,
  };
}

export async function parseTargetUpload(file: File): Promise<TargetUploadPayload> {
  const parsed = await readUploadRows(file);
  const parsedRecords = parsed.rows.map((row) => parseTargetRow(row));
  const firstValid = parsedRecords.find((record) => record.month && record.year);
  const month = firstValid?.month || new Date().getMonth() + 1;
  const year = firstValid?.year || new Date().getFullYear();
  const validRecords = parsedRecords.filter((record) => record.status === "valid").length;
  const failedRecords = parsedRecords.filter((record) => record.status === "failed").length;
  const batchId = crypto.randomUUID();

  return {
    batch: {
      id: batchId,
      fileName: file.name,
      month,
      year,
      status: failedRecords > 0 ? "uploaded" : "validated",
      totalRecords: parsedRecords.length,
      validRecords,
      failedRecords,
      createdAt: new Date().toISOString(),
    },
    records: parsedRecords.map((record) => ({ ...record, batchId })),
  };
}
