import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

/**
 * `table-workbook.ts` is imported by eleven client components as well as by five API routes, so it
 * may never reach a server-only module. `house-xlsx-identity.ts` is one: it embeds the wordmark, so
 * it opens a file with `node:fs`, and a Turbopack client build then dies with "the chunking context
 * does not support external modules (request: node:fs)".
 *
 * The colours live in `house-xlsx-palette.ts` for exactly this reason. The build already catches the
 * mistake — but two and a half minutes into `validate`, in a message that names a chunking context
 * rather than the import that caused it. This names it in milliseconds.
 */
function assertTableWorkbookStaysClientSafe() {
  const source = readFileSync(new URL("../src/lib/export/table-workbook.ts", import.meta.url), "utf8");
  assert.equal(
    /from\s+"@\/lib\/export\/house-xlsx-identity"/.test(source),
    false,
    "table-workbook.ts is bundled into client components, so it must take its house colours from " +
      '"@/lib/export/house-xlsx-palette", never "@/lib/export/house-xlsx-identity" — the identity ' +
      "module reads the wordmark with node:fs and fails the Turbopack client build.",
  );
  // A positive control: the palette import is really there, so the check above cannot pass merely
  // because the file stopped using the house colours altogether.
  assert.ok(
    /from\s+"@\/lib\/export\/house-xlsx-palette"/.test(source),
    "table-workbook.ts still takes its house colours from the palette module",
  );
}

export async function runOutstationExpenseExportTests() {
  assertTableWorkbookStaysClientSafe();

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
