import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { requestRecordingSlot } from "@/lib/phoenix-crm/server/visit-recordings";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = a one-time upload slot in the private recordings bucket, for the visit recording the Super Admin
// requires of the reps he chooses (owner, 2026-10-16). Issued to the territory's own rep only, when the
// recording has stopped; the save that follows claims it and refuses any path the server did not issue.
// Like the voice note's slot, the answer carries no issue time: a recording dates nothing.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const slot = await requestRecordingSlot(viewer, body);
    return NextResponse.json({ slot, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not prepare the recording upload.");
  }
}
