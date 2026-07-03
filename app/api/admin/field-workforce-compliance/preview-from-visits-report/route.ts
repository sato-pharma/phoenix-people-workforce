import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { fieldWorkforceMonthKey } from "@/lib/field-workforce-compliance/archive";
import { buildFieldWorkforceCompliancePreviewFromVisitsReport } from "@/lib/field-workforce-compliance/ireports360-source";
import { FieldWorkforcePreviewError } from "@/lib/field-workforce-compliance/preview";
import { getLatestVisitsSyncRuns } from "@/lib/visits-report/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseIntField(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_calendar", "read");

    let body: unknown = null;
    try {
      body = await request.json();
    } catch {
      body = null;
    }
    const month = parseIntField((body as { month?: unknown } | null)?.month);
    const year = parseIntField((body as { year?: unknown } | null)?.year);

    if (month === null || year === null) {
      return NextResponse.json({
        error: "missing_month_year",
        message: "Provide a month (1-12) and a year to view compliance for.",
        success: false,
      }, { status: 400 });
    }

    const todayIso = new Date().toISOString().slice(0, 10);
    const [preview, latestSyncRuns] = await Promise.all([
      buildFieldWorkforceCompliancePreviewFromVisitsReport({ month, todayIso, year }),
      getLatestVisitsSyncRuns(1),
    ]);
    const lastSuccessfulSync = latestSyncRuns.find((run) => run.status === "success") ?? null;

    const monthKey = fieldWorkforceMonthKey(preview.metadata.year, preview.metadata.month);
    await writeAuditLog({
      actorLoginId: resolveEmployeeIdentityId(access) ?? access.loginId ?? "system",
      entityId: monthKey,
      entityType: "field_workforce_compliance_import",
      newValues: {
        employeeCount: preview.metadata.employeeCount,
        highSeverityCount: preview.severityCounts.High,
        monthKey,
        reviewCandidateCount: preview.reviewCandidates.length,
        source: "ireports360_visits_mirror",
        sourceFilename: preview.metadata.fileName,
      },
      summary: "Field Workforce Compliance preview generated from the iReports360 visits mirror.",
    });

    return NextResponse.json({
      data: preview,
      mirrorLastSyncedAt: lastSuccessfulSync?.completedAt ?? null,
      success: true,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({
        error: "forbidden",
        message: "You do not have access to view Field Workforce Compliance data.",
        success: false,
      }, { status: 403 });
    }

    if (error instanceof FieldWorkforcePreviewError) {
      return NextResponse.json({
        error: error.code,
        errors: error.errors,
        message: error.message,
        success: false,
        warnings: error.warnings,
      }, { status: error.status });
    }

    return NextResponse.json({
      error: "field_workforce_visits_report_failed",
      message: error instanceof Error ? error.message : "Failed to build Field Workforce Compliance from the visits mirror.",
      success: false,
    }, { status: 500 });
  }
}
