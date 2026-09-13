import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { createNativeVisit, listMyNativeVisits } from "@/lib/crm/native-visits/service";
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

// GET  = the signed-in rep's own native visits (pilot). The rep is the session, never a parameter.
// POST = the rep saves one visit. A resend of the same submission id answers with the saved visit.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "crm_visit_entry", "read");
    const rows = await listMyNativeVisits(access);
    return NextResponse.json({ rows, success: true });
  } catch (error) {
    return failure(error, "Could not load your visits.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "crm_visit_entry", "create");
    const body = (await request.json()) as unknown;
    const result = await createNativeVisit(access, body);
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    return failure(error, "Could not save the visit.");
  }
}
