import { NextResponse } from "next/server";

import { getUserAttemptSummary } from "@/lib/error-monitor/service";
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
    const summary = await getUserAttemptSummary({
      dateFrom: url.searchParams.get("dateFrom") || null,
      dateTo: url.searchParams.get("dateTo") || null,
      hrId: url.searchParams.get("hrId") || null,
    });

    return NextResponse.json(summary);
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Failed to load user attempt summary." },
      { status: 500 },
    );
  }
}
