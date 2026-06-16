import { redirect } from "next/navigation";

import { ActionCenterHub } from "@/components/action-center/action-center-hub";
import type {
  ActionHubData,
  ActionHubItem,
  ActionHubModule,
} from "@/components/action-center/types";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { vacationTypeLabel } from "@/lib/vacation/calculations";
import { getVacationActionCenterData } from "@/lib/vacation/service";
import { getResignationsDashboardData } from "@/lib/resignations/service";
import { getManagerPendingExcuses } from "@/lib/excuses/service";
import { listOutstationRequests } from "@/lib/outstation/service";
import { getApproverPendingRequests } from "@/lib/marketing-requests/service";
import type { VacationActionCenterRow } from "@/lib/vacation/types";
import type { ResignationRecord } from "@/lib/resignations/types";
import type { EmployeeExcuseRequest } from "@/lib/excuses/service";
import type { OutstationExpenseRequest } from "@/lib/outstation/types";
import type { MarketingApproverInboxRow } from "@/lib/marketing-requests/service";

export const dynamic = "force-dynamic";

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

function mapMarketingItem(row: MarketingApproverInboxRow): ActionHubItem {
  return {
    id: row.id,
    module: "marketing",
    employeeName: row.requesterName,
    employeeHrId: row.requesterHrId,
    title: `${row.requestType} · ${row.customerName}`,
    statusLabel: row.currentStepName,
    submittedAt: row.submittedAt ?? new Date().toISOString(),
    urgency: "normal",
    detail: {
      module: "marketing",
      requestCode: row.requestCode,
      customerName: row.customerName,
      requestType: row.requestType,
      estimatedCost: row.estimatedCost,
      payDate: row.payDate,
      currentStepName: row.currentStepName,
      decisionLabels: row.decisionLabels
        ? { approve: row.decisionLabels.approve, reject: row.decisionLabels.reject, return: row.decisionLabels.return }
        : null,
    },
  };
}

export default async function ActionCenterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }

  const params = await searchParams;
  const initialModule = (typeof params.module === "string" ? params.module : null) as ActionHubModule | null;
  const initialId = typeof params.id === "string" ? params.id : null;

  const settled = await Promise.allSettled([
    getVacationActionCenterData(access).catch(() => null),
    getResignationsDashboardData().catch(() => null),
    getManagerPendingExcuses(access).catch(() => null),
    listOutstationRequests().catch(() => null),
    getApproverPendingRequests(access).catch(() => null),
  ]);

  const [leaveResult, resignationsResult, excusesResult, outstationResult, marketingResult] = settled;

  const items: ActionHubItem[] = [];

  if (leaveResult.status === "fulfilled" && leaveResult.value) {
    for (const row of leaveResult.value.rows) {
      items.push(mapLeaveItem(row));
    }
  }

  if (resignationsResult.status === "fulfilled" && resignationsResult.value) {
    const actionableStatuses = new Set(["submitted", "under_review"]);
    for (const record of resignationsResult.value.records) {
      if (actionableStatuses.has(record.status)) {
        items.push(mapResignationItem(record));
      }
    }
  }

  if (excusesResult.status === "fulfilled" && excusesResult.value) {
    for (const request of excusesResult.value) {
      items.push(mapExcuseItem(request));
    }
  }

  if (outstationResult.status === "fulfilled" && outstationResult.value) {
    for (const request of outstationResult.value) {
      if (request.status === "submitted") {
        items.push(mapOutstationItem(request));
      }
    }
  }

  if (marketingResult.status === "fulfilled" && marketingResult.value) {
    for (const row of marketingResult.value.rows) {
      items.push(mapMarketingItem(row));
    }
  }

  items.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));

  const data: ActionHubData = {
    generatedAt: new Date().toISOString(),
    items,
  };

  return (
    <ActionCenterHub
      initialData={data}
      initialModule={initialModule}
      initialId={initialId}
    />
  );
}
