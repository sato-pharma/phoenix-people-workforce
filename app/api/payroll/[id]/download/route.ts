import ExcelJS from "exceljs";
import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { getSalaryBatchExport } from "@/lib/payroll/service";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { payrollSheetHeaders, payrollSheetValue } from "@/lib/payroll/salary-sheet-fields";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = [...payrollSheetHeaders];

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const access = await resolveAccessContext(_request);
    await assertPermission(access, "payroll", "export");
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
      fgColor: { argb: "FFF97316" },
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
      sheet.addRow(headers.map((header) =>
        payrollSheetValue(record, exportData.batch.month, exportData.batch.year, index + 1, header),
      ));
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
    const message = clientSafeErrorMessage(error, "Payroll download failed.");
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message }, { status: 403 });
    }

    return NextResponse.json({ error: "download_failed", message }, { status: 500 });
  }
}
