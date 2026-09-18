import { NextResponse } from "next/server";

import { unauthenticatedSessionResponse } from "@/lib/auth/api-session-response";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { getOwnOutstationRequestsAwaitingDeparturePhoto } from "@/lib/outstation/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The caller's own outstation requests still owing a DEPARTURE photo, as JSON, for the native app.
 *
 * No business logic here. It calls `getOwnOutstationRequestsAwaitingDeparturePhoto(access)` — the
 * exact function the portal's expense dashboard renders its "Departure photo needed" card from — so
 * the app and the web portal can never disagree about which trip is waiting. Membership is decided
 * there, by the same resolver the payroll gate uses, and scoped to the caller by HR ID.
 *
 * NO PERMISSION ANSWERS AN EMPTY LIST, NEVER A 403. The native app reads any 401 or 403 as "this
 * session is over" and signs the employee out (`ApiError.isSessionExpired` in `mobile/src/lib/api.ts`),
 * so a 403 here would log out every employee who cannot file outstation expenses the moment their
 * home screen loaded. The capture this list leads to needs `outstation:create`
 * (`app/api/outstation/[id]/departure-photo/route.ts`), so a caller without it has, truthfully,
 * nothing to photograph. A caller with no session at all still gets 401 — that one IS over.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    // An unauthenticated caller resolves to an anonymous Employee, never to a null role, so the
    // empty-list answer below would otherwise reach it too — see api-session-response.ts.
    const unauthenticated = unauthenticatedSessionResponse(access);
    if (unauthenticated) return unauthenticated;

    if (!(await canAccess(access, "outstation", "create"))) {
      return NextResponse.json({ data: { requests: [] }, success: true });
    }

    const requests = await getOwnOutstationRequestsAwaitingDeparturePhoto(access);
    return NextResponse.json({ data: { requests }, success: true });
  } catch (error) {
    logPortalFailure({ module: "departure-photo-due", route: "/api/outstation/departure-photo-due" }, error);
    const message = clientSafeErrorMessage(error, "Unable to load the trips waiting on a departure photo.");
    return NextResponse.json({ error: "departure_photo_due_failed", message }, { status: 500 });
  }
}
