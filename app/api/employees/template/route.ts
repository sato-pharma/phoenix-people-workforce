import ExcelJS from "exceljs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = [
  "HR_ID",
  "Full Name",
  "Arabic Name",
  "Work Email",
  "Mobile Number",
  "Job Title",
  "Hire Date",
  "Birth Date",
  "Education",
  "Manager HR_ID",
  "Manager Name",
  "Department",
  "Line",
  "Region",
  "Area",
  "Team",
  "Position",
  "Net Salary",
  "Social Insurance",
  "Taxes",
  "Medical Insurance",
  "Comprehensive Wage",
  "Subscription Wage",
  "Fuel Allowance",
  "Extra Cost Of Living",
  "Gross Salary",
  "Payment Mode",
  "CRM_ID",
  "CRM Username",
];

export async function GET() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Employee Master Data");

  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = {
    fgColor: { argb: "FFFF6B00" },
    pattern: "solid",
    type: "pattern",
  };
  sheet.columns = headers.map((header) => ({
    header,
    key: header,
    width: Math.max(header.length + 4, 16),
  }));
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = {
    from: { column: 1, row: 1 },
    to: { column: headers.length, row: 1 },
  };
  const paymentModeColumn = headers.indexOf("Payment Mode") + 1;

  for (let rowNumber = 2; rowNumber <= 1000; rowNumber += 1) {
    sheet.getCell(rowNumber, paymentModeColumn).dataValidation = {
      allowBlank: true,
      formulae: ['"one_part,two_parts"'],
      type: "list",
    };
  }

  const buffer = await workbook.xlsx.writeBuffer();

  return new Response(buffer, {
    headers: {
      "Content-Disposition": 'attachment; filename="phoenix-employee-template.xlsx"',
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  });
}
