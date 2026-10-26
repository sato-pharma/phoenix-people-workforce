/**
 * Manager/line rollups for the currently-loaded month — Tier 2.2 of the FWC upscaling
 * roadmap. Pure aggregation over an already-in-memory employee list (no new fetch, no DB
 * access): "Roll up to team/line best-and-worst" so the CEO/NSM doesn't have to scan every
 * row individually. Informational only — never affects severity, status, or deductions.
 */

import type { FieldWorkforceEmployeeSummary } from "@/lib/field-workforce-compliance/types";

const UNASSIGNED_GROUP_LABEL = "Unassigned";

export type FieldWorkforceGroupScorecard = {
  /** Average over the members who have a percentage; null when none has one yet. */
  avgCompliancePercent: number | null;
  employeeCount: number;
  flaggedEmployeeCount: number;
  groupName: string;
  totalHighSeverityCount: number;
  totalNoActivityCandidates: number;
};

/** Groups employees by a caller-supplied key (manager name, line name, ...) and aggregates
 * each group's compliance signals. Employees with a blank/null group key are bucketed under
 * "Unassigned" rather than dropped, so nobody silently disappears from the rollup. Sorted
 * worst-first (lowest avgCompliancePercent) — the most actionable order for a compliance
 * leaderboard — with ties broken alphabetically by group name. */
function buildFieldWorkforceGroupScorecards(
  employees: FieldWorkforceEmployeeSummary[],
  groupKeyOf: (employee: FieldWorkforceEmployeeSummary) => string | null | undefined,
): FieldWorkforceGroupScorecard[] {
  const groups = new Map<string, FieldWorkforceEmployeeSummary[]>();
  for (const employee of employees) {
    const key = groupKeyOf(employee)?.trim() || UNASSIGNED_GROUP_LABEL;
    const members = groups.get(key) ?? [];
    members.push(employee);
    groups.set(key, members);
  }

  const scorecards: FieldWorkforceGroupScorecard[] = [];
  for (const [groupName, members] of groups) {
    // A member with no eligible day yet has no percentage: he is left out of the average rather
    // than counted as 0%.
    const percents = members
      .map((employee) => employee.compliancePercent)
      .filter((value): value is number => value !== null);
    const totalCompliance = percents.reduce((sum, value) => sum + value, 0);
    scorecards.push({
      avgCompliancePercent: percents.length > 0 ? Math.round((totalCompliance / percents.length) * 100) / 100 : null,
      employeeCount: members.length,
      flaggedEmployeeCount: members.filter((employee) => employee.severityCounts.High > 0).length,
      groupName,
      totalHighSeverityCount: members.reduce((sum, employee) => sum + employee.severityCounts.High, 0),
      totalNoActivityCandidates: members.reduce((sum, employee) => sum + employee.noActivityCandidates, 0),
    });
  }

  // Groups with no percentage yet sort after every scored group.
  const sortValue = (scorecard: FieldWorkforceGroupScorecard) => scorecard.avgCompliancePercent ?? Number.POSITIVE_INFINITY;
  return scorecards.sort((left, right) =>
    (sortValue(left) === sortValue(right) ? 0 : sortValue(left) - sortValue(right)) || left.groupName.localeCompare(right.groupName));
}

export function buildFieldWorkforceManagerScorecards(employees: FieldWorkforceEmployeeSummary[]): FieldWorkforceGroupScorecard[] {
  return buildFieldWorkforceGroupScorecards(employees, (employee) => employee.managerName);
}

export function buildFieldWorkforceLineScorecards(employees: FieldWorkforceEmployeeSummary[]): FieldWorkforceGroupScorecard[] {
  return buildFieldWorkforceGroupScorecards(employees, (employee) => employee.lineName);
}
