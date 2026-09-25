import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { requestVoiceSlot } from "@/lib/phoenix-crm/server/voice-notes";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = a one-time upload slot in the private voice bucket, issued to whoever may enter this
// territory's visits. The phone PUTs the recording straight to the slot; a later save refuses any path
// the server did not issue to that person. Unlike the photo slot, the answer carries no issue time:
// audio dates nothing, and a timestamp in the payload is the first step towards it dating something.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const slot = await requestVoiceSlot(viewer, body);
    return NextResponse.json({ slot, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not prepare the voice note upload.");
  }
}
