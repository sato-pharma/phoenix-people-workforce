import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { revertAreaConsolidation } from "@/lib/territory-management/area-consolidation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Put every moved row back where it was.
//
// The service reads the undo buffer rather than assuming everything came from the source area, so
// this restores the exact prior state — including a row that was on no area at all.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ consolidationId: string }> },
) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const { consolidationId } = await params;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as { reason?: string | null };

    const result = await revertAreaConsolidation(access, {
      consolidationId,
      reason: body.reason ?? null,
    });

    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not revert that consolidation.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
