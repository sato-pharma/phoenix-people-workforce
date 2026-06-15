import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import {
  buildPhoenixTableWorkbook,
  type ExportColumn,
  type ExportRow,
} from "../src/lib/export/table-workbook.ts";

const outstationHeaders = [
  "TripID",
  "Specialist",
  "HR_ID",
  "Date",
  "To Date",
  "Durattion",
  "Request Type",
  "Transportation Type",
  "Trip Type",
  "From",
  "To",
  "Address",
  "Travel Cost",
  "Meeting Amount",
  "Allowance",
  "Other",
  "Total",
  "KM",
  "Description",
  "Status",
  "HR",
  "HR Notes",
  "AM Workload",
  "PM Workload",
];

export async function runOutstationExpenseExportTests() {
  const columns: ExportColumn[] = outstationHeaders.map((label) => ({
    key: label.toLowerCase().replace(/[^a-z0-9]+/g, ""),
    label,
    numeric: ["Durattion", "Travel Cost", "Meeting Amount", "Allowance", "Other", "Total", "KM", "AM Workload", "PM Workload"].includes(label),
  }));
  const rows: ExportRow[] = [
    {
      address: "Damanhour, Beheira",
      allowance: 125,
      amworkload: 1,
      date: "2026-06-01",
      description: "Manual test",
      durattion: 1,
      from: "Alexandria",
      hr: "Approved",
      hrid: "B-74",
      hrnotes: "OK",
      km: 67,
      meetingamount: 0,
      other: 0,
      pmworkload: 7,
      requesttype: "Traveling",
      specialist: "Ahmed Abdallah",
      status: "submitted",
      to: "Damanhour",
      todate: "2026-06-01",
      total: 367,
      transportationtype: "Bus",
      travelcost: 242,
      tripid: "OUTSTATION-1",
      triptype: "Return same day",
    },
  ];

  const buffer = await buildPhoenixTableWorkbook({
    columns,
    rows,
    sheetName: "Outstation expenses",
    subtitle: "Test export",
    template: "outstation_expenses",
    title: "Outstation expenses",
  });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  assert.ok(workbook.getWorksheet("Dashboard"), "Outstation export must include a dashboard sheet.");
  assert.ok(workbook.getWorksheet("Premium Policy"), "Outstation export must include a policy sheet.");
  const detail = workbook.getWorksheet("Outstation expenses");
  assert.ok(detail, "Outstation export must include the detailed expense sheet.");

  const headerRow = detail.getRow(4);
  assert.deepEqual(
    outstationHeaders.map((_, index) => headerRow.getCell(index + 1).value),
    outstationHeaders,
  );
}
