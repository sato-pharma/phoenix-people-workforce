import { canAccess, type AccessContext } from "@/lib/auth/permissions";
import { getEmployeeDirectoryRows, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { hrIdForStorage, hrIdsMatch } from "@/lib/hr-id";
import { daysUntilLifecycleDate } from "@/lib/lifecycle-risk/metrics";

import { saveManagerRecommendation } from "./recommendation-store";
import { getContractRenewalDashboardData } from "./service";
import {
  CONTRACT_RECOMMENDATION_NOTE_MAX,
  contractRecommendHref,
  type ManagerRecommendationContext,
} from "./manager-recommendation-labels";
import type {
  ContractManagerRecommendation,
  ContractManagerRecommendationValue,
  ContractRow,
} from "./types";

export {
  CONTRACT_RECOMMENDATION_NOTE_MAX,
  contractRecommendationLabels,
  contractRecommendHref,
  type ManagerRecommendationContext,
} from "./manager-recommendation-labels";

/**
 * THE MANAGER'S RECOMMENDATION ON A CONTRACT RENEWAL (owner, 2026-11-11).
 *
 * The renewal reminder (app/api/notifications/contract-renewals, 75/60/30/15 days ahead) is sent to
 * the employee's manager chain and asks for a "manager recommendation". Until now there was nowhere
 * to give one: the button opened Contract Renewal, which only HR and the Super Admin can open, so
 * every district manager, the National Sales Manager and the other managers were dropped on the
 * portal home — "people are redirected to nothing". The owner chose a page of its own: the employee,
 * Renew / Don't renew, a note, and HR reads the answer on the Contract Renewal board.
 *
 * WHO MAY ANSWER: anyone above the employee in the reporting line (managerHrId, followed upward) —
 * the whole chain, never one hop, because the reminder already reaches the manager's manager and the
 * org's "filter by manager means the whole chain" rule. Scope runs downward only: nobody answers for
 * themself or for someone above them.
 * WHO MAY READ: the same chain, plus whoever holds contracts:read (HR and the Super Admin), who see
 * every answer but give none — HR records its own decision on the board, not here.
 */

/** How far ahead a manager's "my team's renewals" list looks — past the reminder's first rung (75). */
export const TEAM_RENEWAL_WINDOW_DAYS = 90;

export class ContractRecommendationError extends Error {
  readonly status: 400 | 403 | 404;

  constructor(message: string, status: 400 | 403 | 404) {
    super(message);
    this.name = "ContractRecommendationError";
    this.status = status;
  }
}

export function isContractRecommendationError(error: unknown): error is ContractRecommendationError {
  return error instanceof ContractRecommendationError;
}

/**
 * Everyone above `employee` in the reporting line, nearest first. Stops at the top, at an id the
 * directory does not hold, and at a loop (a bad manager link must not hang the page).
 */
export function managerChainOf(employee: Pick<EmployeeDirectoryRow, "hrId" | "managerHrId">, rows: readonly EmployeeDirectoryRow[]) {
  const chain: EmployeeDirectoryRow[] = [];
  const seen = new Set<string>([String(employee.hrId)]);
  let managerHrId = employee.managerHrId;
  while (managerHrId) {
    const manager = rows.find((row) => hrIdsMatch(row.hrId, managerHrId));
    if (!manager || seen.has(String(manager.hrId))) break;
    seen.add(String(manager.hrId));
    chain.push(manager);
    managerHrId = manager.managerHrId;
  }
  return chain;
}

export function isInManagerChain(
  viewerHrId: string | null | undefined,
  employee: Pick<EmployeeDirectoryRow, "hrId" | "managerHrId">,
  rows: readonly EmployeeDirectoryRow[],
) {
  if (!viewerHrId || hrIdsMatch(viewerHrId, employee.hrId)) return false;
  return managerChainOf(employee, rows).some((manager) => hrIdsMatch(manager.hrId, viewerHrId));
}

export function parseRecommendationInput(body: unknown) {
  const source = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const employeeHrId = String(source.employeeHrId ?? "").trim();
  const recommendation = String(source.recommendation ?? "").trim();
  const note = String(source.note ?? "").trim();
  if (!employeeHrId) throw new ContractRecommendationError("Choose the employee.", 400);
  if (recommendation !== "renew" && recommendation !== "do_not_renew") {
    throw new ContractRecommendationError("Choose Renew or Do not renew.", 400);
  }
  if (note.length > CONTRACT_RECOMMENDATION_NOTE_MAX) {
    throw new ContractRecommendationError(`Keep the note under ${CONTRACT_RECOMMENDATION_NOTE_MAX} characters.`, 400);
  }
  return { employeeHrId, note: note || null, recommendation: recommendation as ContractManagerRecommendationValue };
}

function displayNameOf(rows: readonly EmployeeDirectoryRow[], hrId: string) {
  const row = rows.find((candidate) => hrIdsMatch(candidate.hrId, hrId));
  return row?.displayName || row?.fullName || null;
}

export async function getManagerRecommendationContext(
  access: AccessContext,
  employeeHrId: string,
): Promise<ManagerRecommendationContext> {
  const [directory, dashboard, canOpenBoard] = await Promise.all([
    getEmployeeDirectoryRows(),
    getContractRenewalDashboardData(),
    canAccess(access, "contracts", "read"),
  ]);
  const employee = directory.find((row) => hrIdsMatch(row.hrId, employeeHrId));
  // The board's rows are the active employees, so a leaver has no renewal to recommend on.
  const row = employee ? dashboard.rows.find((candidate) => hrIdsMatch(candidate.hr_id, employee.hrId)) : null;
  if (!employee || !row) return { state: "not_found" };

  const canRecommend = isInManagerChain(access.hrId, employee, directory);
  if (!canRecommend && !canOpenBoard) return { state: "forbidden" };

  const recommendations = row.manager_recommendations;
  return {
    canOpenBoard,
    canRecommend,
    daysUntil: daysUntilLifecycleDate(row.contract_renewal_date),
    employee: {
      area: row.area,
      hrId: employee.hrId,
      jobTitle: row.job_title,
      line: row.line,
      managerName: employee.managerName ?? (employee.managerHrId ? displayNameOf(directory, employee.managerHrId) : null),
      name: employee.displayName || employee.fullName,
    },
    mine: recommendations.find((item) => hrIdsMatch(item.recommenderHrId, access.hrId)) ?? null,
    recommendations,
    renewalDate: row.contract_renewal_date,
    state: "ready",
  };
}

export async function submitManagerRecommendation(access: AccessContext, body: unknown) {
  const input = parseRecommendationInput(body);
  // A TEST-… login reads as the real employee it mirrors and must never write as her.
  if (access.testPersona) {
    throw new ContractRecommendationError("A test account cannot record a recommendation.", 403);
  }
  const context = await getManagerRecommendationContext(access, input.employeeHrId);
  if (context.state === "not_found") throw new ContractRecommendationError("This employee has no contract renewal.", 404);
  if (context.state === "forbidden" || !context.canRecommend) {
    throw new ContractRecommendationError("Only a manager above this employee can recommend on the renewal.", 403);
  }
  const recommenderHrId = hrIdForStorage(access.hrId);
  if (!recommenderHrId) throw new ContractRecommendationError("Your account has no employee record.", 403);

  await saveManagerRecommendation({
    employeeHrId: hrIdForStorage(context.employee.hrId) ?? context.employee.hrId,
    note: input.note,
    recommendation: input.recommendation,
    recommenderHrId,
    renewalDate: context.renewalDate,
  });
  return getManagerRecommendationContext(access, input.employeeHrId);
}

export type TeamRenewal = {
  hrId: string;
  name: string;
  jobTitle: string;
  line: string;
  area: string;
  renewalDate: string;
  daysUntil: number;
  mine: ContractManagerRecommendation | null;
  href: string;
};

/** The renewals coming up in the next TEAM_RENEWAL_WINDOW_DAYS for everyone below this viewer. */
export function teamRenewalsFor(
  viewerHrId: string | null | undefined,
  rows: readonly ContractRow[],
  directory: readonly EmployeeDirectoryRow[],
  today?: Date,
): TeamRenewal[] {
  if (!viewerHrId) return [];
  return rows
    .flatMap((row): TeamRenewal[] => {
      const employee = directory.find((candidate) => hrIdsMatch(candidate.hrId, row.hr_id));
      if (!employee || !isInManagerChain(viewerHrId, employee, directory)) return [];
      const daysUntil = daysUntilLifecycleDate(row.contract_renewal_date, today);
      if (daysUntil === null || daysUntil < 0 || daysUntil > TEAM_RENEWAL_WINDOW_DAYS) return [];
      return [{
        area: row.area,
        daysUntil,
        hrId: employee.hrId,
        href: contractRecommendHref(employee.hrId),
        jobTitle: row.job_title,
        line: row.line,
        mine: row.manager_recommendations.find((item) => hrIdsMatch(item.recommenderHrId, viewerHrId)) ?? null,
        name: employee.displayName || employee.fullName,
        renewalDate: row.contract_renewal_date,
      }];
    })
    .sort((left, right) => left.daysUntil - right.daysUntil || left.name.localeCompare(right.name));
}

export async function listTeamRenewals(access: AccessContext): Promise<TeamRenewal[]> {
  const [directory, dashboard] = await Promise.all([getEmployeeDirectoryRows(), getContractRenewalDashboardData()]);
  return teamRenewalsFor(access.hrId, dashboard.rows, directory);
}
