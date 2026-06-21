import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertPermission, type PhoenixRole } from "@/lib/auth/permissions";
import { getDoubleVisitDashboardData } from "@/lib/double-visit-analytics/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Double-visit coaching insights for the portal Overview (managers only). The
// double-visit service is itself access-scoped (RM=region, PM/GPM=line by line_id,
// DM=direct reports, exec=all), so we only gate which roles see the section at all and
// then summarise the scoped result. Loaded lazily by the client.
const DOUBLE_VISIT_MANAGER_ROLES: ReadonlySet<PhoenixRole> = new Set<PhoenixRole>([
  "District Manager",
  "Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Training Manager",
]);

const EMPTY = {
  available: false,
  kpis: null,
  byRegion: [],
  mostVisited: [],
  fewestVisited: [],
  neverVisited: [],
} as const;

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_profile", "read");
    if (!DOUBLE_VISIT_MANAGER_ROLES.has(access.role)) {
      return NextResponse.json(EMPTY, { headers: { "Cache-Control": "no-store" } });
    }

    const data = await getDoubleVisitDashboardData({ access });
    const scores = data.mrScores ?? [];
    const totalReps = scores.length;
    const neverVisitedScores = scores.filter((score) => score.daysSinceLastDv === null);
    const coveredReps = totalReps - neverVisitedScores.length;
    const coveragePercent = totalReps > 0 ? Math.round((coveredReps / totalReps) * 100) : 0;

    const visited = scores.filter((score) => score.totalDvs > 0).sort((a, b) => b.totalDvs - a.totalDvs);
    const mostVisited = visited
      .slice(0, 5)
      .map((score) => ({ name: score.mrName, totalDvs: score.totalDvs, lineName: score.lineName }));
    const fewestVisited = [...visited]
      .reverse()
      .slice(0, 5)
      .map((score) => ({ name: score.mrName, totalDvs: score.totalDvs, lineName: score.lineName }));
    const neverVisited = neverVisitedScores
      .slice(0, 8)
      .map((score) => ({ name: score.mrName, lineName: score.lineName, areaName: score.areaName }));

    const byRegion = (data.heatmap?.byArea ?? []).slice(0, 8).map((row) => ({
      label: row.label,
      totalVisits: row.totalVisits,
      mrCount: row.mrCount,
      coveragePercent: row.coveragePercent,
    }));

    return NextResponse.json(
      {
        available: totalReps > 0,
        kpis: {
          totalVisits: data.kpis.totalVisits,
          doubleVisitorCount: data.kpis.doubleVisitorCount,
          coveredReps,
          totalReps,
          neverVisitedCount: neverVisitedScores.length,
          coveragePercent,
        },
        byRegion,
        mostVisited,
        fewestVisited,
        neverVisited,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(EMPTY, { headers: { "Cache-Control": "no-store" } });
  }
}
