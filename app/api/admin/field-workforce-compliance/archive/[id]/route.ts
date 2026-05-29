import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadFieldWorkforceComplianceArchive } from "@/lib/field-workforce-compliance/archive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_calendar", "read");

    const { id } = await context.params;
    const detail = await loadFieldWorkforceComplianceArchive({
      actorLoginId: resolveEmployeeIdentityId(access) ?? access.loginId ?? "system",
      id,
    });

    if (!detail) {
      return NextResponse.json({
        error: "field_workforce_archive_not_found",
        message: "The archived Field Workforce Compliance month was not found.",
        success: false,
      }, { status: 404 });
    }

    return NextResponse.json({
      data: detail,
      success: true,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({
        error: "forbidden",
        message: "You do not have access to view Field Workforce Compliance archives.",
        success: false,
      }, { status: 403 });
    }

    return NextResponse.json({
      error: "field_workforce_archive_view_failed",
      message: error instanceof Error ? error.message : "Field Workforce Compliance archive view failed.",
      success: false,
    }, { status: 500 });
  }
}
