import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { sfeBringBack } from "@/lib/phoenix-crm/server/list";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = the SFE Manager brings a customer back from the Archive himself (owner, 2026-09-29: the SFE
// manages the Archive). Filed and decided as a bring-back request at the SFE step, so the history reads
// the same whoever moved him. The SFE Manager only (the Super Admin in test mode).
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const restored = await sfeBringBack(viewer, body);
    return NextResponse.json({ restored, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not bring the customer back.");
  }
}
