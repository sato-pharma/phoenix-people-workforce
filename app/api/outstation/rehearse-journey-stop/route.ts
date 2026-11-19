import { NextResponse } from "next/server";
import { z } from "zod";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { readAccuracyInput } from "@/lib/geo/coordinate-input";
import { readDeparturePhotoPosition } from "@/lib/outstation/departure-evidence";
import { rehearseOutstationJourneyStop } from "@/lib/outstation/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { parseJsonBody } from "@/lib/http/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A TEST ACCOUNT's rehearsal of a journey stop (owner, 2026-11-03). Its Submit saved no claim, so
 * there is no trip for the real stop route to attach to; this measures and prices the stop exactly
 * as a real one for the person the account mirrors, and persists NOTHING — it is on
 * TEST_ACCOUNT_READONLY_POSTS, and tests/test-account-readonly-posts.test.ts keeps this file
 * write-free. Anyone who is not a test account is refused in the service.
 */
function rehearsalStatus(error: unknown) {
  if (isForbiddenError(error)) return 403;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("the most one trip may carry") || message.includes("closed at the end of")) return 409;
  if (
    message.includes("missing") ||
    message.includes("invalid") ||
    message.includes("required") ||
    message.includes("must not") ||
    message.includes("must be") ||
    message.includes("carry no location") ||
    message.includes("location")
  ) {
    return 400;
  }
  return 500;
}

/** A GPS figure, a distance or an amount as a number, or as text; numberOrNull and the shared readers take both. */
const rehearsalNumberField = z.union([z.number(), z.string()]).nullable().optional();
const rehearsalTextField = z.string().nullable().optional();

/**
 * What the test claim screen sends (journey-stop-rehearsal.tsx): the stop's position, the checked trip's
 * arrival and dates, and the server's own earlier stop records sent back verbatim. Every field is optional, so
 * an empty body still reaches the service — which refuses anyone who is not a test account with its own 403.
 */
const RehearseJourneyStopBodySchema = z.object({
  accuracyMeters: rehearsalNumberField,
  arrival: z
    .object({
      capturedAt: rehearsalTextField,
      distanceFromResidenceKm: rehearsalNumberField,
      latitude: rehearsalNumberField,
      longitude: rehearsalNumberField,
    })
    .nullable()
    .optional(),
  latitude: rehearsalNumberField,
  locationLabel: rehearsalTextField,
  longitude: rehearsalNumberField,
  stops: z.array(z.unknown()).nullable().optional(),
  ticketAmount: rehearsalNumberField,
  ticketFileCount: rehearsalNumberField,
  transportationType: rehearsalTextField,
  tripEndDate: rehearsalTextField,
  tripStartDate: rehearsalTextField,
});

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "outstation", "create");

    const parsedBody = await parseJsonBody(request, RehearseJourneyStopBodySchema);
    if (!parsedBody.ok) {
      return NextResponse.json({ error: "invalid_request_body", message: parsedBody.message }, { status: 400 });
    }
    const body = parsedBody.data;
    // Never cast the raw body field to a number: `Number(null)` is 0, a fix at 0,0.
    const { latitude, longitude } = readDeparturePhotoPosition(body);
    const arrival = (body.arrival && typeof body.arrival === "object" ? body.arrival : {}) as Record<string, unknown>;

    const result = await rehearseOutstationJourneyStop(access, {
      accuracyMeters: readAccuracyInput(body.accuracyMeters),
      arrival: {
        capturedAt: typeof arrival.capturedAt === "string" ? arrival.capturedAt : null,
        distanceFromResidenceKm: numberOrNull(arrival.distanceFromResidenceKm),
        latitude: numberOrNull(arrival.latitude),
        longitude: numberOrNull(arrival.longitude),
      },
      latitude,
      locationLabel: typeof body.locationLabel === "string" ? body.locationLabel : null,
      longitude,
      stops: body.stops,
      ticket: { amount: numberOrNull(body.ticketAmount), fileCount: numberOrNull(body.ticketFileCount) },
      transportationType: typeof body.transportationType === "string" ? body.transportationType : null,
      tripEndDate: typeof body.tripEndDate === "string" ? body.tripEndDate : null,
      tripStartDate: typeof body.tripStartDate === "string" ? body.tripStartDate : null,
    });

    // The flag WORDING is shown here, unlike the real stop route: the reader is a test account
    // rehearsing the rule, and seeing why a journey would be held is the point of the rehearsal.
    return NextResponse.json({
      pricing: result.pricing,
      stop: result.stop,
      stopsLeft: result.stopsLeft,
      success: true,
    });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unable to rehearse the stop.");
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "outstation_stop_rehearsal_failed", message },
      { status: rehearsalStatus(error) },
    );
  }
}
