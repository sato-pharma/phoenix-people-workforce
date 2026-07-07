import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import {
  buildDeductionReportWorkbook,
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

  // --- CRM / fingerprint deduction report ------------------------------------
  // Row A: already-approved (uses appliedAmount, basis "Approved").
  // Row B: pending, day-based, no stored amount -> estimated from base salary
  //        (base / 30 x days), basis "Estimate".
  // Row C: pending, day-based, no base salary -> 0, basis "No base salary".
  const dbuf = await buildDeductionReportWorkbook({
    title: "CRM Test",
    subtitle: "sub",
    qtyHeader: "No-Activity Days",
    rows: [
      {
        employeeCode: "B-1",
        employeeHrIdCompact: "b1",
        employeeName: "Ahmed",
        deductionValue: 2,
        deductionUnit: "days",
        estimatedAmount: null,
        dates: ["2026-06-03", "2026-06-05"],
        decision: { decisionStatus: "Approved for Payroll", appliedDeductionValue: 2, appliedAmount: 340.5 },
      },
      {
        employeeCode: "B-2",
        employeeHrIdCompact: "b2",
        employeeName: "Mona",
        deductionValue: 3,
        deductionUnit: "days",
        estimatedAmount: null,
        dates: ["2026-06-10", "2026-06-11", "2026-06-12"],
        decision: null,
      },
      {
        employeeCode: "B-3",
        employeeHrIdCompact: "b3",
        employeeName: "No Salary",
        deductionValue: 1,
        deductionUnit: "days",
        estimatedAmount: null,
        dates: [],
        decision: null,
      },
    ],
    hireDates: new Map([["b1", "2020-01-01"]]),
    baseSalaries: new Map([["b2", 9000]]), // 9000 / 30 * 3 = 900
  });
  const dws = await loadSheet(dbuf);
  // Rows: 1 title, 2 subtitle, 3 header, 4-6 data, 7 totals.
  // Cols: 1 HR ID, 2 Name, 3 Hire Date, 4 Days, 5 Dates, 6 Value, 7 Value Basis, 8 Status.
  assert.equal(cellStr(dws, 3, 1), "HR ID");
  assert.equal(cellStr(dws, 3, 5), "Dates (problem days)");
  assert.equal(cellStr(dws, 3, 6), "Value (EGP)");
  assert.equal(cellStr(dws, 3, 7), "Value Basis");
  // approved row
  assert.equal(cellStr(dws, 4, 1), "B-1");
  assert.equal(cellStr(dws, 4, 3), "2020-01-01");
  assert.equal(cellStr(dws, 4, 5), "2026-06-03, 2026-06-05");
  assert.equal(cellNum(dws, 4, 6), 340.5);
  assert.equal(cellStr(dws, 4, 7), "Approved");
  // estimated row: 9000 / 30 * 3 = 900
  assert.equal(cellNum(dws, 5, 6), 900);
  assert.equal(cellStr(dws, 5, 7), "Estimate");
  // no-base-salary row: 0
  assert.equal(cellNum(dws, 6, 6), 0);
  assert.equal(cellStr(dws, 6, 7), "No base salary");
  // totals: qty 2+3+1=6, value 340.5+900+0=1240.5
  assert.equal(cellStr(dws, 7, 1), "TOTAL");
  assert.equal(cellNum(dws, 7, 4), 6);
  assert.equal(cellNum(dws, 7, 6), 1240.5);

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
  assert.equal(cellStr(ews, 3, 1), "HR ID");
  assert.equal(cellStr(ews, 4, 1), "B-1");
  assert.equal(cellStr(ews, 4, 3), "2020-01-01");
  assert.equal(cellNum(ews, 4, 10), 1200.5);
  assert.equal(cellNum(ews, 4, 11), 400);
  assert.equal(cellStr(ews, 4, 12), "Include this run");
}
