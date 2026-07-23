import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { approveHeldNotification } from "@/lib/notifications/confidence-gate";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { id } = await params;
    const access = await resolveAccessContext(request);
    const body = await request.json().catch(() => ({}));
    await approveHeldNotification(access, id, typeof body.note === "string" ? body.note : undefined);
    return NextResponse.json({ success: true });
  } catch (error) {
    const apiError = toApiError(error, "Unable to approve this notification.");
    return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
  }
}
