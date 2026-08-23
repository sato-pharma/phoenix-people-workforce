/**
 * Why a residence -> destination distance could not be measured, in words an admin can act on.
 *
 * Google's Routes API answers HTTP 200 with an EMPTY `routes` array when the destination
 * coordinate has no road near it. A governorate's map centre is exactly that: verified live
 * 2026-08-23 against the production server key, the centres of New Valley, Marsa Matrouh,
 * Red Sea and South Sinai all return zero routes, while every city — Alexandria, Hurghada,
 * Siwa, Sharm El Sheikh, even Riyadh and Dubai — routes fine. Sending the place id or the
 * formatted address instead of the coordinate does not help; Google has no road to reach.
 *
 * Two very different faults used to share one sentence that blamed Google for both: a missing
 * `GOOGLE_MAPS_SERVER_KEY` returns the same all-null result as a genuinely unreachable point,
 * so a configuration outage (which is how every map surface died on 2026-08-01) read as "bad
 * destination" and sent the reader hunting the wrong thing.
 */

export type DistanceFailure = {
  error: "maps_not_configured" | "route_not_found";
  message: string;
  status: 422 | 503;
};

function formatCoordinate(value: number) {
  return value.toFixed(5);
}

/** The server has no Google Maps key at all — nothing about the destination is at fault. */
export function mapsNotConfiguredFailure(): DistanceFailure {
  return {
    error: "maps_not_configured",
    message:
      "Google Maps is not configured on this server, so no distance can be measured. "
      + "Type the distance below to continue, and report this to IT.",
    status: 503,
  };
}

/** Google returned no driving route for these coordinates. */
export function noDrivingRouteFailure(params: {
  destinationIsRegion: boolean;
  destinationLabel: string | null;
  destinationLat: number;
  destinationLng: number;
}): DistanceFailure {
  const label = params.destinationLabel?.trim() || null;
  const coordinates = `${formatCoordinate(params.destinationLat)}, ${formatCoordinate(params.destinationLng)}`;

  if (params.destinationIsRegion) {
    return {
      error: "route_not_found",
      message:
        `${label ?? "The selected destination"} is a region, not a place. Google measures to the `
        + `region's map centre (${coordinates}), which sits in open desert with no road, so there `
        + "is no driving route. Pick a city or an exact location — or type the distance below.",
      status: 422,
    };
  }

  return {
    error: "route_not_found",
    message:
      `Google has no driving route to ${label ? `${label} (${coordinates})` : coordinates}. `
      + "That point is off-road — a map centre, desert or water. Pick a nearby city or an exact "
      + "address — or type the distance below.",
    status: 422,
  };
}
