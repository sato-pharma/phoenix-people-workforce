import { NextResponse } from "next/server";

import { listMyPendingMissingPunchActions } from "@/lib/attendance/missing-punch-verification";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Inbox: missing-punch verifications where the caller is authorized to act on the current step. */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "read");

    const verifications = await listMyPendingMissingPunchActions(access.hrId, access.role === "Super Admin");
    return NextResponse.json({ verifications });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Missing-punch verifications failed to load.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
