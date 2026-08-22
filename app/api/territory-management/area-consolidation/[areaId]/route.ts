import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";
import { previewAreaConsolidation } from "@/lib/territory-management/area-consolidation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Everything a consolidation of this area WOULD do, itemized by name rather than by count.
//
// This is the screen the owner reads before pressing anything — "I check if confirmed, I press the
// button". A count cannot be checked by a human, so the service names the rows.
export async function GET(request: Request, { params }: { params: Promise<{ areaId: string }> }) {
  try {
    const { areaId } = await params;
    const parsed = Number(areaId);
    if (!Number.isInteger(parsed)) throw validationError("That is not a valid area.");

    const access = await resolveAccessContext(request);
    const preview = await previewAreaConsolidation(access, parsed);
    return NextResponse.json({ preview, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not build the consolidation preview.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
