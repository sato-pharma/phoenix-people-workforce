/**
 * The published salary batch, as a workbook.
 *
 * WHAT THIS REPLACES. `/api/payroll/[id]/download` built its workbook inline: one worksheet, one
 * orange header row, a freeze and an autofilter, and nothing else. No cover, so a file sitting in
 * someone's downloads folder could not say which month it was, which batch, or whether that batch
 * had even been approved. No section bands, so thirty-seven columns of money arrived as one
 * undifferentiated wall. No totals, so the first thing anyone did with it was add a SUM row by
 * hand — and a hand-typed total over a filtered range is how a wrong number gets quoted.
 *
 * It is the same data as the monthly run sheet and the payslips, so it now reads like them: the
 * house identity, the same computed section bands, the same money formats, and the same freeze
 * through the name so a figure is never orphaned from the person it belongs to.
 *
 * THIS IS A PUBLISHED BATCH, WHICH IS WHY THERE IS NO HELD TREATMENT HERE. A held row never
 * reaches `salary_records` — `publishToPayslips` filters it out — so by the time a batch exists,
 * held people are ABSENT rather than marked. The cover says so in words, because "37 rows" invites
 * the reader to believe that is everyone who was owed money that month, and it is not.
 */

import ExcelJS from "exceljs";

import { systemDocuments } from "@/config/system-settings";
import {
  buildPayrollCoverSheet,
  PAYROLL_HEADER_ROW,
  payrollBodyCell,
  payrollHeaderCell,
  payrollTemplateColumnWidth,
  payrollTotalsCell,
  resolvePayrollBands,
  writePayrollSectionBand,
  writePayrollSheetMasthead,
} from "@/lib/payroll/payroll-sheet-style";
import {
  isPayrollNumericHeader,
  payrollMoneyHeaders,
  payrollSheetHeaders,
  payrollSheetValue,
} from "@/lib/payroll/salary-sheet-fields";
import type { SalaryBatch, SalaryRecord } from "@/lib/payroll/types";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function periodLabel(month: number, year: number) {
  return `${MONTHS[month - 1] ?? String(month)} ${year}`;
}

const CONFIDENTIAL_NOTE =
  "CONFIDENTIAL — Payroll compensation data. For authorized finance and executive review only.";

function coverRows(batch: SalaryBatch, records: SalaryRecord[]): Array<[string, string]> {
  const dateOnly = (value: string | null) => (value ? value.slice(0, 10) : "—");
  return [
    ["Period", periodLabel(batch.month, batch.year)],
    ["Batch status", batch.status],
    ["Rows in this batch", String(records.length)],
    ["Source file", batch.fileName || "—"],
    ["Approved", dateOnly(batch.approvedAt)],
    ["Part 1 paid", dateOnly(batch.part1PaidAt)],
    ["Part 2 ready", dateOnly(batch.part2ReadyAt)],
    ["Locked", dateOnly(batch.lockedAt)],
    // Said outright, because the row count invites the opposite conclusion.
    [
      "Held people are NOT here",
      "A held row is dropped at publish, so anyone held that month is absent from this batch " +
        "entirely — not listed with a zero. This count is who was paid, not who was owed.",
    ],
  ];
}

export function salaryBatchFileName(batch: SalaryBatch): string {
  const period = `${batch.year}-${String(batch.month).padStart(2, "0")}`;
  return `sato-payroll-${period}.xlsx`;
}

/**
 * Returns an ArrayBuffer, which is what `writeBuffer` actually produces and what `Response` accepts
 * as a BodyInit. The sibling builders cast theirs to `Buffer`, which typechecks nowhere it is
 * streamed — the route failed on exactly that.
 */
