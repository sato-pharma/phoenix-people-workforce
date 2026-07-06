import ExcelJS from "exceljs";
import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import {
  bankFileCompactKey,
  buildBankFileRows,
  type EmployeeBankInfo,
} from "@/lib/payroll/exports/bank-file";
import { getSalaryBatchExport } from "@/lib/payroll/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = ["HR_ID", "Full Name", "Bank Name", "Account / IBAN", "Amount", "Missing Bank"];

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(_request);
    await assertPermission(access, "payroll", "export");
    const { id } = await params;

    const exportData = await getSalaryBatchExport(id, access);
    if (!exportData) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const directory = await getEmployeeDirectory();
    const bankByHrId = new Map<string, EmployeeBankInfo>();
    for (const employee of directory.employees) {
      bankByHrId.set(bankFileCompactKey(employee.hrId), {
        bankName: employee.bankName,
        bankAccount: employee.bankAccount,
        hasBankAccount: employee.hasBankAccount,
      });
    }
    const rows = buildBankFileRows(exportData.records, bankByHrId);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Bank Transfer");
    sheet.addRow(HEADERS);
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = { fgColor: { argb: "FFFF6B00" }, pattern: "solid", type: "pattern" };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.columns = HEADERS.map((header) => ({ header, key: header, width: Math.max(header.length + 4, 18) }));

    for (const row of rows) {
      sheet.addRow([row.hrId, row.fullName, row.bankName, row.bankAccount, row.amount, row.missingBank ? "YES" : ""]);
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const period = `${exportData.batch.year}-${String(exportData.batch.month).padStart(2, "0")}`;
    return new Response(buffer, {
      headers: {
        "Content-Disposition": `attachment; filename="phoenix-bank-transfer-${period}.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bank-file export failed.";
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message }, { status: 403 });
    }
    return NextResponse.json({ error: "bank_file_failed", message }, { status: 500 });
  }
}
