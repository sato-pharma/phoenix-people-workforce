import { NextResponse } from "next/server";

import { isSalaryBlindRole } from "@/lib/auth/hr-functions";
import {
  assertPermission,
  isSalaryRedactedForViewer,
} from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { hrIdsMatch } from "@/lib/hr-id";
import {
  canAccessCompanyOrganogram,
  canViewOrganogramSensitiveFields,
  getOrganogramReport,
  isLineScopedOrganogramRole,
  resolveOrganogramLinesForEmployee,
} from "@/lib/reports/organogram";
import { buildOrganogramEmployeeDetail } from "@/lib/reports/organogram-employee-detail";
import {
  errorMessage,
  isDatabaseSchemaMissing,
  isSupabaseEnvMissing,
  isSupabaseTimeout,
  type VacancyReportData,
} from "@/lib/reports/vacancies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function reportError(error: unknown) {
  if (isSupabaseTimeout(error)) {
    return { message: "Supabase request timed out. Check your connection and try again.", status: 504 };
  }
  if (isSupabaseEnvMissing(error)) {
    return { message: "Supabase environment variables are missing.", status: 409 };
  }
  if (isDatabaseSchemaMissing(error)) {
    return { message: "Supabase schema is not ready.", status: 409 };
  }
  return { message: errorMessage(error), status: 500 };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ hrId: string }> },
) {
  const { hrId } = await params;

  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "organogram", "read");

    // Resolve the exact scoped chart this viewer is allowed to see, then confirm the
    // requested person is on it. This reuses the SAME scoping as the chart route
    // (company vs. line), so a line-scoped viewer can never pull the profile of
    // someone outside their line, and Head-Office suppression is honoured too.
    let report: VacancyReportData;
    if (canAccessCompanyOrganogram(access)) {
      report = await getOrganogramReport(access, { mode: "company" });
    } else if (isLineScopedOrganogramRole(access)) {
      const lineNames = await resolveOrganogramLinesForEmployee(access);
      if (!lineNames || lineNames.length === 0) {
        return NextResponse.json(
          { error: "organogram_scope_missing", message: "Unable to resolve your Organogram line scope." },
          { status: 409 },
        );
      }
      report = await getOrganogramReport(access, { lineNames, mode: "line" });
    } else {
      return NextResponse.json(
        { error: "forbidden", message: "Organogram access is limited to National Sales Managers, Product Managers, and Group Product Managers." },
        { status: 403 },
      );
    }

    const isOnViewerChart = report.organogramRows.some(
      (row) => row.type === "employee" && hrIdsMatch(row.hrId, hrId),
    );
    if (!isOnViewerChart) {
      // 404, not 403 — do not confirm the existence of a person the viewer cannot see.
      return NextResponse.json(
        { error: "not_found", message: "Employee is not in your organogram." },
        { status: 404 },
      );
    }

    const directory = await getEmployeeDirectory();
    const employee = directory.employees.find((candidate) => hrIdsMatch(candidate.hrId, hrId));
    if (!employee) {
      return NextResponse.json(
        { error: "not_found", message: "Employee record not found." },
        { status: 404 },
      );
    }

    const canViewSensitive = canViewOrganogramSensitiveFields(access);
    const detail = buildOrganogramEmployeeDetail(employee, {
      canViewSensitive,
      // The seat that never sees a salary gets no money row at all, not a column of blanks.
      omitSalary: isSalaryBlindRole(access.role),
      redactSalary: canViewSensitive && isSalaryRedactedForViewer(access, employee.hrId),
    });

    return NextResponse.json(detail);
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: "You do not have access to organogram reports." },
        { status: 403 },
      );
    }

    const { message, status } = reportError(error);
    return NextResponse.json({ error: "organogram_employee_failed", message }, { status });
  }
}
