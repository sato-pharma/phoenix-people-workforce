import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { confirmDirectOrderCleanup } from "@/lib/direct-orders/service";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Apply the duplicate cleanup an SFE Manager reviewed and confirmed (owner rule 5, 2026-08-09).
 *
 * The body is the reviewer's EDITED plan, not the plan the server proposed — they may have chosen a
 * different survivor, dropped a merge, or excluded one request from a duplicate set. The service
 * re-derives every precondition against live data before writing, so a stale or hand-altered body
 * cannot make it do something the rules would refuse.
 *
 * Zero authorization logic here: confirmDirectOrderCleanup asserts Super Admin / SFE Manager, and
 * each cancellation additionally passes the workflow registry's own gate.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as {
      merges?: Array<{ survivorId?: string; mergedIds?: string[] }>;
      duplicates?: Array<{ keeperId?: string; duplicateIds?: string[] }>;
      repairPharmacyIds?: string[];
      releasePharmacyIds?: string[];
      reason?: string;
    };

    const result = await confirmDirectOrderCleanup(access, {
      merges: (body.merges ?? [])
        .map((merge) => ({ survivorId: String(merge.survivorId ?? ""), mergedIds: (merge.mergedIds ?? []).map(String) }))
        .filter((merge) => merge.survivorId && merge.mergedIds.length > 0),
      duplicates: (body.duplicates ?? [])
        .map((group) => ({
          keeperId: String(group.keeperId ?? ""),
          duplicateIds: (group.duplicateIds ?? []).map(String),
        }))
        .filter((group) => group.keeperId && group.duplicateIds.length > 0),
      repairPharmacyIds: (body.repairPharmacyIds ?? []).map(String).filter(Boolean),
      releasePharmacyIds: (body.releasePharmacyIds ?? []).map(String).filter(Boolean),
      reason: String(body.reason ?? ""),
    });

    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not apply the cleanup.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
