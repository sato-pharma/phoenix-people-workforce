import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { listRecentNotificationSends } from "@/lib/notifications/confidence-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const limitParam = Number(url.searchParams.get("limit"));
    const limit = Number.isInteger(limitParam) && limitParam > 0 ? limitParam : undefined;
    const data = await listRecentNotificationSends(access, { limit });
    return NextResponse.json({ data, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Unable to load recent automated sends.");
    return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
  }
}
