import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { assertPageOpenForRole } from "@/lib/auth/seat-page-fences";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getFieldWorkforceComplianceEmployeeTrend } from "@/lib/field-workforce-compliance/live-snapshots";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    hrId: string;
  }>;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_calendar", "read");
    // Fenced off the Talent Acquisition seat with its page (seat-page-fences.ts, audit P7-01).
    assertPageOpenForRole(access.role, "/admin/field-workforce-compliance");

    const { hrId } = await context.params;
    if (!hrId.trim()) {
      return NextResponse.json({
        error: "invalid_hr_id",
        message: "hrId is required.",
        success: false,
      }, { status: 400 });
    }

    const trend = await getFieldWorkforceComplianceEmployeeTrend({ hrId: decodeURIComponent(hrId) });

    return NextResponse.json({
      data: trend,
      success: true,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({
        error: "forbidden",
        message: "You do not have access to view Field Workforce Compliance data.",
        success: false,
      }, { status: 403 });
    }

    return NextResponse.json({
      error: "field_workforce_employee_trend_failed",
      message: clientSafeErrorMessage(error, "Field Workforce Compliance employee trend could not be loaded."),
      success: false,
    }, { status: 500 });
  }
}
