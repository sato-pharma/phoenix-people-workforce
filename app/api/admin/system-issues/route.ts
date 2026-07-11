import { NextResponse } from "next/server";

import { getErrorEvents } from "@/lib/error-monitor/service";
import { getRecentGcpLogEntries } from "@/lib/observability/gcp-logs";
import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const allowed = access.role === "CEO" || canAccessSystemAdministratorWorkspace(access);
    if (!allowed) {
      return NextResponse.json({ message: "Forbidden: insufficient permissions." }, { status: 403 });
    }

    const url = new URL(request.url);
    const hoursBack = Number(url.searchParams.get("hoursBack") ?? "24");

    const [appErrors, gcpLogs] = await Promise.all([
      getErrorEvents({ pageSize: 100 }),
      getRecentGcpLogEntries({ hoursBack: Number.isFinite(hoursBack) ? hoursBack : 24 }),
    ]);

    return NextResponse.json({ appErrors, gcpLogs });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Failed to load system issues." },
      { status: 500 },
    );
  }
}
