import ExcelJS from "exceljs";

import type { ConsolidatedCustomer, CustomerMappingRow } from "@/lib/sales/customer-mapping";

// XLSX builder for the Customer Mapping tab. Unlike the premium banner-styled exports, the main
// "Customer Mapping" sheet is a DELIBERATELY CLEAN grid: headers in row 1, data from row 2, and the
// Customer Code in column A stored as TEXT. That is exactly what Excel VLOOKUP needs — you can select
// the whole sheet as the table_array and look up a raw customer code straight from a distributor's
// sales sheet, with no banner rows to offset the range or number/text mismatches to break the match.

const BLACK = "FF000000";
const WHITE = "FFFFFFFF";
const ORANGE_SOFT = "FFFFF7ED";

type Column = { header: string; key: string; numeric?: boolean; text?: boolean; width: number };

const MAPPING_COLUMNS: Column[] = [
  { header: "Customer Code", key: "customerCode", text: true, width: 18 },
  { header: "Customer Name", key: "customerName", width: 34 },
  { header: "Customer Address", key: "customerAddress", width: 44 },
  { header: "Distributor Code", key: "distributorCode", text: true, width: 16 },
  { header: "Distributor", key: "distributorName", width: 20 },
  { header: "Brick ID", key: "brickId", text: true, width: 12 },
  { header: "Brick Name", key: "brickName", width: 26 },
  { header: "Area ID", key: "areaCode", text: true, width: 12 },
  { header: "Area Name", key: "areaName", width: 22 },
  { header: "Region ID", key: "regionCode", text: true, width: 12 },
  { header: "Region Name", key: "regionName", width: 20 },
  { header: "Master Customer", key: "masterCustomerId", text: true, width: 16 },
  { header: "Distributors (count)", key: "distributorSpan", numeric: true, width: 16 },
];

const CONSOLIDATED_COLUMNS: Column[] = [
  { header: "Master Customer", key: "masterCustomerId", text: true, width: 16 },
  { header: "Customer Name", key: "customerName", width: 34 },
  { header: "Customer Address", key: "customerAddress", width: 44 },
  { header: "Brick ID", key: "brickId", text: true, width: 12 },
  { header: "Brick Name", key: "brickName", width: 26 },
  { header: "Area ID", key: "areaCode", text: true, width: 12 },
  { header: "Area Name", key: "areaName", width: 22 },
  { header: "Region ID", key: "regionCode", text: true, width: 12 },
  { header: "Region Name", key: "regionName", width: 20 },
  { header: "Distributors (count)", key: "distributorSpan", numeric: true, width: 16 },
  { header: "Distributor Codes", key: "distributorCodes", width: 30 },
  { header: "Customer Codes", key: "customerCodes", width: 36 },
  { header: "Total Units", key: "totalUnits", numeric: true, width: 14 },
  { header: "Total Value (EGP)", key: "totalValue", numeric: true, width: 18 },
];

function writeGrid(sheet: ExcelJS.Worksheet, columns: Column[], records: Record<string, unknown>[]) {
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  const headerRow = sheet.getRow(1);
  columns.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = column.header;
    cell.font = { bold: true, color: { argb: WHITE }, name: "Calibri", size: 11 };
    cell.fill = { fgColor: { argb: BLACK }, pattern: "solid", type: "pattern" };
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });
  headerRow.height = 20;

  records.forEach((record, rowIndex) => {
    const row = sheet.getRow(rowIndex + 2);
    columns.forEach((column, index) => {
      const cell = row.getCell(index + 1);
      const raw = record[column.key];
      if (column.numeric) {
        cell.value = typeof raw === "number" ? raw : Number(raw ?? 0);
        cell.alignment = { horizontal: "right" };
      } else {
        cell.value = raw === null || raw === undefined ? "" : String(raw);
        if (column.text) cell.numFmt = "@"; // force text so codes never coerce to numbers
        cell.alignment = { horizontal: "left" };
      }
      cell.font = { name: "Calibri", size: 10.5 };
      if (rowIndex % 2 === 1) cell.fill = { fgColor: { argb: ORANGE_SOFT }, pattern: "solid", type: "pattern" };
    });
  });

  columns.forEach((column, index) => {
    sheet.getColumn(index + 1).width = column.width;
  });
}

function writeGuide(sheet: ExcelJS.Worksheet) {
  const lines: [string, boolean][] = [
    ["How to use this file (VLOOKUP by customer code)", true],
    ["", false],
    ["1. Open your distributor's raw sales sheet and find the customer code column.", false],
    ["2. In that sheet, add a new column and paste this formula (adjust the cell + column letters):", false],
    ["       =VLOOKUP(<customer code cell>, 'Customer Mapping'!$A:$M, <column number>, FALSE)", false],
    ["", false],
    ["   Column numbers in the 'Customer Mapping' sheet:", false],
    ["       2 = Customer Name      6 = Brick ID        7 = Brick Name", false],
    ["       8 = Area ID            9 = Area Name       10 = Region ID", false],
    ["       11 = Region Name       12 = Master Customer", false],
    ["", false],
    ["3. Customer codes are unique WITHIN one distributor. If you mix distributors in one lookup,", false],
    ["   filter the 'Customer Mapping' sheet to that distributor first (or export per distributor).", false],
    ["", false],
    ["Consolidation: the 'Consolidated' sheet lists one row per real pharmacy. The same pharmacy", false],
    ["sold by several distributors shares one 'Master Customer' id (matched on name + brick + address).", false],
  ];
  lines.forEach(([text, bold], index) => {
    const cell = sheet.getRow(index + 1).getCell(1);
    cell.value = text;
    cell.font = { bold, name: "Calibri", size: bold ? 13 : 11 };
  });
  sheet.getColumn(1).width = 100;
}

export async function buildCustomerMappingWorkbook(input: {
  consolidated: ConsolidatedCustomer[];
  rows: CustomerMappingRow[];
}): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  const mappingSheet = workbook.addWorksheet("Customer Mapping");
  writeGrid(
    mappingSheet,
    MAPPING_COLUMNS,
    input.rows.map((row) => ({ ...row })),
  );

  const consolidatedSheet = workbook.addWorksheet("Consolidated");
  writeGrid(
    consolidatedSheet,
    CONSOLIDATED_COLUMNS,
    input.consolidated.map((master) => ({
      ...master,
      customerCodes: master.members.map((member) => `${member.distributorCode}:${member.customerCode}`).join(", "),
      distributorCodes: master.members.map((member) => member.distributorCode).join(", "),
    })),
  );

  writeGuide(workbook.addWorksheet("How to VLOOKUP"));

  const buffer = await workbook.xlsx.writeBuffer();
  return buffer as ArrayBuffer;
}
