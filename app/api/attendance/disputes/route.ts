import { NextResponse } from "next/server";

import { canReviewDisputes, listPendingDisputes } from "@/lib/attendance/digest-service.ts";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The dispute queue. Gated TWICE on purpose: the matrix grant lets a page render,
 * and the reviewer check decides who may see other people's pay disputes — a
 * matrix grant alone once let a Regional Manager export 69 employees' deductions.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "read");
    if (!(await canReviewDisputes(access))) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }

    const disputes = await listPendingDisputes();
    return NextResponse.json({ disputes });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Attendance disputes failed to load.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
