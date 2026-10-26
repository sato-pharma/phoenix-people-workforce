import ExcelJS from "exceljs";

import { compactHrKey } from "@/lib/payroll/copilot/feeders";
import {
  autoSizeColumns,
  MONEY_FMT,
  PHOENIX_ORANGE,
  styleDataRow,
  styleHeaderRow,
} from "@/lib/payroll/exports/excel-style";
import { isHeldReleaseOnlyRecord } from "@/lib/payroll/held-release";
import { roundCurrency } from "@/lib/payroll/money";
import {
  statutoryFromInsuranceWage,
  type InsuranceWageMap,
} from "@/lib/payroll/statutory/insurance-wages";
import type { StatutoryConfig } from "@/lib/payroll/statutory/types";
import type { SalaryRecord } from "@/lib/payroll/types";

/**
 * Statutory summary for a payroll batch — the accountant's and the Authority's view of the month.
 *
 * WHAT THIS USED TO DO, AND WHY IT WAS WRONG. It reconstructed each person's subject wage by
 * DIVIDING the social insurance stored on the payslip by 11%, then scaled the employer share off
 * that same figure. That is only correct if the stored deduction really is 11% of a wage, and on
 * production it is not — the Automated Payroll engine copied `employees.social_insurance` raw. On
 * the August 2026 batch the reconstruction produced an insured payroll of 2,626,960.36 against a
 * true 1,214,513.00, and put 90 of the 100 people ABOVE the 16,700 legal ceiling: a wage the
 * insurance office does not accept, printed on the document prepared for them.
 *
 * A reconstruction cannot detect any of that. Dividing by a rate always yields a number, and a
 * number always looks like an answer.
 *
 * WHAT IT DOES NOW. The subject wage is READ from `employees.social_insurance_wage` — the column
 * that alone decides the filing — clamped to the statutory floor and ceiling on the way in, so a
 * figure above the ceiling is not merely unlikely but unreachable. The employee and employer shares
 * are both derived from that wage, so one wrong figure can no longer become three.
 *
 * WHAT WAS ACTUALLY DEDUCTED SITS BESIDE IT, NOT INSTEAD OF IT. The two disagree for every month
 * published before the engine was fixed, and hiding that would be the same mistake in a new place.
 * `deductedEmployeeSi` is what the payslip took, `employeeSi` is what the wage says the filing is,
 * and `variance` is the gap. A month built by the fixed engine carries a variance of zero.
 *
 * NEITHER FIGURE IS PAY. Social insurance and income tax are reported as governmental deductions
 * and neither reduces take-home — the company absorbs both — so nothing on this sheet is money
 * anybody did or did not receive.
 */

export type StatutorySummaryRow = {
  hrId: string;
  fullName: string;
  /** From the employee's own insurance wage, clamped. Null when no wage is on file. */
  subjectWage: number | null;
  /** The employee share the filing says, from the subject wage. Null when no wage is on file. */
  employeeSi: number | null;
  /** The employer share the filing says, from the subject wage. Null when no wage is on file. */
  employerSi: number | null;
  totalSi: number | null;
  /** What the payslip actually deducted — carried, never derived. */
  deductedEmployeeSi: number;
  /** deducted − filed. Null when there is no filed figure to compare against. */
  variance: number | null;
  incomeTax: number;
};

export type StatutorySummaryTotals = {
  /** Sum of the subject wages — the figure the filing is assessed on. */
  insuredPayroll: number;
  employeeSi: number;
  employerSi: number;
  totalSi: number;
  deductedEmployeeSi: number;
  incomeTax: number;
  /** How many people on this batch have no insurance wage on file. */
  withoutWage: number;
  /** How many people's deduction differs from what their own wage says. */
  withVariance: number;
};

export function buildStatutorySummaryRows(
  records: SalaryRecord[],
  config: StatutoryConfig,
  insuranceWages: InsuranceWageMap,
): { rows: StatutorySummaryRow[]; totals: StatutorySummaryTotals } {
  // A row that pays only an earlier month's held salary is not part of this month's filing: that
  // person worked nothing this month, and the held money was filed in the month it was earned.
  const rows: StatutorySummaryRow[] = records.filter((record) => !isHeldReleaseOnlyRecord(record)).map((record) => {
    const deductedEmployeeSi = roundCurrency(record.socialInsurance);
    const incomeTax = roundCurrency(record.employmentIncomeTax);
    const hrId = record.employeeCode || record.hrId;
    // The batch stores an id in whatever casing and hyphenation the master had, and the wage map is
    // keyed compactly like every other payroll map — so both sides go through the same helper.
    const filed = statutoryFromInsuranceWage(
      insuranceWages.get(compactHrKey(record.hrId || record.employeeCode)),
      config,
    );

    // No wage on file means there is no filing figure for this person, and saying so is the whole
    // point. The old form had no way to express it: a null wage divided into a deduction still
    // produced a wage, so somebody with nothing on file looked exactly like somebody assessed.
    if (!filed) {
      return {
        hrId,
        fullName: record.fullName,
        subjectWage: null,
        employeeSi: null,
        employerSi: null,
        totalSi: null,
        deductedEmployeeSi,
        variance: null,
        incomeTax,
      };
    }

    return {
      hrId,
      fullName: record.fullName,
      subjectWage: filed.subjectWage,
      employeeSi: filed.employee,
      employerSi: filed.employer,
      totalSi: roundCurrency(filed.employee + filed.employer),
      deductedEmployeeSi,
      variance: roundCurrency(deductedEmployeeSi - filed.employee),
      incomeTax,
    };
  });

  const totals = rows.reduce<StatutorySummaryTotals>(
    (acc, row) => ({
      insuredPayroll: roundCurrency(acc.insuredPayroll + (row.subjectWage ?? 0)),
      employeeSi: roundCurrency(acc.employeeSi + (row.employeeSi ?? 0)),
      employerSi: roundCurrency(acc.employerSi + (row.employerSi ?? 0)),
      totalSi: roundCurrency(acc.totalSi + (row.totalSi ?? 0)),
      deductedEmployeeSi: roundCurrency(acc.deductedEmployeeSi + row.deductedEmployeeSi),
      incomeTax: roundCurrency(acc.incomeTax + row.incomeTax),
      withoutWage: acc.withoutWage + (row.subjectWage === null ? 1 : 0),
      withVariance: acc.withVariance + (row.variance !== null && row.variance !== 0 ? 1 : 0),
    }),
    {
      insuredPayroll: 0,
      employeeSi: 0,
      employerSi: 0,
      totalSi: 0,
      deductedEmployeeSi: 0,
      incomeTax: 0,
      withoutWage: 0,
      withVariance: 0,
    },
  );

  return { rows, totals };
}

