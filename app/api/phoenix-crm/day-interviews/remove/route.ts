import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { removeDayInterview } from "@/lib/phoenix-crm/server/interview-cvs";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = remove one interview added by hand to TODAY's Interviews day, with its CV. A booked one is the
// hiring calendar's to change, so it is never removed here.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as Parameters<typeof removeDayInterview>[1];
    const removed = await removeDayInterview(viewer, body);
    return NextResponse.json({ removed, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not remove the interview.");
  }
}
