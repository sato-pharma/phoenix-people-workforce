import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { googleDirectionsRoute, isGoogleMapsServerKeyConfigured } from "@/lib/google-maps/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import { mapsNotConfiguredFailure, noDrivingRouteFailure } from "@/lib/outstation/distance-failure";
import { getResidenceLocationForEmployee } from "@/lib/outstation/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function minutesFromSeconds(value: number | null | undefined) {
  return value != null ? Number((value / 60).toFixed(1)) : null;
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertOutstationAdminAccess(access, "approve");

    const body = (await request.json().catch(() => ({}))) as {
      destinationIsRegion?: boolean;
      destinationLabel?: string;
      destinationLat?: number;
      destinationLng?: number;
      managerHrId?: string;
    };

    const managerHrId = typeof body.managerHrId === "string" ? body.managerHrId.trim() : "";
    const destinationLat = Number(body.destinationLat);
    const destinationLng = Number(body.destinationLng);
    const destinationIsRegion = body.destinationIsRegion === true;
    const destinationLabel =
      typeof body.destinationLabel === "string" ? body.destinationLabel.trim() || null : null;

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

    if (!isGoogleMapsServerKeyConfigured()) {
      const failure = mapsNotConfiguredFailure();
      console.error(
        "[outstation] distance calculation unavailable: GOOGLE_MAPS_SERVER_KEY is not set",
      );
      return NextResponse.json(
        { error: failure.error, message: failure.message },
        { status: failure.status },
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
      const failure = noDrivingRouteFailure({
        destinationIsRegion,
        destinationLabel,
        destinationLat,
        destinationLng,
      });
      console.warn(
        `[outstation] no driving route for ${managerHrId} to ${destinationLat},${destinationLng}`
          + `${destinationIsRegion ? " (administrative region)" : ""}`,
      );
      return NextResponse.json(
        { error: failure.error, message: failure.message },
        { status: failure.status },
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
    const message = clientSafeErrorMessage(error, "Distance calculation failed.");
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "distance_calc_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
