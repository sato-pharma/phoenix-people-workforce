import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { recalculateOutstationDistanceOnly } from "@/lib/outstation/distance-backfill";
import { parseOutstationRequestId } from "@/lib/outstation/request-id";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Fill in a request's missing travel distance, and NOTHING else.
 *
 * Deliberately not part of the admin edit route: that one reprices the claim from the distance it
 * is handed (fuel is distance x 2 x the rate, and ticket, travel cost and eligibility follow), which
 * is right for an admin changing a claim and wrong for recovering a measurement that was never
 * taken. The service asserts the same Super Admin gate the edit path uses — the route does not
 * re-implement it, so there is one authority for who may do this.
 *
 * A refusal is a 422 carrying the same `DistanceFailure` vocabulary the live calculator returns, so
 * an admin reads one set of words whether the distance is being measured for the first time or
 * recovered later.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);

    const { id: rawId } = await params;
    const id = parseOutstationRequestId(rawId);
    if (id === null) {
      return NextResponse.json(
        { error: "invalid_outstation_id", message: "Request id is invalid." },
        { status: 400 },
      );
    }

    const outcome = await recalculateOutstationDistanceOnly(id, access);

    if (!outcome.ok) {
      return NextResponse.json(
        { error: outcome.failure.error, message: outcome.failure.message, success: false },
        { status: outcome.failure.status },
      );
    }

    return NextResponse.json({
      distanceKm: outcome.distanceKm,
      durationMinutes: outcome.durationMinutes,
      requestId: outcome.requestId,
      success: true,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: isForbiddenError(error) ? "forbidden" : "outstation_distance_backfill_failed",
        message: clientSafeErrorMessage(error, "Unable to recalculate the distance."),
      },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
