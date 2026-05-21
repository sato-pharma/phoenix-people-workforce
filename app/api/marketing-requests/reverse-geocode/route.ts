import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { googleReverseGeocode } from "@/lib/google-maps/server";
import { toApiError } from "@/lib/http/api-errors";
import { assertMarketingRequestAccess } from "@/lib/marketing-requests/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    assertMarketingRequestAccess(access);

    const body = (await request.json()) as Record<string, unknown>;
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return NextResponse.json(
        { error: "missing_coordinates", message: "Coordinates are required." },
        { status: 400 },
      );
    }

    const result = await googleReverseGeocode({ lat: latitude, lng: longitude });
    const label = result?.formattedAddress ?? [result?.area, result?.city].filter(Boolean).join(", ");

    return NextResponse.json({
      area: result?.area ?? null,
      city: result?.city ?? null,
      governorate: result?.city ?? null,
      label: label || null,
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