/**
 * The columns, in order.
 *
 * Exported so a test can build the real workbook and read the cells back. The three defects that
 * shipped in one night here all passed a review of the SOURCE and would have failed a read of the
 * emitted file, which is why the sheet is built in this module rather than inside the route.
 */
export const STATUTORY_SUMMARY_HEADERS = [
  "HR_ID",
  "Full Name",
  "Subject Wage",
  "Employee SI (11%)",
  "Employer SI (18.75%)",
  "Total SI",
  "Deducted on payslip",
  "Variance",
  "Income Tax",
] as const;

/** What a cell says when nobody has entered an insurance wage — never a zero, never a blank. */
export const NO_INSURANCE_WAGE_CELL = "No insurance wage on file";

/**
 * Build the Statutory Summary workbook.
 *
 * Lives beside the figures it prints so the two cannot drift: a column added here without a value
 * beside it shifts every cell to its right, and the only thing that can catch that is opening the
 * file that comes out.
 */
export function buildStatutorySummaryWorkbook(input: {
  rows: StatutorySummaryRow[];
  totals: StatutorySummaryTotals;
  /**
   * Printed under the TOTAL after the notes above: who the rows cannot show, in words. Used for the
   * people publish held back (audit finding 43), who have no salary record and so no row here.
   */
  extraNotes?: string[];
}): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Statutory Summary");

  sheet.columns = STATUTORY_SUMMARY_HEADERS.map((header) => ({ header, key: header }));
  styleHeaderRow(sheet.getRow(1), PHOENIX_ORANGE);
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  for (const row of input.rows) {
    const values: Array<string | number> = [
      row.hrId,
      row.fullName,
      row.subjectWage ?? NO_INSURANCE_WAGE_CELL,
      row.employeeSi ?? "",
      row.employerSi ?? "",
      row.totalSi ?? "",
      row.deductedEmployeeSi,
      row.variance ?? "",
      row.incomeTax,
    ];
    const dataRow = sheet.addRow(values);
    styleDataRow(dataRow);
    for (let column = 3; column <= STATUTORY_SUMMARY_HEADERS.length; column += 1) {
      const cell = dataRow.getCell(column);
      if (typeof cell.value === "number") cell.numFmt = MONEY_FMT;
    }
  }

  const totalRow = sheet.addRow([
    "TOTAL",
    "",
    // The insured payroll — what the filing is assessed on. This cell used to be blank, because
    // the wages above it were reconstructed and summing fiction would have been worse than nothing.
    input.totals.insuredPayroll,
    input.totals.employeeSi,
    input.totals.employerSi,
    input.totals.totalSi,
    input.totals.deductedEmployeeSi,
    roundCurrency(input.totals.deductedEmployeeSi - input.totals.employeeSi),
    input.totals.incomeTax,
  ]);
  styleDataRow(totalRow, true);
  for (let column = 3; column <= STATUTORY_SUMMARY_HEADERS.length; column += 1) {
    totalRow.getCell(column).numFmt = MONEY_FMT;
  }

  // What the columns cannot say on their own goes underneath, in words. A count of people with no
  // wage on file is not a footnote — they are absent from the insured payroll directly above it.
  const notes: string[] = [];
  if (input.totals.withoutWage > 0) {
    notes.push(
      `${input.totals.withoutWage} of ${input.rows.length} people have no insurance wage on file. ` +
        "They carry no filing figure here and are NOT counted in the insured payroll total.",
    );
  }
  if (input.totals.withVariance > 0) {
    notes.push(
      `${input.totals.withVariance} people were deducted an amount that is not 11% of their own ` +
        "insurance wage. The Variance column shows the gap per person. This is what a month built " +
        "before the payroll engine read the wage column looks like.",
    );
  }
  // Then what the rows cannot show at all, supplied by the caller (see `extraNotes`).
  notes.push(...(input.extraNotes ?? []).filter((note) => note.trim().length > 0));
  if (notes.length > 0) {
    sheet.addRow([]);
    for (const note of notes) {
      const noteRow = sheet.addRow([note]);
      sheet.mergeCells(noteRow.number, 1, noteRow.number, STATUTORY_SUMMARY_HEADERS.length);
      noteRow.getCell(1).alignment = { horizontal: "left", vertical: "top", wrapText: true };
      noteRow.height = 28;
    }
  }

  autoSizeColumns(sheet);
  return workbook;
}
