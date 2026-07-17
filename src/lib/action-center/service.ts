import { hrIdsMatch, resolveNavigationMode, type AccessContext } from "@/lib/auth/permissions";
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
import { canUseAdminOutstationWorkspace } from "@/lib/outstation/admin-access";
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

// Exported: reused by the Approvals Hub's company-wide "All Decisions" view
// (src/lib/approvals-hub/service.ts) so decision-text parsing stays in one place.
export function decodeDecision(raw: string | null | undefined): "approved" | "rejected" | "returned" | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (/(approv|accept)/.test(s)) return "approved";
  if (/(reject|declin|denied)/.test(s)) return "rejected";
  if (/(return|resubmit|sent_back)/.test(s)) return "returned";
  return null;
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
      if (hrIdsMatch(row.employeeHrId, hrId)) items.push(mapVacation(row));
    }
  }
  if (excuse.status === "fulfilled" && excuse.value) {
    for (const row of excuse.value.requests) items.push(mapExcuse(row));
  }
  if (outstation.status === "fulfilled" && outstation.value) {
    for (const row of outstation.value) {
      if (hrIdsMatch(row.employeeHrId, hrId)) items.push(mapOutstation(row));
    }
  }
  if (plans.status === "fulfilled" && plans.value) {
    for (const row of plans.value.plans) {
      if (hrIdsMatch(row.employeeHrId, hrId)) items.push(mapPlan(row));
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
    urgency: request.approvalRecommendation === "auto_approve" ? "low" : request.approvalRecommendation === "reject" ? "high" : "normal",
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
  // Outstation: admin-only AND restricted to real approval authority — listOutstationRequests()
  // is an unscoped company-wide read, and only Super Admin can act on these requests
  // (see canUseAdminOutstationWorkspace). Other admin-shell roles (Finance Manager, CEO, etc.)
  // must not see items in an "awaiting my action" inbox they cannot act on.
  // Resignations: admin-only (unscoped company-wide aggregates).
  // Contract renewal: always included — already access-scoped via canSeeContractRow(access, employee).
  const includeOutstationAdminSource =
    audience === "admin" && canUseAdminOutstationWorkspace(access, "approve");
  const settled = await Promise.allSettled([
    getVacationActionCenterData(access).catch(() => null),
    getManagerPendingExcuses(access).catch(() => null),
    getResignationsDashboardData(access).catch(() => null),
    includeOutstationAdminSource ? listOutstationRequests().catch(() => null) : Promise.resolve(null),
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
  // Vacation (leave), excuse & weekly/monthly plans now live on the dedicated Approvals Hub pages
  // (/…/approvals/vacation, /…/approvals/excuse, /…/approvals/plan) — exclude them here so this
  // residual "Other Approvals" inbox shows each request in exactly one place.
  return items.filter(
    (item) =>
      item.module !== "leave" &&
      item.module !== "excuse" &&
      item.module !== "weekly_plan" &&
      !hrIdsMatch(item.employeeHrId, access.hrId),
  );
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

  // Role-aware deep-link back into the Approvals Hub (portal vs admin shell). Mirrors the
  // `?module=X&id=Y` convention the inbox/notifications already use, so "View request" always
  // routes to the correct surface for the viewer and never dead-ends.
  const isPortal = resolveNavigationMode(access) === "employee-portal";
  const hubBase = isPortal ? "/employee-portals/approvals-hub" : "/admin/approvals-hub";
  // Vacation/excuse/plan history links point at their dedicated per-request pages (they left the
  // "Other Approvals" hub) so clicking a past decision never re-opens it inside the residual hub
  // inbox. Resignation (and any other still-in-hub module) keeps the ?module=X&id=Y hub deep-link.
  const dedicatedHistorySegment: Record<string, string> = { leave: "vacation", excuse: "excuse", weekly_plan: "plan" };
  const historyHref = (module: string, id: unknown) => {
    const segment = dedicatedHistorySegment[module];
    const encodedId = encodeURIComponent(String(id ?? ""));
    if (segment) {
      const base = isPortal ? `/employee-portals/approvals/${segment}` : `/admin/approvals/${segment}`;
      return `${base}/${encodedId}`;
    }
    return `${hubBase}?module=${module}&id=${encodedId}`;
  };

  // Native-page deep-links for the admin/system modules (these never render inside the hub —
  // they live on their own dedicated pages, where the full decided record is shown).
  const NATIVE_HREFS = {
    salary: "/payroll",
    sales_import: "/sales/queue",
    marketing_request: "/admin/marketing-requests/inbox",
    payroll_expense: "/admin/outstation/expenses",
  } as const;

  const [leaves, excuses, plans, resignations, salaries, salesImports, marketingSteps, expenses, momSteps] =
    await Promise.allSettled([
      db
        .from("v2_vacation_requests")
        .select("id,employee_name,employee_hr_id,vacation_type,start_date,status,manager_decision,manager_decision_at,manager_decision_by_hr_id,hr_decision,hr_decision_at,hr_decision_by_hr_id")
        .or(`manager_decision_by_hr_id.ilike.${hrId},hr_decision_by_hr_id.ilike.${hrId}`)
        .not("manager_decision_at", "is", null)
        .order("manager_decision_at", { ascending: false })
        .limit(200),
      db
        .from("v2_excuse_requests")
        .select("id,employee_name,employee_hr_id,excuse_date,excuse_type,manager_decision,manager_decision_at,manager_decision_by_hr_id")
        .ilike("manager_decision_by_hr_id", hrId)
        .not("manager_decision", "is", null)
        .order("manager_decision_at", { ascending: false })
        .limit(200),
      db
        .from("employee_plan_headers")
        .select("id,employee_name,employee_hr_id,period_key,plan_kind,status,manager_decision_at,manager_decision_by_hr_id,ceo_decision_at,ceo_decision_by_hr_id")
        .or(`manager_decision_by_hr_id.ilike.${hrId},ceo_decision_by_hr_id.ilike.${hrId}`)
        .not("manager_decision_at", "is", null)
        .order("manager_decision_at", { ascending: false })
        .limit(200),
      db
        .from("employee_resignations")
        .select("id,employee_name,employee_hr_id,effective_date,status,reviewed_by,reviewed_at,approved_by,approved_at,rejected_by,rejected_at")
        .or(`reviewed_by.ilike.${hrId},approved_by.ilike.${hrId},rejected_by.ilike.${hrId}`)
        .order("reviewed_at", { ascending: false })
        .limit(100),
      db
        .from("salary_batches")
        .select("id,file_name,month,year,status,approved_by,approved_at")
        .ilike("approved_by", hrId)
        .not("approved_at", "is", null)
        .order("approved_at", { ascending: false })
        .limit(100),
      db
        .from("sales_import_batches")
        .select("id,file_name,period,month,year,status,approved_by,approved_at,rejected_by,rejected_at")
        .or(`approved_by.ilike.${hrId},rejected_by.ilike.${hrId}`)
        .order("approved_at", { ascending: false })
        .limit(100),
      db
        .from("marketing_request_approval_steps")
        .select("request_id,step_name,status,decision_by_hr_id,decision_at,marketing_requests(request_code,requester_hr_id)")
        .ilike("decision_by_hr_id", hrId)
        .not("decision_at", "is", null)
        .order("decision_at", { ascending: false })
        .limit(200),
      db
        .from("outstation_expenses")
        .select("id,specialist,hr_id,expense_date,total,status,approved_by,approved_at")
        .ilike("approved_by", hrId)
        .not("approved_at", "is", null)
        .order("approved_at", { ascending: false })
        .limit(200),
      // manager_of_manager decisions are never written to the main request's
      // manager_decision_by_hr_id column (only direct_manager is). Query the
      // steps table directly so the secondary manager sees their history too.
      db
        .from("v2_vacation_approval_steps")
        .select("request_id,step_key,status,approver_hr_id,decided_at,v2_vacation_requests(id,employee_name,employee_hr_id,vacation_type,start_date)")
        .eq("step_key", "manager_of_manager")
        .ilike("approver_hr_id", hrId)
        .neq("status", "pending")
        .not("decided_at", "is", null)
        .order("decided_at", { ascending: false })
        .limit(200),
    ]);

  if (leaves.status === "fulfilled" && !leaves.value.error) {
    for (const row of leaves.value.data ?? []) {
      const isMgrDecider = String(row.manager_decision_by_hr_id ?? "").toUpperCase() === hrId;
      const isHrDecider = String(row.hr_decision_by_hr_id ?? "").toUpperCase() === hrId;
      const decisionRaw = isHrDecider && row.hr_decision ? row.hr_decision : row.manager_decision;
      const decidedAt = isHrDecider && row.hr_decision_at ? row.hr_decision_at : row.manager_decision_at;
      // Returned requests set manager_decision_at but leave manager_decision NULL — detect via status.
      const decision = decodeDecision(decisionRaw) ?? (row.status === "returned" ? ("returned" as const) : null);
      if (!decision || (!isMgrDecider && !isHrDecider)) continue;
      items.push({
        id: `history:leave:${row.id}`,
        module: "leave",
        employeeName: String(row.employee_name ?? "Unknown"),
        employeeHrId: String(row.employee_hr_id ?? ""),
        title: `Leave · ${String(row.vacation_type ?? "").replace(/_/g, " ")} · ${row.start_date ?? ""}`,
        decision,
        decidedAt: String(decidedAt ?? ""),
        href: historyHref("leave", row.id),
      });
    }
  }

  // Secondary manager (manager_of_manager) decisions — not in the main leaves query above.
  if (momSteps.status === "fulfilled" && !momSteps.value.error) {
    const seenLeaveIds = new Set(
      items.filter((i) => i.module === "leave").map((i) => i.id.replace(/^history:leave:/, "")),
    );
    for (const row of momSteps.value.data ?? []) {
      const reqId = String(row.request_id ?? "");
      if (!reqId || seenLeaveIds.has(reqId)) continue;
      const req = (row as { v2_vacation_requests?: { employee_name?: string; employee_hr_id?: string; vacation_type?: string; start_date?: string } | null }).v2_vacation_requests;
      if (!req) continue;
      const decision = row.status === "approved" ? "approved" as const : row.status === "rejected" ? "rejected" as const : null;
      if (!decision) continue;
      items.push({
        id: `history:leave:${reqId}`,
        module: "leave",
        employeeName: String(req.employee_name ?? "Unknown"),
        employeeHrId: String(req.employee_hr_id ?? ""),
        title: `Leave · ${String(req.vacation_type ?? "").replace(/_/g, " ")} · ${String(req.start_date ?? "")}`,
        decision,
        decidedAt: String(row.decided_at ?? ""),
        href: historyHref("leave", reqId),
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
        href: historyHref("excuse", row.id),
      });
    }
  }

  if (plans.status === "fulfilled" && !plans.value.error) {
    for (const row of plans.value.data ?? []) {
      const isMgrDecider = String(row.manager_decision_by_hr_id ?? "").toUpperCase() === hrId;
      const isCeoDecider = String(row.ceo_decision_by_hr_id ?? "").toUpperCase() === hrId;
      if (!isMgrDecider && !isCeoDecider) continue;
      const s = String(row.status ?? "").toLowerCase();
      // Derive decision from status — employee_plan_headers has no text decision columns
      let decision: "approved" | "rejected" | "returned" | null = null;
      let decidedAt: string | null = null;
      if (isCeoDecider && row.ceo_decision_at) {
        decision = ["final_approved", "hr_acknowledged"].includes(s) ? "approved" : s === "ceo_returned" ? "returned" : null;
        decidedAt = row.ceo_decision_at;
      } else if (isMgrDecider && row.manager_decision_at) {
        decision = s === "manager_returned" ? "returned" : row.manager_decision_at ? "approved" : null;
        decidedAt = row.manager_decision_at;
      }
      if (!decision) continue;
      items.push({
        id: `history:weekly_plan:${row.id}`,
        module: "weekly_plan",
        employeeName: String(row.employee_name ?? "Unknown"),
        employeeHrId: String(row.employee_hr_id ?? ""),
        title: `${String(row.plan_kind ?? "weekly").charAt(0).toUpperCase()}${String(row.plan_kind ?? "weekly").slice(1)} plan · ${row.period_key ?? ""}`,
        decision,
        decidedAt: String(decidedAt ?? ""),
        href: historyHref("weekly_plan", row.id),
      });
    }
  }

  if (resignations.status === "fulfilled" && !resignations.value.error) {
    for (const row of resignations.value.data ?? []) {
      const isApprover = String(row.approved_by ?? "").toUpperCase() === hrId;
      const isRejector = String(row.rejected_by ?? "").toUpperCase() === hrId;
      const isReviewer = String(row.reviewed_by ?? "").toUpperCase() === hrId;
      if (!isApprover && !isRejector && !isReviewer) continue;
      // Derive the decision from the final status, not from which actor column matched — a
      // reviewer is not necessarily the approver. A row still under review (matched only via
      // reviewed_by) is shown as "returned" (in-progress), never as "approved".
      const status = String(row.status ?? "").toLowerCase();
      let decision: "approved" | "rejected" | "returned" | null;
      if (/(approv|complet)/.test(status)) decision = "approved";
      else if (/(reject)/.test(status)) decision = "rejected";
      else if (/(cancel|review|return)/.test(status)) decision = "returned";
      else decision = isApprover ? "approved" : isRejector ? "rejected" : "returned";
      const decidedAt = isApprover ? row.approved_at : isRejector ? row.rejected_at : row.reviewed_at;
      items.push({
        id: `history:resignation:${row.id}`,
        module: "resignation",
        employeeName: String(row.employee_name ?? "Unknown"),
        employeeHrId: String(row.employee_hr_id ?? ""),
        title: `Resignation · effective ${row.effective_date ?? ""}`,
        decision,
        decidedAt: String(decidedAt ?? ""),
        href: historyHref("resignation", row.id),
      });
    }
  }

  if (salaries.status === "fulfilled" && !salaries.value.error) {
    for (const row of salaries.value.data ?? []) {
      items.push({
        id: `history:salary:${row.id}`,
        module: "salary",
        employeeName: String(row.file_name ?? "Payroll batch"),
        employeeHrId: "",
        title: `Payroll batch · ${String(row.month ?? "")}/${String(row.year ?? "")}`,
        decision: "approved",
        decidedAt: String(row.approved_at ?? ""),
        href: NATIVE_HREFS.salary,
      });
    }
  }

  if (salesImports.status === "fulfilled" && !salesImports.value.error) {
    for (const row of salesImports.value.data ?? []) {
      const isApprover = String(row.approved_by ?? "").toUpperCase() === hrId && row.approved_at;
      const isRejector = String(row.rejected_by ?? "").toUpperCase() === hrId && row.rejected_at;
      if (!isApprover && !isRejector) continue;
      const periodLabel = row.period ?? `${String(row.month ?? "")}/${String(row.year ?? "")}`;
      items.push({
        id: `history:sales_import:${row.id}`,
        module: "sales_import",
        employeeName: String(row.file_name ?? "Sales import"),
        employeeHrId: "",
        title: `Sales import · ${String(periodLabel)}`,
        decision: isRejector ? "rejected" : "approved",
        decidedAt: String((isRejector ? row.rejected_at : row.approved_at) ?? ""),
        href: NATIVE_HREFS.sales_import,
      });
    }
  }

  if (marketingSteps.status === "fulfilled" && !marketingSteps.value.error) {
    for (const row of marketingSteps.value.data ?? []) {
      const decision = decodeDecision(row.status);
      if (!decision) continue;
      const parent = (row as { marketing_requests?: { request_code?: string | null; requester_hr_id?: string | null } | null }).marketing_requests;
      items.push({
        id: `history:marketing:${row.request_id}:${row.step_name ?? ""}`,
        module: "marketing_request",
        employeeName: String(parent?.request_code ?? "Marketing request"),
        employeeHrId: String(parent?.requester_hr_id ?? ""),
        title: `Marketing · ${String(row.step_name ?? "approval")}`,
        decision,
        decidedAt: String(row.decision_at ?? ""),
        href: NATIVE_HREFS.marketing_request,
      });
    }
  }

  if (expenses.status === "fulfilled" && !expenses.value.error) {
    for (const row of expenses.value.data ?? []) {
      items.push({
        id: `history:payroll_expense:${row.id}`,
        module: "payroll_expense",
        employeeName: String(row.specialist ?? "Expense"),
        employeeHrId: String(row.hr_id ?? ""),
        title: `Expense · ${Number(row.total ?? 0).toLocaleString()} EGP · ${String(row.expense_date ?? "")}`,
        decision: "approved",
        decidedAt: String(row.approved_at ?? ""),
        href: NATIVE_HREFS.payroll_expense,
      });
    }
  }

  items.sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
  return items;
}

const DEEP_LINK_READ_ONLY = "Decision already recorded — this is a read-only view.";

// Build a read-only inbox card for a leave request the caller already decided. Self-contained
// (queries the table directly) so it never perturbs the live, pending-only inbox pipeline. Only
// returns the item when the caller is the actual decider (or HR/system) — so it can never leak.
async function buildLeaveDeepLinkItem(access: AccessContext, id: string, hrId: string): Promise<ActionHubItem | null> {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("v2_vacation_requests")
    .select("id,employee_name,employee_hr_id,vacation_type,start_date,end_date,duration_days,payment_status,balance_before_days,hr_decision_comment,status,manager_decision,manager_decision_at,manager_decision_by_hr_id,hr_decision,hr_decision_at,hr_decision_by_hr_id")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  const isDecider =
    String(row.manager_decision_by_hr_id ?? "").toUpperCase() === hrId ||
    String(row.hr_decision_by_hr_id ?? "").toUpperCase() === hrId;
  if (!isDecider && access.scope !== "system") return null;

  const { data: stepData } = await db
    .from("v2_vacation_approval_steps")
    .select("step_order,step_key,status,approver_hr_id,decision_comment,decided_at")
    .eq("request_id", id)
    .order("step_order", { ascending: true });
  const approvalSteps = ((stepData as Array<Record<string, unknown>> | null) ?? []).map((step) => ({
    order: Number(step.step_order ?? 0),
    status: String(step.status ?? ""),
    stepKey: String(step.step_key ?? ""),
    genericStep: String(step.step_key ?? ""),
    approverName: step.approver_hr_id ? String(step.approver_hr_id) : null,
    decidedAt: step.decided_at ? String(step.decided_at) : null,
    decisionComment: step.decision_comment ? String(step.decision_comment) : null,
  }));

  return {
    id: String(row.id),
    module: "leave",
    employeeName: String(row.employee_name ?? "Unknown"),
    employeeHrId: String(row.employee_hr_id ?? ""),
    title: `${vacationTypeLabel(String(row.vacation_type ?? "annual"))} · ${Number(row.duration_days ?? 0)} day${Number(row.duration_days ?? 0) === 1 ? "" : "s"}`,
    statusLabel: String(row.status ?? "").replace(/_/g, " "),
    submittedAt: String(row.manager_decision_at ?? row.start_date ?? ""),
    urgency: "normal",
    readOnlyReason: DEEP_LINK_READ_ONLY,
    detail: {
      module: "leave",
      vacationType: vacationTypeLabel(String(row.vacation_type ?? "annual")),
      startDate: String(row.start_date ?? ""),
      endDate: String(row.end_date ?? ""),
      durationDays: Number(row.duration_days ?? 0),
      paymentStatus: String(row.payment_status ?? "unpaid"),
      balanceBeforeDays: Number(row.balance_before_days ?? 0),
      hrDecisionComment: row.hr_decision_comment ? String(row.hr_decision_comment) : null,
      actionAvailability: {},
      approvalSteps,
      slaAgeDays: 0,
    },
  };
}

// Read-only inbox card for a weekly/monthly plan the caller already decided. Self-contained; the
// status label reflects the *real* decided status (never a misleading "Needs … approval").
async function buildPlanDeepLinkItem(access: AccessContext, id: string, hrId: string): Promise<ActionHubItem | null> {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("employee_plan_headers")
    .select("id,employee_name,employee_hr_id,employee_job_title,manager_name,period_key,period_start_date,period_end_date,plan_kind,status,manager_decision_by_hr_id,ceo_decision_by_hr_id,employee_plan_items(activity_date,activity_type,activity_title,area,location_text,objective,double_visit_medical_rep_name,start_time,end_time,notes,sort_order)")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  const isMgr = String(row.manager_decision_by_hr_id ?? "").toUpperCase() === hrId;
  const isCeo = String(row.ceo_decision_by_hr_id ?? "").toUpperCase() === hrId;
  if (!isMgr && !isCeo && access.scope !== "system") return null;

  const rawItems = ((row.employee_plan_items as Array<Record<string, unknown>> | undefined) ?? [])
    .slice()
    .sort((a, b) =>
      `${String(a.activity_date ?? "")}-${String(a.sort_order ?? "").padStart(4, "0")}`.localeCompare(
        `${String(b.activity_date ?? "")}-${String(b.sort_order ?? "").padStart(4, "0")}`,
      ),
    );
  const items = rawItems.map((item) => ({
    activityDate: String(item.activity_date ?? ""),
    activityLabel: String(item.activity_title ?? ""),
    activityType: String(item.activity_type ?? ""),
    area: item.area ? String(item.area) : null,
    isCoaching: /coach/i.test(String(item.activity_type ?? "")),
    notes: item.notes ? String(item.notes) : null,
    objective: item.objective ? String(item.objective) : null,
    region: null,
    repName: item.double_visit_medical_rep_name ? String(item.double_visit_medical_rep_name) : null,
    timeLabel:
      item.start_time || item.end_time ? `${String(item.start_time ?? "")}${item.end_time ? `–${String(item.end_time)}` : ""}` : null,
    visitDetails: [],
  }));
  const kindLabel = String(row.plan_kind ?? "weekly") === "monthly" ? "Monthly" : "Weekly";
  const reviewBase = resolveNavigationMode(access) === "employee-portal" ? "/employee-portals/plans" : "/admin/weekly-plans";

  return {
    id: String(row.id),
    module: "weekly_plan",
    employeeName: String(row.employee_name ?? "Unknown"),
    employeeHrId: String(row.employee_hr_id ?? ""),
    title: `${kindLabel} plan · ${String(row.period_key ?? "")}`,
    statusLabel: String(row.status ?? "").replace(/_/g, " "),
    submittedAt: "",
    urgency: "normal",
    readOnlyReason: DEEP_LINK_READ_ONLY,
    detail: {
      module: "weekly_plan",
      stage: isCeo ? "ceo" : "manager",
      planKind: String(row.plan_kind ?? "weekly") === "monthly" ? "monthly" : "weekly",
      periodKey: String(row.period_key ?? ""),
      periodStartDate: String(row.period_start_date ?? ""),
      periodEndDate: String(row.period_end_date ?? ""),
      employeeJobTitle: row.employee_job_title ? String(row.employee_job_title) : null,
      managerName: row.manager_name ? String(row.manager_name) : null,
      itemCount: items.length,
      items,
      reviewHref: `${reviewBase}?plan=${String(row.id)}`,
    },
  };
}

export async function getActionCenterDeepLinkItem(
  access: AccessContext,
  module: string | null | undefined,
  id: string | null | undefined,
): Promise<ActionHubItem | null> {
  if (!id) return null;
  const hrId = (access.hrId ?? "").trim().toUpperCase();

  if (module === "excuse") {
    const result = await getExcuseRequestForActionCenterDeepLink(access, id);
    if (!result) return null;
    return mapExcuseItem(
      result.request,
      result.canAct ? null : "Direct manager owns this approval. HR has visibility only.",
    );
  }

  if (module === "resignation") {
    const dashboard = await getResignationsDashboardData(access).catch(() => null);
    const record = dashboard?.records.find((r) => r.id === id) ?? null;
    if (!record) return null;
    const decided = /(approv|reject|complet|cancel)/.test(String(record.status ?? "").toLowerCase());
    return { ...mapResignationItem(record), readOnlyReason: decided ? DEEP_LINK_READ_ONLY : null };
  }

  if (module === "leave") return buildLeaveDeepLinkItem(access, id, hrId);
  if (module === "weekly_plan") return buildPlanDeepLinkItem(access, id, hrId);

  return null;
}
