import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { readCapturedPosition } from "@/lib/outstation/captured-coordinates";
import { captureOutstationLocation } from "@/lib/outstation/service";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { MISSING_CAPTURED_COORDINATES } from "@/app/api/outstation/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "outstation", "create");

    const body = await request.json();
    // Never `Number(body.capturedLatitude)`: `Number(null)` is 0, which is finite, so a body with
    // no GPS fix passed this 400 and was saved as an arrival at 0°N 0°E.
    const position = readCapturedPosition(body.capturedLatitude, body.capturedLongitude);
    const capturedAccuracyMeters = Number(body.capturedAccuracyMeters);

    if (!position) {
      return NextResponse.json(MISSING_CAPTURED_COORDINATES, { status: 400 });
    }

    const result = await captureOutstationLocation(access, {
      capturedAccuracyMeters,
      capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : undefined,
      capturedLatitude: position.latitude,
      capturedLongitude: position.longitude,
      offlineCaptured: Boolean(body.offlineCaptured),
    });

    return NextResponse.json(result);
  } catch (error) {
    const message =
      clientSafeErrorMessage(error, "Unable to capture current location.");
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "outstation_capture_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
