import ExcelJS from "exceljs";
import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { buildStatutorySummaryRows } from "@/lib/payroll/exports/statutory-summary";
import { getStatutoryConfigForPeriod } from "@/lib/payroll/statutory/config";
import { getSalaryBatchExport } from "@/lib/payroll/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = [
  "HR_ID",
  "Full Name",
  "Subject Wage",
  "Employee SI (11%)",
  "Employer SI (18.75%)",
  "Total SI",
  "Income Tax",
];

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(_request);
    await assertPermission(access, "payroll", "export");
    const { id } = await params;

    const exportData = await getSalaryBatchExport(id, access);
    if (!exportData) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const config = await getStatutoryConfigForPeriod({
      month: exportData.batch.month,
      year: exportData.batch.year,
    });
    const { rows, totals } = buildStatutorySummaryRows(exportData.records, config);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Statutory Summary");
    sheet.addRow(HEADERS);
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = { fgColor: { argb: "FFFF6B00" }, pattern: "solid", type: "pattern" };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.columns = HEADERS.map((header) => ({ header, key: header, width: Math.max(header.length + 4, 16) }));

    for (const row of rows) {
      sheet.addRow([
        row.hrId,
        row.fullName,
        row.subjectWage,
        row.employeeSi,
        row.employerSi,
        row.totalSi,
        row.incomeTax,
      ]);
    }

    const totalRow = sheet.addRow([
      "TOTAL",
      "",
      "",
      totals.employeeSi,
      totals.employerSi,
      totals.totalSi,
      totals.incomeTax,
    ]);
    totalRow.font = { bold: true };

    const buffer = await workbook.xlsx.writeBuffer();
    const period = `${exportData.batch.year}-${String(exportData.batch.month).padStart(2, "0")}`;
    return new Response(buffer, {
      headers: {
        "Content-Disposition": `attachment; filename="phoenix-statutory-summary-${period}.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Statutory summary export failed.";
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message }, { status: 403 });
    }
    return NextResponse.json({ error: "statutory_summary_failed", message }, { status: 500 });
  }
}
