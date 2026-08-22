import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { applyAreaConsolidation } from "@/lib/territory-management/area-consolidation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Move every current-assignment row from this area onto the target.
//
// The target is REQUIRED in the body and is not defaulted here. The owner presses this button after
// reading a preview that names the target, so the value he confirmed is the value that is sent —
// rather than the route re-deriving one and possibly disagreeing with what he saw on screen.
export async function POST(request: Request, { params }: { params: Promise<{ areaId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const { areaId } = await params;
    const sourceAreaId = Number(areaId);
    if (!Number.isInteger(sourceAreaId)) throw validationError("That is not a valid area.");

    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as {
      targetAreaId?: number | string | null;
      notes?: string | null;
    };

    const targetAreaId = Number(body.targetAreaId);
    if (!Number.isInteger(targetAreaId)) {
      throw validationError("Choose the area these rows should move to.");
    }

    const result = await applyAreaConsolidation(access, {
      sourceAreaId,
      targetAreaId,
      notes: body.notes ?? null,
    });

    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not consolidate that area.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
