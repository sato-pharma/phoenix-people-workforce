import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { readAccuracyInput } from "@/lib/geo/coordinate-input";
import { readDeparturePhotoPosition } from "@/lib/outstation/departure-evidence";
import { captureOutstationJourneyStop } from "@/lib/outstation/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { parseOutstationRequestId } from "@/lib/outstation/request-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A STOP on a car trip — the next place of a chained journey (owner rule, 2026-10-18; pricing in
 * chained-journey.ts). Posted by the employee from the place itself, with a live photo and GPS.
 *
 * Every rule that matters — the caller owns the trip, a car trip, still undecided and out of
 * payroll, inside the trip window, a live photo with a position, at most six stops — is enforced
 * in the SERVICE. The permission check below only establishes that the caller may touch the
 * outstation module at all.
 */
function journeyStopStatus(error: unknown) {
  if (isForbiddenError(error)) return 403;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  // The trip moved on (decided, in payroll, full, or written in between): not a bad payload.
  if (
    message.includes("already been decided") ||
    message.includes("added to payroll") ||
    message.includes("the most one trip may carry") ||
    message.includes("changed while")
  ) {
    return 409;
  }
  if (
    message.includes("required") ||
    message.includes("invalid") ||
    message.includes("must be") ||
    message.includes("can only") ||
    message.includes("too large") ||
    message.includes("empty") ||
    message.includes("not available") ||
    message.includes("missing") ||
    message.includes("carry no location") ||
    message.includes("captured inside the app")
  ) {
    return 400;
  }
  return 500;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "outstation", "create");

    const { id: rawId } = await params;
    const id = parseOutstationRequestId(rawId);
    if (id === null) {
      return NextResponse.json(
        { error: "invalid_outstation_id", message: "Request id is invalid." },
        { status: 400 },
      );
    }

    const body = (await request.json()) as Record<string, unknown>;
    const imageDataUrl = String(body.imageDataUrl ?? "");
    if (!imageDataUrl) {
      return NextResponse.json(
        { error: "missing_photo", message: "Take the stop photo before saving it." },
        { status: 400 },
      );
    }

    // Read here, judged in the service: a photo with no position is refused there before anything
    // is uploaded. Never cast the raw body field to a number: `Number(null)` is 0, a fix at 0,0.
    const { latitude, longitude } = readDeparturePhotoPosition(body);

    const result = await captureOutstationJourneyStop(access, {
      accuracyMeters: readAccuracyInput(body.accuracyMeters),
      imageDataUrl,
      latitude,
      locationLabel: typeof body.locationLabel === "string" ? body.locationLabel : null,
      longitude,
      requestId: id,
    });

    // The flag WORDING stays with the approver: telling the employee "Google needs about 58
    // minutes" is telling a forger the line to stay under (risk review, 2026-10-18).
    return NextResponse.json({
      claimedTotalAmount: result.request.claimedTotalAmount,
      flagged: result.pricing.flags.length > 0,
      fuelAmount: result.request.fuelAmount,
      mode: result.pricing.mode,
      modeReason: result.pricing.modeReason,
      stopGovernorate: result.stop.governorate,
      stopNumber: result.stop.stopNumber,
      success: true,
    });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unable to save the stop.");
    return NextResponse.json(
      {
        error: isForbiddenError(error) ? "forbidden" : "outstation_journey_stop_failed",
        message,
      },
      { status: journeyStopStatus(error) },
    );
  }
}
