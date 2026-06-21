import type { AccessContext } from "@/lib/auth/permissions";
import type { ActionHubItem, MyRequestItem, MyRequestStatusTone } from "@/components/action-center/types";
import { vacationTypeLabel } from "@/lib/vacation/calculations";
import { getVacationActionCenterData, getVacationReportData } from "@/lib/vacation/service";
import { getExcuseWorkspace, getManagerPendingExcuses, type EmployeeExcuseRequest } from "@/lib/excuses/service";
import { listMedicalRepExpenseRequests, listOutstationRequests } from "@/lib/outstation/service";
import {
  getEmployeePlansWorkspace,
  getPlansAwaitingAction,
  type ApproverPendingPlan,
  type EmployeePlan,
} from "@/lib/weekly-planning/service";
import { getMyResignations, getResignationsDashboardData } from "@/lib/resignations/service";
import { getContractRenewalDashboardData } from "@/lib/contracts/service";
import type { VacationActionCenterRow, VacationRequestRecord } from "@/lib/vacation/types";
import type { OutstationExpenseRequest } from "@/lib/outstation/types";
import type { ResignationRecord } from "@/lib/resignations/types";
import type { ContractRow } from "@/lib/contracts/types";
import { getApproverPendingRequests, getMarketingRequestDraftWorkspace } from "@/lib/marketing-requests/service";
import type { MarketingApprovedRequestRow, MarketingRequest } from "@/lib/marketing-requests/types";
import { listUnifiedOutstationExpenses } from "@/lib/payroll/expenses";
import type { PayrollExpenseApproval } from "@/lib/payroll/types";
import {
  EMPTY_PORTAL_ATTENTION_INBOX,
  type ActionHubUrgency,
  type PortalAttentionInbox,
  type PortalAttentionItem,
  type PortalAttentionModule,
} from "@/components/action-center/types";

// Case-insensitive HR_ID equality (matches the `.ilike` comparisons used across the
// domain services). Guards each source so a manager viewing their own list never sees
// a direct report's request leak in.
function sameHrId(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (v: string | null | undefined) => String(v ?? "").trim().toUpperCase();
  const left = norm(a);
  return left.length > 0 && left === norm(b);
}

// Normalize any module's raw status token into a small set of display tones.
function toTone(status: string): MyRequestStatusTone {
  const s = String(status ?? "").toLowerCase();
  if (/(reject|declin|denied|cancel)/.test(s)) return "rejected";
  if (/(return|needs_edit|sent_back|resubmit)/.test(s)) return "returned";
  if (/(approv|acknowledg|complet|finaliz|active|accepted)/.test(s)) return "approved";
  if (/(pending|submit|review|await|draft|needs_assignment|in_progress|current)/.test(s)) return "pending";
  return "neutral";
}

