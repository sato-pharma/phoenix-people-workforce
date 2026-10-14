import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  closeOrphanedVacationRequest,
  isVacationSchemaMissing,
  vacationErrorMessage,
} from "@/lib/vacation/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Close one returned vacation request whose employee has left the company.
 *
 * A return is a question addressed to the ONE employee who submitted the request, and nothing
 * expires a `returned` request — so once that person resigns it can never be answered. This route
 * decides nothing and chooses nothing: Super Admin only, the registry transition, the `returned`
 * status check, the mandatory reason and the guard that REFUSES while the employee can still log in
 * all live in `closeOrphanedVacationRequest`. That last one is what separates this from a delete
 * button.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { reason?: string };
    const result = await closeOrphanedVacationRequest(access, {
      reason: String(body.reason ?? ""),
      requestId: id,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const message = vacationErrorMessage(error) || "Could not close this request.";
    if (isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:")) {
      return NextResponse.json({ error: "forbidden", message, success: false }, { status: 403 });
    }
    if (isVacationSchemaMissing(error)) {
      return NextResponse.json({ error: "vacation_schema_missing", message, success: false }, { status: 409 });
    }
    return NextResponse.json({ error: "vacation_close_orphaned_failed", message, success: false }, { status: 400 });
  }
}
