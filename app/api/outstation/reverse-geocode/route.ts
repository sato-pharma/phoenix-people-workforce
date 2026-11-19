import { NextResponse } from "next/server";
import { z } from "zod";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { parseEvidenceLocationBody, resolveEvidenceLocation } from "@/lib/evidence/location-service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { parseJsonBody } from "@/lib/http/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A coordinate or an accuracy as a number, or as text — exactly what readCoordinateInput accepts; null is none. */
const evidenceCoordinateField = z.union([z.number(), z.string()]).nullable().optional();

/**
 * What the photo stamp asks for (evidence-watermark.ts: `{ accuracyMeters, latitude, longitude }`; `accuracy`
 * is the older name parseEvidenceLocationBody still reads). The schema judges only the shape; whether the pin
 * is a usable place — present, finite, inside the globe — stays parseEvidenceLocationBody's call below.
 */
const ReverseGeocodeBodySchema = z.object({
  accuracy: evidenceCoordinateField,
  accuracyMeters: evidenceCoordinateField,
  latitude: evidenceCoordinateField,
  longitude: evidenceCoordinateField,
});

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "outstation", "create");

    const parsedBody = await parseJsonBody(request, ReverseGeocodeBodySchema);
    if (!parsedBody.ok) {
      return NextResponse.json({ error: "invalid_request_body", message: parsedBody.message }, { status: 400 });
    }
    const body = parsedBody.data;
    const parsed = parseEvidenceLocationBody(body);

    if (!parsed) {
      return NextResponse.json(
        { error: "missing_coordinates", message: "Coordinates are required." },
        { status: 400 },
      );
    }

    // `location` carries the full evidence stamp — address, Phoenix brick/area/region, and the
    // exact lines to burn into the arrival and departure photos (owner instruction 2026-08-23).
    // `area`, `city` and `label` are the original three fields, unchanged, so nothing that already
    // reads this route has to change at the same time.
    const location = await resolveEvidenceLocation(parsed);

    return NextResponse.json({
      area: location.components.area,
      city: location.components.city,
      label: location.address,
      location,
    });
  } catch (error) {
    const message =
      clientSafeErrorMessage(error, "Unable to resolve captured location.");
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "reverse_geocode_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
