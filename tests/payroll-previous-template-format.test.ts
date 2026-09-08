import assert from "node:assert/strict";
import ExcelJS from "exceljs";

import { checkWorkbook } from "../scripts/check-workbook-integrity.mjs";
import { buildFullSheetWorkbook, buildPart1SheetWorkbook } from "../src/lib/automated-payroll/exports/sheet.ts";
import { buildStepTemplateWorkbook } from "../src/lib/automated-payroll/exports/step-template.ts";
import type { AssembledRow } from "../src/lib/automated-payroll/assemble.ts";
import type { MonthlySalaryRun, StepRow } from "../src/lib/automated-payroll/types.ts";
import { HOUSE_XLSX_COLORS } from "../src/lib/export/house-xlsx-palette.ts";
import {
  PAYROLL_HEADER_ROW,
  PAYROLL_SECTION_ROW,
  PAYROLL_TEMPLATE_TOTAL_HEADERS,
  payrollTemplateColumnWidth,
  resolvePayrollBands,
} from "../src/lib/payroll/payroll-sheet-style.ts";
import type { PayrollSheetHeader } from "../src/lib/payroll/salary-sheet-fields.ts";

// The automated payroll sheets are cut to the PREVIOUS salary template — the one
// `/api/payroll/template` produces — because the owner asked for the two to be one format
// (2026-09-08). They were already on the same masthead and the same columns; what differed was the
// grid, and every difference below was invisible in a screenshot and survived review once:
//
//   1. the ZEBRA SAT ON THE OPPOSITE ROWS. The template tints even SHEET rows and data starts at
//      row 6; the run sheet tinted by row INDEX, so row 6 was white where the template has it
//      tinted. Two sheets of the same month, printed side by side, striped in antiphase.
//   2. NO RULE WHERE A SECTION ENDS. The format carries no fills, so the Brand Blue rule at each
//      boundary is the only thing separating "Additions" from "Governmental Deductions" — without
//      it 37 money columns read as one undivided block.
//   3. THE SUBTOTALS READ AS ENTRY. Total Additions / Governmental Deductions / Total Deductions
//      are derived, and the template sets them in deep bold for exactly that reason.
//
// And the half that must NOT be lost to any of it: HELD and the execution column are the run
// sheet's own signals, which an upload template has no idea exist. A held row is dropped at publish
// with no salary_record written, so its thick leading rule is load-bearing, and the editable tint
// on a step template is an instruction rather than decoration.

const run: MonthlySalaryRun = {
  createdAt: "", createdBy: null, id: "run-1", month: 7, monthKey: "2026-07",
  part1ConfirmedAt: null, part1ConfirmedBy: null, part2ConfirmedAt: null, part2ConfirmedBy: null,
  phase: "part1", publishedAt: null, publishedBatchId: null, publishedBy: null,
  updatedAt: "", year: 2026,
};

const HELD_NAME = "Beta Two";

function assembled(hrId: string, fullName: string, onHold = false): AssembledRow {
  return {
    bankAccount: "EG1", bankName: "CIB", carriedForwardApplied: 0, compact: hrId.toLowerCase(),
    lifecycle: "regular", onHold, overpaidResidual: 0,
    row: {
      area: "Cairo", baseSalary: 12000, bonus: 0, calendarDays: 31, crm: 0, employmentIncomeTax: 640,
      expenses: 0, extraCostOfLiving: 500, fingerPrint: 0, firstPart: 6000, fuelAllowance: 800,
      fullName, governmentalDeductions: 1140, grossSalary: 13140, hireDate: "2022-06-01", hrId,
      incentive: 0, jobTitle: "Medical Rep", line: "CNS", loans: 0, medicalInsurance: 0,
      monthSalary: 12000, nameAr: null, netSalary: 13300, otherAdditions: 0, otherDeductions: 0,
      overtime: 0, paymentMode: "two_parts", payrollComment: null, row: 1, secondPart: 6000,
      socialInsurance: 500, totalAdditions: 1300, totalDeductions: 1140, unpaidVacations: 0,
      workingDays: 26,
    },
  } as AssembledRow;
}

async function load(buffer: ArrayBuffer | Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  return workbook;
}

