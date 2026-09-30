import { NextResponse } from "next/server";

import { loadSystemIssuesSnapshot } from "@/lib/error-monitor/system-issues";
import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const allowed = access.role === "CEO" || canAccessSystemAdministratorWorkspace(access);
    if (!allowed) {
      return NextResponse.json({ message: "Forbidden: insufficient permissions." }, { status: 403 });
    }

    const snapshot = await loadSystemIssuesSnapshot();
    return NextResponse.json(snapshot);
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "Failed to load system issues.") },
      { status: 500 },
    );
  }
}
