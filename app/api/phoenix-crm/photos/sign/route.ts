import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { signPhotoPaths } from "@/lib/phoenix-crm/server/photos";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = short-lived display links for a batch of clinic photos. A read, sent as a POST because the
// batch of paths does not belong in a URL; any path outside the viewer's territories refuses the whole
// batch.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const paths = body && typeof body === "object" ? (body as Record<string, unknown>).paths : null;
    const urls = await signPhotoPaths(viewer, paths);
    return NextResponse.json({ urls, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the photos.");
  }
}
