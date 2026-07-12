import { NextResponse } from "next/server";

import { getDeployTimeline } from "@/lib/error-monitor/service";
import { getCurrentReleaseTag } from "@/lib/error-monitor/derived-status";
import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Deploy timeline: errors-per-day, deploy markers, and regressions (signatures that went
// quiet across a deploy then came back on the current build). CEO + Super Admin.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const allowed = access.role === "CEO" || canAccessSystemAdministratorWorkspace(access);
    if (!allowed) {
      return NextResponse.json({ message: "Forbidden: insufficient permissions." }, { status: 403 });
    }

    const timeline = await getDeployTimeline(getCurrentReleaseTag(), 14);
    return NextResponse.json({ timeline });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Failed to load deploy timeline." },
      { status: 500 },
    );
  }
}
