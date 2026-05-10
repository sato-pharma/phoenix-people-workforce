import ExcelJS from "exceljs";
import { NextResponse } from "next/server";

import { getSalaryBatchExport } from "@/lib/payroll/service";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import type { SalaryRecord } from "@/lib/payroll/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = [
  "#",
  "HR ID",
  "Employee Name",
  "Arabic Name",
  "Job Title",
  "Line",
  "Area",
  "Hire Date",
  "Net Salary",
  "Expenses (Prev Month)",
  "Incentive",
  "Overtime",
  "Bonus",
  "Extra CoL",
  "Fuel Allow.",
  "Other Add.",
  "Total Additions",
  "Social Ins.",
  "Income Tax",
  "No CRM",
  "Fingerprint",
  "Unpaid Vac.",
  "Medical Ins.",
  "Loans",
  "Other Ded.",
  "Total Deductions",
  "Month Salary",
  "1st Part",
  "2nd Part",
  "Comment",
  "Month",
  "Year",
];

function rowValues(record: SalaryRecord, month: number, year: number, index: number) {
  return [
    index,
    record.employeeCode,
    record.fullName,
    record.nameAr ?? "",
    record.jobTitle,
    record.line,
    record.area,
    record.hireDate ?? "",
    record.grossSalary,
    record.expenses,
    record.incentive,
    record.overtime,
    record.bonus,
    record.extraCostOfLiving,
    record.fuelAllowance,
    record.otherAdditions,
    record.totalAdditions,
    record.socialInsurance,
    record.employmentIncomeTax,
    record.crm,
    record.fingerPrint,
    record.unpaidVacations,
    record.medicalInsurance,
    record.loans,
    record.otherDeductions,
    record.totalDeductions,
    record.netSalary,
    record.firstPart,
    record.secondPart,
    record.payrollComment ?? "",
    month,
    year,
  ];
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const access = await resolveAccessContext(_request);
    const { id } = await params;
    const exportData = await getSalaryBatchExport(id, access);

    if (!exportData) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Payroll Data");
    sheet.addRow(headers);
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = {
      fgColor: { argb: "FFFF6B00" },
      pattern: "solid",
      type: "pattern",
    };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.autoFilter = {
      from: { column: 1, row: 1 },
      to: { column: headers.length, row: 1 },
    };
    sheet.columns = headers.map((header) => ({
      header,
      key: header,
      width: Math.max(header.length + 4, 14),
    }));

    exportData.records.forEach((record, index) => {
      sheet.addRow(rowValues(record, exportData.batch.month, exportData.batch.year, index + 1));
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const period = `${exportData.batch.year}-${String(exportData.batch.month).padStart(2, "0")}`;

    return new Response(buffer, {
      headers: {
        "Content-Disposition": `attachment; filename="phoenix-payroll-${period}.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Payroll download failed.";
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message }, { status: 403 });
    }

    return NextResponse.json({ error: "download_failed", message }, { status: 500 });
  }
}
