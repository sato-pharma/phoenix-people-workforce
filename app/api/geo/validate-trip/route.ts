import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { validateTripRoute } from "@/lib/geo-intelligence/service";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "geo_intelligence", "read");

    const body = await request.json();
    const fromText = String(body.from ?? body.fromText ?? "").trim();
    const toText = String(body.to ?? body.toText ?? "").trim();

    if (!fromText || !toText) {
      return NextResponse.json(
        { error: "missing_route", message: "Both from and to are required." },
        { status: 400 },
      );
    }

    const result = await validateTripRoute({
      claimedAmount: Number(body.claimedAmount ?? 0),
      employeeHrId: body.employeeHrId ? String(body.employeeHrId) : null,
      employeeName: String(body.employeeName ?? "Unknown Employee"),
      fromText,
      sourceFileMonth: body.sourceFileMonth ? String(body.sourceFileMonth) : null,
      toText,
      tripDate: body.tripDate ? String(body.tripDate) : null,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to validate trip.";
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "geo_validate_trip_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
