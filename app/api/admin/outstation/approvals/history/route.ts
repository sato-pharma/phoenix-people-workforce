import { NextResponse } from "next/server";

import { unauthenticatedSessionResponse } from "@/lib/auth/api-session-response";
import { assertOutstationExpenseApprovalReviewAccess } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { historyFilterOf, loadDeskHistory, loadSheetHistory } from "@/lib/outstation/approvals/history";
import { deskRouteFailure } from "@/lib/outstation/approvals/route-failure";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/outstation/approvals/history";

/**
 * Expense Approvals — what was already decided. Read only, and only on a press: the page never
 * calls this while it loads.
 *
 *   ?source=sheets          the trips that came from the expense sheets (values only)
 *   ?filter=&search=&offset the decided claims employees filed in Phoenix, 50 at a time
 */
export async function GET(request: Request) {
  let access: Awaited<ReturnType<typeof resolveAccessContext>> | null = null;
  try {
    access = await resolveAccessContext(request);
    const unauthenticated = unauthenticatedSessionResponse(access);
    if (unauthenticated) return unauthenticated;
    assertOutstationExpenseApprovalReviewAccess(access, "expense approvals");

    const url = new URL(request.url);
    if (url.searchParams.get("source") === "sheets") {
      return NextResponse.json({ sheets: await loadSheetHistory(access) });
    }
    const page = await loadDeskHistory(access, {
      filter: historyFilterOf(url.searchParams.get("filter")),
      offset: Number(url.searchParams.get("offset")) || 0,
      search: url.searchParams.get("search"),
    });
    return NextResponse.json(page);
  } catch (error) {
    return deskRouteFailure({ access, code: "expense_approvals_history_failed", error, fallback: "Unable to load the history.", route: ROUTE });
  }
}
