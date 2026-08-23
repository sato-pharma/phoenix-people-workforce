import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { parseEvidenceLocationBody, resolveEvidenceLocation } from "@/lib/evidence/location-service";
import { toApiError } from "@/lib/http/api-errors";
import { assertMarketingRequestAccess } from "@/lib/marketing-requests/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    assertMarketingRequestAccess(access);

    const body = (await request.json()) as Record<string, unknown>;
    const parsed = parseEvidenceLocationBody(body);

    if (!parsed) {
      return NextResponse.json(
        { error: "missing_coordinates", message: "Coordinates are required." },
        { status: 400 },
      );
    }

    // `location` is the evidence stamp (address + Phoenix brick/area/region + the watermark lines).
    // The four flat fields keep their original meaning on purpose: the capture screen writes
    // `area`/`governorate` into the CUSTOMER's own record, and those must stay Google's answer for
    // the pin, never the Phoenix territory the pin happens to fall in.
    const location = await resolveEvidenceLocation(parsed);

    return NextResponse.json({
      area: location.components.area,
      city: location.components.city,
      // Deliberately `city`, not `components.governorate` — that is what this route has always
      // returned, and the capture screen's governorate field is populated from it. Kept verbatim.
      governorate: location.components.city,
      label: location.address,
      location,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }

    const apiError = toApiError(error, "Unable to resolve captured location.");
    return NextResponse.json(
      { error: apiError.code, message: apiError.message },
      { status: apiError.status },
    );
  }
}
