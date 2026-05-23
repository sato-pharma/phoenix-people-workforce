import { NextResponse } from "next/server";

import {
  assertPermission,
  canReadEmployeeDirectory,
  filterEmployeeDirectoryForAccess,
} from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { provisionNewHireAccess } from "@/lib/employees/access-provisioning";
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
  const message = employeeDirectoryErrorMessage(error);

  if (isForbiddenError(error)) {
    return {
      message,
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

  if (
    message.includes("required") ||
    message.includes("not allowed") ||
    message.includes("Invalid HR_ID") ||
    message.includes("format is invalid") ||
    message.includes("cannot be the same employee") ||
    message.includes("Use the resignation workflow") ||
    message.includes("already exists") ||
    message.includes("immutable")
  ) {
    return {
      message,
      status: 400,
    };
  }

  if (message.includes("was not found")) {
    return {
      message,
      status: 404,
    };
  }

  return {
    message,
    status: 500,
  };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ error: "unauthorized", message: "Authentication required." }, { status: 401 });
    }
    if (!(await canReadEmployeeDirectory(access))) {
      await assertPermission(access, "employees", "read");
    }

    return NextResponse.json(
      filterEmployeeDirectoryForAccess(await getEmployeeDirectory(), access),
    );
  } catch (error) {
    const { message, status } = employeeApiError(error);
    return NextResponse.json({ error: "employee_load_failed", message }, { status });
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

    const savedRows = await upsertEmployee(payload.employee);
    const accessProvisioning = payload.employee.originalHrId?.trim()
      ? null
      : await provisionNewHireAccess({
        actor: { loginId: access.loginId ?? null, role: access.role },
        hrIds: [savedRows[0]?.hr_id ?? payload.employee.hrId],
        source: "manual employee add",
      });
    const directory = await getEmployeeDirectory();

    return NextResponse.json(
      {
        ...filterEmployeeDirectoryForAccess(directory, access),
        ...(accessProvisioning ? { accessProvisioning } : {}),
      },
    );
  } catch (error) {
    const { message, status } = employeeApiError(error);
    return NextResponse.json({ error: "employee_save_failed", message }, { status });
  }
}
