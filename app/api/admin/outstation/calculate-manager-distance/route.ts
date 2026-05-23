import { NextResponse } from "next/server";

import { assertAdminManagerExpenseAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { googleDirectionsRoute } from "@/lib/google-maps/server";
import { getResidenceLocationForEmployee } from "@/lib/outstation/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function minutesFromSeconds(value: number | null | undefined) {
  return value != null ? Number((value / 60).toFixed(1)) : null;
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertAdminManagerExpenseAccess(access);

    const body = (await request.json().catch(() => ({}))) as {
      destinationLat?: number;
      destinationLng?: number;
      managerHrId?: string;
    };

    const managerHrId = typeof body.managerHrId === "string" ? body.managerHrId.trim() : "";
    const destinationLat = Number(body.destinationLat);
    const destinationLng = Number(body.destinationLng);

    if (!managerHrId) {
      return NextResponse.json(
        { error: "missing_hr_id", message: "managerHrId is required." },
        { status: 400 },
      );
    }

    if (!Number.isFinite(destinationLat) || !Number.isFinite(destinationLng)) {
      return NextResponse.json(
        { error: "invalid_destination", message: "destinationLat and destinationLng must be valid numbers." },
        { status: 400 },
      );
    }

    const residence = await getResidenceLocationForEmployee(managerHrId);
    if (
      !residence ||
      residence.residenceLatitude == null ||
      residence.residenceLongitude == null
    ) {
      return NextResponse.json(
        {
          error: "missing_residence",
          message: `No registered residence location found for employee ${managerHrId}. Please ensure their address is set in the employee directory.`,
        },
        { status: 422 },
      );
    }

    const directions = await googleDirectionsRoute(
      { lat: residence.residenceLatitude, lng: residence.residenceLongitude },
      { lat: destinationLat, lng: destinationLng },
    );

    if (directions.distanceMeters == null) {
      return NextResponse.json(
        {
          error: "route_not_found",
          message: "Google Maps could not calculate a driving route to the selected destination.",
        },
        { status: 422 },
      );
    }

    const distanceKm = Number((directions.distanceMeters / 1000).toFixed(2));
    const durationMinutes =
      minutesFromSeconds(directions.durationInTrafficSeconds) ??
      minutesFromSeconds(directions.durationSeconds);

    return NextResponse.json({
      distanceKm,
      durationMinutes,
      fromLabel: [
        residence.residenceAddress,
        residence.residenceCity,
        residence.residenceArea,
      ]
        .filter(Boolean)
        .join(", ") || `${residence.residenceLatitude}, ${residence.residenceLongitude}`,
      routePolyline: directions.polyline,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Distance calculation failed.";
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "distance_calc_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
