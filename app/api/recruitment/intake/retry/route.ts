import { NextResponse } from "next/server";

import { assertSameOriginMutation, readJsonObject, requireRecruitmentAccess, recruitmentApiError, str } from "@/app/api/recruitment/_lib/http";
import { requeueInbound } from "@/lib/recruitment/inbound/intake-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Admin "retry" for a dead-lettered inbound CV: re-queues it with a fresh attempt budget so the
// worker re-processes it on the next tick. Requires the recruitment update grant.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    await requireRecruitmentAccess(request, "recruitment", "update");
    const id = str((await readJsonObject(request)).id);
    if (!id) {
      return NextResponse.json({ error: "validation", message: "A queue row id is required.", success: false }, { status: 400 });
    }
    const requeued = await requeueInbound(id);
    if (!requeued) {
      return NextResponse.json(
        { error: "not_found", message: "No dead-lettered intake row with that id (only dead rows can be retried).", success: false },
        { status: 404 },
      );
    }
    return NextResponse.json({ requeued: true, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to re-queue the inbound CV.");
  }
}
