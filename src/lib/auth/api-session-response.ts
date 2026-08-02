import { NextResponse } from "next/server";

import type { AccessContext } from "@/lib/auth/permissions";

/**
 * Tells "you are not signed in" apart from "you are signed in but not allowed".
 *
 * API routes resolve their caller with `resolveAccessContext`, which does NOT throw when the
 * session cookie is missing, expired or rejected — it quietly returns the anonymous guest context.
 * Every permission check then fails (a guest is denied by `canAccess` and carries scope "none"),
 * `assertPermission` throws `Forbidden: ...`, and the route's catch renders that as a 403 with a
 * resource-specific "you do not have access to X" message.
 *
 * The result is that an ordinary expired session is reported as a permissions problem, which sends
 * whoever hit it hunting through roles for something that was never misconfigured. That happened in
 * production on 2026-08-02: a burst of "Session rejected: absolute expiry reached" surfaced in the
 * UI as "You do not have access to CRM visit workload".
 *
 * This CANNOT widen access. It only fires for `source === "guest"` — a caller who is already denied
 * every resource — and it returns a denial (401) rather than data. A signed-in caller who simply
 * lacks the permission gets `null` here and continues to the route's own 403, unchanged.
 */
export function unauthenticatedSessionResponse(
  access: Pick<AccessContext, "source">,
): NextResponse | null {
  if (access.source !== "guest") return null;

  return NextResponse.json(
    {
      error: "session_expired",
      message: "Your session has expired. Sign in again to continue.",
    },
    { status: 401 },
  );
}

/** True when the request carries no usable session, so the caller is anonymous. */
export function isUnauthenticatedAccess(access: Pick<AccessContext, "source">): boolean {
  return access.source === "guest";
}
