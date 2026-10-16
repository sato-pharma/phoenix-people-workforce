import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { parseEvidenceLocationBody, resolveEvidenceLocation } from "@/lib/evidence/location-service";
import { validationError } from "@/lib/http/api-errors";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One lookup per photo taken, and a save allows 90 photos an hour; a loop stops here, not at the map bill. */
const LOOKUPS_PER_HOUR = 120;

// POST = the place stamp burned into a live photo: the street address, the Phoenix brick, area and
// region, and the coordinates — the same wording as every other Phoenix evidence photo. Same gate as
// taking the photo (`create`); it reveals only the geography of a point the caller already holds, and
// writes nothing. Each lookup can be a paid street-address call, so it is limited per person; a refused
// lookup costs the photo nothing — the phone stamps the coordinates alone. Since 2026-10-16 a capture
// within ~11 m of one asked about in the last few hours is answered from memory instead of from Google
// (`memoizeReverseGeocode`), and the allowance still counts EVERY lookup, remembered or not, so who is
// refused and when is exactly what it was.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    // A test login is counted as itself, never against the allowance of the rep it mirrors.
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.testPersona ? access.loginId : access.hrId || access.loginId, request }),
      limit: LOOKUPS_PER_HOUR,
      scope: "phoenix_crm_location",
      windowMs: 60 * 60 * 1000,
    });
    const body = (await request.json()) as unknown;
    const parsed = parseEvidenceLocationBody((body && typeof body === "object" ? body : {}) as Record<string, unknown>);
    if (!parsed) throw validationError("Your location was not captured. Capture it again.");
    const location = await resolveEvidenceLocation(parsed);
    return NextResponse.json({ location, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not read the place for this location.");
  }
}
