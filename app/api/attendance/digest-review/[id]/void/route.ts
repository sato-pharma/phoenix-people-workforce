import { NextResponse } from "next/server";

import { isAuthorizedDisputeReviewer } from "@/lib/attendance/digest-read";
import { voidDigestReview } from "@/lib/attendance/settlement-service";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "read");
    if (!access.hrId) throw validationError("No HR ID on session.");

    const authorized = await isAuthorizedDisputeReviewer(access.hrId, access.role === "Super Admin");
    if (!authorized) {
      return NextResponse.json({ error: "forbidden", message: "You are not an authorized digest reviewer." }, { status: 403 });
    }

    const { id: rawId } = await params;
    const digestId = Number(rawId);
    if (!Number.isInteger(digestId) || digestId <= 0) throw validationError("Invalid digest id.");

    const payload = await request.json().catch(() => ({}));
    const { reason } = (payload ?? {}) as Record<string, unknown>;
    if (typeof reason !== "string" || !reason.trim()) throw validationError("A reason is required to void a digest under review.");

    await voidDigestReview({ actorHrId: access.hrId, digestId, reason });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Digest void failed.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
