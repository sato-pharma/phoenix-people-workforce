import { NextResponse } from "next/server";

import { canOpenDigestPortal, confirmDigestLines } from "@/lib/attendance/digest-service.ts";
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
    // TEMPORARY LOCKDOWN — owner 2026-09-08. Fails closed on a lookup error. Gated
    // here as well as on the page: a confirmation is what turns a flagged day into an
    // approved deduction, so this route must not stay open behind a hidden page.
    if (!(await canOpenDigestPortal(access).catch(() => false))) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    if (!access.hrId) throw validationError("No HR ID on session.");

    const { id: rawId } = await params;
    const digestId = Number(rawId);
    if (!Number.isInteger(digestId) || digestId <= 0) throw validationError("Invalid digest id.");

    const payload = await request.json().catch(() => ({}));
    const lineIds = Array.isArray((payload as { lineIds?: unknown })?.lineIds)
      ? (payload as { lineIds: unknown[] }).lineIds
          .map(Number)
          .filter((value) => Number.isInteger(value) && value > 0)
      : [];
    if (lineIds.length === 0) throw validationError("At least one lineId is required.");

    // Ownership is enforced inside the service against the digest's own employee,
    // never from anything in this request body.
    const result = await confirmDigestLines({
      actorHrId: access.hrId,
      actorRole: String(access.role ?? ""),
      digestId,
      lineIds,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Attendance digest confirmation failed.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
