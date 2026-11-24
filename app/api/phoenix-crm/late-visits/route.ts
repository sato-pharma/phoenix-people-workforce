import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { fileLateVisit } from "@/lib/phoenix-crm/server/late-visits";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A phone files one of its own held visits that missed its two hours or the 02:00 close (owner, 24 Nov 2026: "never
// any visit to be lost from either a rep or from the manager"). `create`, the same gate as logging a visit; the
// person comes from the session, never the body. The Super Admin decides it on `late-visits/decide`.
// server/late-visits.ts holds the rules.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const body = (await request.json()) as Record<string, unknown>;
    const viewer = await resolvePhoenixCrmViewer(access);
    // A whole day of held visits is 40 at most on one phone; past this the phone simply keeps them.
    await assertApiRateLimit({ identifier: String(viewer.hrId ?? ""), limit: 100, scope: "phoenix-crm:late-visits", windowMs: 60 * 60 * 1000 });
    const filed = await fileLateVisit(viewer, body.visit);
    return NextResponse.json({ filed, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save this visit.");
  }
}
