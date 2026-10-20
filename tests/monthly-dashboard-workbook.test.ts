import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import {
  buildMonthlySalesDashboardWorkbook,
  describeMonthlyDashboardFilters,
} from "../src/lib/sales/monthly-dashboard-workbook.ts";
import { salesManagerFilterOptions } from "../src/lib/sales/service.ts";
import type { SalesDashboardData } from "../src/lib/sales/types.ts";
import { stripComments } from "./support/comment-strip.ts";

const META = {
  exportedByName: "A-9",
  exportedByHrId: "A-9",
  role: "CEO",
  generatedAtIso: "2026-07-09T10:00:00.000Z",
};

function isXlsx(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer);
  // .xlsx is a zip → first two bytes are 'P' 'K' (0x50 0x4B)
  return bytes.length > 100 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function fixture(): SalesDashboardData {
  return {
    summary: {
      totalApprovedSales: 100_000,
      totalApprovedTarget: 90_000,
      achievementRate: 100_000 / 90_000,
      approvedRecords: 3,
      linkedEmployees: 2,
      dataQualityRate: 0.95,
      topManager: "Manager One",
    },
    filters: {
      lines: ["Pedia"],
      periods: ["2026-06"],
      salesTypes: ["Retail"],
      managers: ["Manager One"],
      territories: ["Cairo"],
      products: ["Saginkgo"],
      families: ["Antibiotics"],
    },
    trend: [
      { period: "2026-05", sales: 90_000, target: 85_000, achievementRate: 90_000 / 85_000, linkedEmployees: 2 },
      { period: "2026-06", sales: 100_000, target: 90_000, achievementRate: 100_000 / 90_000, linkedEmployees: 2 },
    ],
    channelMix: [
      { name: "Retail", value: 70_000 },
      { name: "Stores", value: 30_000 },
    ],
    familyMatrix: [{ name: "Antibiotics", sales: 100_000, target: 90_000, achievementRate: 100_000 / 90_000 }],
    pareto: [{ name: "Saginkgo", sales: 70_000, cumulativePercent: 0.7 }],
    territories: [{ name: "Cairo", sales: 100_000, target: 90_000, achievementRate: 100_000 / 90_000 }],
    linePerformance: [{ line: "Pedia", sales: 100_000, target: 90_000, achievementRate: 100_000 / 90_000, linkedEmployees: 2 }],
    managerPerformance: [
      {
        manager: "Manager One",
        line: "Pedia",
        sales: 100_000,
        target: 90_000,
        achievementRate: 100_000 / 90_000,
        topProduct: "Saginkgo",
        retailSales: 70_000,
        storesSales: 30_000,
      },
    ],
    productPerformance: [{ product: "Saginkgo", family: "Antibiotics", sales: 70_000, target: 60_000, achievementRate: 70_000 / 60_000 }],
    forecast: [],
    anomalies: [{ label: "Saginkgo / Cairo", detail: "20 units above normal range", score: 2.1 }],
    transactions: [
      {
        employeeHrId: "B-100",
        employeeName: "Rep One",
        managerHrId: "B-157",
        managerName: "Manager One",
        line: "Pedia",
        territory: "Cairo",
        salesType: "Retail",
        family: "Antibiotics",
        product: "Saginkgo",
        period: "2026-06",
        salesUnits: 700,
        salesValue: 70_000,
        targetValue: 60_000,
        achievementRate: 70_000 / 60_000,
        ownershipLabel: "Assigned employee",
      },
    ],
    linkage: { linked: 2, unlinked: 0, ambiguous: 0 },
    recentBatches: [
      {
        fileName: "june-closing.xlsx",
        line: "Pedia",
        period: "2026-06",
        status: "approved",
        uploadedBy: "B-1",
        createdAt: "2026-07-01T10:00:00.000Z",
        totalRecords: 3,
        approvedSalesValue: 100_000,
        approvedTargetValue: 90_000,
      },
    ],
  };
}

const EXPECTED_SHEETS = [
  "Cover",
  "Trend",
  "Channel Mix",
  "Family Performance",
  "Territory Performance",
  "Line Performance",
  "Manager Performance",
  "Product Performance",
  "Pareto",
  "Anomalies",
  "Recent Batches",
  "Transactions",
];

