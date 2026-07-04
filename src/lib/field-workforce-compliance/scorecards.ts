/**
 * Manager/line rollups for the currently-loaded month — Tier 2.2 of the FWC upscaling
 * roadmap. Pure aggregation over an already-in-memory employee list (no new fetch, no DB
 * access): "Roll up to team/line best-and-worst" so the CEO/NSM doesn't have to scan every
 * row individually. Informational only — never affects severity, status, or deductions.
 */

import type { FieldWorkforceEmployeeSummary } from "@/lib/field-workforce-compliance/types";

const UNASSIGNED_GROUP_LABEL = "Unassigned";

export type FieldWorkforceGroupScorecard = {
  avgCompliancePercent: number;
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
    const totalCompliance = members.reduce((sum, employee) => sum + employee.compliancePercent, 0);
    scorecards.push({
      avgCompliancePercent: Math.round((totalCompliance / members.length) * 100) / 100,
      employeeCount: members.length,
      flaggedEmployeeCount: members.filter((employee) => employee.severityCounts.High > 0).length,
      groupName,
      totalHighSeverityCount: members.reduce((sum, employee) => sum + employee.severityCounts.High, 0),
      totalNoActivityCandidates: members.reduce((sum, employee) => sum + employee.noActivityCandidates, 0),
    });
  }

  return scorecards.sort((left, right) =>
    left.avgCompliancePercent - right.avgCompliancePercent || left.groupName.localeCompare(right.groupName));
}

export function buildFieldWorkforceManagerScorecards(employees: FieldWorkforceEmployeeSummary[]): FieldWorkforceGroupScorecard[] {
  return buildFieldWorkforceGroupScorecards(employees, (employee) => employee.managerName);
}

export function buildFieldWorkforceLineScorecards(employees: FieldWorkforceEmployeeSummary[]): FieldWorkforceGroupScorecard[] {
  return buildFieldWorkforceGroupScorecards(employees, (employee) => employee.lineName);
}
