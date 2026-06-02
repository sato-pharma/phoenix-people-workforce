import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  buildPayrollExpenseDsmSummaries,
  getApprovedExpenseTotalsByHrId,
  groupPayrollExpenses,
  summarizePayrollExpenses,
} from "../src/lib/payroll/expense-metrics.ts";
import type { PayrollExpenseApproval } from "../src/lib/payroll/types.ts";

function expense(input: Partial<PayrollExpenseApproval>): PayrollExpenseApproval {
  return {
    allowance: 0,
    amWorkload: 0,
    approvedAt: null,
    approvedBy: null,
    date: "2026-04-10T00:00:00.000Z",
    description: "",
    from: "",
    hr: "",
    hrApproved: false,
    hrComment: "",
    hrId: null,
    hrNotes: "",
    km: 0,
    location: "",
    meetingAmount: 0,
    open: "",
    payoutMonth: 5,
    payoutYear: 2026,
    pmWorkload: 0,
    reportId: null,
    requestType: "Travel",
    row: 1,
    sourceFileName: "",
    specialist: "",
    status: "",
    to: "",
    toDate: "",
    total: 0,
    transportationType: "",
    travelCost: 0,
    tripId: "",
    tripType: "",
    ...input,
  };
}

export function runExpenseMetricsTests() {
  const rows = [
    expense({
      allowance: 25,
      hrApproved: true,
      hrId: "HR-001",
      km: 10,
      meetingAmount: 50,
      specialist: "A",
      total: 175,
      travelCost: 100,
      tripId: "T1",
    }),
    expense({
      allowance: 10,
      hrApproved: false,
      hrId: "HR-001",
      km: 20,
      meetingAmount: 0,
      specialist: "A",
      total: 110,
      travelCost: 100,
      tripId: "T2",
    }),
    expense({
      allowance: 5,
      hrApproved: true,
      hrId: "HR-002",
      km: 15,
      meetingAmount: 20,
      requestType: "Meeting",
      specialist: "B",
      total: 75,
      travelCost: 50,
      tripId: "T3",
    }),
  ];

  const summary = summarizePayrollExpenses(rows);
  assert.equal(summary.totalRows, 3);
  assert.equal(summary.totalAmount, 360);
  assert.equal(summary.approvedRows, 2);
  assert.equal(summary.approvedAmount, 250);
  assert.equal(summary.pendingRows, 1);
  assert.equal(summary.pendingAmount, 110);
  assert.equal(summary.totalDistance, 45);
  assert.equal(summary.totalTravelCost, 250);
  assert.equal(summary.totalMeetingAmount, 70);
  assert.equal(summary.totalAllowance, 40);
  assert.equal(summary.specialistCount, 2);
  assert.equal(summary.averageCostPerTrip, 120);

  const byRequest = groupPayrollExpenses(rows, (row) => row.requestType);
  assert.equal(byRequest[0]?.key, "Travel");
  assert.equal(byRequest[0]?.total, 285);

  const approvedByHrId = getApprovedExpenseTotalsByHrId(rows);
  assert.equal(approvedByHrId.get("HR-001"), 175);
  assert.equal(approvedByHrId.get("HR-002"), 75);

  const dsmSummaries = buildPayrollExpenseDsmSummaries({
    dsms: [
      { fullName: "DSM One", hrId: "HR-001", lineName: "Line A" },
      { fullName: "DSM Two", hrId: "HR-002", lineName: "Line A" },
    ],
    expenses: rows,
  });
  assert.equal(dsmSummaries[0]?.hrId, "HR-001");
  assert.equal(dsmSummaries[0]?.totalTrips, 2);
  assert.equal(dsmSummaries[0]?.approvedAmount, 175);
  assert.equal(dsmSummaries[0]?.pendingAmount, 110);

  const expenseServiceSource = readFileSync("src/lib/payroll/expenses.ts", "utf8");
  assert.match(expenseServiceSource, /getPayrollExpenseMetrics/);
  assert.match(expenseServiceSource, /getPayrollExpenseDashboardData/);
  assert.match(expenseServiceSource, /summarizePayrollExpenses/);
  assert.match(expenseServiceSource, /getApprovedExpenseTotalsByHrId/);

  const platformSource = readFileSync("src/lib/platform/metrics.ts", "utf8");
  assert.match(platformSource, /getPayrollExpenseMetrics/);
  assert.doesNotMatch(platformSource, /listPayrollExpenses/);
  assert.doesNotMatch(platformSource, /listPayrollExpenseReports/);

  const overviewSource = readFileSync("src/lib/overview/service.ts", "utf8");
  assert.match(overviewSource, /getPayrollExpenseDashboardData/);
  assert.doesNotMatch(overviewSource, /listPayrollExpenses/);
  assert.doesNotMatch(overviewSource, /listPayrollExpenseReports/);

  const dashboardPageSource = readFileSync("app/(admin)/payroll/expenses/dashboard/page.tsx", "utf8");
  assert.match(dashboardPageSource, /getPayrollExpenseDashboardData/);
  assert.doesNotMatch(dashboardPageSource, /listPayrollExpenses/);
  assert.doesNotMatch(dashboardPageSource, /getEmployeeDirectory/);

  const dashboardComponentSource = readFileSync("src/components/payroll/expenses-dashboard.tsx", "utf8");
  assert.match(dashboardComponentSource, /summarizePayrollExpenses/);
  assert.match(dashboardComponentSource, /groupPayrollExpenses/);

  const employeePortalSource = readFileSync("src/lib/employee-portal/service.ts", "utf8");
  assert.match(employeePortalSource, /summarizePayrollExpenses/);
  assert.match(employeePortalSource, /buildPayrollExpenseDsmSummaries/);

  const importRouteSource = readFileSync("app/api/payroll/expenses/import/route.ts", "utf8");
  assert.match(importRouteSource, /importApprovedExpensesToPayroll/);
  assert.doesNotMatch(importRouteSource, /listPayrollExpenses/);
}
