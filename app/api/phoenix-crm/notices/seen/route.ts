import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isPreviewSession } from "@/lib/auth/preview-session-guard";
import { resolveAccessContext } from "@/lib/auth/server";
import { isPhoenixCrmModuleKey } from "@/lib/phoenix-crm/modules";
import { markPhoenixCrmModuleNoticesRead } from "@/lib/phoenix-crm/server/unread-notices";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { module } = the viewer has that Phoenix CRM module on his screen: mark the notices that open it
//        as read, for him alone, so the pulsing "new" badge clears (owner, 2026-10-08).
//
// It only ever writes the CALLER's own read state — the helper resolves his identity from the session
// and the body names a module, never a person or a notice — so there is no id to forge. Answers 204
// whatever happens: a badge that clears a visit late is not worth an error on a rep's screen.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    // A local preview is somebody looking AS this person, on a server whose .env.local is the PRODUCTION
    // database: the person has seen nothing, so their "new" badge must stay. Same reasoning as
    // /api/activity/track; 204 like every other answer here, because nothing on the page may change.
    if (isPreviewSession(access)) return new NextResponse(null, { status: 204 });
    await assertPermission(access, "phoenix_crm", "read");
    const body = (await request.json().catch(() => null)) as { module?: unknown } | null;
    const moduleKey = typeof body?.module === "string" ? body.module : null;
    if (isPhoenixCrmModuleKey(moduleKey)) await markPhoenixCrmModuleNoticesRead(access, moduleKey);
    return new NextResponse(null, { status: 204 });
  } catch {
    return new NextResponse(null, { status: 204 });
  }
}
