import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { listExplanationGroupsAwaitingViewer } from "@/lib/dispute-center/explanations";
import { toApiError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// What is waiting for the signed-in person to confirm — only explanations that name HIM.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "read");
    const groups = await listExplanationGroupsAwaitingViewer(access);
    return NextResponse.json({ data: groups, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Unable to load what is waiting for your confirmation.");
    return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
  }
}
