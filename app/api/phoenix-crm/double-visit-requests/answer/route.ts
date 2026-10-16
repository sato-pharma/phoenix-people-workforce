import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { answerDoubleVisitRequest } from "@/lib/phoenix-crm/server/double-visit-requests";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = a person asked for a double visit accepts one of the rep's days, or declines (owner, 2026-10-16).
//
// 🔴 `read`, NOT `approve`, ON PURPOSE — the same reason as the older visit ask: a product manager and the
// Marketing Manager hold phoenix_crm `read` and nothing else, so `read` is the narrowest gate that serves
// every person a rep can ask. Gate two is IDENTITY, read from the request's own row inside the service
// (`assertDoubleVisitAnswerer`): only a person recorded as asked answers, never somebody named in this
// body, and the Super Admin answers nothing real.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const report = await answerDoubleVisitRequest(viewer, body);
    return NextResponse.json({ success: true, report });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the answer.");
  }
}
