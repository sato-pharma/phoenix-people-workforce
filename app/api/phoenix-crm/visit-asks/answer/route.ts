import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { answerVisitAsk } from "@/lib/phoenix-crm/server/visit-asks";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = the person asked accepts a visit ask with a day, or declines it (owner, 2026-10-02).
//
// 🔴 `read`, NOT `approve`, ON PURPOSE. A product manager — and the Marketing Manager, whom CNS reps may
// ask (the owner's CNS rule, 2026-10-02) — holds phoenix_crm `read` and nothing else —
// `create`, `update` and `approve` are what the module turns into entering visits and deciding a
// territory's requests — so `read` is the narrowest gate one that serves every person asked. Gate two
// is IDENTITY, read from the ask's own row inside the service (`assertVisitAskAnswerer`): only the
// person recorded as asked answers it, never somebody named in this body, and in the test world the
// Super Admin or a test login working as that person. The registry declares it the same way, audited
// as a mutation.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const inbox = await answerVisitAsk(viewer, body);
    return NextResponse.json({ inbox, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the answer.");
  }
}
