import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, toApiError } from "@/lib/http/api-errors";
import { getMarketingSalesEvidence } from "@/lib/marketing-requests/sales-evidence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Historical sales evidence for a request's customer — read-only, for the SFE validation step. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const access = await resolveAccessContext(request);
    return NextResponse.json(await getMarketingSalesEvidence(id, access));
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    const apiError = toApiError(error, "Unable to load sales evidence for this request.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
