import ExcelJS from "exceljs";

import { addPhoenixTableSheet, type ExportColumn, type ExportRow } from "@/lib/export/table-workbook";
import type { SosDashboardData, SosDistributorRow, SosGroupRow } from "@/lib/sales/sos-dashboard";

// Multi-sheet "Source of Sales" workbook: Summary + Product + Region + Area + Distributor, each
// rendered with the premium Phoenix table style. Built from already-scoped + Head-Office/confidential
// stripped data (the caller passes the output of getPortalSosDashboard), so the export can never
// contain anything the viewer can't see on screen.

const GROUP_COLUMNS: ExportColumn[] = [
  { key: "label", label: "Name", width: 34 },
  { key: "value", label: "Value (EGP)", numeric: true, width: 18 },
  { key: "units", label: "Units", numeric: true, width: 14 },
  { key: "share", label: "Share %", numeric: true, width: 12 },
];

function groupRows(rows: SosGroupRow[]): ExportRow[] {
  return rows.map((row) => ({
    label: row.label,
    value: Math.round(row.value),
    units: Math.round(row.units),
    share: Number((row.share * 100).toFixed(1)),
  }));
}

export async function buildSosDashboardWorkbook(input: {
  data: SosDashboardData;
  scopeSummary: string;
}): Promise<ExcelJS.Buffer> {
  const { data, scopeSummary } = input;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  const subtitle = `${scopeSummary} · ${data.period ?? "—"}`;
  const s = data.summary;

  // Summary sheet — headline KPIs as a metric/value table.
  addPhoenixTableSheet(workbook, {
    title: "Source of Sales — Summary",
    subtitle,
    sheetName: "Summary",
    columns: [
      { key: "metric", label: "Metric", width: 34 },
      { key: "value", label: "Value", numeric: true, width: 22 },
    ],
    rows: [
      { metric: "Total value (EGP)", value: Math.round(s.totalValue) },
      { metric: "Total units", value: Math.round(s.totalUnits) },
      { metric: "Avg price / unit (EGP)", value: Math.round(s.avgPricePerUnit) },
      { metric: "Distributors", value: s.distributorCount },
      { metric: "Products", value: s.productCount },
      { metric: "Direct share %", value: Number((s.directShare * 100).toFixed(1)) },
      { metric: "Areas reached", value: s.areasReached },
      { metric: "Total areas (scope)", value: s.totalAreas },
    ],
  });

  addPhoenixTableSheet(workbook, { title: "By Product", subtitle, sheetName: "Product", columns: GROUP_COLUMNS, rows: groupRows(data.byProduct) });
  addPhoenixTableSheet(workbook, { title: "By Region", subtitle, sheetName: "Region", columns: GROUP_COLUMNS, rows: groupRows(data.byRegion) });
  addPhoenixTableSheet(workbook, { title: "By Area", subtitle, sheetName: "Area", columns: GROUP_COLUMNS, rows: groupRows(data.byArea) });

  const distributorColumns: ExportColumn[] = [
    { key: "label", label: "Distributor", width: 34 },
    { key: "value", label: "Value (EGP)", numeric: true, width: 18 },
    { key: "units", label: "Units", numeric: true, width: 14 },
    { key: "share", label: "Share %", numeric: true, width: 12 },
    { key: "regions", label: "Regions", numeric: true, width: 12 },
    { key: "areas", label: "Areas", numeric: true, width: 12 },
    { key: "products", label: "Products", numeric: true, width: 12 },
  ];
  addPhoenixTableSheet(workbook, {
    title: "By Distributor",
    subtitle,
    sheetName: "Distributor",
    columns: distributorColumns,
    rows: (data.byDistributor as SosDistributorRow[]).map((row) => ({
      label: row.label,
      value: Math.round(row.value),
      units: Math.round(row.units),
      share: Number((row.share * 100).toFixed(1)),
      regions: row.regions,
      areas: row.areas,
      products: row.products,
    })),
  });

  return await workbook.xlsx.writeBuffer();
}
