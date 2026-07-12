import { NextResponse } from "next/server";

import { getReproTrail } from "@/lib/error-monitor/service";
import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The "what was the user doing right before this error" repro trail. Gated to the same
// CEO + Super Admin audience as the rest of the System Issues dashboard — the caller can
// already see the error and its hr_id here; this adds the immediate navigation context.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const allowed = access.role === "CEO" || canAccessSystemAdministratorWorkspace(access);
    if (!allowed) {
      return NextResponse.json({ message: "Forbidden: insufficient permissions." }, { status: 403 });
    }

    const url = new URL(request.url);
    const hrId = url.searchParams.get("hrId");
    const before = url.searchParams.get("before");
    if (!hrId || !before) {
      return NextResponse.json({ message: "hrId and before are required." }, { status: 400 });
    }

    const entries = await getReproTrail(hrId, before, 5);
    return NextResponse.json({ entries });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Failed to load repro trail." },
      { status: 500 },
    );
  }
}
