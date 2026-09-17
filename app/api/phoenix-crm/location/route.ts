import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { parseEvidenceLocationBody, resolveEvidenceLocation } from "@/lib/evidence/location-service";
import { validationError } from "@/lib/http/api-errors";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = the place stamp burned into a live photo: the street address, the Phoenix brick, area and
// region, and the coordinates — the same wording as every other Phoenix evidence photo. Same gate as
// taking the photo (`create`); it reveals only the geography of a point the caller already holds, and
// writes nothing.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const body = (await request.json()) as unknown;
    const parsed = parseEvidenceLocationBody((body && typeof body === "object" ? body : {}) as Record<string, unknown>);
    if (!parsed) throw validationError("Your location was not captured. Capture it again.");
    const location = await resolveEvidenceLocation(parsed);
    return NextResponse.json({ location, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not read the place for this location.");
  }
}
