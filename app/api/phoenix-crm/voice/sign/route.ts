import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { signVoicePaths } from "@/lib/phoenix-crm/server/voice-notes";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = short-lived playback links for stored voice notes. A read, sent as a POST for the reason the
// photo route is: the paths do not belong in a URL. A path outside the viewer's territories refuses the
// whole batch, so a reader cannot probe for notes by asking for one at a time.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const paths = body && typeof body === "object" ? (body as Record<string, unknown>).paths : null;
    const urls = await signVoicePaths(viewer, paths);
    return NextResponse.json({ urls, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not open the voice note.");
  }
}
