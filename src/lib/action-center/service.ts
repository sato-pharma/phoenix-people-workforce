import type { AccessContext } from "@/lib/auth/permissions";
import type { ActionHubItem, HistoricalApprovalItem, MyRequestItem, MyRequestStatusTone } from "@/components/action-center/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { vacationTypeLabel } from "@/lib/vacation/calculations";
import { getVacationActionCenterData, getVacationReportData } from "@/lib/vacation/service";
import {
  getExcuseRequestForActionCenterDeepLink,
  getExcuseWorkspace,
  getManagerPendingExcuses,
  type EmployeeExcuseRequest,
} from "@/lib/excuses/service";
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
    href: `/employee-portals/excuses?requestId=${encodeURIComponent(row.id)}`,
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
    decisionNote: row.managerDecisionComment,
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
  ]);

  const [vacation, excuse, outstation, plans, resignations] = settled;
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

function mapExcuseItem(request: EmployeeExcuseRequest, readOnlyReason?: string | null): ActionHubItem {
  return {
    id: request.id,
    module: "excuse",
    employeeName: request.employeeName,
    employeeHrId: request.employeeHrId,
    title: `${request.excuseType === "morning" ? "Morning" : "Afternoon"} Excuse · ${request.excuseDate}`,
    statusLabel: humanize(request.status),
    submittedAt: request.createdAt,
    urgency: "normal",
    readOnlyReason: readOnlyReason ?? null,
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
  // Outstation and resignations: admin-only (unscoped company-wide aggregates).
  // Contract renewal: always included — already access-scoped via canSeeContractRow(access, employee).
  const includeAdminSources = audience === "admin";
  const settled = await Promise.allSettled([
    getVacationActionCenterData(access).catch(() => null),
    getManagerPendingExcuses(access).catch(() => null),
    getResignationsDashboardData(access).catch(() => null),
    includeAdminSources ? listOutstationRequests().catch(() => null) : Promise.resolve(null),
    getContractRenewalDashboardData(access).catch(() => null),
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
  // Never surface a requester's own submission in their own action inbox — the CEO
  // role can submit requests and those should only appear in "My Requests", not here.
  return items.filter((item) => !sameHrId(item.employeeHrId, access.hrId));
}

/**
 * Returns a chronological list of every approval decision the signed-in user has
 * ever made, across leave, excuse, weekly-plan, and resignation modules.
 * Ordered by decision timestamp descending (newest first).
 */
export async function getMyApprovalHistory(access: AccessContext): Promise<HistoricalApprovalItem[]> {
  const hrId = (access.hrId ?? "").trim().toUpperCase();
  if (!hrId) return [];

  const db = getSupabaseAdmin();
  const items: HistoricalApprovalItem[] = [];

  const [leaves, excuses, plans, resignations] = await Promise.allSettled([
    db
      .from("v2_vacation_requests")
      .select("id,employee_name,employee_hr_id,vacation_type,start_date,manager_decision,manager_decision_at,manager_decision_by_hr_id,hr_decision,hr_decision_at,hr_decision_by_hr_id")
      .or(`manager_decision_by_hr_id.ilike.${hrId},hr_decision_by_hr_id.ilike.${hrId}`)
      .not("manager_decision", "is", null)
      .order("manager_decision_at", { ascending: false })
      .limit(200),
    db
      .from("employee_excuses")
      .select("id,employee_name,employee_hr_id,excuse_date,excuse_type,manager_decision,manager_decision_at,manager_decision_by_hr_id")
      .ilike("manager_decision_by_hr_id", hrId)
      .not("manager_decision", "is", null)
      .order("manager_decision_at", { ascending: false })
      .limit(200),
    db
      .from("employee_plans")
      .select("id,employee_name,employee_hr_id,period_key,plan_kind,manager_decision,manager_decision_at,manager_decision_by_hr_id,ceo_decision,ceo_decision_at,ceo_decision_by_hr_id")
      .or(`manager_decision_by_hr_id.ilike.${hrId},ceo_decision_by_hr_id.ilike.${hrId}`)
      .not("manager_decision", "is", null)
      .order("manager_decision_at", { ascending: false })
      .limit(200),
    db
      .from("employee_resignations")
      .select("id,employee_name,employee_hr_id,effective_date,status,reviewed_by,reviewed_at,approved_by,approved_at,rejected_by,rejected_at")
      .or(`reviewed_by.ilike.${hrId},approved_by.ilike.${hrId},rejected_by.ilike.${hrId}`)
      .order("reviewed_at", { ascending: false })
      .limit(100),
  ]);

  function decodeDecision(raw: string | null | undefined): "approved" | "rejected" | "returned" | null {
    if (!raw) return null;
    const s = raw.toLowerCase();
    if (/(approv|accept)/.test(s)) return "approved";
    if (/(reject|declin|denied)/.test(s)) return "rejected";
    if (/(return|resubmit|sent_back)/.test(s)) return "returned";
    return null;
  }

  if (leaves.status === "fulfilled" && !leaves.value.error) {
    for (const row of leaves.value.data ?? []) {
      const isMgrDecider = String(row.manager_decision_by_hr_id ?? "").toUpperCase() === hrId;
      const isHrDecider = String(row.hr_decision_by_hr_id ?? "").toUpperCase() === hrId;
      const decisionRaw = isHrDecider && row.hr_decision ? row.hr_decision : row.manager_decision;
      const decidedAt = isHrDecider && row.hr_decision_at ? row.hr_decision_at : row.manager_decision_at;
      const decision = decodeDecision(decisionRaw);
      if (!decision || (!isMgrDecider && !isHrDecider)) continue;
      items.push({
        id: `history:leave:${row.id}`,
        module: "leave",
        employeeName: String(row.employee_name ?? "Unknown"),
        employeeHrId: String(row.employee_hr_id ?? ""),
        title: `Leave · ${String(row.vacation_type ?? "").replace(/_/g, " ")} · ${row.start_date ?? ""}`,
        decision,
        decidedAt: String(decidedAt ?? ""),
        href: null,
      });
    }
  }

  if (excuses.status === "fulfilled" && !excuses.value.error) {
    for (const row of excuses.value.data ?? []) {
      const decision = decodeDecision(row.manager_decision);
      if (!decision) continue;
      items.push({
        id: `history:excuse:${row.id}`,
        module: "excuse",
        employeeName: String(row.employee_name ?? "Unknown"),
        employeeHrId: String(row.employee_hr_id ?? ""),
        title: `Excuse · ${String(row.excuse_type ?? "")} · ${row.excuse_date ?? ""}`,
        decision,
        decidedAt: String(row.manager_decision_at ?? ""),
        href: null,
      });
    }
  }

  if (plans.status === "fulfilled" && !plans.value.error) {
    for (const row of plans.value.data ?? []) {
      const isMgrDecider = String(row.manager_decision_by_hr_id ?? "").toUpperCase() === hrId;
      const isCeoDecider = String(row.ceo_decision_by_hr_id ?? "").toUpperCase() === hrId;
      const decisionRaw = isCeoDecider && row.ceo_decision ? row.ceo_decision : row.manager_decision;
      const decidedAt = isCeoDecider && row.ceo_decision_at ? row.ceo_decision_at : row.manager_decision_at;
      const decision = decodeDecision(decisionRaw);
      if (!decision || (!isMgrDecider && !isCeoDecider)) continue;
      items.push({
        id: `history:weekly_plan:${row.id}`,
        module: "weekly_plan",
        employeeName: String(row.employee_name ?? "Unknown"),
        employeeHrId: String(row.employee_hr_id ?? ""),
        title: `${String(row.plan_kind ?? "weekly").charAt(0).toUpperCase()}${String(row.plan_kind ?? "weekly").slice(1)} plan · ${row.period_key ?? ""}`,
        decision,
        decidedAt: String(decidedAt ?? ""),
        href: null,
      });
    }
  }

  if (resignations.status === "fulfilled" && !resignations.value.error) {
    for (const row of resignations.value.data ?? []) {
      const isApprover = String(row.approved_by ?? "").toUpperCase() === hrId;
      const isRejector = String(row.rejected_by ?? "").toUpperCase() === hrId;
      const isReviewer = String(row.reviewed_by ?? "").toUpperCase() === hrId;
      const decision = isApprover ? "approved" : isRejector ? "rejected" : isReviewer ? "approved" : null;
      const decidedAt = isApprover ? row.approved_at : isRejector ? row.rejected_at : row.reviewed_at;
      if (!decision) continue;
      items.push({
        id: `history:resignation:${row.id}`,
        module: "resignation",
        employeeName: String(row.employee_name ?? "Unknown"),
        employeeHrId: String(row.employee_hr_id ?? ""),
        title: `Resignation · effective ${row.effective_date ?? ""}`,
        decision,
        decidedAt: String(decidedAt ?? ""),
        href: null,
      });
    }
  }

  items.sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
  return items;
}

export async function getActionCenterDeepLinkItem(
  access: AccessContext,
  module: string | null | undefined,
  id: string | null | undefined,
): Promise<ActionHubItem | null> {
  if (module !== "excuse" || !id) return null;
  const result = await getExcuseRequestForActionCenterDeepLink(access, id);
  if (!result) return null;
  return mapExcuseItem(
    result.request,
    result.canAct ? null : "Direct manager owns this approval. HR has visibility only.",
  );
}
