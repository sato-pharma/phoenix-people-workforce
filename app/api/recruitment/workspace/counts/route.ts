import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { forbiddenError, unauthorizedError } from "@/lib/http/api-errors";
import { parseWorkspaceFilters } from "@/lib/recruitment/workspace/filters";
import { loadWorkspaceCounts } from "@/lib/recruitment/workspace/rows-db";
import { workspaceViewer } from "@/lib/recruitment/workspace/role-tabs";
import { recruitmentApiError } from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every count the workspace shows — the tab badges, the region and area badges, the status counts and
 * the funnel — from the same database filter the rows come from, so a badge can never disagree with
 * the table under it. Same named gate as the rows (`workspaceViewer`), for the same reason: the CEO
 * reads this screen without the pool's `candidates: read`.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) throw unauthorizedError();
    const viewer = workspaceViewer(access);
    if (!viewer.canRead) throw forbiddenError("Forbidden: the recruitment workspace is not open to this account.");

    const filters = parseWorkspaceFilters(new URL(request.url).searchParams);
    const counts = await loadWorkspaceCounts(filters, viewer);
    return NextResponse.json({ ...counts, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not count the CVs.");
  }
}
