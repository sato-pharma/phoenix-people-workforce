import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { getAwaitingMyActionItems } from "@/lib/action-center/service";
import {
  getExcuseAwaitingBadge,
  getPlanAwaitingBadge,
  getVacationAwaitingBadge,
} from "@/lib/approvals-hub/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Batched sidebar badge counts — ONE poll replaces the four separate 30s polls of
// /api/approvals/plan/pending-count, /api/approvals/vacation/pending-count,
// /api/approvals/excuse/pending-count and /api/approvals-hub/pending-count (which
// stay in place untouched for any other consumer). Each domain runs under EXACTLY
// the same permission guard as its dedicated endpoint, its dataset is fetched ONCE
// (the per-domain endpoints fetch the vacation/excuse/plan responder dataset twice
// per poll — once for the count, once for the overdue flag), and a failing domain
// falls back to the same {count: 0} shape its dedicated endpoint returns — one
// broken domain never blanks the other badges.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const [plan, vacation, excuse, hub] = await Promise.allSettled([
      (async () => {
        await assertPermission(access, "weekly_plans", "read");
        return getPlanAwaitingBadge(access);
      })(),
      (async () => {
        await assertPermission(access, "leave", "read");
        return getVacationAwaitingBadge(access);
      })(),
      (async () => {
        await assertPermission(access, "leave", "read");
        return getExcuseAwaitingBadge(access);
      })(),
      (async () => {
        await assertPermission(access, "leave", "read");
        const audience = resolveNavigationMode(access) === "employee-portal" ? "portal" : "admin";
        const items = await getAwaitingMyActionItems(access, audience);
        return { count: items.length };
      })(),
    ]);
    return NextResponse.json(
      {
        plan: plan.status === "fulfilled" ? plan.value : { count: 0, overdue: false },
        vacation: vacation.status === "fulfilled" ? vacation.value : { count: 0, overdue: false },
        excuse: excuse.status === "fulfilled" ? excuse.value : { count: 0, overdue: false },
        hub: hub.status === "fulfilled" ? hub.value : { count: 0 },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({
      plan: { count: 0, overdue: false },
      vacation: { count: 0, overdue: false },
      excuse: { count: 0, overdue: false },
      hub: { count: 0 },
    });
  }
}
