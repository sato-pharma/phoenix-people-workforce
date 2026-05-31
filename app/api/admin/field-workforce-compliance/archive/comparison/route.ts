import { NextResponse } from "next/server";

import { getFieldWorkforceComplianceComparison } from "@/lib/field-workforce-compliance/archive";
import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function actorFromAccess(access: Awaited<ReturnType<typeof resolveAccessContext>>) {
  return resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
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

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_calendar", "read");

    const data = await getFieldWorkforceComplianceComparison({
      actorLoginId: actorFromAccess(access),
    });

    return NextResponse.json({
      data,
      success: true,
    });
  } catch (error) {
    return apiResponse(error, "Field Workforce Compliance comparison could not be loaded.");
  }
}
