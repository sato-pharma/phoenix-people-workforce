// The gate the three held-changes sheet routes share, so the export, the preview and the apply cannot
// drift apart on who may call them. Same posture as the decide route beside them: `sales:import`, and
// then Super Admin only — releasing a hold is an owner decision by construction.

import { NextResponse } from "next/server";

import { resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { hrIdForStorage } from "@/lib/hr-id";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export type GuardOwnerAccess = Awaited<ReturnType<typeof resolveAccessContext>>;

/**
 * Super Admin only, server-side, before anything is read or written. The ROUTE resolves the access
 * context and asks `assertPermission` itself (the access-registry coverage test reads each route's
 * own source for both); this is the owner half they share.
 */
export function assertGuardSheetOwner(access: GuardOwnerAccess): void {
  if (access.role !== "Super Admin" && access.scope !== "system") {
    const forbidden = new Error("Forbidden.") as Error & { status?: number };
    forbidden.status = 403;
    throw forbidden;
  }
}

export function guardSheetActor(access: GuardOwnerAccess): string {
  return hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
}

export function guardSheetFailure(error: unknown, fallback: string): NextResponse {
  if (isApiRateLimitError(error)) {
    return NextResponse.json(
      { error: "rate_limited", message: error.message, success: false },
      { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
    );
  }
  if (isForbiddenError(error) || (error as { status?: unknown } | null)?.status === 403) {
    return NextResponse.json({ error: "Forbidden.", success: false }, { status: 403 });
  }
  // A refusal this feature raised on purpose (a sheet that is not the right one, a page that no
  // longer matches its preview) carries its own 4xx and its own words.
  const status = (error as { status?: unknown } | null)?.status;
  if (error instanceof Error && typeof status === "number" && status >= 400 && status < 500) {
    return NextResponse.json({ error: error.message, success: false }, { status });
  }
  // A refusal the database wrote on purpose (a switched-off brick, say) is the reason, not "failed".
  if ((error as { code?: unknown } | null)?.code === "P0001") {
    return NextResponse.json({ error: clientSafeErrorMessage(error, fallback), success: false }, { status: 409 });
  }
  return NextResponse.json({ error: clientSafeErrorMessage(error, fallback), success: false }, { status: 500 });
}
