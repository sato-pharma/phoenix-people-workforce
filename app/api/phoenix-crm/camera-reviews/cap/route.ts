import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { saveCameraDailyCap } from "@/lib/phoenix-crm/server/camera-items";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = the Super Admin sets how many camera items a rep's Phoenix day records at once (owner, 20 Nov 2026: a tab
// "to control the cap", 3 to start). From the next one over it, an item waits on his camera page. His alone: the
// service asserts `canEnterMissedRecords` again.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "update");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const saved = await saveCameraDailyCap(viewer, body);
    return NextResponse.json({ saved, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the daily limit.");
  }
}
