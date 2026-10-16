/**
 * Phoenix CRM — one district manager's week, his ask to edit it, or his ask to take a customer off his own
 * list, as the Approvals Hub's plan page shows it (owner, 2026-10-16: "decided in the Approvals Hub, as
 * today"). The Hub's page falls through to this when the id is not a legacy plan.
 *
 * Who may open it: whoever reads that district manager's plan (`readsManagerPlanOf` — he himself, the
 * managers above him, SFE, the CEO and the Super Admin), plus the approver stored on the row. Who may decide
 * it: the approver stored for the step, or the Administrator in his place — the same predicates the write
 * routes enforce, so a button is never shown that the server would refuse.
 *
 * 🔴 The Approvals Hub's own service must NEVER import this file: it reaches the notice senders through
 * `manager-plans.ts`, and the notification layer imports the Hub's service.
 */

import type { AccessContext } from "@/lib/auth/permissions";
import { addDaysIso } from "@/lib/crm/dates";
import { formatPhoenixDateTime, formatPhoenixLongDate } from "@/lib/i18n/format";
import {
  managerPlanStage,
  managerPlanStatusLabel,
  returnStageOfApproved,
  type ManagerPlanStage,
  type ManagerPlanStatus,
} from "@/lib/phoenix-crm/manager-plan-rules";
import { personKey } from "@/lib/phoenix-crm/scope";
import { resolvePhoenixCrmViewer, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadManagerCustomerRow } from "@/lib/phoenix-crm/server/manager-customers";
import { managerAskDeciderRole, managerPlanDeciderRole, readsManagerPlanOf, type ManagerPlanDeciderRole } from "@/lib/phoenix-crm/server/manager-plan-reach";
import { loadEditAskRow, loadEditAsks, loadManagerPlanRow, type ManagerEditAskRow, type ManagerPlanRow } from "@/lib/phoenix-crm/server/manager-plan-rows";
import { loadManagerPlanBoardFor, type ManagerPlanBoardView } from "@/lib/phoenix-crm/server/manager-plans";
import { loadPeopleNames, nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";

export type ManagerHubStepState = "done" | "current" | "waiting" | "returned";

export type ManagerHubStep = { label: string; who: string; state: ManagerHubStepState; at: string | null };

export type ManagerHubAsk = {
  requestId: string;
  reason: string;
  askedAt: string | null;
  status: ManagerEditAskRow["status"];
  decisionNote: string | null;
  /** The viewer decides it now: its approver, or the Administrator. */
  decideAs: "first" | "administrator" | null;
  version: number;
};

export type ManagerHubPlanDetail = {
  kind: "plan";
  isTest: boolean;
  planId: string;
  managerName: string;
  weekText: string;
  status: ManagerPlanStatus;
  statusLabel: string;
  sentAt: string | null;
  sentLate: boolean;
  decisionNote: string | null;
  returnedDayText: string | null;
  steps: ManagerHubStep[];
  board: ManagerPlanBoardView;
  /** The viewer decides the week now (approve, return the week, return one day). */
  decideAs: ManagerPlanDeciderRole | null;
  version: number;
  /** The days a return may name. */
  returnableDays: Array<{ date: string; dateText: string }>;
  /** The ask to edit this page was opened for, or the one waiting on the week. */
  ask: ManagerHubAsk | null;
  isOwner: boolean;
};

export type ManagerHubRemovalDetail = {
  kind: "removal";
  isTest: boolean;
  customerId: string;
  managerName: string;
  customerName: string;
  speciality: string | null;
  grade: string | null;
  potentialGrade: string | null;
  areaName: string | null;
  reason: string | null;
  status: "pending" | "removed" | "refused" | "active";
  statusLabel: string;
  decisionNote: string | null;
  approverName: string | null;
  decideAs: "first" | "administrator" | null;
  isOwner: boolean;
};

export type ManagerHubDetail = { kind: "not_found" } | ManagerHubPlanDetail | ManagerHubRemovalDetail;

const NOT_FOUND: ManagerHubDetail = { kind: "not_found" };

function at(value: string | null): string | null {
  return value ? formatPhoenixDateTime(value) : null;
}

function mayOpen(viewer: PhoenixCrmViewer, managerHrId: string, approverHrIds: ReadonlyArray<string | null>): boolean {
  if (readsManagerPlanOf(viewer, managerHrId)) return true;
  return approverHrIds.some((hrId) => hrId !== null && personKey(hrId) === viewer.hrId);
}

function who(names: PeopleNames, hrId: string | null, role: string | null, fallback: string): string {
  if (role === "administrator") return "The Administrator";
  return hrId ? nameOf(names, hrId) : fallback;
}

/** The tracker: sent, the first approver, then the second where there is one. */
function planSteps(plan: ManagerPlanRow, names: PeopleNames): ManagerHubStep[] {
  const hasSecond = plan.secondApproverHrId !== null;
  const returnedAt = plan.status === "returned" ? plan.returnedStage ?? returnStageOfApproved(hasSecond) : null;
  const steps: ManagerHubStep[] = [
    {
      label: plan.submittedLate ? "Sent after the Thursday deadline" : "Sent",
      who: nameOf(names, plan.managerHrId),
      state: plan.submittedAt ? "done" : "current",
      at: at(plan.submittedAt),
    },
  ];
  const firstDone = plan.status === "first_approved" || plan.status === "approved" || (plan.status === "returned" && returnedAt === "second");
  steps.push({
    label: "Manager approval",
    who: firstDone
      ? who(names, plan.firstDecidedByHrId ?? (hasSecond ? null : plan.decidedByHrId), plan.firstDecidedRole ?? (hasSecond ? null : plan.decidedByRole), plan.firstApproverHrId ? nameOf(names, plan.firstApproverHrId) : "The approver")
      : plan.status === "returned" && returnedAt === "first"
        ? who(names, plan.decidedByHrId, plan.decidedByRole, "The approver")
        : plan.firstApproverHrId
          ? nameOf(names, plan.firstApproverHrId)
          : "The approver",
    state: firstDone ? "done" : plan.status === "returned" && returnedAt === "first" ? "returned" : plan.status === "submitted" ? "current" : "waiting",
    at: firstDone ? at(plan.firstDecidedAt ?? (hasSecond ? null : plan.decidedAt)) : plan.status === "returned" && returnedAt === "first" ? at(plan.decidedAt) : null,
  });
  if (hasSecond) {
    const secondDone = plan.status === "approved";
    const secondReturned = plan.status === "returned" && returnedAt === "second";
    steps.push({
      label: "Second approval",
      who: secondDone || secondReturned ? who(names, plan.decidedByHrId, plan.decidedByRole, "The second approver") : nameOf(names, plan.secondApproverHrId),
      state: secondDone ? "done" : secondReturned ? "returned" : plan.status === "first_approved" ? "current" : "waiting",
      at: secondDone || secondReturned ? at(plan.decidedAt) : null,
    });
  }
  return steps;
}

async function planDetail(viewer: PhoenixCrmViewer, plan: ManagerPlanRow, askId: string | null): Promise<ManagerHubDetail> {
  const asks = await loadEditAsks([plan.planId]);
  const ask = (askId ? asks.find((entry) => entry.requestId === askId) : asks.find((entry) => entry.status === "pending")) ?? null;
  if (!mayOpen(viewer, plan.managerHrId, [plan.firstApproverHrId, plan.secondApproverHrId, ask?.approverHrId ?? null])) return NOT_FOUND;

  const [board, names] = await Promise.all([
    loadManagerPlanBoardFor(viewer, plan.managerHrId, plan.weekStart, plan.isTest),
    loadPeopleNames([
      plan.managerHrId,
      plan.firstApproverHrId,
      plan.secondApproverHrId,
      plan.firstDecidedByHrId,
      plan.decidedByHrId,
    ]),
  ]);
  const hasSecond = plan.secondApproverHrId !== null;
  const stage: ManagerPlanStage | null = plan.status === "approved" ? returnStageOfApproved(hasSecond) : managerPlanStage(plan.status);
  const decideAs =
    stage && (plan.status === "submitted" || plan.status === "first_approved" || plan.status === "approved")
      ? managerPlanDeciderRole(viewer, { stage, firstApproverHrId: plan.firstApproverHrId, secondApproverHrId: plan.secondApproverHrId, isTest: plan.isTest })
      : null;
  // A week already approved is returned only by its last approver, and only before it has ended.
  const weekOpen = addDaysIso(plan.weekStart, 5) >= viewer.cairoToday;
  return {
    kind: "plan",
    isTest: plan.isTest,
    planId: plan.planId,
    managerName: nameOf(names, plan.managerHrId),
    weekText: `Week of ${formatPhoenixLongDate(plan.weekStart)}`,
    status: plan.status,
    statusLabel: managerPlanStatusLabel(plan.status),
    sentAt: at(plan.submittedAt),
    sentLate: plan.submittedLate === true,
    decisionNote: plan.decisionNote ?? plan.firstDecisionNote,
    returnedDayText: plan.returnedDay ? formatPhoenixLongDate(plan.returnedDay) : null,
    steps: planSteps(plan, names),
    board,
    decideAs: weekOpen ? decideAs : null,
    version: plan.version,
    returnableDays: board.days.filter((day) => day.halves.length > 0).map((day) => ({ date: day.date, dateText: day.dateText })),
    ask: ask
      ? {
          requestId: ask.requestId,
          reason: ask.reason,
          askedAt: at(ask.createdAt),
          status: ask.status,
          decisionNote: ask.decisionNote,
          decideAs: ask.status === "pending" ? managerAskDeciderRole(viewer, { approverHrId: ask.approverHrId, isTest: ask.isTest }) : null,
          version: ask.version,
        }
      : null,
    isOwner: plan.managerHrId === viewer.hrId,
  };
}

async function removalDetail(viewer: PhoenixCrmViewer, id: string): Promise<ManagerHubDetail> {
  const row = await loadManagerCustomerRow(id);
  if (!row || row.isTest !== viewer.isTestPersona) return NOT_FOUND;
  if (!mayOpen(viewer, row.managerHrId, [row.approverHrId])) return NOT_FOUND;
  const names = await loadPeopleNames([row.managerHrId, row.approverHrId]);
  const refused = row.status === "active" && row.removalDecisionNote !== null;
  const status: ManagerHubRemovalDetail["status"] = row.status === "removal_pending" ? "pending" : row.status === "removed" ? "removed" : refused ? "refused" : "active";
  const statusLabel =
    status === "pending"
      ? `Waiting for ${row.approverHrId ? nameOf(names, row.approverHrId) : "the approver"}`
      : status === "removed"
        ? "Removed from Manager's own list"
        : status === "refused"
          ? "Refused — it stays on Manager's own list"
          : "On Manager's own list";
  return {
    kind: "removal",
    isTest: row.isTest,
    customerId: row.id,
    managerName: nameOf(names, row.managerHrId),
    customerName: row.name,
    speciality: row.speciality,
    grade: row.grade || null,
    potentialGrade: row.potentialGrade || null,
    areaName: row.areaName,
    reason: row.removalReason,
    status,
    statusLabel,
    decisionNote: row.removalDecisionNote,
    approverName: row.approverHrId ? nameOf(names, row.approverHrId) : null,
    decideAs: status === "pending" ? managerAskDeciderRole(viewer, { approverHrId: row.approverHrId, isTest: row.isTest }) : null,
    isOwner: row.managerHrId === viewer.hrId,
  };
}

/**
 * The page for one id: a week, an ask to edit a week (shown on its week), or an own-list removal. Not
 * found for an id the viewer may not open — never a hint that it exists.
 */
export async function loadManagerPlanHubDetail(access: AccessContext, id: string): Promise<ManagerHubDetail> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NOT_FOUND;
  let viewer: PhoenixCrmViewer;
  try {
    viewer = await resolvePhoenixCrmViewer(access);
  } catch {
    return NOT_FOUND;
  }
  const plan = await loadManagerPlanRow(id, viewer.isTestPersona);
  if (plan) return planDetail(viewer, plan, null);
  const ask = await loadEditAskRow(id);
  if (ask && ask.isTest === viewer.isTestPersona) {
    const askPlan = await loadManagerPlanRow(ask.planId, ask.isTest);
    return askPlan ? planDetail(viewer, askPlan, ask.requestId) : NOT_FOUND;
  }
  return removalDetail(viewer, id);
}
