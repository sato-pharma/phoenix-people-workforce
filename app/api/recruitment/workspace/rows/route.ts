import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { forbiddenError, unauthorizedError } from "@/lib/http/api-errors";
import { isUuid } from "@/lib/http/uuid";
import { parseWorkspaceFilters } from "@/lib/recruitment/workspace/filters";
import { loadWorkspacePage, WORKSPACE_PAGE_DEFAULT } from "@/lib/recruitment/workspace/rows-db";
import { workspaceViewer } from "@/lib/recruitment/workspace/role-tabs";
import type { WorkspaceCursor } from "@/lib/recruitment/workspace/types";
import { recruitmentApiError } from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `after=<createdAt>~<id>` — the last row the screen already holds. Anything malformed starts at the top. */
function parseCursor(raw: string | null): WorkspaceCursor | null {
  if (!raw) return null;
  const at = raw.lastIndexOf("~");
  if (at <= 0) return null;
  const createdAt = raw.slice(0, at);
  const id = raw.slice(at + 1);
  if (!Number.isFinite(Date.parse(createdAt)) || !isUuid(id)) return null;
  return { createdAt, id };
}

/**
 * One page of the recruitment workspace's rows, newest received first.
 *
 * Gated by the workspace's own named rule (`workspaceViewer`), not by `candidates: read`: the CEO
 * reads this screen and must never hold the pool's grant (`tests/ceo-account-contract.test.ts`). The
 * viewer's tabs and the Talent Acquisition fence are applied INSIDE the database filter, from the
 * session — a tab in the query the viewer may not see simply returns nothing.
 *
 * `ids=a,b` re-reads exactly those people (the screen refreshing rows it just acted on), still behind
 * the viewer's tabs and the fence.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) throw unauthorizedError();
    const viewer = workspaceViewer(access);
    if (!viewer.canRead) throw forbiddenError("Forbidden: the recruitment workspace is not open to this account.");

    const params = new URL(request.url).searchParams;
    const filters = parseWorkspaceFilters(params);
    const limitRaw = Number(params.get("limit"));
    const idsRaw = params.get("ids");
    const page = await loadWorkspacePage(filters, viewer, {
      after: parseCursor(params.get("after")),
      ids: idsRaw === null ? undefined : idsRaw.split(",").map((id) => id.trim()).filter(Boolean),
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : WORKSPACE_PAGE_DEFAULT,
    });
    return NextResponse.json({ ...page, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not load the CVs.");
  }
}
