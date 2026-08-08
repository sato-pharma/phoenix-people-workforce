import { NextResponse } from "next/server";

import { isGuestFallbackAccess } from "@/lib/auth/page-access-guard";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { canAccessPortalClosing } from "@/lib/sales/monthly-closing-portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The "Open Phoenix Workforce" link inside the closing-published email — one URL shared by every
// recipient (Super Admin, SFE Manager, CEO, District/Regional/National Manager, Product/Group
// Product Manager, Marketing Manager), so it cannot know in advance which page each person can
// even see. Resolves that here, server-side, instead of leaving it to client-side role routing
// (which sends most of those roles to a generic landing page, not the Matrix itself — see
// resolveLandingPathForRole).
//
// Not authenticated -> /login (same as every other page in the app; this route adds no new
// "return to this page after login" behavior, matching existing convention).
// Super Admin / system scope / SFE Manager -> the admin Closing Matrix, filtered to this line
// and period via query params (see app/(admin)/sales/monthly-closing/page.tsx searchParams).
// District/Regional/National Manager, Product/Group Product Manager -> their own portal Monthly
// Closing tab, which resolves their line automatically; only the period is passed through.
// Everyone else (CEO, Marketing Manager, or any role with no closing view) -> unchanged, their
// normal landing page. Granting the CEO a Matrix view is a real access-control decision this
// route does not make on its own.
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  const url = new URL(request.url);
  const line = url.searchParams.get("line")?.trim() ?? "";
  const period = url.searchParams.get("period")?.trim() ?? "";

  const destination = (() => {
    if (isGuestFallbackAccess(access)) return "/login";

    if (access.role === "Super Admin" || access.scope === "system" || access.role === "SFE Manager") {
      const params = new URLSearchParams();
      if (line) params.set("line", line);
      if (period) params.set("period", period);
      const qs = params.toString();
      return `/sales/monthly-closing${qs ? `?${qs}` : ""}`;
    }

    if (canAccessPortalClosing(access)) {
      const params = new URLSearchParams();
      if (period) params.set("period", period);
      const qs = params.toString();
      return `/employee-portals/monthly-closing${qs ? `?${qs}` : ""}`;
    }

    return resolveLandingPathForRole(access.role);
  })();

  return NextResponse.redirect(new URL(destination, request.url));
}
