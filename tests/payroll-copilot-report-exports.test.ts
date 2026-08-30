import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import {
  buildExpenseReportWorkbook,
  buildVacationReportWorkbook,
  formatPeriodLabel,
  periodFileSlug,
} from "../src/lib/payroll/copilot/report-exports.ts";

async function loadSheet(buf: ArrayBuffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as ArrayBuffer);
  return wb.worksheets[0];
}

function cellStr(ws: ExcelJS.Worksheet, r: number, c: number): string {
  const v = ws.getRow(r).getCell(c).value;
  return v === null || v === undefined ? "" : String(v);
}

function cellNum(ws: ExcelJS.Worksheet, r: number, c: number): number {
  return Number(ws.getRow(r).getCell(c).value ?? 0);
}

export async function runPayrollCopilotReportExportsTests() {
  // --- period label helpers --------------------------------------------------
  assert.equal(formatPeriodLabel({ month: 6, year: 2026 }), "June 2026");
  assert.equal(formatPeriodLabel({ month: 1, year: 2026 }), "January 2026");
  assert.equal(periodFileSlug({ month: 6, year: 2026 }), "June_2026");

  // --- unpaid-vacation report ------------------------------------------------
  const vbuf = await buildVacationReportWorkbook({
    periodLabel: "June 2026",
    rows: [
      {
        employeeHrId: "B-155",
        employeeName: "Ahmed Sharaf",
        vacationType: "emergency",
        startDate: "2026-06-30",
        endDate: "2026-06-30",
        unpaidDays: 0.5,
        balanceDaysAvailable: 0,
        salaryDeductionAmount: 433.33,
        balanceAvailable: false,
        existingSettlement: null,
      },
    ],
    hireDates: new Map([["b155", "2026-02-01"]]),
  });
  const vws = await loadSheet(vbuf);
  assert.equal(cellStr(vws, 3, 1), "HR ID");
  assert.equal(cellStr(vws, 3, 9), "Salary Deduction (EGP)");
  assert.equal(cellStr(vws, 4, 1), "B-155");
  assert.equal(cellStr(vws, 4, 3), "2026-02-01");
  assert.equal(cellNum(vws, 4, 7), 0.5);
  assert.equal(cellNum(vws, 4, 9), 433.33);
  assert.equal(cellStr(vws, 4, 10), "Pending (no balance)");

  // --- outstation-expenses report --------------------------------------------
  const ebuf = await buildExpenseReportWorkbook({
    periodLabel: "June 2026",
    sourceMonthLabel: "May 2026",
    rows: [
      {
        employeeHrId: "B-1",
        employeeName: "Ahmed",
        dateFrom: "2026-05-03",
        dateTo: "2026-05-04",
        locationFrom: "Cairo",
        locationTo: "Alexandria",
        km: 220,
        type: "traveling",
        travelCost: 1200.5,
        allowance: 400,
        existingDecision: { decision: "include" },
      },
    ],
    hireDates: new Map([["b1", "2020-01-01"]]),
  });
  const ews = await loadSheet(ebuf);
  // Title/subtitle must make the month-lag explicit: this is May's trips, paid in June's payroll.
  assert.match(cellStr(ews, 1, 1), /May 2026 trips, paid in June 2026 payroll/);
  assert.match(cellStr(ews, 2, 1), /May 2026.*not June 2026/);
  assert.equal(cellStr(ews, 3, 1), "HR ID");
  assert.equal(cellStr(ews, 4, 1), "B-1");
  assert.equal(cellStr(ews, 4, 3), "2020-01-01");
  assert.equal(cellNum(ews, 4, 10), 1200.5);
  assert.equal(cellNum(ews, 4, 11), 400);
  assert.equal(cellStr(ews, 4, 12), "Include this run");
}