function humanize(status: string): string {
  return String(status ?? "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function mapVacation(row: VacationRequestRecord): MyRequestItem {
  const type = vacationTypeLabel(row.vacationType);
  return {
    id: `leave:${row.id}`,
    module: "leave",
    title: `${type} · ${Number(row.durationDays)} day${row.durationDays === 1 ? "" : "s"}`,
    statusLabel: humanize(row.status),
    statusTone: toTone(row.status),
    submittedAt: row.createdAt,
    href: null,
    lines: [
      { label: "Type", value: type },
      { label: "From", value: row.startDate },
      { label: "To", value: row.endDate },
    ],
    decisionNote: row.hrDecisionComment ?? row.managerDecisionComment ?? null,
  };
}

function mapExcuse(row: EmployeeExcuseRequest): MyRequestItem {
  return {
    id: `excuse:${row.id}`,
    module: "excuse",
    title: `${row.excuseType === "morning" ? "Morning" : "Afternoon"} excuse · ${row.excuseDate}`,
    statusLabel: humanize(row.status),
    statusTone: toTone(row.status),
    submittedAt: row.createdAt,
    href: null,
    lines: [
      { label: "Date", value: row.excuseDate },
      { label: "Duration", value: `${row.durationHours} hours` },
    ],
    decisionNote: null,
  };
}

function mapOutstation(row: OutstationExpenseRequest): MyRequestItem {
  const status = row.status ?? "submitted";
  return {
    id: `outstation:${row.id}`,
    module: "outstation",
    title: `Outstation · ${row.tripStartDate}`,
    statusLabel: humanize(status),
    statusTone: toTone(status),
    submittedAt: row.createdAt,
    href: null,
    lines: [
      { label: "Type", value: String(row.expenseType) },
      { label: "Trip start", value: row.tripStartDate },
      { label: "Claimed", value: `${Number(row.claimedTotalAmount || 0).toLocaleString("en-EG", { maximumFractionDigits: 2 })} EGP` },
    ],
    decisionNote: row.reportHrNotes ?? null,
  };
}

function mapPlan(row: EmployeePlan): MyRequestItem {
  return {
    id: `weekly_plan:${row.id}`,
    module: "weekly_plan",
    title: `Weekly plan · ${row.periodKey}`,
    statusLabel: humanize(row.status),
    statusTone: toTone(row.status),
    submittedAt: row.submittedAt ?? row.updatedAt,
    href: null,
    lines: [
      { label: "Period", value: row.periodStartDate },
      ...(row.managerName ? [{ label: "Manager", value: row.managerName }] : []),
    ],
    decisionNote: null,
  };
}

function mapResignationRecord(row: ResignationRecord): MyRequestItem {
  return {
    id: `resignation:${row.id}`,
    module: "resignation",
    title: `Resignation · effective ${row.effectiveDate}`,
    statusLabel: humanize(row.status),
    statusTone: toTone(row.status),
    submittedAt: row.createdAt,
    href: null,
    lines: [
      { label: "Effective", value: row.effectiveDate },
      { label: "Submitted", value: row.submittedDate },
    ],
    decisionNote: row.rejectedReason ?? row.workflowNotes ?? null,
  };
}

function mapMarketingRequest(row: MarketingRequest): MyRequestItem {
  return {
    id: `marketing:${row.id}`,
    module: "marketing",
    title: `Marketing · ${row.requestCode}`,
    statusLabel: humanize(row.status),
    statusTone: toTone(row.status),
    submittedAt: row.submittedAt ?? row.createdAt,
    href: null,
    lines: [
      { label: "Code", value: row.requestCode },
      {
        label: "Est. cost",
        value: `${Number(row.estimatedCost || 0).toLocaleString("en-EG", { maximumFractionDigits: 0 })} EGP`,
      },
    ],
    decisionNote: null,
  };
}

function mapMarketingApproved(row: MarketingApprovedRequestRow): MyRequestItem {
  return {
    id: `marketing:${row.id}`,
    module: "marketing",
    title: `Marketing · ${row.requestCode}`,
    statusLabel: humanize(row.status),
    statusTone: toTone(row.status),
    submittedAt: "",
    href: null,
    lines: [
      { label: "Code", value: row.requestCode },
      { label: "Customer", value: row.customerName },
    ],
    decisionNote: null,
  };
}

/**
 * Aggregate every request the signed-in employee submitted themselves, across
 * modules, into one uniform list for the Actions "My requests" tab.
 *
 * Each source is resolved independently and failures degrade to "no items for
 * that module" (a non-eligible employee — e.g. a non-medical-rep with no
 * outstation access — simply contributes nothing) rather than failing the page.
 * Every source is additionally filtered to the caller's own HR_ID as a guard,
 * so a manager viewing their own list never sees a direct report's request here.
 */
export async function getMyRequestItems(access: AccessContext): Promise<MyRequestItem[]> {
  const hrId = access.hrId?.trim() ?? "";
  if (!hrId) return [];

  const settled = await Promise.allSettled([
    getVacationReportData(access, { employee: hrId }).catch(() => null),
    getExcuseWorkspace(access).catch(() => null),
    listMedicalRepExpenseRequests(access).catch(() => null),
    getEmployeePlansWorkspace(access).catch(() => null),
    getMyResignations(access).catch(() => null),
    getMarketingRequestDraftWorkspace(access).catch(() => null),
  ]);

  const [vacation, excuse, outstation, plans, resignations, marketing] = settled;
  const items: MyRequestItem[] = [];

  if (vacation.status === "fulfilled" && vacation.value) {
    for (const row of vacation.value.rows) {
      if (sameHrId(row.employeeHrId, hrId)) items.push(mapVacation(row));
    }
  }
  if (excuse.status === "fulfilled" && excuse.value) {
    for (const row of excuse.value.requests) items.push(mapExcuse(row));
  }
  if (outstation.status === "fulfilled" && outstation.value) {
    for (const row of outstation.value) {
      if (sameHrId(row.employeeHrId, hrId)) items.push(mapOutstation(row));
    }
  }
  if (plans.status === "fulfilled" && plans.value) {
    for (const row of plans.value.plans) {
      if (sameHrId(row.employeeHrId, hrId)) items.push(mapPlan(row));
    }
  }
  if (resignations.status === "fulfilled" && resignations.value) {
    for (const row of resignations.value) items.push(mapResignationRecord(row));
  }
  if (marketing.status === "fulfilled" && marketing.value) {
    const workspace = marketing.value;
    // Dedupe by request id across the draft-workspace buckets and guard to the
    // caller's own requests so a manager never sees a report's request here.
    const ownById = new Map<string, MyRequestItem>();
    for (const row of [...workspace.drafts, ...workspace.inApproval, ...workspace.returned]) {
      if (sameHrId(row.requesterHrId, hrId)) ownById.set(row.id, mapMarketingRequest(row));
    }
    for (const row of workspace.approvedRequests) {
      if (sameHrId(row.requesterHrId, hrId)) ownById.set(row.id, mapMarketingApproved(row));
    }
    for (const item of ownById.values()) items.push(item);
  }

  items.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  return items;
}

// ── "Awaiting my action" inbox (approver-side) ────────────────────────────────
// Cross-module aggregation of items pending the caller's decision, reused by both
// the admin Actions page and the employee-portal Actions page.
//
// SECURITY: the "portal" audience includes ONLY access-scoped, manager-relevant
// sources — vacation (role-scoped to the caller's team/hierarchy/line), excuse
// (scoped to the caller's manager_hr_id), and weekly plans (scoped to the plan's
// manager_hr_id / CEO gate). The unscoped HR/admin sources (all resignations, all
// outstation, contract renewals) are admin-shell only and are never aggregated for
// a portal manager.

const ACTIVE_CONTRACT_STATUSES = new Set(["requested", "manager_review", "hr_review"]);

function mapLeaveItem(row: VacationActionCenterRow): ActionHubItem {
  const typeLabel = vacationTypeLabel(row.vacationType);
  return {
    id: row.id,
    module: "leave",
    employeeName: row.employeeName,
    employeeHrId: row.employeeHrId,
    title: `${typeLabel} · ${row.durationDays} day${row.durationDays === 1 ? "" : "s"}`,
    statusLabel: row.status.replace(/_/g, " "),
    submittedAt: row.createdAt,
    urgency: row.slaAgeDays >= 3 ? "high" : "normal",
    slaAgeDays: row.slaAgeDays,
    slaIsOverdue: row.slaAgeDays >= 3,
    detail: {
      module: "leave",
      vacationType: typeLabel,
      startDate: row.startDate,
      endDate: row.endDate,
      durationDays: row.durationDays,
      paymentStatus: row.paymentStatus,
      balanceBeforeDays: row.balanceBeforeDays,
      hrDecisionComment: row.hrDecisionComment,
      actionAvailability: Object.fromEntries(
        Object.entries(row.actionAvailability).map(([k, v]) => [k, (v as { enabled: boolean }).enabled]),
      ),
      approvalSteps: row.approvalSteps.map((step) => ({
        order: step.order,
        status: step.status,
        stepKey: step.stepKey,
        genericStep: step.genericStep,
        approverName: step.approverName,
        decidedAt: step.decidedAt,
        decisionComment: step.decisionComment,
      })),
      slaAgeDays: row.slaAgeDays,
    },
  };
}

function mapResignationItem(record: ResignationRecord): ActionHubItem {
  return {
    id: record.id,
    module: "resignation",
    employeeName: record.employeeName,
    employeeHrId: record.employeeHrId,
    title: `Resignation · ${record.effectiveDate}`,
    statusLabel: record.status.replace(/_/g, " "),
    submittedAt: record.createdAt,
    urgency: "high",
    detail: {
      module: "resignation",
      effectiveDate: record.effectiveDate,
      submittedDate: record.submittedDate,
      reason: record.reason,
      workflowNotes: record.workflowNotes,
      rejectedReason: record.rejectedReason,
      jobTitle: record.jobTitle,
      lineName: record.lineName,
    },
  };
}

function mapExcuseItem(request: EmployeeExcuseRequest): ActionHubItem {
  return {
    id: request.id,
    module: "excuse",
    employeeName: request.employeeName,
    employeeHrId: request.employeeHrId,
    title: `${request.excuseType === "morning" ? "Morning" : "Afternoon"} Excuse · ${request.excuseDate}`,
    statusLabel: "Pending review",
    submittedAt: request.createdAt,
    urgency: "normal",
    detail: {
      module: "excuse",
      excuseType: request.excuseType,
      excuseDate: request.excuseDate,
      durationHours: request.durationHours,
      managerName: request.managerName,
      departmentName: request.departmentName,
      lineName: request.lineName,
    },
  };
}

function mapOutstationItem(request: OutstationExpenseRequest): ActionHubItem {
  return {
    id: String(request.id),
    module: "outstation",
    employeeName: request.employeeName,
    employeeHrId: request.employeeHrId,
    title: `Outstation · ${request.tripStartDate}`,
    statusLabel: "Pending approval",
    submittedAt: request.createdAt,
    urgency: request.approvalRecommendation === "auto_approve" ? "low" : request.fraudFlags.length > 0 ? "high" : "normal",
    detail: {
      module: "outstation",
      expenseType: request.expenseType,
      tripStartDate: request.tripStartDate,
      tripEndDate: request.tripEndDate,
      toLabel: request.toLabel,
      allowanceAmount: request.allowanceAmount,
      claimedTotalAmount: request.claimedTotalAmount,
      approvalRecommendation: request.approvalRecommendation,
      approvalReason: request.approvalReason,
      fraudFlags: request.fraudFlags,
      notes: request.notes,
      requestId: request.id,
    },
  };
}

function mapContractRenewalItem(row: ContractRow): ActionHubItem | null {
  if (!row.workflow || !ACTIVE_CONTRACT_STATUSES.has(row.workflow.status)) return null;
  const w = row.workflow;
  return {
    id: w.id,
    module: "contract_renewal",
    employeeName: w.employeeName,
    employeeHrId: w.employeeHrId,
    title: `Contract Renewal · ${w.requestedRenewalDate}`,
    statusLabel: w.status.replace(/_/g, " "),
    submittedAt: w.createdAt,
    urgency: "high",
    detail: {
      module: "contract_renewal",
      requestedRenewalDate: w.requestedRenewalDate,
      proposedStartDate: w.proposedStartDate,
      proposedEndDate: w.proposedEndDate,
      jobTitle: w.jobTitle,
      lineName: w.lineName,
      areaName: w.areaName,
      workflowNotes: w.workflowNotes,
      decisionReason: w.decisionReason,
      currentStatus: w.status,
    },
  };
}

function mapWeeklyPlanItem(plan: ApproverPendingPlan): ActionHubItem {
  const kindLabel = plan.planKind === "weekly" ? "Weekly" : "Monthly";
  return {
    id: plan.id,
    module: "weekly_plan",
    employeeName: plan.employeeName,
    employeeHrId: plan.employeeHrId,
    title: `${kindLabel} plan · ${plan.periodKey}`,
    statusLabel: plan.stage === "manager" ? "Needs manager review" : "Needs CEO approval",
    submittedAt: plan.submittedAt,
    urgency: "normal",
    detail: {
      module: "weekly_plan",
      stage: plan.stage,
      planKind: plan.planKind,
      periodKey: plan.periodKey,
      periodStartDate: plan.periodStartDate,
      periodEndDate: plan.periodEndDate,
      employeeJobTitle: plan.employeeJobTitle,
      managerName: plan.managerName,
      itemCount: plan.itemCount,
      items: plan.items,
      reviewHref: plan.reviewHref,
    },
  };
}

export type ActionInboxAudience = "admin" | "portal";

export async function getAwaitingMyActionItems(
  access: AccessContext,
  audience: ActionInboxAudience,
): Promise<ActionHubItem[]> {
  // Marketing is intentionally excluded everywhere — it keeps its own dedicated inbox.
  const includeAdminSources = audience === "admin";
  const settled = await Promise.allSettled([
    getVacationActionCenterData(access).catch(() => null),
    getManagerPendingExcuses(access).catch(() => null),
    includeAdminSources ? getResignationsDashboardData().catch(() => null) : Promise.resolve(null),
    includeAdminSources ? listOutstationRequests().catch(() => null) : Promise.resolve(null),
    includeAdminSources ? getContractRenewalDashboardData(access).catch(() => null) : Promise.resolve(null),
    getPlansAwaitingAction(access).catch(() => null),
  ]);

  const [leave, excuse, resignations, outstation, contract, plans] = settled;
  const items: ActionHubItem[] = [];

  if (leave.status === "fulfilled" && leave.value) {
    for (const row of leave.value.rows) items.push(mapLeaveItem(row));
  }
  if (excuse.status === "fulfilled" && excuse.value) {
    for (const request of excuse.value) items.push(mapExcuseItem(request));
  }
  if (resignations.status === "fulfilled" && resignations.value) {
    for (const record of resignations.value.records) {
      if (record.status === "submitted" || record.status === "under_review") {
        items.push(mapResignationItem(record));
      }
    }
  }
  if (outstation.status === "fulfilled" && outstation.value) {
    for (const request of outstation.value) {
      if (request.status === "submitted") items.push(mapOutstationItem(request));
    }
  }
  if (contract.status === "fulfilled" && contract.value) {
    for (const row of contract.value.rows) {
      const item = mapContractRenewalItem(row);
      if (item) items.push(item);
    }
  }
  if (plans.status === "fulfilled" && plans.value) {
    for (const plan of plans.value) items.push(mapWeeklyPlanItem(plan));
  }

  items.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  return items;
}

// ── Portal Overview "Needs your attention" inbox ──────────────────────────────
// Role-adaptive feed used ONLY by the employee-portal Overview tile. Approver
// roles see items pending their decision (vacation / excuse / marketing / plan /
// team expenses); everyone sees items returned to them for action. Each source is
// independently access-scoped — this NEVER widens the Actions-Center portal
// audience. Heavy fetches (myRequests, expenses) can be injected by the caller to
// avoid duplicate work when the overview payload already loaded them.

const PORTAL_ATTENTION_RETURNED_HREF: Record<PortalAttentionModule, string> = {
  leave: "/employee-portals/actions",
  excuse: "/employee-portals/actions",
  marketing: "/employee-portals/marketing-requests",
  outstation: "/employee-portals/expenses",
  weekly_plan: "/employee-portals/plans",
};

function urgencyRank(urgency: ActionHubUrgency): number {
  return urgency === "high" ? 0 : urgency === "normal" ? 1 : 2;
}

function portalAttentionModuleForMyRequest(module: MyRequestItem["module"]): PortalAttentionModule | null {
  switch (module) {
    case "leave":
      return "leave";
    case "excuse":
      return "excuse";
    case "outstation":
      return "outstation";
    case "weekly_plan":
      return "weekly_plan";
    case "marketing":
      return "marketing";
    default:
      return null; // resignation has no portal "attention" surface
  }
}

// Only people-managers approve team outstation expenses (not PM/GPM/TM, who are
// product-portfolio roles, nor individual contributors). Keeps the attention inbox
// from surfacing expense approvals to roles that never action them.
const EXPENSE_APPROVER_ROLES = new Set<string>([
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Manager",
]);

export async function getPortalAttentionInbox(
  access: AccessContext,
  opts: { myRequests?: MyRequestItem[]; expenses?: PayrollExpenseApproval[] } = {},
): Promise<PortalAttentionInbox> {
  const hrId = access.hrId?.trim() ?? "";
  if (!hrId) return EMPTY_PORTAL_ATTENTION_INBOX;

  const [awaiting, marketingApprovals, plans, expenses, myRequests] = await Promise.all([
    getAwaitingMyActionItems(access, "portal").catch(() => [] as ActionHubItem[]),
    getApproverPendingRequests(access).catch(() => null),
    getEmployeePlansWorkspace(access).catch(() => null),
    opts.expenses
      ? Promise.resolve(opts.expenses)
      : listUnifiedOutstationExpenses(undefined, undefined, undefined, access).catch(
          () => [] as PayrollExpenseApproval[],
        ),
    opts.myRequests ? Promise.resolve(opts.myRequests) : getMyRequestItems(access).catch(() => [] as MyRequestItem[]),
  ]);

  const items: PortalAttentionItem[] = [];

  // 1) Vacation + excuse approvals (already portal-scoped by getAwaitingMyActionItems).
  for (const item of awaiting) {
    const attentionModule: PortalAttentionModule | null =
      item.module === "leave" ? "leave" : item.module === "excuse" ? "excuse" : null;
    if (!attentionModule) continue;
    items.push({
      id: `approval:${item.module}:${item.id}`,
      module: attentionModule,
      kind: "approval",
      title: item.title,
      subtitle: item.employeeName,
      href: "/employee-portals/actions",
      submittedAt: item.submittedAt,
      urgency: item.urgency,
    });
  }

  // 2) Marketing requests pending the caller's gating decision (scoped to approver).
  if (marketingApprovals) {
    for (const row of marketingApprovals.rows) {
      items.push({
        id: `approval:marketing:${row.id}`,
        module: "marketing",
        kind: "approval",
        title: `Marketing · ${row.requestCode}`,
        subtitle: `${row.requesterName} · ${row.currentStepName}`,
        href: "/employee-portals/marketing-requests/inbox",
        submittedAt: row.submittedAt ?? "",
        urgency: "normal",
      });
    }
  }

  // 3) Weekly/monthly plans awaiting the caller's manager approval. The workspace is
  //    visibility-scoped, so additionally require the plan's managerHrId === caller.
  if (plans) {
    for (const plan of plans.plans) {
      if (plan.status !== "submitted") continue;
      if (!sameHrId(plan.managerHrId, hrId)) continue;
      items.push({
        id: `approval:weekly_plan:${plan.id}`,
        module: "weekly_plan",
        kind: "approval",
        title: `${plan.planKind === "monthly" ? "Monthly" : "Weekly"} plan · ${plan.periodKey}`,
        subtitle: plan.employeeName,
        href: "/employee-portals/plans",
        submittedAt: plan.submittedAt ?? plan.updatedAt,
        urgency: "normal",
      });
    }
  }

  // 4) Team outstation expense REQUESTS pending the caller's approval. Only people-
  //    managers approve team expenses, and only system-entered requests (trip_id
  //    "OUTSTATION-…") are part of an approval workflow — historical Excel rows
  //    (different trip_id) are excluded so the inbox never floods with non-actionable
  //    line history. Exclude the caller's own claims (those live in My Requests).
  if (EXPENSE_APPROVER_ROLES.has(access.role)) {
    for (const expense of expenses) {
      if (expense.hrApproved) continue;
      if (!String(expense.tripId).startsWith("OUTSTATION-")) continue;
      if (sameHrId(expense.hrId, hrId)) continue;
      items.push({
        id: `approval:outstation:${expense.tripId}`,
        module: "outstation",
        kind: "approval",
        title: `Expense · ${expense.date}`,
        subtitle: expense.hr || expense.hrId || null,
        href: "/employee-portals/expense-dashboard",
        submittedAt: expense.date,
        urgency: "normal",
      });
    }
  }

  // 5) Returned-to-me items (for everyone, including non-managers).
  for (const request of myRequests) {
    if (request.statusTone !== "returned") continue;
    const attentionModule = portalAttentionModuleForMyRequest(request.module);
    if (!attentionModule) continue;
    items.push({
      id: `returned:${request.id}`,
      module: attentionModule,
      kind: "returned",
      title: request.title,
      subtitle: request.decisionNote,
      href: PORTAL_ATTENTION_RETURNED_HREF[attentionModule],
      submittedAt: request.submittedAt,
      urgency: "high",
    });
  }

  items.sort((a, b) => {
    // Returned items first (the user must act), then by urgency, then oldest first.
    if (a.kind !== b.kind) return a.kind === "returned" ? -1 : 1;
    if (a.urgency !== b.urgency) return urgencyRank(a.urgency) - urgencyRank(b.urgency);
    return String(a.submittedAt).localeCompare(String(b.submittedAt));
  });

  const capped = items.slice(0, 50);
  return {
    totalCount: capped.length,
    approvalCount: capped.filter((item) => item.kind === "approval").length,
    returnedCount: capped.filter((item) => item.kind === "returned").length,
    items: capped,
  };
}
