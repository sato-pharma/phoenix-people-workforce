import { NextResponse } from "next/server";

import { canAccess } from "@/lib/auth/permissions";
import { isGuestFallbackAccess } from "@/lib/auth/page-access-guard";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolveClosingPublishDestination } from "@/lib/sales/closing-publish-destination";
import { trustedOriginForRedirect } from "@/lib/security/origins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The "Open Phoenix Workforce" link inside the closing-published email — one URL shared by every
// recipient (Super Admin, SFE Manager, CEO, District/Regional/National Manager, Product/Group
// Product Manager, Marketing Manager), so it cannot know in advance which page each person can
// even see. Resolved here, server-side, instead of left to client-side role routing (which sends
// most of those roles to a generic landing page, not the Matrix itself — see
// resolveLandingPathForRole).
//
// Not authenticated -> /login (same as every other page in the app; this route adds no new
// "return to this page after login" behavior, matching existing convention).
//
// WHICH page each role gets is resolveClosingPublishDestination's rule, not this handler's: it
// drifted out of step with the Closing Matrix page's own role guard once — the CEO's link could
// not reach the page he had asked for by name — and the module beside it carries that account and
// the test that now ties the two together. This handler stays what it always was: redirect-only,
// never a hard 403, so a stale or mis-scoped click degrades to the clicker's own landing page
// rather than an error page.
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  const url = new URL(request.url);
  const line = url.searchParams.get("line")?.trim() ?? "";
  const period = url.searchParams.get("period")?.trim() ?? "";

  const destination = isGuestFallbackAccess(access)
    ? "/login"
    : resolveClosingPublishDestination({
        viewer: access,
        // The same sales:read boundary the admin and portal Closing pages themselves enforce. Asked
        // once, and never for a guest — who is already on their way to /login above.
        canReadSales: await canAccess(access, "sales", "read"),
        line,
        period,
      });

  // The PUBLIC origin, never `request.url`'s: behind Railway's proxy that is the container's own
  // bind address, so every click on this email link landed on https://0.0.0.0:8080/… and the
  // browser gave up with no answer (System Audit, 29 Oct 2026). tests/redirect-public-origin.test.ts.
  return NextResponse.redirect(new URL(destination, trustedOriginForRedirect(request)));
}
