// Pure data-shaping helpers for the DV Planner tool (app/employee-portals/dv-planner +
// dv-planner-workspace.tsx) — kept out of the page/component so the roster-merge and
// match logic can be unit tested directly, per this repo's domain-first convention.

import { canonicalHrIdKey } from "@/lib/hr-id";

import type { DoubleVisitReportData } from "./types";

export type DvPlannerRep = {
  areaName: string | null;
  hrId: string;
  lineName: string | null;
  name: string;
};

export type DvPlannerVisit = {
  activityDate: string;
  doubleVisitorName: string | null;
  visitCount: number;
  visitedHrId: string;
};

/**
 * Merge the "never visited" roster with active-mapped rows from the report into one
 * deduped rep list, plus the flattened visit list the workspace matches against. A
 * row's fields take precedence over the never-visited seed (a rep who WAS visited
 * should show their row's freshest area/line/name), but a row never overwrites a
 * known field with a blank one.
 */
export function buildDvPlannerRoster(
  data: Pick<DoubleVisitReportData, "neverVisited" | "rows"> | null | undefined,
): { reps: DvPlannerRep[]; visits: DvPlannerVisit[] } {
  const repsByHrId = new Map<string, DvPlannerRep>();
  for (const rep of data?.neverVisited ?? []) {
    const key = canonicalHrIdKey(rep.hrId);
    if (!key) continue;
    repsByHrId.set(key, {
      areaName: rep.areaName,
      hrId: rep.hrId,
      lineName: null,
      name: rep.name || rep.hrId,
    });
  }
  for (const row of data?.rows ?? []) {
    if (row.visitedStatus !== "active_mapped" || !row.visitedHrId) continue;
    const key = canonicalHrIdKey(row.visitedHrId);
    if (!key) continue;
    const current = repsByHrId.get(key);
    repsByHrId.set(key, {
      areaName: row.areaName ?? current?.areaName ?? null,
      hrId: row.visitedHrId,
      lineName: row.lineName ?? current?.lineName ?? null,
      name: row.visitedName ?? current?.name ?? row.visitedHrId,
    });
  }

  const reps = Array.from(repsByHrId.values()).sort((a, b) => a.name.localeCompare(b.name));
  const visits = (data?.rows ?? [])
    .filter((row) => row.visitedStatus === "active_mapped" && row.visitedHrId)
    .map((row) => ({
      activityDate: row.activityDate,
      doubleVisitorName: row.doubleVisitorName,
      visitCount: row.visitCount,
      visitedHrId: row.visitedHrId as string,
    }));

  return { reps, visits };
}

/** Groups visits by `${canonicalHrIdKey}|${activityDate}` for O(1) per-rep-per-day lookup. */
export function groupDvPlannerVisitsByRepDate(visits: readonly DvPlannerVisit[]): Map<string, DvPlannerVisit[]> {
  const result = new Map<string, DvPlannerVisit[]>();
  for (const visit of visits) {
    const hrKey = canonicalHrIdKey(visit.visitedHrId);
    if (!hrKey) continue;
    const key = `${hrKey}|${visit.activityDate}`;
    const list = result.get(key);
    if (list) list.push(visit);
    else result.set(key, [visit]);
  }
  return result;
}

/** The workspace's core answer: was a double visit recorded for this rep on this exact day? */
export function matchDvPlannerVisits(
  visitsByRepDate: Map<string, DvPlannerVisit[]>,
  hrId: string,
  date: string,
): { visitors: string[]; wasRecorded: boolean } {
  const hrKey = canonicalHrIdKey(hrId) ?? hrId.toLowerCase();
  const matches = date ? (visitsByRepDate.get(`${hrKey}|${date}`) ?? []) : [];
  const visitors = Array.from(
    new Set(matches.map((visit) => visit.doubleVisitorName).filter((name): name is string => Boolean(name))),
  );
  return { visitors, wasRecorded: matches.length > 0 };
}
