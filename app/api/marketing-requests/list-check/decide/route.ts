import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";
import { decideMarketingListCheck } from "@/lib/marketing-requests/crm-list-check";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A person's answer on an unsure row. The role is checked inside `decideMarketingListCheck` (SFE Manager
 * or Super Admin, owner, 2026-11-03), before anything is read, and the answer records who and when.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => null)) as { checkId?: unknown; decision?: unknown } | null;
    const checkId = typeof body?.checkId === "string" ? body.checkId.trim() : "";
    const decision = body?.decision;
    if (!checkId || (decision !== "same" && decision !== "not_same")) {
      throw validationError("Say which row and whether it is the same doctor.");
    }
    await decideMarketingListCheck(access, { checkId, decision });
    return NextResponse.json({ success: true });
  } catch (error) {
    const apiError = toApiError(error, "The answer could not be saved.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
