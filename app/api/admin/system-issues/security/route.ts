import { NextResponse } from "next/server";

import { getLoginSecuritySignals } from "@/lib/error-monitor/service";
import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Login security lens for Tab 2 — brute-force IPs, hammered accounts, locked accounts,
// new-location logins. Gated to the same CEO + Super Admin audience as the rest of the
// System Issues dashboard (the caller already sees per-user failed-login counts here).
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const allowed = access.role === "CEO" || canAccessSystemAdministratorWorkspace(access);
    if (!allowed) {
      return NextResponse.json({ message: "Forbidden: insufficient permissions." }, { status: 403 });
    }

    const signals = await getLoginSecuritySignals(7);
    // Blocking an IP changes who can authenticate → Super Admin only (the lens itself is
    // CEO + SA read-only). canManage tells the UI whether to show Block/Unblock controls.
    const canManage = canAccessSystemAdministratorWorkspace(access);
    return NextResponse.json({ canManage, signals });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "Failed to load security signals.") },
      { status: 500 },
    );
  }
}
