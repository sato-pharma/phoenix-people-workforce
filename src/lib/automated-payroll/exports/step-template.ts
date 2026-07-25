import ExcelJS from "exceljs";

import {
  AMBER,
  BLACK,
  bandHeader,
  gridBorder,
  SLATE,
  VALUE_FMT,
  WHITE,
} from "@/lib/sales/sales-workbook-kit";

import { monthLabel } from "../notify.ts";
import { stepDefinition } from "../step-definitions.ts";
import type { MonthlySalaryRun, StepKey, StepRow } from "../types.ts";

/**
 * Generic pre-populated per-step xlsx: locked identity + context + "Recommended"
 * columns, amber EDITABLE columns for each field (plus Reason / Hold), branded
 * band, dropdowns where relevant. The same rows the UI grid shows. Re-uploaded and
 * parsed by imports/step-parser.ts (matched by header name, tolerant of the band).
 */

const RECOMMENDED_FILL = "FFF1F5F9";
const EDIT_FILL = AMBER;

export function stepTemplateColumns(stepKey: StepKey): { label: string; editable: boolean; money: boolean }[] {
  const definition = stepDefinition(stepKey);
  const columns: { label: string; editable: boolean; money: boolean }[] = [
    { label: "#", editable: false, money: false },
    { label: "HR_ID", editable: false, money: false },
    { label: "Full Name", editable: false, money: false },
  ];
  for (const context of definition.contextColumns) {
    columns.push({ label: context.label, editable: false, money: false });
  }
  if (definition.isHoldStep) {
    columns.push({ label: "Hold?", editable: true, money: false });
    columns.push({ label: "Hold Reason", editable: true, money: false });
    return columns;
  }
  for (const field of definition.fields) {
    // No system recommendation exists for a free-text reason or a routing choice —
    // only numeric (money/days) fields get a "Recommended" column.
    if (field.kind === "money" || field.kind === "days") {
      columns.push({ label: `Recommended ${field.label}`, editable: false, money: field.kind === "money" });
    }
    columns.push({ label: field.label, editable: true, money: field.kind === "money" });
  }
  if (definition.hasReason) columns.push({ label: "Reason", editable: true, money: false });
  return columns;
}

function cellValueForColumn(stepKey: StepKey, row: StepRow, label: string): string | number {
  const definition = stepDefinition(stepKey);
  if (label === "HR_ID") return row.hrId;
  if (label === "Full Name") return row.fullName;
  if (definition.isHoldStep) {
    if (label === "Hold?") return row.onHold ? "Yes" : "No";
    if (label === "Hold Reason") return row.reason ?? "";
  }
  const context = definition.contextColumns.find((column) => column.label === label);
  if (context) {
    const value = row.context[context.key];
    return value == null ? "" : (value as string | number);
  }
  if (label === "Reason") return row.reason ?? "";
  const recommendedField = definition.fields.find((field) => `Recommended ${field.label}` === label);
  if (recommendedField) return row.recommended[recommendedField.key] ?? 0;
  const editField = definition.fields.find((field) => field.label === label);
  if (editField) {
    if (editField.kind === "text") return row.reasons?.[editField.key] ?? "";
    if (editField.kind === "select") return row.selects?.[editField.key] ?? editField.options?.[0]?.value ?? "";
    return row.values[editField.key] ?? 0;
  }
  return "";
}

export async function buildStepTemplateWorkbook(input: {
  run: MonthlySalaryRun;
  stepKey: StepKey;
  rows: StepRow[];
}): Promise<Buffer> {
  const definition = stepDefinition(input.stepKey);
  const columns = stepTemplateColumns(input.stepKey);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(definition.title.slice(0, 28));

  bandHeader(
    sheet,
    columns.length,
    `${definition.title} — ${monthLabel(input.run.month, input.run.year)}`,
    "Edit the amber columns only, then re-upload. Grey columns are the system recommendation.",
  );

  const headerRowNumber = 5;
  const headerRow = sheet.getRow(headerRowNumber);
  columns.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = column.label;
    cell.font = { bold: true, color: { argb: WHITE }, name: "Calibri", size: 10.5 };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.fill = { fgColor: { argb: BLACK }, pattern: "solid", type: "pattern" };
    cell.border = gridBorder();
  });
  headerRow.height = 28;

  let rowNumber = headerRowNumber + 1;
  input.rows.forEach((row, index) => {
    const excelRow = sheet.getRow(rowNumber);
    columns.forEach((column, ci) => {
      const cell = excelRow.getCell(ci + 1);
      cell.value = ci === 0 ? index + 1 : (cellValueForColumn(input.stepKey, row, column.label) as ExcelJS.CellValue);
      if (column.money && typeof cell.value === "number") cell.numFmt = VALUE_FMT;
      cell.font = { color: { argb: SLATE }, name: "Calibri", size: 10 };
      cell.alignment = { horizontal: column.money ? "right" : "left", vertical: "middle" };
      cell.border = gridBorder();
      if (column.editable) {
        cell.fill = { fgColor: { argb: EDIT_FILL }, pattern: "solid", type: "pattern" };
      } else if (column.label.startsWith("Recommended")) {
        cell.fill = { fgColor: { argb: RECOMMENDED_FILL }, pattern: "solid", type: "pattern" };
      }
      if (definition.isHoldStep && column.label === "Hold?") {
        cell.dataValidation = {
          type: "list",
          allowBlank: true,
          formulae: ['"Yes,No"'],
          showErrorMessage: true,
          error: "Enter Yes or No.",
        };
      }
      const selectField = definition.fields.find(
        (field) => field.kind === "select" && field.label === column.label,
      );
      if (selectField?.options?.length) {
        const choices = selectField.options.map((option) => option.value).join(",");
        cell.dataValidation = {
          type: "list",
          allowBlank: true,
          formulae: [`"${choices}"`],
          showErrorMessage: true,
          error: `Enter one of: ${choices}.`,
        };
      }
    });
    rowNumber += 1;
  });

  columns.forEach((column, index) => {
    sheet.getColumn(index + 1).width = Math.min(26, Math.max(12, column.label.length + 2));
  });
  sheet.getColumn(3).width = 26;
  sheet.views = [{ state: "frozen", ySplit: headerRowNumber, showGridLines: false }];

  return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
}
