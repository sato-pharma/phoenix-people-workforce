import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { decideCameraItem } from "@/lib/phoenix-crm/server/camera-items";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = the Super Admin approves or rejects one Phoenix Camera item (owner, 20 Nov 2026: "leave the decision to
// the decision maker"). Approve records the visit through his "Record a missed visit" door, validates at the seal's
// place or adds the new customer; Reject archives it and takes back what was recorded at once. His alone: the
// service asserts `canEnterMissedRecords` again, so nothing on the screen decides who may.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "update");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const decided = await decideCameraItem(viewer, body);
    return NextResponse.json({ decided, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the decision.");
  }
}
