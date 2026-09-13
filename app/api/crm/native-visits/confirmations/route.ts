import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { decideNativeVisitPartner, listMyNativeVisitConfirmations } from "@/lib/crm/native-visits/service";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown, fallback: string) {
  const apiError = toApiError(error, fallback);
  const status = isForbiddenError(error) ? 403 : apiError.status;
  return NextResponse.json(
    { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
    { status },
  );
}

// GET  = native visits naming the signed-in manager as accompanying, for reps beneath him.
// POST = he confirms or rejects ONE of them. Only the named partner can; the service checks it.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "crm_visit_entry", "approve");
    const rows = await listMyNativeVisitConfirmations(access);
    return NextResponse.json({ rows, success: true });
  } catch (error) {
    return failure(error, "Could not load the visits waiting for you.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "crm_visit_entry", "approve");
    const body = (await request.json()) as Record<string, unknown>;
    const result = await decideNativeVisitPartner(access, {
      partnerId: body.partnerId,
      decision: body.decision,
      note: body.note,
    });
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    return failure(error, "Could not record your answer.");
  }
}
