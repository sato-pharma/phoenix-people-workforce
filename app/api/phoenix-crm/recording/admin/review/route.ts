import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { reviewRecordedVisit } from "@/lib/phoenix-crm/server/visit-recordings";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = approve or refuse one recorded visit. A recorded visit, of any type, waits for the
// Administrator first and counts in nothing until he approves it (owner, 2026-10-16). His alone: the
// service asserts `canAdminister` again, so nothing on the screen decides who may.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const reviewed = await reviewRecordedVisit(viewer, body);
    return NextResponse.json({ reviewed, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the decision.");
  }
}
