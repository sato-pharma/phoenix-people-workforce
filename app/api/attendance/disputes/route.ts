import { NextResponse } from "next/server";

import { isAuthorizedDisputeReviewer, listOpenDisputes } from "@/lib/attendance/digest-read";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Authorization here is data-driven (attendance_digest_settings.approver_hr_ids),
// not a static role — mirrors the "either HR Manager or System Admin" spec.
// assertPermission(attendance:read) is the coarse baseline; the real gate is
// isAuthorizedDisputeReviewer, re-checked independently (defense in depth) by
// reviewDigestDispute itself when a decision is actually submitted.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "read");

    const authorized = await isAuthorizedDisputeReviewer(access.hrId, access.role === "Super Admin");
    if (!authorized) {
      return NextResponse.json({ error: "forbidden", message: "You are not an authorized dispute reviewer." }, { status: 403 });
    }

    return NextResponse.json({ disputes: await listOpenDisputes() });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Attendance disputes failed to load.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
