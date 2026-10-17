import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertPermission } from "@/lib/auth/permissions";
import { vacationTypeLabel } from "@/lib/vacation/calculations";
import { getVacationActionCenterData } from "@/lib/vacation/service";
import { getResignationsDashboardData } from "@/lib/resignations/service";
import { getManagerPendingExcuses } from "@/lib/excuses/service";
import { listOutstationRequests } from "@/lib/outstation/service";
import { viewedPersonCanApproveOutstation } from "@/lib/outstation/admin-access";
import { getContractRenewalDashboardData } from "@/lib/contracts/service";
import { authRoleForHrId, getPlansAwaitingAction, type ApproverPendingPlan } from "@/lib/weekly-planning/service";
import type { AccessContext } from "@/lib/auth/permissions";
import type { ActionHubItem } from "@/components/action-center/types";
import type { VacationActionCenterRow } from "@/lib/vacation/types";
import type { ResignationRecord } from "@/lib/resignations/types";
import type { EmployeeExcuseRequest } from "@/lib/excuses/service";
import type { OutstationExpenseRequest } from "@/lib/outstation/types";
import type { ContractRow } from "@/lib/contracts/types";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { getCrmManagerPlanActionItems } from "@/lib/approvals-hub/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_VIEW_AS_ROLES = new Set(["Super Admin"]);
const ACTIVE_CONTRACT_STATUSES = new Set(["requested", "manager_review", "hr_review"]);

function mapLeave(row: VacationActionCenterRow): ActionHubItem {
  const typeLabel = vacationTypeLabel(row.vacationType);
  return {
    id: row.id, module: "leave", employeeName: row.employeeName, employeeHrId: row.employeeHrId,
    title: `${typeLabel} · ${row.durationDays} day${row.durationDays === 1 ? "" : "s"}`,
    statusLabel: row.status.replace(/_/g, " "), submittedAt: row.createdAt,
    urgency: row.slaAgeDays >= 3 ? "high" : "normal",
    slaAgeDays: row.slaAgeDays, slaIsOverdue: row.slaAgeDays >= 3,
    detail: {
      module: "leave", vacationType: typeLabel, startDate: row.startDate, endDate: row.endDate,
      durationDays: row.durationDays, paymentStatus: row.paymentStatus,
      balanceBeforeDays: row.balanceBeforeDays, hrDecisionComment: row.hrDecisionComment,
      actionAvailability: Object.fromEntries(Object.entries(row.actionAvailability).map(([k, v]) => [k, (v as { enabled: boolean }).enabled])),
      approvalSteps: row.approvalSteps.map((s) => ({ order: s.order, status: s.status, stepKey: s.stepKey, genericStep: s.genericStep, approverName: s.approverName, decidedAt: s.decidedAt, decisionComment: s.decisionComment })),
      slaAgeDays: row.slaAgeDays,
    },
  };
}

function mapResignation(record: ResignationRecord): ActionHubItem {
  return {
    id: record.id, module: "resignation", employeeName: record.employeeName, employeeHrId: record.employeeHrId,
    title: `Resignation · ${record.effectiveDate}`, statusLabel: record.status.replace(/_/g, " "),
    submittedAt: record.createdAt, urgency: "high",
    detail: { module: "resignation", effectiveDate: record.effectiveDate, submittedDate: record.submittedDate, reason: record.reason, workflowNotes: record.workflowNotes, rejectedReason: record.rejectedReason, jobTitle: record.jobTitle, lineName: record.lineName },
  };
}

function mapExcuse(r: EmployeeExcuseRequest): ActionHubItem {
  return {
    id: r.id, module: "excuse", employeeName: r.employeeName, employeeHrId: r.employeeHrId,
    title: `${r.excuseType === "morning" ? "Morning" : "Afternoon"} Excuse · ${r.excuseDate}`,
    statusLabel: "Pending review", submittedAt: r.createdAt, urgency: "normal",
    detail: { module: "excuse", excuseType: r.excuseType, excuseDate: r.excuseDate, durationHours: r.durationHours, managerName: r.managerName, departmentName: r.departmentName, lineName: r.lineName },
  };
}

function mapOutstation(r: OutstationExpenseRequest): ActionHubItem {
  return {
    id: String(r.id), module: "outstation", employeeName: r.employeeName, employeeHrId: r.employeeHrId,
    title: `Outstation · ${r.tripStartDate}`, statusLabel: "Pending approval", submittedAt: r.createdAt,
    urgency: r.approvalRecommendation === "auto_approve" ? "low" : r.approvalRecommendation === "reject" ? "high" : "normal",
    detail: { module: "outstation", expenseType: r.expenseType, tripStartDate: r.tripStartDate, tripEndDate: r.tripEndDate, toLabel: r.toLabel, allowanceAmount: r.allowanceAmount, claimedTotalAmount: r.claimedTotalAmount, approvalRecommendation: r.approvalRecommendation, approvalReason: r.approvalReason, notes: r.notes, requestId: r.id },
  };
}

