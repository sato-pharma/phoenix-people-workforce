import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { loadAdminPhotoAsks, sendAdminPhotoReading } from "@/lib/phoenix-crm/server/admin-photo";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The rep's half of the Super Admin's photo validation (owner, 2026-11-20): the customers whose location he is
// asked to capture, and the Capture-location reading he sends. `territoryForValidation` inside the service is
// the gate on WHO — the territory's rep or one of its managers, exactly as for his own validation. Golden rule
// #1: the answer names the customer and whether the reading was sent, nothing else.

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const asks = await loadAdminPhotoAsks(viewer, search.get("seatId"), search.get("test"));
    return NextResponse.json({ asks, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not read the locations to capture.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const asks = await sendAdminPhotoReading(viewer, body);
    return NextResponse.json({ asks, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not send the location.");
  }
}
