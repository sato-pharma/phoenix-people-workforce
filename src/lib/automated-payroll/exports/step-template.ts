import ExcelJS from "exceljs";
import { HOUSE_XLSX_FONT } from "@/lib/export/house-xlsx-palette";

import { HOUSE_XLSX_COLORS, writeHouseMasthead } from "@/lib/export/house-xlsx-identity";
import {
  PAYROLL_HEADER_ROW,
  payrollHeaderCell,
  writePayrollSectionBand,
} from "@/lib/payroll/payroll-sheet-style";
import { VALUE_FMT } from "@/lib/sales/sales-workbook-kit";

import { monthLabel } from "../notify.ts";
import { stepDefinition, stepFieldsTotal } from "../step-definitions.ts";
import type { MonthlySalaryRun, StepKey, StepRow } from "../types.ts";

/**
 * Generic pre-populated per-step xlsx: locked identity + context + "Recommended"
 * columns, amber EDITABLE columns for each field (plus Reason / Hold), branded
 * band, dropdowns where relevant. The same rows the UI grid shows. Re-uploaded and
 * parsed by imports/step-parser.ts (matched by header name, tolerant of the band).
 */

/**
 * Which group a column belongs to, for the band above the header.
 *
 * The sheet has four kinds of column and used to distinguish them by fill alone — amber meant
 * "type here", grey meant "the system's suggestion". A caption says it in words, which survives
 * greyscale and a reader who has never been told what amber meant.
 */
function bandLabelFor(
  column: { editable: boolean; label: string },
  totalLabel: string | null,
): string {
  if (column.label === "#" || column.label === "HR_ID" || column.label === "Full Name") return "Row";
  if (column.label.startsWith("Recommended")) return "System recommendation";
  if (totalLabel && column.label === totalLabel) return "Step total";
  return column.editable ? "Your entry" : "Context";
}