function mapContract(row: ContractRow): ActionHubItem | null {
  if (!row.workflow || !ACTIVE_CONTRACT_STATUSES.has(row.workflow.status)) return null;
  const w = row.workflow;
  return {
    id: w.id, module: "contract_renewal", employeeName: w.employeeName, employeeHrId: w.employeeHrId,
    title: `Contract Renewal · ${w.requestedRenewalDate}`, statusLabel: w.status.replace(/_/g, " "),
    submittedAt: w.createdAt, urgency: "high",
    detail: { module: "contract_renewal", requestedRenewalDate: w.requestedRenewalDate, proposedStartDate: w.proposedStartDate, proposedEndDate: w.proposedEndDate, jobTitle: w.jobTitle, lineName: w.lineName, areaName: w.areaName, workflowNotes: w.workflowNotes, decisionReason: w.decisionReason, currentStatus: w.status },
  };
}

function mapWeeklyPlan(plan: ApproverPendingPlan): ActionHubItem {
  const kindLabel = plan.planKind === "weekly" ? "Weekly" : "Monthly";
  return {
    id: plan.id, module: "weekly_plan", employeeName: plan.employeeName, employeeHrId: plan.employeeHrId,
    title: `${kindLabel} plan · ${plan.periodKey}`,
    statusLabel: plan.stage === "manager" ? "Needs manager review" : "Needs CEO approval",
    submittedAt: plan.submittedAt, urgency: "normal",
    detail: { module: "weekly_plan", stage: plan.stage, planKind: plan.planKind, periodKey: plan.periodKey, periodStartDate: plan.periodStartDate, periodEndDate: plan.periodEndDate, employeeJobTitle: plan.employeeJobTitle, managerName: plan.managerName, itemCount: plan.itemCount, items: plan.items, reviewHref: `/admin/weekly-plans?plan=${plan.id}` },
  };
}

// Marketing requests are intentionally excluded from this consolidated inbox — they keep
// their own dedicated approval inbox at /workspace/marketing-requests + portal equivalents.
//
// Outstation is the one feed that takes no access context: listOutstationRequests() reads every
// request in the company. It is included only when the VIEWED person may decide outstation
// requests (viewedPersonCanApproveOutstation), the same gate the Action Center applies to its own
// viewer — otherwise every submitted trip landed in the queue of whichever manager was picked
// (audit F-31).
async function fetchAllItems(
  viewAccess: AccessContext,
  options: { includeOutstation: boolean },
): Promise<ActionHubItem[]> {
  const planManagerAccess: AccessContext = { ...viewAccess, role: "Manager", scope: "team" };
  const settled = await Promise.allSettled([
    getVacationActionCenterData(viewAccess).catch(() => null),
    getResignationsDashboardData(viewAccess).catch(() => null),
    getManagerPendingExcuses(viewAccess).catch(() => null),
    options.includeOutstation ? listOutstationRequests().catch(() => null) : Promise.resolve(null),
    getContractRenewalDashboardData(viewAccess).catch(() => null),
    getPlansAwaitingAction(planManagerAccess).catch(() => null),
    // The district managers' Phoenix CRM weeks, asks to edit and own-list removals waiting on him.
    getCrmManagerPlanActionItems(viewAccess).catch(() => null),
  ]);
  const [leave, resig, excuse, outstation, contract, plans, crmManagerPlans] = settled;
  const items: ActionHubItem[] = [];
  if (leave.status === "fulfilled" && leave.value) for (const r of leave.value.rows) items.push(mapLeave(r));
  if (resig.status === "fulfilled" && resig.value) for (const r of resig.value.records.filter((r) => r.status === "submitted" || r.status === "under_review")) items.push(mapResignation(r));
  if (excuse.status === "fulfilled" && excuse.value) for (const r of excuse.value) items.push(mapExcuse(r));
  if (outstation.status === "fulfilled" && outstation.value) for (const r of outstation.value.filter((r) => r.status === "submitted")) items.push(mapOutstation(r));
  if (contract.status === "fulfilled" && contract.value) for (const r of contract.value.rows) { const i = mapContract(r); if (i) items.push(i); }
  if (plans.status === "fulfilled" && plans.value) for (const p of plans.value) items.push(mapWeeklyPlan(p));
  if (crmManagerPlans.status === "fulfilled" && crmManagerPlans.value) items.push(...crmManagerPlans.value);
  items.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  return items;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employees", "read");

    if (!ALLOWED_VIEW_AS_ROLES.has(access.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const viewAs = searchParams.get("viewAs");
    if (!viewAs) {
      return NextResponse.json({ error: "viewAs is required" }, { status: 400 });
    }

    const url = new URL(request.url);
    const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") ?? "50")), 200);
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0"));

    const viewAccess: AccessContext = { ...access, hrId: viewAs };
    // The viewed person's OWN app role — viewAccess still carries the caller's Super Admin role.
    const viewedRole = await authRoleForHrId(viewAs);
    const allItems = await fetchAllItems(viewAccess, {
      includeOutstation: viewedPersonCanApproveOutstation(viewedRole),
    });
    const total = allItems.length;
    const page = allItems.slice(offset, offset + limit);
    return NextResponse.json({ items: page, total, limit, offset });
  } catch (error) {
    return NextResponse.json(
      { error: clientSafeErrorMessage(error, "Failed to fetch hub data") },
      { status: 500 },
    );
  }
}
