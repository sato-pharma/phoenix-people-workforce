import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { readVisitResendStatus, recordVisitResend } from "@/lib/phoenix-crm/server/visit-resend-log";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  = asked only while a phone is holding a visit: the off switch, the server's clock, and which of the
//        ids it names stand as this person's own visits.
// POST = how one held visit ended, for the count nobody could read before (server/visit-resend-log.ts).
//        🔴 ALWAYS 204. It is evidence about work already done, so nothing here can fail a rep, and a phone
//        has no reason to send it twice.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const resend = await readVisitResendStatus(viewer, searchOf(request).get("ids"));
    return NextResponse.json({ resend, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not check the waiting visits.");
  }
}

export async function POST(request: Request) {
  const csrf = assertSameOriginMutation(request);
  if (csrf) return csrf;
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    // Past a rep's whole bad day. Over it the report is dropped like any other that could not be filed.
    await assertApiRateLimit({ identifier: String(viewer.hrId ?? ""), limit: 200, scope: "phoenix-crm:visit-resend-report", windowMs: 60 * 60 * 1000 });
    await recordVisitResend(viewer, (await request.json()) as unknown);
  } catch {
    // The same answer as everything else here. A report that could not be filed costs nobody anything.
  }
  return new Response(null, { status: 204 });
}
