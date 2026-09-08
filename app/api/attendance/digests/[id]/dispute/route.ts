import { NextResponse } from "next/server";

import { canOpenDigestPortal, disputeDigestLine } from "@/lib/attendance/digest-service.ts";
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
    // TEMPORARY LOCKDOWN — owner 2026-09-08. Fails closed on a lookup error.
    if (!(await canOpenDigestPortal(access).catch(() => false))) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    if (!access.hrId) throw validationError("No HR ID on session.");

    const { id: rawId } = await params;
    const digestId = Number(rawId);
    if (!Number.isInteger(digestId) || digestId <= 0) throw validationError("Invalid digest id.");

    const payload = (await request.json().catch(() => ({}))) as {
      lineId?: unknown;
      reason?: unknown;
      attachmentUrl?: unknown;
    };
    const lineId = Number(payload.lineId);
    if (!Number.isInteger(lineId) || lineId <= 0) throw validationError("Invalid line id.");
    const reason = String(payload.reason ?? "").trim();
    if (!reason) throw validationError("Tell us why this day is wrong.");

    await disputeDigestLine({
      actorHrId: access.hrId,
      actorRole: String(access.role ?? ""),
      attachmentUrl: typeof payload.attachmentUrl === "string" ? payload.attachmentUrl : null,
      digestId,
      lineId,
      reason,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Attendance dispute could not be recorded.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
