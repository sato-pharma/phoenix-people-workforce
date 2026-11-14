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

import { STEP_FILE_NEVER_SAVED, STEP_FILE_REVISION_PREFIX } from "../imports/step-file-revision.ts";
import { monthLabel } from "../notify.ts";
import { stepDefinition, stepFieldsTotal } from "../step-definitions.ts";
import type { MonthlySalaryRun, StepKey, StepRow } from "../types.ts";

/**
 * Generic pre-populated per-step xlsx: locked identity + context + "Recommended"
 * columns, amber EDITABLE columns for each field (plus Reason / Hold), branded
 * band, dropdowns where relevant. The same rows the UI grid shows. Re-uploaded and
 * parsed by imports/step-parser.ts (matched by header name, tolerant of the band).
 */

const RECOMMENDED_FILL = "FFF1F5F9";
const EDIT_FILL = AMBER;

type TemplateColumn = { label: string; editable: boolean; money: boolean };

export function stepTemplateColumns(stepKey: StepKey): TemplateColumn[] {
  const definition = stepDefinition(stepKey);
  const columns: { label: string; editable: boolean; money: boolean }[] = [
    { label: "#", editable: false, money: false },
    { label: "HR_ID", editable: false, money: false },
    { label: "Full Name", editable: false, money: false },
  ];
  for (const context of definition.contextColumns) {
    // Honour the column's own `money` flag so the sheet formats a salary the way
    // the screen does — an export must match the screen.
    //
    // READ-ONLY ONLY WHILE ITS HEADING IS UNIQUE. This comment used to say context columns "are
    // never parsed back on re-upload", and that belief is what let finding 33 ship: step-parser's
    // `pickCell` matches on the normalised HEADING TEXT and returns the FIRST column that matches,
    // so a context column sharing a heading with an editable field IS what gets read — and its
    // value is then written into that field. The rule is enforced below rather than assumed here.
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
    // A field with nowhere to be saved ships read-only (audit finding 31): an editable column the
    // commit cannot store is a promise the sheet breaks, and the parser skips it for the same reason.
    columns.push({ label: field.label, editable: field.notPersisted !== true, money: field.kind === "money" });
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
  assertHeadingsAreUnique(stepKey, columns);
  return columns;
}

/**
 * TWO COLUMNS MAY NEVER SHARE A HEADING.
 *
 * `pickCell` in step-parser.ts finds a column by its normalised heading text and returns the FIRST
 * match, and `sheet_to_json` renames a duplicate header rather than dropping it. So a template with
 * two identical headings does not merely look untidy — it reads the wrong column on re-upload and
 * writes that value into the other one's field. On the Part 1 Unpaid Vacation step that replaced a
 * leaver's balance-aware settlement with a flat day rate and silently discarded the figure
 * HR had actually typed.
 *
 * Refusing the download is the right failure: a template with colliding headings is already a
 * booby-trapped file, and handing it over to be filled in and re-uploaded is worse than not
 * handing it over at all. Unreachable today — `tests/automated-payroll-template-headings.test.ts`
 * checks every step at CI time — so this only ever catches a definition built after that test.
 */
function assertHeadingsAreUnique(stepKey: StepKey, columns: TemplateColumn[]): void {
  const seen = new Map<string, string>();
  for (const column of columns) {
    const normalized = column.label.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const first = seen.get(normalized);
    if (first !== undefined) {
      throw new Error(
        `The ${stepKey} step template has two columns reading as the same heading ` +
          `("${first}" and "${column.label}"). A re-upload would read the first and write it into ` +
          "the other's field, so the template is not safe to hand out. Give one of them a " +
          "distinct heading.",
      );
    }
    seen.set(normalized, column.label);
  }
}

/**
 * A worksheet name Excel will accept, built from the step's own title.
 *
 * ExcelJS THROWS on a sheet name containing any of * ? : \ / [ ], and it throws before a single
 * byte is written. The Part 2 step is titled "Any more deductions?", so `addWorksheet` rejected it
 * and the Download-template button on that one step answered 500 with nothing to say — found
 * 2026-09-12 while re-verifying finding 48, which could not be checked on that step because the
 * template it needs cannot be produced.
 *
 * Derived from the title rather than hard-coded per step, because the title is what a future step
 * changes, and a punctuation mark in it must never again decide whether a download works.
 */
function worksheetNameFor(title: string): string {
  const cleaned = title.replace(/[*?:\\\/\[\]]/g, "").replace(/\s+/g, " ").trim();
  return (cleaned || "Step").slice(0, 28);
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
  /** The step's revision this file is built from (null: never saved). Read back by parseStepWorkbook. */
  revision?: string | null;
}): Promise<Buffer> {
  const definition = stepDefinition(input.stepKey);
  const columns = stepTemplateColumns(input.stepKey);
  const workbook = new ExcelJS.Workbook();
  // Invisible on the sheet: a document property, so the layout and every column stay as they are.
  if (input.revision !== undefined) {
    workbook.keywords = `${STEP_FILE_REVISION_PREFIX}${input.revision ?? STEP_FILE_NEVER_SAVED}`;
  }
  const sheet = workbook.addWorksheet(worksheetNameFor(definition.title));

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
  sheet.views = [{ state: "frozen", ySplit: headerRowNumber, showGridLines: false }];

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

  bandHeader(
    sheet,
    labels.length,
    `${definition.title} — breakdown — ${monthLabel(input.run.month, input.run.year)}`,
    "Read-only. Every line behind each employee's figure on the first sheet. Edits here are ignored on re-upload.",
  );

  const headerRowNumber = 5;
  const headerRow = sheet.getRow(headerRowNumber);
  labels.forEach((label, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = label;
    cell.font = { bold: true, color: { argb: WHITE }, name: "Calibri", size: 10.5 };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.fill = { fgColor: { argb: BLACK }, pattern: "solid", type: "pattern" };
    cell.border = gridBorder();
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
        cell.font = { color: { argb: SLATE }, name: "Calibri", size: 10 };
        cell.alignment = { horizontal: isMoney ? "right" : "left", vertical: "middle" };
        cell.border = gridBorder();
        cell.fill = { fgColor: { argb: RECOMMENDED_FILL }, pattern: "solid", type: "pattern" };
      });
      rowNumber += 1;
    }
  }

  labels.forEach((label, index) => {
    sheet.getColumn(index + 1).width = Math.min(34, Math.max(12, label.length + 2));
  });
  sheet.getColumn(2).width = 26;
  sheet.views = [{ state: "frozen", ySplit: headerRowNumber, showGridLines: false }];
}
