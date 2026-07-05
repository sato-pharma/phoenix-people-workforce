import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadFieldWorkforceComplianceArchive } from "@/lib/field-workforce-compliance/archive";
import {
  generateFieldWorkforceGodModeWorkbook,
  generateFieldWorkforceSimpleSummaryWorkbook,
} from "@/lib/field-workforce-compliance/export";
import { getFieldWorkforceRecommendationsReport } from "@/lib/field-workforce-compliance/recommendations";
import { toApiError } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

type ExportVariant = "godmode" | "summary";

function resolveVariant(request: Request): ExportVariant {
  const value = new URL(request.url).searchParams.get("variant");
  return value === "summary" ? "summary" : "godmode";
}

function actorFromAccess(access: Awaited<ReturnType<typeof resolveAccessContext>>) {
  return resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
}

function filename(variant: ExportVariant, monthKey: string) {
  const label = variant === "summary" ? "summary" : "godmode-book";
  return `field-workforce-compliance-${label}-${monthKey}.xlsx`;
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
    const variant = resolveVariant(request);
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: `export:admin:fwc-${variant}` });

    const { id } = await context.params;
    const actorLoginId = actorFromAccess(access);

    const detail = await loadFieldWorkforceComplianceArchive({ actorLoginId, auditView: false, id });
    if (!detail) {
      return NextResponse.json({
        error: "field_workforce_archive_not_found",
        message: "The archived Field Workforce Compliance month was not found.",
        success: false,
      }, { status: 404 });
    }

    const workbook = variant === "summary"
      ? generateFieldWorkforceSimpleSummaryWorkbook(detail)
      : generateFieldWorkforceGodModeWorkbook(
          detail,
          await getFieldWorkforceRecommendationsReport({ actorLoginId, archiveId: id, auditFinalReportView: false }),
        );

    await writeAuditLog({
      actorLoginId,
      entityId: id,
      entityType: "field_workforce_compliance_import",
      newValues: {
        employeeCount: detail.preview.employees.length,
        monthKey: detail.archive.monthKey,
        variant,
      },
      summary: variant === "summary"
        ? "Field Workforce Compliance monthly summary exported."
        : "Field Workforce Compliance god-mode book exported.",
    });

    const buffer = await workbook.xlsx.writeBuffer();

    return new NextResponse(buffer, {
      headers: {
        "Content-Disposition": `attachment; filename="${filename(variant, detail.archive.monthKey)}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: error.message },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    return apiResponse(error, "Field Workforce Compliance export failed.");
  }
}
