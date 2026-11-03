import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import { addDaysIso, cairoTodayIso } from "@/lib/crm/dates";
import { indexPhoenixWorkEvidence, loadPhoenixWorkEvidenceDays, phoenixWorkEvidenceProvesWorkedDay } from "@/lib/crm/phoenix-work-evidence";
import type { PhoenixTeamRow } from "@/lib/crm/phoenix-team-starts";
import { queryOwnVisitsOfDepartedAgents, scanVisitsForRangeCreditingPartners } from "@/lib/crm/reads";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import {
  isFieldWorkforceComplianceEligibleTitle,
  isSfeManagerTitle,
  logsOwnCrmVisitsTitle,
} from "@/lib/field-workforce-compliance/eligibility";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { compactHrKey } from "@/lib/payroll/copilot/feeders";
import { seatPeople } from "@/lib/phoenix-crm/scope";
import { loadManagerOwnVisitDays } from "@/lib/phoenix-crm/server/manager-plan-readers";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { loadApprovedLeaveDays } from "@/lib/vacation/approved-leave-days";

import {
  buildHoldoutsReport,
  HOLDOUT_WINDOW_DAYS,
  peopleOnLeaveAllWindow,
  vendorDaysFromRows,
  type HoldoutPerson,
  type HoldoutsReport,
  type HoldoutTag,
  type HoldoutTeam,
  type HoldoutVisitRow,
} from "./ireports360-holdouts.ts";

/**
 * The reads behind the "Still on iReports360" tab. Read-only, and every failed read THROWS, because a
 * failed read shown as an empty list would read as nobody left. The access decision is the CRM hub's
 * (`canUseAdminCrmWorkspace`): nothing here is on a route of its own.
 */

const COLUMNS = "source, visit_date, agent_hr_id, double_hr_id, double2_hr_id, double_crm_id";

function keyOf(hrId: string | null | undefined): string {
  return compactHrKey(canonicalHrIdKey(hrId) ?? "");
}

function tagFor(jobTitle: string | null, employmentStatus: string | null): HoldoutTag | null {
  if (isTerminalEmploymentStatus(employmentStatus)) return "leaving or left";
  if (isSfeManagerTitle(jobTitle)) return "no deduction";
  if (resolveJobFunctionRole(jobTitle) === "District Manager") return "keeps both apps by ruling";
  return logsOwnCrmVisitsTitle(jobTitle) ? null : "no CRM charge";
}

export type IReports360HoldoutsData = {
  from: string;
  to: string;
  report: HoldoutsReport;
  onLeaveAllWindow: string[];
  /** False when the team starts could not be read, so a row's team line says nothing rather than something wrong. */
  teamsReadable: boolean;
};

async function teamsByPerson(teams: readonly PhoenixTeamRow[]): Promise<Map<string, HoldoutTeam[]>> {
  const org = await loadPhoenixCrmOrg();
  const byTeamSeat = new Map(teams.map((team) => [team.teamSeatId, team]));
  const out = new Map<string, HoldoutTeam[]>();
  const add = (hrId: string | null | undefined, seatId: string | null | undefined) => {
    const key = keyOf(hrId);
    const team = seatId ? byTeamSeat.get(seatId) : undefined;
    if (!key || !team) return;
    const held = out.get(key) ?? [];
    if (held.some((entry) => entry.team === team.team)) return;
    out.set(key, [...held, { startsOn: team.runningStartsOn, state: team.state, team: team.team }]);
  };
  for (const territory of org.territories) {
    for (const seat of seatPeople(territory)) add(seat.occupantHrId, territory.parentSeatId);
  }
  for (const team of teams) add(org.seats.get(team.teamSeatId)?.occupantHrId, team.teamSeatId);
  return out;
}

export async function loadIReports360Holdouts(input: {
  teams: readonly PhoenixTeamRow[] | null;
  cairoToday?: string;
}): Promise<IReports360HoldoutsData> {
  const to = input.cairoToday ?? cairoTodayIso();
  const from = addDaysIso(to, -HOLDOUT_WINDOW_DAYS);
  const windowDays: string[] = [];
  for (let day = from; day <= to; day = addDaysIso(day, 1)) windowDays.push(day);

  const directory = await getEmployeeDirectoryRows({ includeInactive: true });
  const [doorRows, departedRows, phoenixEvidence, managerOwnVisits, teamMap] = await Promise.all([
    scanVisitsForRangeCreditingPartners<HoldoutVisitRow>({ columns: COLUMNS, dateFrom: from, dateTo: to }),
    // A rep serving notice is already off the door above (the exclusion reads status, not a date), so
    // their own rows come back through their last working day.
    queryOwnVisitsOfDepartedAgents<HoldoutVisitRow>({
      columns: COLUMNS,
      dateFrom: from,
      dateTo: to,
      hrIds: directory.map((employee) => employee.hrId),
    }),
    loadPhoenixWorkEvidenceDays({ end: to, start: from }),
    loadManagerOwnVisitDays({ end: to, start: from }),
    input.teams ? teamsByPerson(input.teams) : Promise.resolve(new Map<string, HoldoutTeam[]>()),
  ]);

  const { days: vendorDays, rowsNamingNobody } = vendorDaysFromRows([...doorRows, ...departedRows], keyOf);
  const phoenixDays = [
    ...[...indexPhoenixWorkEvidence(phoenixEvidence, keyOf).values()]
      .filter(phoenixWorkEvidenceProvesWorkedDay)
      .map((day) => ({ date: day.date, key: keyOf(day.hrId) })),
    ...managerOwnVisits.map((day) => ({ date: day.date, key: keyOf(day.hrId) })),
  ];

  const people = new Map<string, HoldoutPerson>(
    directory.map((employee) => [
      keyOf(employee.hrId),
      {
        name: employee.displayName || employee.fullName,
        tag: tagFor(employee.jobTitle, employee.employmentStatus),
        teams: teamMap.get(keyOf(employee.hrId)) ?? [],
      },
    ]),
  );

  const candidates = directory.filter(
    (employee) => !isTerminalEmploymentStatus(employee.employmentStatus) && isFieldWorkforceComplianceEligibleTitle(employee.jobTitle),
  );
  const leave = await loadApprovedLeaveDays(candidates.map((employee) => employee.hrId), { from, to });
  const onLeave = peopleOnLeaveAllWindow({
    appearing: new Set([...vendorDays.map((day) => day.key), ...phoenixDays.map((day) => day.key)]),
    candidates: candidates.map((employee) => keyOf(employee.hrId)),
    leaveDays: leave.map((day) => ({ date: day.day, key: keyOf(day.hrId) })),
    windowDays,
  });

  return {
    from,
    onLeaveAllWindow: onLeave.map((key) => people.get(key)?.name ?? "Name not on file").sort(),
    report: buildHoldoutsReport({ people, phoenixDays, rowsNamingNobody, vendorDays }),
    teamsReadable: input.teams !== null,
    to,
  };
}
