import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertPharmacySearchAccess } from "@/lib/pharmacy-search/access";
import { pharmacySearchApiError } from "@/lib/pharmacy-search/api-error";
import { DEFAULT_RADIUS_KM } from "@/lib/pharmacy-search/nearby";
import { loadPharmacyProfile } from "@/lib/pharmacy-search/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Widest radius a caller may ask for. Beyond this "nearby" stops meaning anything useful. */
const MAX_RADIUS_KM = 10;

function parseRadius(raw: string | null): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_RADIUS_KM;
  return Math.min(MAX_RADIUS_KM, value);
}

/** The full profile for one pharmacy already in the database. Read-only. */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPharmacySearchAccess(access);

    const params = new URL(request.url).searchParams;
    return NextResponse.json(
      await loadPharmacyProfile(
        {
          customerCode: params.get("code"),
          distributorCode: params.get("distributor"),
          name: params.get("name"),
          phoenixPharmacyCode: params.get("phoenix"),
          radiusKm: parseRadius(params.get("radius")),
        },
        access,
      ),
    );
  } catch (error) {
    const { code, message, status } = pharmacySearchApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}
