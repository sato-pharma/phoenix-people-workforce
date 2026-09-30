import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { movePlace, retirePlace } from "@/lib/phoenix-crm/server/place-move";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = move a validated place to one of its own readings or to coordinates from a map, with a written
// reason — or remove one of a customer's places. The Super Admin and the SFE Manager only (owner,
// 2026-09-29: "the location is fixed forever, only the system administrator changes it"); the service
// refuses everyone else before anything is read.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as { action?: unknown } | null;
    if (body?.action === "retire") {
      const place = await retirePlace(viewer, body);
      return NextResponse.json({ place, success: true });
    }
    const moved = await movePlace(viewer, body);
    return NextResponse.json({ moved, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not move the place.");
  }
}
