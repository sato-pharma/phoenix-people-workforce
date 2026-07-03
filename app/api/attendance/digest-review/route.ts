import { NextResponse } from "next/server";

import { isAuthorizedDisputeReviewer, listPendingDigestReviews } from "@/lib/attendance/digest-read";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same reviewer pool as dispute review (attendance_digest_settings.approver_hr_ids)
// — a deduction-bearing digest never reaches the employee without one of these
// approvers (or the CEO fallback) reviewing it first.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "read");

    const authorized = await isAuthorizedDisputeReviewer(access.hrId, access.role === "Super Admin");
    if (!authorized) {
      return NextResponse.json({ error: "forbidden", message: "You are not an authorized digest reviewer." }, { status: 403 });
    }

    return NextResponse.json({ digests: await listPendingDigestReviews() });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Digest review queue failed to load.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
