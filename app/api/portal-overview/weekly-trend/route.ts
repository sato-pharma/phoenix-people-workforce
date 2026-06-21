import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveWeeklyAccessScope } from "@/lib/sales/weekly/access";
import { loadWeeklyDashboard } from "@/lib/sales/weekly/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Scoped weekly sales trend for the portal Overview "Sales Performance" section.
// Reuses the shared weekly access scope (PM/GPM product scope, NSM line, region roles
// fail-closed) and its confidential-product stripping, so this can never leak beyond
// the caller's scope. Loaded lazily by the client so it never blocks first paint.
const MAX_WEEKS = 12;

const EMPTY = { available: false, scopeTier: "none", weeks: [], kpi: null, comparePct: null } as const;

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_profile", "read");

    const accessScope = await resolveWeeklyAccessScope(access);
    if (accessScope.tier === "none") {
      return NextResponse.json(EMPTY, { headers: { "Cache-Control": "no-store" } });
    }

    const dashboard = await loadWeeklyDashboard({ allWeeks: true, accessScope });
    const weeks = (dashboard.trend ?? []).slice(-MAX_WEEKS).map((point) => ({
      weekStart: point.weekStart,
      salesValue: point.salesValue,
      salesUnits: point.salesUnits,
    }));

    return NextResponse.json(
      {
        available: weeks.length > 0,
        scopeTier: accessScope.tier,
        weeks,
        kpi: dashboard.kpis
          ? { salesValue: dashboard.kpis.salesValue, salesUnits: dashboard.kpis.salesUnits }
          : null,
        comparePct: dashboard.compare?.salesValue?.pct ?? null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(EMPTY, { headers: { "Cache-Control": "no-store" } });
  }
}
