import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { geocodeAddressForApi } from "@/lib/geo-intelligence/service";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "geo_intelligence", "read");

    const body = await request.json();
    const addressText = String(body.addressText ?? "").trim();
    if (!addressText) {
      return NextResponse.json(
        { error: "missing_address", message: "addressText is required." },
        { status: 400 },
      );
    }

    const location = await geocodeAddressForApi({
      addressText,
      area: body.area ?? null,
      city: body.city ?? null,
      label: body.label ?? null,
      line: body.line ?? null,
      sourceKey: body.sourceKey ?? null,
      sourceType: body.sourceType ?? "custom",
    });

    return NextResponse.json({ location });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to geocode address.";
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "geo_geocode_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
