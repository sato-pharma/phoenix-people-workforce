import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { captureOutstationLocation } from "@/lib/outstation/service";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "outstation", "create");

    const body = await request.json();
    const capturedLatitude = Number(body.capturedLatitude);
    const capturedLongitude = Number(body.capturedLongitude);
    const capturedAccuracyMeters = Number(body.capturedAccuracyMeters);

    if (!Number.isFinite(capturedLatitude) || !Number.isFinite(capturedLongitude)) {
      return NextResponse.json(
        { error: "missing_coordinates", message: "Captured coordinates are required." },
        { status: 400 },
      );
    }

    const result = await captureOutstationLocation(access, {
      capturedAccuracyMeters,
      capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : undefined,
      capturedLatitude,
      capturedLongitude,
      offlineCaptured: Boolean(body.offlineCaptured),
    });

    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to capture current location.";
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "outstation_capture_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
