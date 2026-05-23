import { NextResponse } from "next/server";

import { assertAdminManagerExpenseAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertAdminManagerExpenseAccess(access);

    const { searchParams } = new URL(request.url);
    const input = (
      searchParams.get("q")?.trim() ??
      searchParams.get("input")?.trim() ??
      ""
    ).trim();
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

    const response = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
      body: JSON.stringify({
        input,
        languageCode: "ar",
        ...(sessiontoken ? { sessionToken: sessiontoken } : {}),
      }),
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text",
      },
      method: "POST",
    });

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      throw new Error(
        `Google Places Autocomplete failed with ${response.status}${details ? `: ${details.slice(0, 240)}` : ""}.`,
      );
    }

    const payload = (await response.json()) as {
      error?: {
        message?: string;
      };
      suggestions?: Array<{
        placePrediction?: {
          placeId?: string;
          text?: {
            text?: string;
          };
        };
      }>;
    };

    if (payload.error) {
      return NextResponse.json(
        {
          error: "places_service_error",
          message: payload.error.message ?? "Google Places autocomplete failed.",
        },
        { status: 502 },
      );
    }

    const predictions = (payload.suggestions ?? [])
      .map((entry) => entry.placePrediction)
      .filter(
        (prediction): prediction is { placeId: string; text: { text: string } } =>
          prediction?.placeId != null && prediction.text?.text != null,
      )
      .map((prediction) => ({
        description: prediction.text!.text!,
        placeId: prediction.placeId!,
      }));

    if (!predictions.length) {
      return NextResponse.json(
        { predictions: [] },
      );
    }

    return NextResponse.json({ predictions });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Places autocomplete failed.";
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "places_autocomplete_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
