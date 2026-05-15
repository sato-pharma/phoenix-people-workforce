import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  employeeDirectoryErrorMessage,
  isEmployeeDirectoryEnvMissing,
  isEmployeeDirectoryTimeout,
} from "@/lib/employees/employee-directory";
import { generateNextHrIdForLine } from "@/lib/employees/hr-id-helper";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function nextHrIdError(error: unknown) {
  if (isForbiddenError(error)) {
    return { message: employeeDirectoryErrorMessage(error), status: 403 };
  }

  if (isEmployeeDirectoryTimeout(error)) {
    return {
      message: "Supabase request timed out while generating Employee ID.",
      status: 504,
    };
  }

  if (isEmployeeDirectoryEnvMissing(error)) {
    return {
      message: "Supabase environment variables are missing.",
      status: 409,
    };
  }

  return {
    message: employeeDirectoryErrorMessage(error),
    status: 500,
  };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employees", "update");

    const url = new URL(request.url);
    const lineIdValue = url.searchParams.get("lineId");
    const parsedLineId = lineIdValue ? Number(lineIdValue) : null;

    if (lineIdValue && (parsedLineId === null || !Number.isFinite(parsedLineId) || parsedLineId <= 0)) {
      return NextResponse.json(
        { error: "invalid_line", message: "Business line is invalid." },
        { status: 400 },
      );
    }

    return NextResponse.json({ hrId: await generateNextHrIdForLine(parsedLineId) });
  } catch (error) {
    const { message, status } = nextHrIdError(error);
    return NextResponse.json({ error: "employee_id_generation_failed", message }, { status });
  }
}
