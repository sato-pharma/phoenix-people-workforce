import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { listFeedbackTasks } from "@/lib/probation/intelligence/feedback-workflow";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Open probation feedback tasks for the caller (their own validated DV-Days awaiting feedback;
// probation administrators see all). Coarse gate is probation:read — the per-task ownership
// boundary is enforced inside the service.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "probation", "read");
    const tasks = await listFeedbackTasks(access);
    return NextResponse.json({ tasks }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    return NextResponse.json({ error: clientSafeErrorMessage(error, "The feedback tasks could not be read.") }, { status: 500 });
  }
}
