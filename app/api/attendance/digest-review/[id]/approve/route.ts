import { NextResponse } from "next/server";

import { isAuthorizedDisputeReviewer } from "@/lib/attendance/digest-read";
import { approveDigestReview, type DigestReviewLineEdit } from "@/lib/attendance/settlement-service";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseLineEdits(value: unknown): DigestReviewLineEdit[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw validationError("lineEdits must be an array.");
  return value.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const lineId = Number(record.lineId);
    if (!Number.isInteger(lineId) || lineId <= 0) throw validationError("Each line edit needs a valid lineId.");
    return {
      deductionDays: record.deductionDays !== undefined ? Number(record.deductionDays) : undefined,
      deductionValue: record.deductionValue !== undefined ? Number(record.deductionValue) : undefined,
      lineId,
      reason: typeof record.reason === "string" ? record.reason : undefined,
    };
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "read");
    if (!access.hrId) throw validationError("No HR ID on session.");

    // Coarse pre-check for a clean 403; approveDigestReview re-validates against
    // the same resolved reviewer list independently (defense in depth).
    const authorized = await isAuthorizedDisputeReviewer(access.hrId, access.role === "Super Admin");
    if (!authorized) {
      return NextResponse.json({ error: "forbidden", message: "You are not an authorized digest reviewer." }, { status: 403 });
    }

    const { id: rawId } = await params;
    const digestId = Number(rawId);
    if (!Number.isInteger(digestId) || digestId <= 0) throw validationError("Invalid digest id.");

    const payload = await request.json().catch(() => ({}));
    const lineEdits = parseLineEdits((payload as { lineEdits?: unknown }).lineEdits);

    await approveDigestReview({
      actionUrl: "/employee-portals/attendance/digests",
      actorHrId: access.hrId,
      digestId,
      lineEdits,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Digest review approval failed.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
