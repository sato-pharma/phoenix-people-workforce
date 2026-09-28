import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import {
  fetchPlacePredictions,
  isPlacesNotConfiguredError,
} from "@/lib/outstation/places-autocomplete";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Destination suggestions for someone REVIEWING or creating an expense on another's behalf.
 *
 * The Google call moved to `@/lib/outstation/places-autocomplete` on 2026-09-28 so this route and
 * the rep-facing one at `app/api/outstation/places-autocomplete` cannot drift on the region lock,
 * the language or the prediction mapping — a divergence there would produce different `to_label`
 * text for the same place depending on who picked it. This route keeps its own, stricter gate.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertOutstationAdminAccess(access, "approve");

    const { searchParams } = new URL(request.url);
    const predictions = await fetchPlacePredictions(
      searchParams.get("input") ?? "",
      searchParams.get("sessiontoken"),
    );

    return NextResponse.json({ predictions });
  } catch (error) {
    if (isPlacesNotConfiguredError(error)) {
      return NextResponse.json(
        { error: "maps_unavailable", message: error.message },
        { status: 503 },
      );
    }

    const message = clientSafeErrorMessage(error, "Places autocomplete failed.");
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "places_autocomplete_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
