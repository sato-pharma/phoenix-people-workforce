import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { requeueExhaustedDurableEmail } from "@/lib/notifications/durable-email";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SEND AGAIN — an approval email that used every outbox retry goes back in the queue (REC-048).
 * It sends nothing here: the drain sends it on its next run with the stored input, through the same
 * sender. The permission is asserted before the domain call, which asserts it again before it reads
 * or writes anything.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "admin", "update");
    const { id } = await params;
    const requeued = await requeueExhaustedDurableEmail(access, id);
    return NextResponse.json({ data: requeued, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Unable to send this email again.");
    return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
  }
}
