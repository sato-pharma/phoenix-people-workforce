// Excel audit workbook for the sales source drill-down: every area's sales decomposed to
// (distributor, brick) for the indirect channel, plus the direct/company channel. Pure — takes
// already-loaded, name-resolved rows and returns the xlsx buffer.
import ExcelJS from "exceljs";

import type { DirectBreakdownRow } from "@/lib/sales/monthly-targets";

const HEADER_STYLE: Partial<ExcelJS.Style> = {
  font: { bold: true, color: { argb: "FFFFFFFF" }, size: 10 },
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B0B0B" } },
  alignment: { vertical: "middle", wrapText: true },
  border: { bottom: { style: "thin", color: { argb: "FFF97316" } } },
};

export type IndirectAuditRow = {
  areaName: string;
  productName: string;
  distributorName: string;
  brickName: string;
  units: number;
  value: number;
};

function styleHeader(row: ExcelJS.Row): void {
  row.eachCell((cell) => Object.assign(cell, { style: HEADER_STYLE }));
  row.height = 20;
}

export async function generateSourceAuditWorkbook(input: {
  period: string;
  lineLabel: string;
  indirect: IndirectAuditRow[];
  direct: DirectBreakdownRow[];
}): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Phoenix Workforce";

  // Sheet 1 — distributor sales decomposed to source (area → product → distributor → brick).
  const ws = wb.addWorksheet("Source Detail", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "Area", key: "area", width: 26 },
    { header: "Product", key: "product", width: 26 },
    { header: "Brick", key: "brick", width: 24 },
    { header: "Distributor", key: "distributor", width: 20 },
    { header: "Units", key: "units", width: 12 },
    { header: "Value (EGP)", key: "value", width: 16 },
  ];
  styleHeader(ws.getRow(1));
  for (const row of input.indirect) {
    ws.addRow({
      area: row.areaName,
      product: row.productName,
      brick: row.brickName,
      distributor: row.distributorName,
      units: Math.round(row.units),
      value: Math.round(row.value),
    });
  }
  ws.getColumn("units").numFmt = "#,##0";
  ws.getColumn("value").numFmt = "#,##0";

  // Sheet 2 — direct/company channel (region → product → distributor; no brick).
  const dws = wb.addWorksheet("Direct (company)", { views: [{ state: "frozen", ySplit: 1 }] });
  dws.columns = [
    { header: "Region", key: "region", width: 20 },
    { header: "Product", key: "product", width: 26 },
    { header: "Distributor", key: "distributor", width: 20 },
    { header: "Units", key: "units", width: 12 },
    { header: "Value (EGP)", key: "value", width: 16 },
  ];
  styleHeader(dws.getRow(1));
  for (const row of input.direct) {
    dws.addRow({
      region: row.regionName,
      product: row.productName,
      distributor: row.distributorName,
      units: Math.round(row.units),
      value: Math.round(row.value),
    });
  }
  dws.getColumn("units").numFmt = "#,##0";
  dws.getColumn("value").numFmt = "#,##0";

  // Sheet 3 — a one-line note so the file is self-describing.
  const ref = wb.addWorksheet("About");
  ref.columns = [{ key: "a", width: 100 }];
  ref.addRow([`Sales source audit — ${input.lineLabel} — ${input.period}.`]);
  ref.addRow(["'Source Detail' = distributor sales for each area, decomposed to distributor and brick."]);
  ref.addRow(["'Direct (company)' = company/direct-channel sales (no brick), by region."]);
  ref.addRow(["Values reconcile exactly to the automatic monthly closing for this line and month."]);

  return wb.xlsx.writeBuffer();
}
