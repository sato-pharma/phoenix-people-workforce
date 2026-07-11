import {
  CoachingApiError,
  filtersFromRequest,
  jsonError,
  requireCoachingPermission,
} from "@/app/api/coaching/_lib/route-utils";
import {
  type AccessContext,
  canAccess,
  canManageCoachingReports,
  normalizeHrId,
} from "@/lib/auth/permissions";
import {
  generateCoachingReportsWorkbook,
} from "@/lib/coaching/excel-export";
import {
  getCoachingReports,
  getCoachingReportsByIds,
} from "@/lib/coaching/service";
import type { CoachingReportFilters } from "@/lib/coaching/types";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { NextResponse } from "next/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isEmployeePortalRole(role: string) {
  return role === "Employee" || role === "Medical Rep";
}

function filenameForToday() {
  return `phoenix-coaching-reports-${new Date().toISOString().slice(0, 10)}.xlsx`;
}

function enforceExportScope(filters: CoachingReportFilters, access: AccessContext) {
  if (access.role !== "Training Manager") return filters;

  const coachHrId = normalizeHrId(access.hrId);
  if (!coachHrId) {
    throw new CoachingApiError("forbidden", "Training Manager export requires a linked HR_ID.", 403);
  }

  return {
    ...filters,
    coachHrId,
  };
}

export async function GET(request: Request) {
  try {
    const access = await requireCoachingPermission(request, "read");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:coaching:reports" });
    if (isEmployeePortalRole(access.role)) {
      throw new CoachingApiError("forbidden", "Employees must use the employee portal coaching workspace.", 403);
    }

    const canExport =
      canManageCoachingReports(access) ||
      await canAccess(access, "coaching", "export");
    if (!canExport) {
      throw new CoachingApiError("forbidden", `Forbidden: ${access.role} cannot export coaching.`, 403);
    }

    const filters = enforceExportScope(filtersFromRequest(request), access);
    const [reports, employees] = await Promise.all([
      getCoachingReports(filters, access),
      getEmployeeDirectoryRows(),
    ]);
    const employeeByHrId = new Map(
      employees.map((employee) => [normalizeHrId(employee.hrId), employee]),
    );
    const details = await getCoachingReportsByIds(reports.map((report) => report.reportId), access);
    const detailById = new Map(details.map((detail) => [detail.report.id, detail]));
    const exportedBy = access.hrId
      ? employeeByHrId.get(normalizeHrId(access.hrId))?.fullName ?? access.hrId
      : access.role;

    const exportReports = reports.map((summary) => {
      const detail = detailById.get(summary.reportId);
      if (!detail) {
        throw new Error(`Coaching report detail was not loaded for ${summary.reportNumber}.`);
      }
      return {
        detail,
        employee: employeeByHrId.get(normalizeHrId(summary.medicalRepHrId)) ?? null,
        summary,
      };
    });

    const workbook = await generateCoachingReportsWorkbook({
      exportDate: new Date(),
      exportedBy,
      filters,
      reports: exportReports,
    });

    return new Response(new Uint8Array(workbook), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${filenameForToday()}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      status: 200,
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: error.message },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    return jsonError(error, "Failed to export coaching reports.");
  }
}
