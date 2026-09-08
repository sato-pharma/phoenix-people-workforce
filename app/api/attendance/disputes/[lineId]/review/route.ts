import { NextResponse } from "next/server";

import { canReviewDisputes, reviewDispute } from "@/lib/attendance/digest-service.ts";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ lineId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "read");
    if (!(await canReviewDisputes(access))) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    if (!access.hrId) throw validationError("No HR ID on session.");

    const { lineId: rawLineId } = await params;
    const lineId = Number(rawLineId);
    if (!Number.isInteger(lineId) || lineId <= 0) throw validationError("Invalid line id.");

    const payload = (await request.json().catch(() => ({}))) as { uphold?: unknown; notes?: unknown };
    if (typeof payload.uphold !== "boolean") {
      // Not defaulted: guessing this wrong either charges someone who was covered or
      // waives a real deduction, and both look identical afterwards.
      throw validationError("`uphold` must be true or false.");
    }

    await reviewDispute({
      lineId,
      notes: typeof payload.notes === "string" ? payload.notes : null,
      reviewerHrId: access.hrId,
      reviewerRole: String(access.role ?? ""),
      uphold: payload.uphold,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Attendance dispute review failed.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
