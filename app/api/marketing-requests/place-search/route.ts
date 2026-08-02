import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { googlePlaceDetails, googlePlacesAutocomplete, hasGoogleServerKey } from "@/lib/google-maps/server";
import { toApiError } from "@/lib/http/api-errors";
import { assertMarketingOnBehalfAccess } from "@/lib/marketing-requests/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Map search for the Super Admin "validate on behalf of an employee" flow: type an address and pick
 * the nearest point, the way the Google Maps box works on a phone.
 *
 * `?input=` returns ranked suggestions, `?placeId=` resolves the chosen one to coordinates plus the
 * area/governorate the validation records store. Gated to the same actors allowed to validate on
 * behalf — this is the only surface that can place a customer without standing in front of it, so
 * it must not be reachable by a field role that is supposed to capture live GPS.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    assertMarketingOnBehalfAccess(access);

    if (!hasGoogleServerKey()) {
      return NextResponse.json(
        {
          error: "google_maps_key_missing",
          message: "Map search is unavailable because the Google Maps server key is not configured.",
        },
        { status: 503 },
      );
    }

    const url = new URL(request.url);
    const placeId = (url.searchParams.get("placeId") ?? "").trim();

    if (placeId) {
      const location = await googlePlaceDetails(placeId);
      if (!location) {
        return NextResponse.json(
          { error: "place_not_found", message: "That place could not be resolved to a location." },
          { status: 404 },
        );
      }
      return NextResponse.json({ location });
    }

    const input = (url.searchParams.get("input") ?? "").trim();
    // Below two characters Google returns noise, and every keystroke is a billed call.
    if (input.length < 2) {
      return NextResponse.json({ suggestions: [] });
    }

    return NextResponse.json({ suggestions: await googlePlacesAutocomplete(input) });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: error instanceof Error ? error.message : "Forbidden." },
        { status: 403 },
      );
    }

    const apiError = toApiError(error, "Map search failed.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
