import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { downloadVisitRecording } from "@/lib/phoenix-crm/server/visit-recordings";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = a ten-minute link that saves one recording as a file named after the rep, the customer and the
// day. The Super Admin's alone (owner, 2026-10-16: "admin can download and delete anytime").
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "update");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const download = await downloadVisitRecording(viewer, body);
    return NextResponse.json({ download, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not prepare the download.");
  }
}
