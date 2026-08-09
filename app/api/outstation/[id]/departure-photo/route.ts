import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { captureOutstationDeparturePhoto } from "@/lib/outstation/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

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
function departurePhotoStatus(error: unknown) {
  if (isForbiddenError(error)) return 403;
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
    const id = Number(rawId);
    if (!Number.isFinite(id)) {
      return NextResponse.json(
        { error: "invalid_outstation_id", message: "Request id is invalid." },
        { status: 400 },
      );
    }

    const body = (await request.json()) as Record<string, unknown>;
    const imageDataUrl = String(body.imageDataUrl ?? "");
    if (!imageDataUrl) {
      return NextResponse.json(
        { error: "missing_photo", message: "Capture the departure photo before submitting it." },
        { status: 400 },
      );
    }

    // Coordinates are optional on purpose. The owner chose to FLAG a departure photo taken far
    // from the trip rather than refuse it, so a device that cannot get a fix must still be able
    // to submit — the review simply records the distance as unknown instead of as zero.
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);

    const result = await captureOutstationDeparturePhoto(access, {
      imageDataUrl,
      latitude: Number.isFinite(latitude) ? latitude : null,
      locationLabel: typeof body.locationLabel === "string" ? body.locationLabel : null,
      longitude: Number.isFinite(longitude) ? longitude : null,
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
