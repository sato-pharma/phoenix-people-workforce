import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import {
  buildSalaryBatchWorkbook,
  salaryBatchFileName,
} from "@/lib/payroll/salary-batch-workbook";
import { getSalaryBatchExport } from "@/lib/payroll/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Download a published salary batch.
 *
 * The workbook lives in `src/lib/payroll/salary-batch-workbook.ts`; this route resolves access and
 * streams the bytes. It used to build the file inline — a header row and nothing else.
 */
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

    const buffer = await buildSalaryBatchWorkbook({
      batch: exportData.batch,
      records: exportData.records,
    });

    return new Response(buffer, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${salaryBatchFileName(exportData.batch)}"`,
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
