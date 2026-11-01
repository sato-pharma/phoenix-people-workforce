import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertPharmacySearchAccess } from "@/lib/pharmacy-search/access";
import { pharmacySearchApiError } from "@/lib/pharmacy-search/api-error";
import { loadExternalPharmacyProfile } from "@/lib/pharmacy-search/external";
import { saveDiscoveredPharmacy } from "@/lib/pharmacy-search/save";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_NOTES_LENGTH = 1000;

/**
 * Save a Google-discovered pharmacy into the discovery register.
 *
 * The body carries a place id and a note — NOT a profile. The profile is rebuilt server-side from
 * that id, so what gets written is what Google and our own brick centroids actually say, not
 * whatever a caller chose to post. A forged brick would otherwise land in the register looking
 * exactly like a derived one.
 */
export async function POST(request: Request) {
  try {
    // The only write in this feature, and it spends a Google Places call on the way. Same-origin
    // first, before any work is done on behalf of a request that may not be ours.
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPharmacySearchAccess(access);

    const body = (await request.json().catch(() => null)) as
      | { notes?: unknown; placeId?: unknown }
      | null;

    const placeId = typeof body?.placeId === "string" ? body.placeId.trim() : "";
    if (!placeId) {
      return NextResponse.json(
        { error: "bad_request", message: "A Google place id is required to save a discovery." },
        { status: 400 },
      );
    }

    const notes = typeof body?.notes === "string" ? body.notes.slice(0, MAX_NOTES_LENGTH) : null;
    const profile = await loadExternalPharmacyProfile({ includeGoogleHospitals: false, placeId, viewer: access });

    return NextResponse.json(await saveDiscoveredPharmacy({ access, notes, profile }));
  } catch (error) {
    const { code, message, status } = pharmacySearchApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}
