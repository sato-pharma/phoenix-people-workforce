import { NextResponse } from "next/server";
import { z } from "zod";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { readDeparturePhotoPosition } from "@/lib/outstation/departure-evidence";
import { captureOutstationDeparturePhoto } from "@/lib/outstation/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { OutstationPhotoRefusedError } from "@/lib/outstation/blank-frame";
import { parseJsonBody } from "@/lib/http/request-body";
import { parseOutstationRequestId } from "@/lib/outstation/request-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The DEPARTURE photo — the second live capture every outstation request must carry (owner
 * request 2026-08-04). Posted by the employee before he leaves the destination.
 *
 * Ownership is enforced in the SERVICE, not here: `captureOutstationDeparturePhoto` checks that
 * the caller is the submitting employee or an outstation admin. The permission check below only
 * establishes that the caller may touch the outstation module at all.
 */
/** A GPS coordinate as a number, or as text; readDeparturePhotoPosition reads both, and null is no fix. */
const departureCoordinateField = z.union([z.number(), z.string()]).nullable().optional();

/**
 * What the departure-photo card sends (departure-photo-card.tsx): the stamped JPEG as a data URL — never capped
 * here, the service judges its size — and the position it was taken at. A missing photo still gets the
 * route's own words, and a missing position the service's.
 */
const DeparturePhotoBodySchema = z.object({
  imageDataUrl: z.string().nullable().optional(),
  latitude: departureCoordinateField,
  locationLabel: z.string().nullable().optional(),
  longitude: departureCoordinateField,
});

function departurePhotoStatus(error: unknown) {
  if (isForbiddenError(error)) return 403;
  // A blank frame, or a car photo whose odometer cannot be read (owner, 2026-11-23): take it again.
  if (error instanceof OutstationPhotoRefusedError) return 400;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  // Already captured: the request is not in a state that accepts another photo. 409 rather than
  // 400 so a double-tap on a slow connection is distinguishable from a bad payload.
  if (message.includes("already been captured")) return 409;
  if (
    message.includes("required") ||
    message.includes("invalid") ||
    message.includes("must be") ||
    message.includes("too large") ||
    message.includes("empty") ||
    message.includes("not available") ||
    message.includes("missing") ||
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

    const parsedBody = await parseJsonBody(request, DeparturePhotoBodySchema);
    if (!parsedBody.ok) {
      return NextResponse.json({ error: "invalid_request_body", message: parsedBody.message }, { status: 400 });
    }
    const body = parsedBody.data;
    const imageDataUrl = String(body.imageDataUrl ?? "");
    if (!imageDataUrl) {
      return NextResponse.json(
        { error: "missing_photo", message: "Capture the departure photo before submitting it." },
        { status: 400 },
      );
    }

    // Read here, judged in the service: a photo with no position is refused there (owner ruling,
    // 2026-09-18, departure-photo-location.ts), and its message carries "required", so the status
    // map above answers 400. A far or inaccurate position is still accepted and only flagged. Never
    // `Number(body.latitude)` here: `Number(null)` is 0, which stored a no-fix photo at 0,0.
    const { latitude, longitude } = readDeparturePhotoPosition(body);

    const result = await captureOutstationDeparturePhoto(access, {
      imageDataUrl,
      latitude,
      locationLabel: typeof body.locationLabel === "string" ? body.locationLabel : null,
      longitude,
      requestId: id,
    });

    return NextResponse.json({
      gateStatus: result.gateStatus,
      review: result.review,
      success: true,
    });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unable to save the departure photo.");
    return NextResponse.json(
      {
        error: isForbiddenError(error) ? "forbidden" : "outstation_departure_photo_failed",
        message,
      },
      { status: departurePhotoStatus(error) },
    );
  }
}
