// The Google Places autocomplete call, shared by the admin and medical-rep routes.
//
// Extracted 2026-09-28 when the medical rep manual expense path was given a destination picker.
// Before that the only caller was `app/api/admin/outstation/places-autocomplete`, which is gated
// on `assertOutstationAdminAccess(access, "approve")` — so the picker component could not be
// reused for a rep at all: it would 403 and render "Could not fetch suggestions".
//
// The two routes differ ONLY in who may call them. Keeping the Google call here means the region
// lock, the language, the v1 endpoint and the prediction mapping cannot drift apart between an
// admin's picker and a rep's — which is exactly the kind of divergence nobody notices until the
// two produce different `to_label` text for the same place.

import type { PlacesPrediction } from "@/lib/outstation/types";

/** Thrown when GOOGLE_MAPS_SERVER_KEY is absent. The routes turn this into a 503, not a 500. */
export class PlacesNotConfiguredError extends Error {
  constructor() {
    super("Google Maps is not configured on this server.");
    this.name = "PlacesNotConfiguredError";
  }
}

export function isPlacesNotConfiguredError(error: unknown): error is PlacesNotConfiguredError {
  return error instanceof PlacesNotConfiguredError;
}

/**
 * Egyptian place suggestions for `input`, or an empty list when there is nothing to ask about.
 *
 * `includedRegionCodes: ["eg"]` is load-bearing, not a nicety: without it "Baniseaf" — the
 * misspelling that prompted this work — can match a place on another continent, and this path
 * stores the chosen text verbatim as the trip's destination.
 */
export async function fetchPlacePredictions(
  input: string,
  sessionToken?: string | null,
): Promise<PlacesPrediction[]> {
  const query = input.trim();
  if (!query) return [];

  const key = process.env.GOOGLE_MAPS_SERVER_KEY ?? "";
  if (!key) throw new PlacesNotConfiguredError();

  // Places API (New). The legacy Places API is no longer enabled for this project, so we call
  // the v1 autocomplete endpoint.
  const response = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    body: JSON.stringify({
      includedRegionCodes: ["eg"],
      input: query,
      languageCode: "ar",
      ...(sessionToken ? { sessionToken } : {}),
    }),
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
    },
    method: "POST",
    // A type-ahead that has not answered in eight seconds is no longer useful to the person typing
    // (integration audit, 13 Nov 2026, ISS-011); the route's own catch turns the throw into its error answer.
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(
      `Google Places Autocomplete failed with ${response.status}${details ? `: ${details.slice(0, 240)}` : ""}.`,
    );
  }

  const payload = (await response.json()) as {
    suggestions?: Array<{
      placePrediction?: {
        placeId?: string;
        text?: { text?: string };
      };
    }>;
  };

  return (payload.suggestions ?? [])
    .map((suggestion) => suggestion.placePrediction)
    .filter(
      (prediction): prediction is { placeId: string; text: { text: string } } =>
        Boolean(prediction?.placeId && prediction?.text?.text),
    )
    .map((prediction) => ({
      description: prediction.text.text,
      placeId: prediction.placeId,
    }));
}