export async function runMonthlyDashboardWorkbookTests() {
  assert.match(describeMonthlyDashboardFilters({ line: "Pedia", territory: "Cairo" }), /Line: Pedia/);
  assert.match(describeMonthlyDashboardFilters({ line: "Pedia", territory: "Cairo" }), /Territory: Cairo/);
  assert.match(describeMonthlyDashboardFilters({}), /No filters applied/);

  // The Manager filter shows NAMES, never "DSM [B-12]" (owner, 2026-10-20). Its value stays the key
  // the server filters on, so a chosen name still narrows the same rows.
  const managerFilter = salesManagerFilterOptions(
    [
      { employeeHrId: "M-1", employeeLookupKey: null, employeeName: "Rep One", line: "CNS", managerHrId: "B-12" },
      { employeeHrId: "M-2", employeeLookupKey: null, employeeName: "Rep Two", line: "CNS", managerHrId: "B-12" },
      { employeeHrId: "M-3", employeeLookupKey: null, employeeName: "Rep Three", line: "Pedia", managerHrId: "B-13" },
      { employeeHrId: "M-4", employeeLookupKey: null, employeeName: "Rep Four", line: "Pedia", managerHrId: null },
    ],
    new Map([
      ["b-12", "Saad Salama"],
      ["b-13", "Amr Adel"],
    ]),
  );
  assert.deepEqual(
    managerFilter.managers,
    ["DSM [B-13]", "DSM [B-12]", "Unassigned DSM"],
    "each manager is offered once, under the key the filter matches on, ordered by the name the user reads",
  );
  assert.deepEqual(
    managerFilter.managerLabels,
    { "DSM [B-12]": "Saad Salama", "DSM [B-13]": "Amr Adel", "Unassigned DSM": "Unassigned DSM" },
    "every manager option is labelled with his name, never his HR code",
  );
  const describedManager = describeMonthlyDashboardFilters({ manager: "DSM [B-12]" }, managerFilter.managerLabels);
  assert.match(describedManager, /Manager: Saad Salama/, "the export's cover names the chosen manager");
  assert.doesNotMatch(describedManager, /B-12/, "the export's cover never prints the manager's HR code");
  const dashboardUi = stripComments(readFileSync("src/components/sales/monthly-sales-dashboard-impl.tsx", "utf8"));
  assert.match(
    dashboardUi,
    /options=\{options\.managers\}\s+optionLabels=\{options\.managerLabels\}/,
    "the Manager dropdown must print the names the server sends beside the keys",
  );

  const buffer = await buildMonthlySalesDashboardWorkbook({
    data: fixture(),
    meta: { ...META, filters: { line: "Pedia" } },
  });
  assert.ok(isXlsx(buffer), "workbook must be a valid .xlsx (zip) buffer");

  const readBack = new ExcelJS.Workbook();
  await readBack.xlsx.load(buffer);
  for (const name of EXPECTED_SHEETS) {
    assert.ok(readBack.getWorksheet(name), `missing sheet: ${name}`);
  }

  const txnSheet = readBack.getWorksheet("Transactions");
  const headerRow = txnSheet!.getRow(2).values as unknown[]; // row 1 is the title banner, row 2 is headers
  const headerLabels = headerRow.filter((value): value is string => typeof value === "string");
  assert.ok(headerLabels.includes("Employee HR_ID"), "Transactions sheet must expose the employee HR_ID column");
  assert.ok(headerLabels.includes("Sales value"), "Transactions sheet must expose the sales value column");

  // Empty dashboard (no active batches) must still build every sheet without throwing.
  const emptyData: SalesDashboardData = {
    summary: {},
    filters: { lines: [], periods: [], salesTypes: [], managers: [], territories: [], products: [], families: [] },
    trend: [],
    channelMix: [],
    familyMatrix: [],
    pareto: [],
    territories: [],
    linePerformance: [],
    managerPerformance: [],
    productPerformance: [],
    forecast: [],
    anomalies: [],
    transactions: [],
    linkage: { linked: 0, unlinked: 0, ambiguous: 0 },
    recentBatches: [],
  };
  const emptyBuffer = await buildMonthlySalesDashboardWorkbook({ data: emptyData, meta: { ...META, filters: {} } });
  assert.ok(isXlsx(emptyBuffer), "empty-dashboard workbook must still build");
  const emptyReadBack = new ExcelJS.Workbook();
  await emptyReadBack.xlsx.load(emptyBuffer);
  for (const name of EXPECTED_SHEETS) {
    assert.ok(emptyReadBack.getWorksheet(name), `empty-dashboard workbook missing sheet: ${name}`);
  }
}
