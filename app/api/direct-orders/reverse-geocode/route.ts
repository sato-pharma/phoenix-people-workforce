import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { parseEvidenceLocationBody, resolveEvidenceLocation } from "@/lib/evidence/location-service";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The evidence stamp for a Direct Order pharmacy-validation storefront photo.
 *
 * Outstation and marketing already had a route like this; Direct Orders never did, which is why
 * its storefront photos carried a bare `GPS: 30.059482, 31.223145` and nothing else. Same gate as
 * the capture itself (`direct_orders:create`) — this route reveals only the geography of a point
 * the caller already holds, and it must not be reachable by anyone who cannot file the evidence.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "direct_orders", "create");

    const body = (await request.json()) as Record<string, unknown>;
    const parsed = parseEvidenceLocationBody(body);

    if (!parsed) {
      return NextResponse.json(
        { error: "missing_coordinates", message: "Coordinates are required." },
        { status: 400 },
      );
    }

    const location = await resolveEvidenceLocation(parsed);

    return NextResponse.json({
      area: location.components.area,
      city: location.components.city,
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
