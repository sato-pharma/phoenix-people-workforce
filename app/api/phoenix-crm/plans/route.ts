import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { startServerTimer } from "@/lib/http/server-timing";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadMonthlyWeekAfterSave } from "@/lib/phoenix-crm/server/monthly-plans";
import { loadPlanner, savePlan, type PlanSaveReads } from "@/lib/phoenix-crm/server/plans";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  = one territory's week in the planner: the days, what is placed on each, the caps, the
//        suggestions and the far-apart days. Anyone who reads the territory.
// POST = save the week's draft (the rep only; checked against the version on screen, days from today
//        onward only). Sending it for review is /plans/submit. A save from the month board that names
//        the month it shows (`boardMonth`) is answered with that week and the month's meters as the
//        board draws them, so the board does not read the whole month again after it (2026-10-16 speed
//        audit); without it, or when that answer cannot be drawn, the save answers exactly as before.
export async function GET(request: Request) {
  const timer = startServerTimer("crm_plans");
  try {
    const access = await resolveAccessContext(request);
    timer.lap("access");
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await timer.measure("viewer", () => resolvePhoenixCrmViewer(access));
    const search = searchOf(request);
    const planner = await timer.measure("load", () => loadPlanner(viewer, { seatId: search.get("seatId"), test: search.get("test"), weekStart: search.get("weekStart") }));
    return NextResponse.json({ planner, success: true }, { headers: timer.headers() });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not open the weekly plan.");
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
    const keep: { reads: PlanSaveReads | null } = { reads: null };
    const saved = await savePlan(viewer, body, keep);
    const boardMonth = body && typeof body === "object" ? (body as Record<string, unknown>).boardMonth : undefined;
    // Never fails the save: it answers null for anything it cannot draw exactly, and the board then
    // reads itself again as before.
    const board = boardMonth !== undefined && keep.reads ? await loadMonthlyWeekAfterSave(viewer, { boardMonth, saved, reads: keep.reads }) : null;
    const plan = board ? { ...saved, board } : saved;
    return NextResponse.json({ plan, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the plan.");
  }
}
