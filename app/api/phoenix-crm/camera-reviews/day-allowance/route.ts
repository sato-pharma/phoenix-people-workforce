import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { saveCameraDayAllowance } from "@/lib/phoenix-crm/server/camera-items";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = the Super Admin raises one rep's camera visits for one Phoenix day, once the manager's approval is in by
// email (owner, 21 Nov 2026: "U ARE ALLOWED 3 A DAYS IF MORE NEEDED WE NEED APPROVAL FROM MANAGERS VIA EMAIL AND
// SYSTEM ADMIN WILL UPDATE IT FOR THIS DAY ONLY"). The approval is written beside it. His alone: the service asserts
// `canEnterMissedRecords` again.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "update");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const saved = await saveCameraDayAllowance(viewer, body);
    return NextResponse.json({ saved, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the day's allowance.");
  }
}
