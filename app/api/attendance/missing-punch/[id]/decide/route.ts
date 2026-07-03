import { NextResponse } from "next/server";

import { decideMissingPunchStep } from "@/lib/attendance/missing-punch-verification";
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

    const { id: rawId } = await params;
    const verificationId = Number(rawId);
    if (!Number.isInteger(verificationId) || verificationId <= 0) throw validationError("Invalid verification id.");

    const payload = await request.json();
    const { decision, notes } = (payload ?? {}) as Record<string, unknown>;
    if (decision !== "confirm" && decision !== "reject") throw validationError("decision must be 'confirm' or 'reject'.");

    const verification = await decideMissingPunchStep({
      actorHrId: access.hrId,
      decision,
      isSuperAdmin: access.role === "Super Admin",
      notes: typeof notes === "string" && notes.trim() ? notes.trim() : null,
      verificationId,
    });
    return NextResponse.json({ verification });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Missing-punch decision failed.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
