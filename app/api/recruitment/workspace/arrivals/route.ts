import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { forbiddenError, unauthorizedError } from "@/lib/http/api-errors";
import { parseWorkspaceFilters } from "@/lib/recruitment/workspace/filters";
import { loadWorkspaceArrivals } from "@/lib/recruitment/workspace/rows-db";
import { workspaceViewer } from "@/lib/recruitment/workspace/role-tabs";
import { recruitmentApiError, recruitmentProblem } from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The live bar's question: how many CVs these filters would show have arrived since `since`, and when
 * the newest came in. A read, polled; it never moves the table under the reader — the bar offers the
 * new rows and the reader chooses when to take them.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) throw unauthorizedError();
    const viewer = workspaceViewer(access);
    if (!viewer.canRead) throw forbiddenError("Forbidden: the recruitment workspace is not open to this account.");

    const params = new URL(request.url).searchParams;
    const sinceRaw = params.get("since");
    const sinceMs = Date.parse(String(sinceRaw ?? ""));
    if (!sinceRaw || !Number.isFinite(sinceMs)) {
      return recruitmentProblem("Send `since` as a date and time.", 400);
    }
    const arrivals = await loadWorkspaceArrivals(parseWorkspaceFilters(params), viewer, new Date(sinceMs));
    return NextResponse.json({ ...arrivals, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not check for new CVs.");
  }
}
