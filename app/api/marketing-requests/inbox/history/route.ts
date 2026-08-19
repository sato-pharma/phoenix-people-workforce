import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { getApproverDecidedRequests } from "@/lib/marketing-requests/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The History tab of the marketing approval inbox — requests that have already been answered.
 *
 * Sibling of `../route.ts` (the live inbox) and deliberately identical in shape: same auth trio,
 * same error mapping, and the scoping decision lives entirely in the service, not here. A route
 * that decided who sees what would put the security boundary in two places.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    return NextResponse.json(await getApproverDecidedRequests(access));
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Marketing approval history failed.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
