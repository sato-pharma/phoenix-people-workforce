import { NextResponse } from "next/server";

import { unauthenticatedSessionResponse } from "@/lib/auth/api-session-response";
import { assertSystemAdministratorWorkspaceAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { loadLoginSecurityOverview } from "@/lib/security/login-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The System Audit login-security section's refresh: locked accounts, forced resets, failed
// sign-ins, the 7-day security lens and one page of recent security activity (`?search=&page=`).
// Moved here from /api/admin/system-issues/security when that page retired on 23 Oct 2026, and
// narrowed to Super Admin with it — the System Audit page is the Super Admin's alone.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const expired = unauthenticatedSessionResponse(access);
    if (expired) return expired;
    assertSystemAdministratorWorkspaceAccess(access, "the System Audit login security");

    const url = new URL(request.url);
    const overview = await loadLoginSecurityOverview({
      page: Number(url.searchParams.get("page") ?? "1"),
      search: url.searchParams.get("search"),
    });
    return NextResponse.json({ overview });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "Failed to load login security.") },
      { status: 500 },
    );
  }
}
