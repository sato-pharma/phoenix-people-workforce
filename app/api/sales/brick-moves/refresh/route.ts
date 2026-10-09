import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { countBrickMoveFilesPending, refreshMovedBrickFiles } from "@/lib/sales/master-data/brick-moves";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// How long one call keeps rebuilding before it answers, so the screen can show progress and call
// again. One file takes a few seconds at most.
const REFRESH_BUDGET_MS = 15_000;

/**
 * Rebuilds the totals of sales files a brick move re-stamped (see brick-moves.ts). A brick move
 * happens inside the database; the screen that made it calls this
 * until nothing is left. GET only counts what is waiting.
 *
 * Super Admin only, with the `sales:import` permission.
 */
function fail(error: unknown, fallback: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
  }
  return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, fallback) }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }
    return NextResponse.json({ remaining: await countBrickMoveFilesPending(), success: true });
  } catch (error) {
    return fail(error, "Could not count the moved files waiting to be rebuilt.");
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }
    const result = await refreshMovedBrickFiles({ budgetMs: REFRESH_BUDGET_MS });
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    return fail(error, "Could not rebuild the moved files.");
  }
}
