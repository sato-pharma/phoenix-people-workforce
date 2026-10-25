import { NextResponse } from "next/server";

import {
  automatedPayrollRunIdFromBatchFileName,
  heldExcludedFilingNote,
  readPublishedHoldRecord,
} from "@/lib/automated-payroll/published-holds";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  buildStatutorySummaryRows,
  buildStatutorySummaryWorkbook,
} from "@/lib/payroll/exports/statutory-summary";
import { getStatutoryConfigForPeriod } from "@/lib/payroll/statutory/config";
import { loadInsuranceWages } from "@/lib/payroll/statutory/insurance-wages";
import { getSalaryBatchExport } from "@/lib/payroll/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { DOWNLOAD_NO_STORE_HEADERS } from "@/lib/http/download-headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const insuranceWages = await loadInsuranceWages();
    const { rows, totals } = buildStatutorySummaryRows(exportData.records, config, insuranceWages);
    // A held employee has no salary record, so no row above: the filing says who is missing and why
    // (audit finding 43). Only a batch Automated Payroll published carries a hold record.
    const runId = automatedPayrollRunIdFromBatchFileName(exportData.batch.fileName);
    const heldNote = runId ? heldExcludedFilingNote(await readPublishedHoldRecord(runId)) : null;
    // The sheet is built in the domain module, beside the figures it prints — see
    // buildStatutorySummaryWorkbook. This route resolves access, loads, and returns the file.
    const workbook = buildStatutorySummaryWorkbook({ rows, totals, extraNotes: heldNote ? [heldNote] : [] });

    const buffer = await workbook.xlsx.writeBuffer();
    const period = `${exportData.batch.year}-${String(exportData.batch.month).padStart(2, "0")}`;
    return new Response(buffer, {
      headers: {
        ...DOWNLOAD_NO_STORE_HEADERS,
        "Content-Disposition": `attachment; filename="phoenix-statutory-summary-${period}.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Statutory summary export failed.");
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message }, { status: 403 });
    }
    return NextResponse.json({ error: "statutory_summary_failed", message }, { status: 500 });
  }
}
