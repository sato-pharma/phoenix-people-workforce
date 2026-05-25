import ExcelJS from "exceljs";

export type ExcelJsonRow = Record<string, unknown>;

export function readableExcelCellValue(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value;

  if (typeof value === "object") {
    if ("result" in value) {
      return readableExcelCellValue((value as { result?: ExcelJS.CellValue }).result ?? "");
    }

    if ("text" in value) {
      return String((value as { text?: unknown }).text ?? "");
    }

    if ("richText" in value) {
      const richText = (value as { richText?: Array<{ text?: unknown }> }).richText ?? [];
      return richText.map((part) => String(part.text ?? "")).join("");
    }
  }

  return value;
}

export function excelCellText(value: ExcelJS.CellValue) {
  const readable = readableExcelCellValue(value);
  if (readable instanceof Date) return readable.toISOString().slice(0, 10);
  return String(readable ?? "").replace(/\s+/g, " ").trim();
}

export async function loadExcelWorkbook(buffer: ArrayBuffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as Parameters<typeof workbook.xlsx.load>[0]);
  return workbook;
}

export function firstExcelWorksheet(workbook: ExcelJS.Workbook) {
  return workbook.worksheets[0] ?? null;
}

export function excelWorksheetToMatrix(
  worksheet: ExcelJS.Worksheet,
  options: { includeEmptyRows?: boolean } = {},
) {
  const matrix: unknown[][] = [];

  for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const values = Array.from({ length: worksheet.columnCount }, (_, index) =>
      readableExcelCellValue(row.getCell(index + 1).value),
    );

    if (!options.includeEmptyRows && values.every((value) => !excelCellText(value as ExcelJS.CellValue))) {
      continue;
    }

    matrix.push(values);
  }

  return matrix;
}

function uniqueHeaderName(header: string, seen: Map<string, number>) {
  const base = header || "__EMPTY";
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}_${count}`;
}

export function excelWorksheetToJsonRows(
  worksheet: ExcelJS.Worksheet,
  headerRowNumber: number,
  options: { defaultValue?: unknown } = {},
): ExcelJsonRow[] {
  const headerRow = worksheet.getRow(headerRowNumber);
  const seen = new Map<string, number>();
  const headers = Array.from({ length: worksheet.columnCount }, (_, index) =>
    uniqueHeaderName(excelCellText(headerRow.getCell(index + 1).value), seen),
  );
  const rows: ExcelJsonRow[] = [];

  for (let rowNumber = headerRowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const values = headers.map((header, index) => [
      header,
      readableExcelCellValue(row.getCell(index + 1).value),
    ] as const);

    if (values.every(([, value]) => !excelCellText(value as ExcelJS.CellValue))) {
      continue;
    }

    rows.push(Object.fromEntries(
      values.map(([header, value]) => [
        header,
        value === "" ? options.defaultValue ?? "" : value,
      ]),
    ));
  }

  return rows;
}
