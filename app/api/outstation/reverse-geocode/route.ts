import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { googleReverseGeocode } from "@/lib/google-maps/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "outstation", "create");

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
      label: label || null,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to resolve captured location.";
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "reverse_geocode_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
