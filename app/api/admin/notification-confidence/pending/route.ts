import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { listPendingNotificationReviews } from "@/lib/notifications/confidence-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const data = await listPendingNotificationReviews(access);
    return NextResponse.json({ data, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Unable to load the pending-review queue.");
    return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
  }
}
