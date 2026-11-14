import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { confirmMasterMatch, keepCodeAsDecided, listCodesAwaitingConfirmation } from "@/lib/marketing-requests/master-recheck";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Person-decided pharmacy codes the sales master now matches (REC-077). Gated in the service, Super Admin
 * only; the night never changes these, a person confirms or keeps each one.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    return NextResponse.json({ codes: await listCodesAwaitingConfirmation(access) });
  } catch (error) {
    const apiError = toApiError(error, "Could not read the codes awaiting confirmation.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json({ error: status === 403 ? "forbidden" : apiError.code, message: apiError.message }, { status });
  }
}

/** Confirm the master's shop for one code, or keep it as decided. One press, one code, one audit entry. */
export async function PATCH(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as { action?: unknown; codeId?: unknown };
    const codeId = String(body.codeId ?? "");
    if (body.action !== "confirm" && body.action !== "keep") {
      return NextResponse.json({ error: "invalid_request", message: "Say whether to confirm or keep the code.", success: false }, { status: 400 });
    }
    const codes = body.action === "confirm" ? await confirmMasterMatch(access, { codeId }) : await keepCodeAsDecided(access, { codeId });
    return NextResponse.json({ codes, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not change the code.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
