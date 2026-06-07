import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { fieldWorkforceMonthKey } from "@/lib/field-workforce-compliance/archive";
import { IReports360ApiError } from "@/lib/field-workforce-compliance/ireports360-client";
import { isIReports360Configured } from "@/lib/field-workforce-compliance/ireports360-config";
import { buildFieldWorkforceCompliancePreviewFromIReports360 } from "@/lib/field-workforce-compliance/ireports360-source";
import { FieldWorkforcePreviewError } from "@/lib/field-workforce-compliance/preview";

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
    await assertPermission(access, "hr_calendar", "import");

    if (!isIReports360Configured()) {
      return NextResponse.json({
        error: "ireports360_not_configured",
        message: "The iReports360 connection is not configured on the server.",
        success: false,
      }, { status: 503 });
    }

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
        message: "Provide a month (1-12) and a year to import from iReports360.",
        success: false,
      }, { status: 400 });
    }

    const todayIso = new Date().toISOString().slice(0, 10);
    const preview = await buildFieldWorkforceCompliancePreviewFromIReports360({
      month,
      todayIso,
      year,
    });

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
        source: "ireports360",
        sourceFilename: preview.metadata.fileName,
      },
      summary: "Field Workforce Compliance preview generated from iReports360.",
    });

    return NextResponse.json({ data: preview, success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({
        error: "forbidden",
        message: "You do not have access to import Field Workforce Compliance data.",
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

    if (error instanceof IReports360ApiError) {
      return NextResponse.json({
        error: "ireports360_request_failed",
        message: error.message,
        success: false,
      }, { status: error.status });
    }

    return NextResponse.json({
      error: "field_workforce_ireports360_failed",
      message: error instanceof Error ? error.message : "iReports360 import failed.",
      success: false,
    }, { status: 500 });
  }
}
