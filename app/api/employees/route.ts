import { type NextRequest, NextResponse } from "next/server";

import {
  assertPermission,
  filterEmployeeDirectoryForAccess,
} from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  employeeDirectoryErrorMessage,
  getEmployeeDirectory,
  isEmployeeDirectoryEnvMissing,
  isEmployeeDirectorySchemaMissing,
  isEmployeeDirectoryTimeout,
  upsertEmployee,
  type EmployeeMutationInput,
} from "@/lib/employees/employee-directory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function employeeApiError(error: unknown) {
  if (isForbiddenError(error)) {
    return {
      message: employeeDirectoryErrorMessage(error),
      status: 403,
    };
  }

  if (isEmployeeDirectoryTimeout(error)) {
    return {
      message: "Supabase request timed out. Check your connection and try again.",
      status: 504,
    };
  }

  if (isEmployeeDirectoryEnvMissing(error)) {
    return {
      message: "Supabase environment variables are missing.",
      status: 409,
    };
  }

  if (isEmployeeDirectorySchemaMissing(error)) {
    return {
      message: "Supabase schema is not ready.",
      status: 409,
    };
  }

  return {
    message: employeeDirectoryErrorMessage(error),
    status: 500,
  };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const search = searchParams.get("search") ?? undefined;
  const lineId = searchParams.get("lineId") ? Number(searchParams.get("lineId")) : undefined;
  const areaId = searchParams.get("areaId") ? Number(searchParams.get("areaId")) : undefined;
  const departmentId = searchParams.get("departmentId") ? Number(searchParams.get("departmentId")) : undefined;
  const teamId = searchParams.get("teamId") ? Number(searchParams.get("teamId")) : undefined;
  const positionId = searchParams.get("positionId") ? Number(searchParams.get("positionId")) : undefined;
  const status = searchParams.get("status") ?? "all";
  const region = searchParams.get("region") ?? undefined;
  const hasBankAccount = searchParams.get("hasBankAccount") ?? undefined;
  const medicalInsuranceStatus = searchParams.get("medicalInsuranceStatus") ?? undefined;
  const socialInsuranceStatus = searchParams.get("socialInsuranceStatus") ?? undefined;
  const salaryPaymentMode = searchParams.get("salaryPaymentMode") ?? undefined;
  const page = searchParams.get("page") ? Number(searchParams.get("page")) : 1;
  const pageSize = searchParams.get("pageSize") ? Number(searchParams.get("pageSize")) : 50;

  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employees", "read");
      const data = await getEmployeeDirectory(
      {
        search,
        lineId,
        areaId,
        departmentId,
        teamId,
        positionId,
        status,
        region,
        hasBankAccount,
        medicalInsuranceStatus,
        socialInsuranceStatus,
        salaryPaymentMode,
        page,
        pageSize,
      },
      access
    );

    return NextResponse.json(data);
  } catch (error) {
    console.error("Employee directory API failed:", error);
    const { message, status: responseStatus } = employeeApiError(error);
    return NextResponse.json(
      { error: "Failed to load employee directory.", message },
      { status: responseStatus },
    );
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employees", "update");

    const payload = (await request.json()) as {
      employee?: EmployeeMutationInput;
    };

    if (!payload.employee) {
      return NextResponse.json(
        { error: "missing_employee", message: "Employee payload is required." },
        { status: 400 },
      );
    }

    await upsertEmployee(payload.employee);

    return NextResponse.json(
      filterEmployeeDirectoryForAccess(await getEmployeeDirectory({ status: "all" }), access),
    );
  } catch (error) {
    const { message, status } = employeeApiError(error);
    return NextResponse.json({ error: "employee_save_failed", message }, { status });
  }
}
