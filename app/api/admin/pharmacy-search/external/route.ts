import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertPharmacySearchAccess } from "@/lib/pharmacy-search/access";
import { pharmacySearchApiError } from "@/lib/pharmacy-search/api-error";
import { findExternalCandidates, loadExternalPharmacyProfile } from "@/lib/pharmacy-search/external";
import { DEFAULT_RADIUS_KM } from "@/lib/pharmacy-search/nearby";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RADIUS_KM = 10;

function parseRadius(raw: string | null): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_RADIUS_KM;
  return Math.min(MAX_RADIUS_KM, value);
}

/**
 * The Google fallback, in two steps so no billed call happens without a human asking for it:
 *
 * - `?q=` returns ranked candidates to choose from (one autocomplete call).
 * - `?placeId=` builds the full profile for the chosen one (one details call + one nearby call).
 *
 * Read-only. Saving what this returns is a separate, explicit POST.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPharmacySearchAccess(access);

    const params = new URL(request.url).searchParams;
    const placeId = params.get("placeId")?.trim();

    if (placeId) {
      return NextResponse.json(
        await loadExternalPharmacyProfile({
          placeId,
          radiusKm: parseRadius(params.get("radius")),
          viewer: access,
        }),
      );
    }

    return NextResponse.json({ candidates: await findExternalCandidates(params.get("q") ?? "") });
  } catch (error) {
    const { code, message, status } = pharmacySearchApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}