export function stepTemplateColumns(stepKey: StepKey): { label: string; editable: boolean; money: boolean }[] {
  const definition = stepDefinition(stepKey);
  const columns: { label: string; editable: boolean; money: boolean }[] = [
    { label: "#", editable: false, money: false },
    { label: "HR_ID", editable: false, money: false },
    { label: "Full Name", editable: false, money: false },
  ];
  for (const context of definition.contextColumns) {
    // Honour the column's own `money` flag so the sheet formats a salary the way
    // the screen does — an export must match the screen. Still read-only either
    // way: context columns are never parsed back on re-upload (step-parser.ts
    // matches editable `field.label`s only).
    columns.push({ label: context.label, editable: false, money: context.money ?? false });
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
  // The step's live total sits after the fields it sums, mirroring the card.
  // Read-only: step-parser.ts matches editable `field.label`s only, so this
  // column is never parsed back on re-upload and can never become a second,
  // competing source of truth for the money. Declared AFTER the fields and
  // BEFORE Reason so the sheet reads in the same order as the screen.
  if (definition.fieldsTotal) {
    columns.push({ label: definition.fieldsTotal.label, editable: false, money: true });
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
  if (definition.fieldsTotal && definition.fieldsTotal.label === label) {
    return stepFieldsTotal(definition, row.values);
  }
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

  sheet.views = [{ showGridLines: false }];
  writeHouseMasthead(workbook, sheet, {
    columns: columns.length,
    provenance: [`${input.rows.length} row${input.rows.length === 1 ? "" : "s"}`],
    subtitle:
      "Type in the \"Your entry\" columns, then re-upload. Everything else is locked — the upload " +
      "reads your entry columns only, so an edit anywhere else was silently ignored before.",
    title: `${definition.title} — ${monthLabel(input.run.month, input.run.year)}`,
  });

  // The band says what each group of columns IS, so "which ones do I fill in" stops depending on
  // knowing what amber meant.
  const totalLabel = definition.fieldsTotal?.label ?? null;
  const bands: { from: number; label: string; to: number }[] = [];
  columns.forEach((column, index) => {
    const label = bandLabelFor(column, totalLabel);
    const previous = bands[bands.length - 1];
    if (previous && previous.label === label && previous.to === index) previous.to = index + 1;
    else bands.push({ from: index + 1, label, to: index + 1 });
  });
  writePayrollSectionBand(sheet, bands);

  const headerRowNumber = PAYROLL_HEADER_ROW;
  const headerRow = sheet.getRow(headerRowNumber);
  columns.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = column.label;
    payrollHeaderCell(cell, { execution: column.editable, numeric: column.money });
  });
  headerRow.height = 28;

  let rowNumber = headerRowNumber + 1;
  input.rows.forEach((row, index) => {
    const excelRow = sheet.getRow(rowNumber);
    columns.forEach((column, ci) => {
      const cell = excelRow.getCell(ci + 1);
      cell.value = ci === 0 ? index + 1 : (cellValueForColumn(input.stepKey, row, column.label) as ExcelJS.CellValue);
      if (column.money && typeof cell.value === "number") cell.numFmt = VALUE_FMT;
      // Your-entry cells read as the live ones: full-strength type on the 6% tint. Everything else
      // is muted, and LOCKED below — the upload parses editable labels only, so an edit to a
      // context or recommendation column was accepted by the sheet and then thrown away.
      cell.font = {
        bold: column.editable,
        color: { argb: column.editable ? HOUSE_XLSX_COLORS.body : HOUSE_XLSX_COLORS.muted },
        name: HOUSE_XLSX_FONT,
        size: 9.5,
      };
      cell.alignment = { horizontal: column.money ? "right" : "left", vertical: "middle" };
      cell.border = { bottom: { style: "hair", color: { argb: HOUSE_XLSX_COLORS.hair } } };
      if (column.editable) {
        cell.fill = { fgColor: { argb: HOUSE_XLSX_COLORS.tint }, pattern: "solid", type: "pattern" };
      }
      cell.protection = { locked: !column.editable };
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
  sheet.views = [{ showGridLines: false, state: "frozen", xSplit: 3, ySplit: headerRowNumber }];

  // Protection is what makes "locked" true rather than merely stated. Selection stays free so the
  // sheet can still be read and copied.
  await sheet.protect("", {
    autoFilter: true,
    formatCells: true,
    formatColumns: true,
    formatRows: true,
    selectLockedCells: true,
    selectUnlockedCells: true,
    sort: true,
  });

  appendDetailSheet(workbook, input);

  return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
}

/**
 * Second, read-only "Detail" worksheet: every source line behind every row —
 * the individual trips behind an expense total, the individual days behind a
 * deduction (owner request 2026-08-01). Keyed by HR_ID so it can be pivoted or
 * VLOOKUP'd against the editable first sheet.
 *
 * Deliberately the SECOND sheet and never parsed back: the re-upload parser
 * reads `firstExcelWorksheet` only, so nothing here can be edited into the
 * payroll. Skipped entirely for steps with no `detailColumns`.
 */
function appendDetailSheet(
  workbook: ExcelJS.Workbook,
  input: { run: MonthlySalaryRun; stepKey: StepKey; rows: StepRow[] },
): void {
  const definition = stepDefinition(input.stepKey);
  const detailColumns = definition.detailColumns ?? [];
  if (detailColumns.length === 0) return;
  if (!input.rows.some((row) => (row.details?.length ?? 0) > 0)) return;

  const sheet = workbook.addWorksheet("Detail");
  const labels = ["HR_ID", "Full Name", ...detailColumns.map((column) => column.label)];

  sheet.views = [{ showGridLines: false }];
  writeHouseMasthead(workbook, sheet, {
    columns: labels.length,
    provenance: ["Read-only"],
    subtitle:
      "Every line behind each employee's figure on the first sheet. The upload reads only the " +
      "first sheet, so nothing typed here can reach the payroll.",
    title: `${definition.title} — breakdown — ${monthLabel(input.run.month, input.run.year)}`,
  });

  const headerRowNumber = PAYROLL_HEADER_ROW;
  const headerRow = sheet.getRow(headerRowNumber);
  labels.forEach((label, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = label;
    payrollHeaderCell(cell, { numeric: index >= 2 && detailColumns[index - 2]?.money === true });
  });
  headerRow.height = 28;

  let rowNumber = headerRowNumber + 1;
  for (const row of input.rows) {
    for (const line of row.details ?? []) {
      const excelRow = sheet.getRow(rowNumber);
      const values: (string | number)[] = [
        row.hrId,
        row.fullName,
        ...detailColumns.map((column) => {
          const value = line[column.key];
          if (column.money) return Number(value ?? 0);
          return value == null ? "" : (value as string | number);
        }),
      ];
      values.forEach((value, index) => {
        const cell = excelRow.getCell(index + 1);
        cell.value = value;
        const isMoney = index >= 2 && detailColumns[index - 2]?.money === true;
        if (isMoney && typeof value === "number") cell.numFmt = VALUE_FMT;
        cell.font = { color: { argb: HOUSE_XLSX_COLORS.body }, name: HOUSE_XLSX_FONT, size: 9.5 };
        cell.alignment = { horizontal: isMoney ? "right" : "left", vertical: "middle" };
        cell.border = { bottom: { style: "hair", color: { argb: HOUSE_XLSX_COLORS.hair } } };
        if (rowNumber % 2 === 0) {
          cell.fill = { fgColor: { argb: HOUSE_XLSX_COLORS.tint }, pattern: "solid", type: "pattern" };
        }
      });
      rowNumber += 1;
    }
  }

  labels.forEach((label, index) => {
    sheet.getColumn(index + 1).width = Math.min(34, Math.max(12, label.length + 2));
  });
  sheet.getColumn(2).width = 26;
  sheet.views = [{ showGridLines: false, state: "frozen", xSplit: 2, ySplit: headerRowNumber }];
}
