import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { validationError } from "@/lib/http/api-errors";
import { startServerTimer } from "@/lib/http/server-timing";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadMonthlyPlanner, transitionMonthlyPlanAsRep } from "@/lib/phoenix-crm/server/monthly-plans";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  = one territory's whole month in the planner: the field-weeks it owns, every doctor with how
//        many days he needs and how many are placed, the AM/PM coverage and call-rate meters, and any
//        over-the-norm deviation. Anyone who reads the territory.
// POST = the rep's own moves on the MONTH: send the whole month to the reviewing manager, or take it
//        back to change it. The days themselves are saved a week at a time through /plans; this route
//        never writes a placement. A manager's decision is /monthly-plans/reviews.
export async function GET(request: Request) {
  // Server-Timing (durations only): access, viewer and load, as on the List and the call prep, so the
  // planner's open is read in the network panel and the process-health line (2 Nov 2026, Stage 2).
  const timer = startServerTimer("crm_monthly_plans");
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    timer.lap("access");
    const viewer = await timer.measure("viewer", () => resolvePhoenixCrmViewer(access));
    const search = searchOf(request);
    const planner = await timer.measure("load", () =>
      loadMonthlyPlanner(viewer, { seatId: search.get("seatId"), test: search.get("test"), month: search.get("month") }),
    );
    return NextResponse.json({ planner, success: true }, { headers: timer.headers() });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not open the monthly plan.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const action = body && typeof body === "object" ? (body as Record<string, unknown>).action : null;
    if (action !== "submit" && action !== "reopen") throw validationError("Reload the page and try again.");
    const plan = await transitionMonthlyPlanAsRep(viewer, body);
    return NextResponse.json({ plan, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not send the monthly plan.");
  }
}
