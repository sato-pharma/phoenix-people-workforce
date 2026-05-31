import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { generateFieldWorkforceFinalActionsWorkbook } from "@/lib/field-workforce-compliance/export";
import { getFieldWorkforceRecommendationsReport } from "@/lib/field-workforce-compliance/recommendations";
import { toApiError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

function actorFromAccess(access: Awaited<ReturnType<typeof resolveAccessContext>>) {
  return resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
}

function filename(monthKey: string) {
  return `field-workforce-compliance-final-actions-${monthKey}.xlsx`;
}

function apiResponse(error: unknown, fallback: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json({
      error: "forbidden",
      message: error instanceof Error ? error.message : "Forbidden.",
      success: false,
    }, { status: 403 });
  }

  const apiError = toApiError(error, fallback);
  return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_calendar", "read");

    const { id } = await context.params;
    const actorLoginId = actorFromAccess(access);
    const report = await getFieldWorkforceRecommendationsReport({
      actorLoginId,
      archiveId: id,
      auditFinalReportView: true,
    });

    if (!report) {
      return NextResponse.json({
        error: "field_workforce_archive_not_found",
        message: "The archived Field Workforce Compliance month was not found.",
        success: false,
      }, { status: 404 });
    }

    await writeAuditLog({
      actorLoginId,
      entityId: id,
      entityType: "field_workforce_compliance_import",
      newValues: {
        finalActionCount: report.finalActions.length,
        monthKey: report.archive.monthKey,
      },
      summary: "Field Workforce Compliance final approved actions exported.",
    });

    const workbook = generateFieldWorkforceFinalActionsWorkbook(report);
    const buffer = await workbook.xlsx.writeBuffer();

    return new NextResponse(buffer, {
      headers: {
        "Content-Disposition": `attachment; filename="${filename(report.archive.monthKey)}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    return apiResponse(error, "Field Workforce Compliance final actions export failed.");
  }
}
