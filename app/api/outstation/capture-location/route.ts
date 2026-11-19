import { NextResponse } from "next/server";
import { z } from "zod";

import { assertPermission } from "@/lib/auth/permissions";
import { readAccuracyInput } from "@/lib/geo/coordinate-input";
import { readCapturedPosition } from "@/lib/outstation/captured-coordinates";
import { captureOutstationLocation } from "@/lib/outstation/service";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { MISSING_CAPTURED_COORDINATES } from "@/app/api/outstation/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { parseJsonBody } from "@/lib/http/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A GPS figure as a number, or as text; the shared readers take both, and null is no fix. */
const captureNumberField = z.union([z.number(), z.string()]).nullable().optional();

/** What Submit Expense's "Capture location" sends (mobile-outstation-wizard.tsx). The position is still required below. */
const CaptureLocationBodySchema = z.object({
  capturedAccuracyMeters: captureNumberField,
  capturedAt: z.string().nullable().optional(),
  capturedLatitude: captureNumberField,
  capturedLongitude: captureNumberField,
  offlineCaptured: z.boolean().nullable().optional(),
});

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "outstation", "create");

    const parsedBody = await parseJsonBody(request, CaptureLocationBodySchema);
    if (!parsedBody.ok) {
      return NextResponse.json({ error: "invalid_request_body", message: parsedBody.message }, { status: 400 });
    }
    const body = parsedBody.data;
    // Never `Number(body.capturedLatitude)`: `Number(null)` is 0, which is finite, so a body with
    // no GPS fix passed this 400 and was saved as an arrival at 0°N 0°E.
    const position = readCapturedPosition(body.capturedLatitude, body.capturedLongitude);
    // Same for the accuracy: `Number(null)`, `Number("")` and `Number(" ")` are 0, a perfect fix the
    // device never reported. No accuracy is null, and the submit holds it for review.
    const capturedAccuracyMeters = readAccuracyInput(body.capturedAccuracyMeters);

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
