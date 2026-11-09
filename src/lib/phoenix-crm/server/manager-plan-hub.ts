/**
 * Phoenix CRM — one manager's week, his ask to edit it, his ask to take a customer off his own list, or a
 * district manager's ask for another day of single visits (owner, 2026-10-20), as
 * the Approvals Hub's plan page shows it (owner, 2026-10-16: "decided in the Approvals Hub, as today"). A
 * district manager's since 2026-10-16; a regional, national or product manager's since 2026-10-17. The
 * Hub's page falls through to this when the id is not a legacy plan.
 *
 * Who may open it: whoever reads that manager's plan (`readsManagerPlanOf` — he himself, the managers above
 * him, SFE, the CEO and the Super Admin), plus the approver stored on the row — the CEO and the Marketing
 * Manager open a regional, national or product manager's week this way. Who may decide
 * it: the approver stored for the step, or the Administrator in his place — the same predicates the write
 * routes enforce, so a button is never shown that the server would refuse.
 *
 * 🔴 The Approvals Hub's own service must NEVER import this file: it reaches the notice senders through
 * `manager-plans.ts`, and the notification layer imports the Hub's service.
 */

import type { AccessContext } from "@/lib/auth/permissions";
import { addDaysIso } from "@/lib/crm/dates";
import { logError } from "@/lib/observability/log";
import { formatPhoenixDateTime, formatPhoenixLongDate } from "@/lib/i18n/format";
import {
  DM_SINGLE_VISIT_HALF_DAYS_MAX,
  freeSingleVisitHalves,
  isManagerAskLive,
  isManagerWeekEndedUndecided,
  isSingleVisitDayAskLive,
  managerAskStage,
  managerPlanConversationOpen,
  managerPlanConversationView,
  managerPlannerTitle,
  managerPlanStage,
  managerPlanStatusLabel,
  nextManagerPlanStatus,
  returnStageOfApproved,
  singleVisitDayAskStatusLabel,
  type ManagerPlanConversationView,
  type ManagerPlanStage,
  type ManagerPlanStatus,
  type SingleVisitDayAskStatus,
} from "@/lib/phoenix-crm/manager-plan-rules";
import { readsRegionalTeamReports, resolvePhoenixCrmViewer, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadWeekHalfNotes } from "@/lib/phoenix-crm/server/manager-plan-bookings";
import { loadManagerCustomerRow } from "@/lib/phoenix-crm/server/manager-customers";
import {
  managerAskDeciderRole,
  managerPlanDeciderRole,
  managerPlanWriterFor,
  mayOpenManagerRecord,
  type ManagerPlanDeciderRole,
} from "@/lib/phoenix-crm/server/manager-plan-reach";
import { loadEditAskRow, loadEditAsks, loadManagerPlanRow, type ManagerEditAskRow, type ManagerPlanRow } from "@/lib/phoenix-crm/server/manager-plan-rows";
import { loadManagerPlanBoardFor, type ManagerPlanBoardView } from "@/lib/phoenix-crm/server/manager-plans";
import { loadSingleVisitHalvesUsed } from "@/lib/phoenix-crm/server/manager-single-visit-cap";
import { loadApprovedSingleVisitDates, loadSingleVisitDayAskRow } from "@/lib/phoenix-crm/server/manager-single-visit-day-rows";
import { loadPeopleNames, nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";

/** "closed": an ask that ended with its week, undecided at that step. */
export type ManagerHubStepState = "done" | "current" | "waiting" | "returned" | "refused" | "closed";

export type ManagerHubStep = { label: string; who: string; state: ManagerHubStepState; at: string | null };

export type ManagerHubAsk = {
  requestId: string;
  reason: string;
  askedAt: string | null;
  status: ManagerEditAskRow["status"];
  statusLabel: string;
  decisionNote: string | null;
  /** The step it waits on — sent back with the decision, so a step already taken is never taken twice. */
  stage: ManagerPlanStage | null;
  /** Asked, the regional manager (or NSM), then the NSM above a regional manager (owner, 2026-10-17). */
  steps: ManagerHubStep[];
  /** The viewer decides this step now: its holder, or the Administrator. */
  decideAs: ManagerPlanDeciderRole | null;
  /** At the first step, the NSM who approves after it — the reopening waits for him too. */
  thenName: string | null;
  version: number;
};

export type ManagerHubPlanDetail = {
  kind: "plan";
  /**
   * A regional sales manager reading a district manager's week only (owner, 2026-11-08, Dr. Hany Saad): the neutral
   * Chain visit and leave lines under each with-a-rep half, keyed "<date>|<half>". Absent for every other reader.
   */
  halfNotes?: Record<string, string[]>;
  isTest: boolean;
  planId: string;
  managerName: string;
  /** "District manager", "Regional sales manager", "National sales manager", "Product manager". */
  managerTitle: string;
  weekText: string;
  status: ManagerPlanStatus;
  statusLabel: string;
  sentAt: string | null;
  sentLate: boolean;
  decisionNote: string | null;
  returnedDayText: string | null;
  /**
   * The week was sent but its Thursday passed before it was decided: the day it ended, which the page says in
   * place of a button nobody can press (owner, 2026-11-08). Null on every other week.
   */
  endedUndecidedOnText: string | null;
  steps: ManagerHubStep[];
  board: ManagerPlanBoardView;
  /** The viewer decides the week now (approve, return the week, return one day). */
  decideAs: ManagerPlanDeciderRole | null;
  /**
   * Approve is open at this status. An approved week still reaches its last approver — to return it before
   * it ends — but never to approve it again, which the server refuses as "already moved on".
   */
  canApprove: boolean;
  /** At the first step, the NSM who approves the week after it. */
  thenName: string | null;
  version: number;
  /** The days a return may name. */
  returnableDays: Array<{ date: string; dateText: string }>;
  /** The ask to edit this page was opened for, or the one waiting on the week. */
  ask: ManagerHubAsk | null;
  isOwner: boolean;
  /** The week's conversation; null until the week has been sent (owner, 2026-11-01). */
  conversation: ManagerPlanConversationView | null;
};

export type ManagerHubRemovalDetail = {
  kind: "removal";
  isTest: boolean;
  customerId: string;
  managerName: string;
  managerTitle: string;
  customerName: string;
  speciality: string | null;
  grade: string | null;
  potentialGrade: string | null;
  areaName: string | null;
  reason: string | null;
  /** When this ask was raised — sent back with the decision, so a re-raised ask is never decided unread. */
  requestedAt: string | null;
  /** "first_approved": the regional manager agreed, and the NSM above him decides next. */
  status: "pending" | "first_approved" | "removed" | "refused" | "active";
  statusLabel: string;
  decisionNote: string | null;
  approverName: string | null;
  /** The step it waits on — sent back with the decision. */
  stage: ManagerPlanStage | null;
  steps: ManagerHubStep[];
  decideAs: ManagerPlanDeciderRole | null;
  /** At the first step, the NSM who approves after it — the customer stays on the list until then. */
  thenName: string | null;
  isOwner: boolean;
};

/** A district manager's ask for another day of single visits (owner, 2026-10-20). */
export type ManagerHubSingleVisitDayDetail = {
  kind: "single_visit_day";
  isTest: boolean;
  requestId: string;
  managerName: string;
  managerTitle: string;
  visitDateText: string;
  weekText: string;
  /** Optional: he may ask without writing why. */
  reason: string | null;
  status: SingleVisitDayAskStatus;
  statusLabel: string;
  decisionNote: string | null;
  /** What his week already spends on single visits, so the approver reads the ask against it. */
  weekLine: string;
  /** The step it waits on — sent back with the decision. */
  stage: ManagerPlanStage | null;
  steps: ManagerHubStep[];
  decideAs: ManagerPlanDeciderRole | null;
  /** At the first step, the NSM who approves after it — the day opens only then. */
  thenName: string | null;
  version: number;
  isOwner: boolean;
};

export type ManagerHubDetail = { kind: "not_found" } | ManagerHubPlanDetail | ManagerHubRemovalDetail | ManagerHubSingleVisitDayDetail;

const NOT_FOUND: ManagerHubDetail = { kind: "not_found" };

function at(value: string | null): string | null {
  return value ? formatPhoenixDateTime(value) : null;
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
  // A regional, national or product manager's week is acknowledged by HR on its own once approved, as his
  // legacy plan is (owner, 2026-10-17: "as today HR auto acknowledge"); a district manager's has no HR step.
  if (plan.plannerKind !== "dm") {
    steps.push({
      label: "HR acknowledgement",
      who: "HR, automatically",
      state: plan.hrAcknowledgedAt ? "done" : "waiting",
      at: at(plan.hrAcknowledgedAt),
    });
  }
  return steps;
}

/** An ask (to edit a week, or to take a customer off his own list) as the tracker reads it. */
type AskTrack = {
  askedLabel: string;
  askerHrId: string;
  askedAt: string | null;
  /** "open" waits on the first step, "first_approved" on the second; "approved" is the last approval. */
  status: "open" | "first_approved" | "approved" | "refused" | "expired";
  approverHrId: string | null;
  secondApproverHrId: string | null;
  firstDecidedByHrId: string | null;
  firstDecidedRole: string | null;
  firstDecidedAt: string | null;
  decidedByHrId: string | null;
  decidedRole: string | null;
  decidedAt: string | null;
};

/**
 * The tracker of an ask: asked, the regional manager (or the NSM), then — where one was stored — the NSM
 * above a regional manager (owner, 2026-10-17: "Week + edit asks + removals"). A refusal at the first
 * step closes it there; a refusal at the second leaves the first step done.
 */
export function askSteps(ask: AskTrack, names: PeopleNames): ManagerHubStep[] {
  const hasSecond = ask.secondApproverHrId !== null;
  const firstTaken = ask.firstDecidedAt !== null;
  const steps: ManagerHubStep[] = [{ label: ask.askedLabel, who: nameOf(names, ask.askerHrId), state: "done", at: at(ask.askedAt) }];
  const approverName = ask.approverHrId ? nameOf(names, ask.approverHrId) : "The approver";
  const finalWho = who(names, ask.decidedByHrId, ask.decidedRole, "The approver");

  if (ask.status === "open") steps.push({ label: "Manager approval", who: approverName, state: "current", at: null });
  else if (firstTaken) steps.push({ label: "Manager approval", who: who(names, ask.firstDecidedByHrId, ask.firstDecidedRole, approverName), state: "done", at: at(ask.firstDecidedAt) });
  else if (ask.status === "approved") steps.push({ label: "Manager approval", who: finalWho, state: "done", at: at(ask.decidedAt) });
  else if (ask.status === "refused") steps.push({ label: "Manager approval", who: finalWho, state: "refused", at: at(ask.decidedAt) });
  else steps.push({ label: "Manager approval", who: approverName, state: "closed", at: at(ask.decidedAt) });

  // The second step shows while it can still be reached, or once it was; an ask closed at the first step
  // never reached it, so it is not drawn as still to come.
  if (hasSecond && (ask.status === "open" || firstTaken)) {
    const secondName = nameOf(names, ask.secondApproverHrId);
    if (ask.status === "open") steps.push({ label: "Second approval", who: secondName, state: "waiting", at: null });
    else if (ask.status === "first_approved") steps.push({ label: "Second approval", who: secondName, state: "current", at: null });
    else if (ask.status === "approved") steps.push({ label: "Second approval", who: finalWho, state: "done", at: at(ask.decidedAt) });
    else if (ask.status === "refused") steps.push({ label: "Second approval", who: finalWho, state: "refused", at: at(ask.decidedAt) });
    else steps.push({ label: "Second approval", who: secondName, state: "closed", at: at(ask.decidedAt) });
  }
  return steps;
}

function editAskTrack(ask: ManagerEditAskRow): AskTrack {
  return {
    askedLabel: "Asked to edit",
    askerHrId: ask.managerHrId,
    askedAt: ask.createdAt,
    status: ask.status === "pending" ? "open" : ask.status === "reopened" ? "approved" : ask.status,
    approverHrId: ask.approverHrId,
    secondApproverHrId: ask.secondApproverHrId,
    firstDecidedByHrId: ask.firstDecidedByHrId,
    firstDecidedRole: ask.firstDecidedRole,
    firstDecidedAt: ask.firstDecidedAt,
    decidedByHrId: ask.decidedByHrId,
    decidedRole: ask.decidedRole,
    decidedAt: ask.decidedAt,
  };
}

function editAskStatusLabel(ask: ManagerEditAskRow, names: PeopleNames): string {
  if (ask.status === "pending") return `Waiting for ${nameOf(names, ask.approverHrId)}`;
  if (ask.status === "first_approved") return `Waiting for ${ask.secondApproverHrId ? nameOf(names, ask.secondApproverHrId) : "the second approver"}`;
  if (ask.status === "reopened") return "Reopened for editing";
  if (ask.status === "expired") return "Closed when the week ended";
  return "Refused — the week stays as sent";
}

async function planDetail(viewer: PhoenixCrmViewer, plan: ManagerPlanRow, askId: string | null): Promise<ManagerHubDetail> {
  const asks = await loadEditAsks([plan.planId]);
  const ask = (askId ? asks.find((entry) => entry.requestId === askId) : asks.find((entry) => isManagerAskLive(entry.status, plan.status))) ?? null;
  if (!mayOpenManagerRecord(viewer, plan.managerHrId, [plan.firstApproverHrId, plan.secondApproverHrId, ask?.approverHrId ?? null, ask?.secondApproverHrId ?? null])) return NOT_FOUND;

  const [board, names] = await Promise.all([
    loadManagerPlanBoardFor(viewer, plan.managerHrId, plan.weekStart, plan.isTest),
    loadPeopleNames([
      plan.managerHrId,
      plan.firstApproverHrId,
      plan.secondApproverHrId,
      plan.firstDecidedByHrId,
      plan.decidedByHrId,
      ask?.approverHrId,
      ask?.secondApproverHrId,
      ask?.firstDecidedByHrId,
      ask?.decidedByHrId,
    ]),
  ]);
  // A regional sales manager reading a district manager's week sees who else is with each rep that day
  // (owner, 2026-11-08). Information only; a failed read leaves the page as it was.
  const halfNotes =
    plan.plannerKind === "dm" && readsRegionalTeamReports(viewer)
      ? await loadWeekHalfNotes({
          halves: board.days.flatMap((day) =>
            day.slots.flatMap((slot) =>
              slot.kind === "with_rep" && slot.repSeatId ? [{ date: day.date, half: slot.half, repName: slot.repName ?? "the rep", repSeatId: slot.repSeatId }] : [],
            ),
          ),
          plannerHrId: plan.managerHrId,
          viewer,
          weekStart: plan.weekStart,
        }).catch((error: unknown) => {
          logError("Phoenix CRM: the chain visit lines of a district manager's week could not be read", {
            error,
            labels: { event: "phoenix_crm_week_half_notes_unread" },
          });
          return undefined;
        })
      : undefined;
  // A decision is offered only on an ask whose week is still a sent one: Reopen on any other would only fail.
  const askStage = ask && isManagerAskLive(ask.status, plan.status) ? managerAskStage(ask.status) : null;
  const hasSecond = plan.secondApproverHrId !== null;
  const stage: ManagerPlanStage | null = plan.status === "approved" ? returnStageOfApproved(hasSecond) : managerPlanStage(plan.status);
  const decideAs =
    stage && (plan.status === "submitted" || plan.status === "first_approved" || plan.status === "approved")
      ? managerPlanDeciderRole(viewer, { stage, firstApproverHrId: plan.firstApproverHrId, secondApproverHrId: plan.secondApproverHrId, isTest: plan.isTest })
      : null;
  // A week already approved is returned only by its last approver, and only before it has ended.
  const weekOpen = addDaysIso(plan.weekStart, 5) >= viewer.cairoToday;
  const endedUndecided = isManagerWeekEndedUndecided(plan.status, plan.weekStart, viewer.cairoToday);
  return {
    kind: "plan",
    ...(halfNotes ? { halfNotes } : {}),
    isTest: plan.isTest,
    planId: plan.planId,
    managerName: nameOf(names, plan.managerHrId),
    managerTitle: managerPlannerTitle(plan.plannerKind, managerPlanWriterFor(viewer, plan.managerHrId)?.jobTitle),
    weekText: `Week of ${formatPhoenixLongDate(plan.weekStart)}`,
    status: plan.status,
    statusLabel: managerPlanStatusLabel(plan.status, { weekStart: plan.weekStart, cairoToday: viewer.cairoToday }),
    sentAt: at(plan.submittedAt),
    sentLate: plan.submittedLate === true,
    decisionNote: plan.decisionNote ?? plan.firstDecisionNote,
    returnedDayText: plan.returnedDay ? formatPhoenixLongDate(plan.returnedDay) : null,
    endedUndecidedOnText: endedUndecided ? formatPhoenixLongDate(addDaysIso(plan.weekStart, 5)) : null,
    steps: planSteps(plan, names),
    board,
    decideAs: weekOpen ? decideAs : null,
    canApprove: nextManagerPlanStatus({ action: "approve", status: plan.status, stage, hasSecond }) !== null,
    thenName: plan.status === "submitted" && plan.secondApproverHrId ? nameOf(names, plan.secondApproverHrId) : null,
    version: plan.version,
    returnableDays: board.days.filter((day) => day.halves.length > 0).map((day) => ({ date: day.date, dateText: day.dateText })),
    ask: ask
      ? {
          requestId: ask.requestId,
          reason: ask.reason,
          askedAt: at(ask.createdAt),
          status: ask.status,
          statusLabel: editAskStatusLabel(ask, names),
          decisionNote: ask.decisionNote ?? ask.firstDecisionNote,
          stage: askStage,
          steps: askSteps(editAskTrack(ask), names),
          decideAs: askStage
            ? managerAskDeciderRole(viewer, { stage: askStage, approverHrId: ask.approverHrId, secondApproverHrId: ask.secondApproverHrId, isTest: ask.isTest })
            : null,
          thenName: askStage === "first" && ask.secondApproverHrId ? nameOf(names, ask.secondApproverHrId) : null,
          version: ask.version,
        }
      : null,
    isOwner: plan.managerHrId === viewer.hrId,
    conversation: managerPlanConversationOpen(plan)
      ? managerPlanConversationView({
          planId: plan.planId,
          isTest: plan.isTest,
          managerName: nameOf(names, plan.managerHrId),
          approverNames: [plan.firstApproverHrId, plan.secondApproverHrId].map((hrId) => (hrId ? nameOf(names, hrId) : null)),
          self: plan.managerHrId === viewer.hrId,
        })
      : null,
  };
}

async function removalDetail(viewer: PhoenixCrmViewer, id: string): Promise<ManagerHubDetail> {
  const row = await loadManagerCustomerRow(id);
  if (!row || row.isTest !== viewer.isTestPersona) return NOT_FOUND;
  if (!mayOpenManagerRecord(viewer, row.managerHrId, [row.approverHrId, row.secondApproverHrId])) return NOT_FOUND;
  const names = await loadPeopleNames([row.managerHrId, row.approverHrId, row.secondApproverHrId, row.firstDecidedByHrId, row.decidedByHrId]);
  // A refusal puts the customer back to active; its decision stamp tells it from one never asked.
  const refused = row.status === "active" && row.decidedAt !== null;
  const status: ManagerHubRemovalDetail["status"] =
    row.status === "removal_pending"
      ? "pending"
      : row.status === "removal_first_approved"
        ? "first_approved"
        : row.status === "removed"
          ? "removed"
          : refused
            ? "refused"
            : "active";
  const statusLabel =
    status === "pending"
      ? `Waiting for ${row.approverHrId ? nameOf(names, row.approverHrId) : "the approver"}`
      : status === "first_approved"
        ? `Waiting for ${row.secondApproverHrId ? nameOf(names, row.secondApproverHrId) : "the second approver"}`
        : status === "removed"
          ? "Removed from Manager's own list"
          : status === "refused"
            ? "Refused — it stays on Manager's own list"
            : "On Manager's own list";
  const stage = managerAskStage(row.status);
  return {
    kind: "removal",
    isTest: row.isTest,
    customerId: row.id,
    managerName: nameOf(names, row.managerHrId),
    managerTitle: managerPlannerTitle(managerPlanWriterFor(viewer, row.managerHrId)?.kind ?? "dm", managerPlanWriterFor(viewer, row.managerHrId)?.jobTitle),
    customerName: row.name,
    speciality: row.speciality,
    grade: row.grade || null,
    potentialGrade: row.potentialGrade || null,
    areaName: row.areaName,
    reason: row.removalReason,
    requestedAt: row.removalRequestedAt,
    status,
    statusLabel,
    decisionNote: row.removalDecisionNote,
    approverName: row.approverHrId ? nameOf(names, row.approverHrId) : null,
    stage,
    steps:
      status === "active" || !row.removalRequestedAt
        ? []
        : askSteps(
            {
              askedLabel: "Asked to remove",
              askerHrId: row.managerHrId,
              askedAt: row.removalRequestedAt,
              status: status === "pending" ? "open" : status === "first_approved" ? "first_approved" : status === "removed" ? "approved" : "refused",
              approverHrId: row.approverHrId,
              secondApproverHrId: row.secondApproverHrId,
              firstDecidedByHrId: row.firstDecidedByHrId,
              firstDecidedRole: row.firstDecidedRole,
              firstDecidedAt: row.firstDecidedAt,
              decidedByHrId: row.decidedByHrId,
              decidedRole: row.decidedRole,
              decidedAt: row.decidedAt,
            },
            names,
          ),
    decideAs: stage
      ? managerAskDeciderRole(viewer, { stage, approverHrId: row.approverHrId, secondApproverHrId: row.secondApproverHrId, isTest: row.isTest })
      : null,
    thenName: stage === "first" && row.secondApproverHrId ? nameOf(names, row.secondApproverHrId) : null,
    isOwner: row.managerHrId === viewer.hrId,
  };
}

async function singleVisitDayDetail(viewer: PhoenixCrmViewer, id: string): Promise<ManagerHubDetail | null> {
  const ask = await loadSingleVisitDayAskRow(id);
  if (!ask) return null;
  if (ask.isTest !== viewer.isTestPersona) return NOT_FOUND;
  if (!mayOpenManagerRecord(viewer, ask.managerHrId, [ask.approverHrId, ask.secondApproverHrId])) return NOT_FOUND;
  const input = { managerHrId: ask.managerHrId, weekStart: ask.weekStart, isTest: ask.isTest };
  const [names, used, approvedDates] = await Promise.all([
    loadPeopleNames([ask.managerHrId, ask.approverHrId, ask.secondApproverHrId, ask.firstDecidedByHrId, ask.decidedByHrId]),
    loadSingleVisitHalvesUsed(input),
    loadApprovedSingleVisitDates(input),
  ]);
  const live = isSingleVisitDayAskLive(ask.status, ask.visitDate, viewer.cairoToday);
  const stage = live ? managerAskStage(ask.status) : null;
  const waitingOn = ask.status === "pending" ? ask.approverHrId : ask.status === "first_approved" ? ask.secondApproverHrId : null;
  const free = freeSingleVisitHalves(used, approvedDates).size;
  const otherApproved = [...approvedDates].filter((date) => date !== ask.visitDate).length;
  return {
    kind: "single_visit_day",
    isTest: ask.isTest,
    requestId: ask.requestId,
    managerName: nameOf(names, ask.managerHrId),
    managerTitle: managerPlannerTitle("dm"),
    visitDateText: formatPhoenixLongDate(ask.visitDate),
    weekText: `Week of ${formatPhoenixLongDate(ask.weekStart)}`,
    reason: ask.reason,
    status: ask.status,
    statusLabel: singleVisitDayAskStatusLabel(ask.status, waitingOn ? nameOf(names, waitingOn) : null, live),
    decisionNote: ask.decisionNote ?? ask.firstDecisionNote,
    weekLine: `The day of single visits without approval: ${free} of ${DM_SINGLE_VISIT_HALF_DAYS_MAX} half-days used this week.${
      otherApproved > 0 ? ` ${otherApproved === 1 ? "One other day is" : `${otherApproved} other days are`} already approved.` : ""
    }`,
    stage,
    steps: askSteps(
      {
        askedLabel: "Asked for the day",
        askerHrId: ask.managerHrId,
        askedAt: ask.createdAt,
        status:
          ask.status === "pending"
            ? live
              ? "open"
              : "expired"
            : ask.status === "first_approved"
              ? live
                ? "first_approved"
                : "expired"
              : ask.status,
        approverHrId: ask.approverHrId,
        secondApproverHrId: ask.secondApproverHrId,
        firstDecidedByHrId: ask.firstDecidedByHrId,
        firstDecidedRole: ask.firstDecidedRole,
        firstDecidedAt: ask.firstDecidedAt,
        decidedByHrId: ask.decidedByHrId,
        decidedRole: ask.decidedRole,
        decidedAt: ask.decidedAt,
      },
      names,
    ),
    decideAs: stage
      ? managerAskDeciderRole(viewer, { stage, approverHrId: ask.approverHrId, secondApproverHrId: ask.secondApproverHrId, isTest: ask.isTest })
      : null,
    thenName: stage === "first" && ask.secondApproverHrId ? nameOf(names, ask.secondApproverHrId) : null,
    version: ask.version,
    isOwner: ask.managerHrId === viewer.hrId,
  };
}

/**
 * The page for one id: a week, an ask to edit a week (shown on its week), an ask for another day of single
 * visits, or an own-list removal. Not
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
  const dayAsk = await singleVisitDayDetail(viewer, id);
  if (dayAsk) return dayAsk;
  return removalDetail(viewer, id);
}
