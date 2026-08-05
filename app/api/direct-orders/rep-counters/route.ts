import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getDirectOrderRepCounters } from "@/lib/direct-orders/rep-counters";
import { toApiError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-rep Direct Orders counters (spec E1).
 *
 * Read-only and derived — this endpoint computes, it never writes, so nobody's number can be edited
 * into a better one. Scope is decided inside the service: a Super Admin or CEO sees the company, a
 * manager sees their own reporting subtree, a rep sees themselves.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const result = await getDirectOrderRepCounters(access);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const apiError = toApiError(error, "Could not load the per-rep counters.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
