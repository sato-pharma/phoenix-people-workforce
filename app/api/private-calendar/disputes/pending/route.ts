import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { listPendingPrivateCalendarDataDisputes } from "@/lib/private-calendar/disputes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const disputes = await listPendingPrivateCalendarDataDisputes(access);
    return NextResponse.json({ data: disputes, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Unable to load pending disputes.");
    return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
  }
}
