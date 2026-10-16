import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { signVisitRecording } from "@/lib/phoenix-crm/server/visit-recordings";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = a ten-minute playback link for one visit's recording. A read, sent as a POST on the voice note's
// own pattern. Only the Super Admin, an SFE manager and a manager above the territory may hear it; anyone
// else is answered as though the visit had no recording at all.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const visitId = body && typeof body === "object" ? (body as Record<string, unknown>).visitId : null;
    const recording = await signVisitRecording(viewer, visitId);
    return NextResponse.json({ recording, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not open the recording.");
  }
}
