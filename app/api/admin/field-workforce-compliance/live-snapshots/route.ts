import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { assertPageOpenForRole } from "@/lib/auth/seat-page-fences";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { listRecentFieldWorkforceComplianceMonths } from "@/lib/field-workforce-compliance/live-snapshots";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Plain recent-months list for the month picker — no computation, so this is always fast.
 * Each month's real numbers are only computed when actually selected (GET .../[monthKey]). */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_calendar", "read");
    // Fenced off the Talent Acquisition seat with its page (seat-page-fences.ts, audit P7-01).
    assertPageOpenForRole(access.role, "/admin/field-workforce-compliance");

    const months = listRecentFieldWorkforceComplianceMonths();

    return NextResponse.json({
      data: months,
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
      error: "field_workforce_months_list_failed",
      message: clientSafeErrorMessage(error, "Field Workforce Compliance months could not be listed."),
      success: false,
    }, { status: 500 });
  }
}
