import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertOutstationAdminAccess(access, "approve");

    const { searchParams } = new URL(request.url);
    const input = searchParams.get("input")?.trim() ?? "";
    const sessiontoken = searchParams.get("sessiontoken") ?? "";

    if (!input) {
      return NextResponse.json({ predictions: [] });
    }

    const key = process.env.GOOGLE_MAPS_SERVER_KEY ?? "";
    if (!key) {
      return NextResponse.json(
        { error: "maps_unavailable", message: "Google Maps is not configured on this server." },
        { status: 503 },
      );
    }

    // Places API (New). The legacy Places API is no longer enabled for this
    // project, so we call the v1 autocomplete endpoint.
    const response = await fetch(
      "https://places.googleapis.com/v1/places:autocomplete",
      {
        body: JSON.stringify({
          input,
          languageCode: "ar",
          ...(sessiontoken ? { sessionToken: sessiontoken } : {}),
        }),
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
        },
        method: "POST",
      },
    );
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

    const predictions = (payload.suggestions ?? [])
      .map((suggestion) => suggestion.placePrediction)
      .filter(
        (prediction): prediction is { placeId: string; text: { text: string } } =>
          Boolean(prediction?.placeId && prediction?.text?.text),
      )
      .map((prediction) => ({
        description: prediction.text.text,
        placeId: prediction.placeId,
      }));

    return NextResponse.json({ predictions });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Places autocomplete failed.";
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "places_autocomplete_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
