import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { parseEvidenceLocationBody, resolveEvidenceLocation } from "@/lib/evidence/location-service";
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

    const body = (await request.json()) as Record<string, unknown>;
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