/** The labels actually written on the header row, in order. */
function headerLabels(sheet: ExcelJS.Worksheet): string[] {
  const labels: string[] = [];
  sheet.getRow(PAYROLL_HEADER_ROW).eachCell((cell) => labels.push(String(cell.value ?? "").trim()));
  return labels;
}

export async function runPayrollPreviousTemplateFormatTests() {
  const rows = [
    assembled("A-1", "Alpha One"),
    assembled("B-2", HELD_NAME, true),
    assembled("C-3", "Gamma Three"),
  ];

  for (const [variant, buffer] of [
    ["full", await buildFullSheetWorkbook({ run, rows })],
    ["part1", await buildPart1SheetWorkbook({ run, rows })],
  ] as const) {
    // ExcelJS emits schema-invalid fragments on some paths and Excel then "repairs" the workbook
    // silently — which throws away exactly the styling this test is about.
    await checkWorkbook(buffer as Buffer);

    const workbook = await load(buffer as Buffer);
    const sheet = workbook.worksheets[workbook.worksheets.length - 1];
    const labels = headerLabels(sheet);
    const columnOf = (header: string) => labels.indexOf(header) + 1;
    const firstDataRow = PAYROLL_HEADER_ROW + 1;

    // ── the template's metrics ──────────────────────────────────────────────────
    assert.equal(
      sheet.getRow(PAYROLL_SECTION_ROW).height,
      24,
      `${variant}: the band row is 24 high in the previous template`,
    );
    assert.equal(
      sheet.getRow(PAYROLL_HEADER_ROW).height,
      32,
      `${variant}: the header row is 32 high in the previous template`,
    );

    for (const [index, label] of labels.entries()) {
      if (label === "Full Name") continue; // the one deliberate override — it carries the longest value
      assert.equal(
        sheet.getColumn(index + 1).width,
        payrollTemplateColumnWidth(label),
        `${variant}: "${label}" must be the width the previous template gives it`,
      );
    }

    // ── the template's grid ─────────────────────────────────────────────────────
    const bodyCell = sheet.getRow(firstDataRow).getCell(columnOf("Base Salary"));
    assert.equal(bodyCell.alignment?.wrapText, true, `${variant}: template body cells wrap`);
    assert.equal(
      bodyCell.border?.bottom?.style,
      "hair",
      `${variant}: a hairline under every cell, tinted or not`,
    );
    assert.equal(bodyCell.border?.right?.style, "hair", `${variant}: a hairline beside every cell`);

    // A section boundary carries the Brand Blue rule — the only thing dividing the sections now
    // that none of them has a fill of its own.
    const bands = resolvePayrollBands(labels as PayrollSheetHeader[]);
    const closing = bands.find((band) => band.to > band.from && band.to < labels.length);
    assert.ok(closing, `${variant}: the sheet has at least one multi-column section to close`);
    const closingBorder = sheet.getRow(firstDataRow).getCell(closing.to).border;
    assert.equal(
      closingBorder?.right?.style,
      "thin",
      `${variant}: a section closes with a rule, not a hairline`,
    );
    assert.equal(
      closingBorder?.right?.color?.argb,
      HOUSE_XLSX_COLORS.blue,
      `${variant}: the section rule is Brand Blue`,
    );

    // ── the zebra sits on EVEN sheet rows, as the template has it ───────────────
    const zebraColumn = columnOf("Base Salary");
    for (const rowNumber of [firstDataRow, firstDataRow + 1, firstDataRow + 2]) {
      const isHeld =
        String(sheet.getRow(rowNumber).getCell(columnOf("Full Name")).value ?? "") === HELD_NAME;
      const fill = (sheet.getRow(rowNumber).getCell(zebraColumn).fill as ExcelJS.FillPattern | undefined)
        ?.fgColor?.argb ?? null;
      // A held row is never tinted — its own signal must not be read as one more stripe.
      const expected = rowNumber % 2 === 0 && !isHeld ? HOUSE_XLSX_COLORS.tint : null;
      assert.equal(
        fill,
        expected,
        `${variant}: row ${rowNumber} must follow the template's even-row tint rule`,
      );
    }

    // ── the subtotals read as derived, not as entry ─────────────────────────────
    for (const header of PAYROLL_TEMPLATE_TOTAL_HEADERS) {
      const column = columnOf(header);
      if (column <= 0) continue; // the Part-1 subset does not carry every subtotal
      const font = sheet.getRow(firstDataRow).getCell(column).font;
      assert.equal(font?.bold, true, `${variant}: "${header}" is a subtotal and the template bolds it`);
      assert.equal(
        font?.color?.argb,
        HOUSE_XLSX_COLORS.deep,
        `${variant}: "${header}" is set in deep, like every subtotal on the template`,
      );
    }

    // ── what the template has no idea about, and must survive it ────────────────
    const heldRow = [firstDataRow, firstDataRow + 1, firstDataRow + 2].find(
      (rowNumber) =>
        String(sheet.getRow(rowNumber).getCell(columnOf("Full Name")).value ?? "") === HELD_NAME,
    );
    assert.ok(heldRow, `${variant}: the held row is on the sheet`);
    const leading = sheet.getRow(heldRow).getCell(1).border;
    assert.equal(leading?.left?.style, "thick", `${variant}: a held row keeps its leading rule`);
    assert.equal(
      leading?.left?.color?.argb,
      HOUSE_XLSX_COLORS.flag,
      `${variant}: the held rule stays the flag colour`,
    );

    const firstPart = columnOf("First Part");
    assert.ok(firstPart > 0, `${variant}: First Part is on the sheet`);
    const execution = sheet.getRow(firstDataRow).getCell(firstPart).border;
    assert.equal(execution?.left?.style, "thin", `${variant}: the execution column keeps its left bracket`);
    assert.equal(execution?.right?.style, "thin", `${variant}: the execution column keeps its right bracket`);
  }

  // ── the step template takes the same grid, and keeps its own "type here" tint ──
  const stepRows: StepRow[] = [
    {
      context: { "Days Worked": 4, "Hire Date": "2026-08-24", "Net Salary": 18000 },
      fullName: "Test Joiner", hrId: "HR-009", jobTitle: "Medical Rep", line: "CNS",
      onHold: false, reason: null,
      recommended: { baseForMonth: 2322.58, ecolPaid: 217.74, fuelPaid: 72.58 },
      values: { baseForMonth: 9000, ecolPaid: 500, fuelPaid: 250 },
    },
  ];
  const stepWorkbook = await load(
    await buildStepTemplateWorkbook({ rows: stepRows, run, stepKey: "p1_new_hires" }),
  );
  const stepSheet = stepWorkbook.worksheets[0];
  assert.equal(
    stepSheet.getRow(PAYROLL_SECTION_ROW).height,
    24,
    "the step template takes the previous template's band height",
  );
  assert.equal(
    stepSheet.getRow(PAYROLL_HEADER_ROW).height,
    32,
    "the step template takes the previous template's header height",
  );

  const stepLabels = headerLabels(stepSheet);
  for (const [index, label] of stepLabels.entries()) {
    if (index === 2) continue; // Full Name keeps its own wider setting
    assert.equal(
      stepSheet.getColumn(index + 1).width,
      payrollTemplateColumnWidth(label),
      `step template: "${label}" must be the width the previous template gives it`,
    );
  }
  const stepBody = stepSheet.getRow(PAYROLL_HEADER_ROW + 1).getCell(2);
  assert.equal(stepBody.alignment?.wrapText, true, "step template body cells wrap");
  assert.equal(
    stepBody.border?.right?.style,
    "hair",
    "step template body cells carry the template's side hairline",
  );

  // The editable tint is what says "type here". The template's zebra must never replace it, or the
  // sheet stops telling anyone which columns the upload actually reads back.
  const entryColumn = stepLabels.indexOf("Base (month)") + 1;
  assert.ok(entryColumn > 0, "the new-hires step has a Base (month) entry column");
  const entryCell = stepSheet.getRow(PAYROLL_HEADER_ROW + 1).getCell(entryColumn);
  assert.equal(
    (entryCell.fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb,
    HOUSE_XLSX_COLORS.tint,
    "an editable column stays tinted — that tint is the instruction, not decoration",
  );
  assert.equal(entryCell.protection?.locked, false, "an editable column stays unlocked");
}
