import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { getPortalHomeSnapshot } from "@/lib/employee-portal/home-snapshot";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { logPortalFailure } from "@/lib/observability/portal-logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The employee portal home screen, as JSON, for the native app.
 *
 * This route deliberately contains NO business logic. It calls `getPortalHomeSnapshot(access)` —
 * the exact function `app/employee-portals/page.tsx` renders from — so the app and the web portal
 * can never disagree about a number, and no payroll, sales or leave rule is re-implemented on the
 * client. That is the pattern every subsequent native read endpoint should follow: resolve access,
 * assert the same permission the page asserts, hand back what the domain service returned.
 *
 * It exists at all because the web portal never needed a read API. Its pages are server components
 * that call `src/lib/<domain>/` directly, so there was nothing for a non-browser client to call.
 *
 * ONE FIELD IS DROPPED ON PURPOSE. `PortalHomeSnapshot.latestPayslip` carries a net salary and a
 * month label, and the standing owner rule is that no payslip appears on any overview or landing
 * page for any role — not the amount, not even the month. Filtering it here rather than remembering
 * not to render it means a future home-screen widget cannot leak it by accident: the data is simply
 * not on the device. The portal's Payslips screen fetches its own data and is unaffected.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_profile", "read");

    const snapshot = await getPortalHomeSnapshot(access);
    const { latestPayslip: _latestPayslip, ...portalHome } = snapshot;

    return NextResponse.json({
      data: {
        ...portalHome,
        navigationMode: resolveNavigationMode(access),
      },
      success: true,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    logPortalFailure({ route: "/api/employee-portals/home", module: "home-snapshot" }, error);
    const message = clientSafeErrorMessage(error, "Unable to load your portal home.");
    return NextResponse.json({ error: "portal_home_failed", message }, { status: 500 });
  }
}