export async function buildSalaryBatchWorkbook(input: {
  batch: SalaryBatch;
  records: SalaryRecord[];
}): Promise<ArrayBuffer> {
  const { batch, records } = input;
  const headers = [...payrollSheetHeaders];
  const label = periodLabel(batch.month, batch.year);

  const workbook = new ExcelJS.Workbook();
  workbook.company = systemDocuments.workbookCompany;
  workbook.created = new Date();
  workbook.creator = systemDocuments.workbookCreator;
  workbook.subject = "Payroll";
  workbook.title = `Payroll — ${label}`;

  buildPayrollCoverSheet(workbook, {
    confidentialNote: CONFIDENTIAL_NOTE,
    rows: coverRows(batch, records),
    subtitle: `${label} · ${batch.status}`,
    title: "Payroll — Published Batch",
  });

  const sheet = workbook.addWorksheet("Payroll");
  writePayrollSheetMasthead(workbook, sheet, {
    columns: headers.length,
    subtitle: `${label} · ${records.length} row${records.length === 1 ? "" : "s"} · ${batch.status}`,
    title: "Payroll — Published Batch",
  });
  const bands = resolvePayrollBands(headers);
  writePayrollSectionBand(sheet, bands);
  const sectionEndColumns = new Set(bands.map((band) => band.to));

  const headerRow = sheet.getRow(PAYROLL_HEADER_ROW);
  headerRow.height = 32;
  headers.forEach((header, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = header;
    payrollHeaderCell(cell, {
      execution: header === "First Part",
      numeric: isPayrollNumericHeader(header),
    });
  });

  records.forEach((record, index) => {
    const row = sheet.getRow(PAYROLL_HEADER_ROW + 1 + index);
    // Even SHEET rows, the previous salary template's rule — see payrollBodyCell.
    const zebra = (PAYROLL_HEADER_ROW + 1 + index) % 2 === 0;
    headers.forEach((header, columnIndex) => {
      const cell = row.getCell(columnIndex + 1);
      const value = payrollSheetValue(record, batch.month, batch.year, index + 1, header);
      cell.value = value as ExcelJS.CellValue;
      if (payrollMoneyHeaders.has(header) && typeof value === "number") cell.numFmt = "#,##0.00";
      payrollBodyCell(cell, {
        execution: header === "First Part",
        header,
        held: false,
        leading: columnIndex === 0,
        sectionEnd: sectionEndColumns.has(columnIndex + 1),
        zebra,
      });
    });
  });

  // A totals row, because otherwise the first thing anyone does is add one by hand — and a
  // hand-typed total over a filtered range is how a wrong figure gets quoted at a meeting.
  const totalsRow = sheet.getRow(PAYROLL_HEADER_ROW + 1 + records.length);
  headers.forEach((header, index) => {
    const cell = totalsRow.getCell(index + 1);
    if (index === 0) cell.value = "TOTALS";
    else if (payrollMoneyHeaders.has(header)) {
      const sum = records.reduce((accumulator, record) => {
        const value = payrollSheetValue(record, batch.month, batch.year, 0, header);
        return accumulator + (typeof value === "number" ? value : 0);
      }, 0);
      cell.value = Math.round(sum * 100) / 100;
      cell.numFmt = "#,##0.00";
    }
    payrollTotalsCell(cell, { numeric: isPayrollNumericHeader(header) });
  });

  headers.forEach((header, index) => {
    sheet.getColumn(index + 1).width = payrollTemplateColumnWidth(header);
  });
  const nameColumn = headers.indexOf("Full Name");
  sheet.getColumn(nameColumn + 1).width = 26;
  sheet.views = [
    {
      showGridLines: false,
      state: "frozen",
      xSplit: nameColumn + 1,
      ySplit: PAYROLL_HEADER_ROW,
    },
  ];
  sheet.autoFilter = {
    from: { column: 1, row: PAYROLL_HEADER_ROW },
    to: { column: headers.length, row: PAYROLL_HEADER_ROW },
  };
  sheet.pageSetup = {
    fitToHeight: 0,
    fitToPage: true,
    fitToWidth: 1,
    margins: { bottom: 0.4, footer: 0.2, header: 0.2, left: 0.3, right: 0.3, top: 0.4 },
    orientation: "landscape",
    paperSize: 9,
    printTitlesRow: `1:${PAYROLL_HEADER_ROW}`,
  };

  return (await workbook.xlsx.writeBuffer()) as ArrayBuffer;
}
