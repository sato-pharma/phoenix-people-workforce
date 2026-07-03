import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { listFieldWorkforceComplianceLiveSnapshots } from "@/lib/field-workforce-compliance/live-snapshots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_calendar", "read");

    const snapshots = await listFieldWorkforceComplianceLiveSnapshots();

    return NextResponse.json({
      data: snapshots,
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
      error: "field_workforce_live_snapshots_list_failed",
      message: error instanceof Error ? error.message : "Field Workforce Compliance snapshots could not be listed.",
      success: false,
    }, { status: 500 });
  }
}
