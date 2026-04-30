import { NextResponse } from "next/server";

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

export async function GET() {
  try {
    return NextResponse.json(await getEmployeeDirectory());
  } catch (error) {
    const { message, status } = employeeApiError(error);
    return NextResponse.json({ error: "employee_load_failed", message }, { status });
  }
}

export async function POST(request: Request) {
  try {
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

    return NextResponse.json(await getEmployeeDirectory());
  } catch (error) {
    const { message, status } = employeeApiError(error);
    return NextResponse.json({ error: "employee_save_failed", message }, { status });
  }
}
