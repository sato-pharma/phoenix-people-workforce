import { redirect } from "next/navigation";

import { ActionsWorkspace } from "@/components/action-center/actions-workspace";
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
import { getContractRenewalDashboardData } from "@/lib/contracts/service";
import { getMyRequestItems } from "@/lib/action-center/service";
import type { VacationActionCenterRow } from "@/lib/vacation/types";
import type { ResignationRecord } from "@/lib/resignations/types";
import type { EmployeeExcuseRequest } from "@/lib/excuses/service";
import type { OutstationExpenseRequest } from "@/lib/outstation/types";
import type { ContractRow } from "@/lib/contracts/types";

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

const ACTIVE_CONTRACT_STATUSES = new Set(["requested", "manager_review", "hr_review"]);

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

export default async function ActionsPage({
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

  // The "Awaiting my action" inbox excludes marketing requests by design — marketing
  // keeps its own dedicated approval inbox. The "My requests" tab is resolved in parallel.
  const [inboxSettled, myRequests] = await Promise.all([
    Promise.allSettled([
      getVacationActionCenterData(access).catch(() => null),
      getResignationsDashboardData().catch(() => null),
      getManagerPendingExcuses(access).catch(() => null),
      listOutstationRequests().catch(() => null),
      getContractRenewalDashboardData(access).catch(() => null),
    ]),
    getMyRequestItems(access).catch(() => []),
  ]);

  const [leaveResult, resignationsResult, excusesResult, outstationResult, contractResult] = inboxSettled;

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

  if (contractResult.status === "fulfilled" && contractResult.value) {
    for (const row of contractResult.value.rows) {
      const item = mapContractRenewalItem(row);
      if (item) items.push(item);
    }
  }

  items.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));

  const data: ActionHubData = {
    generatedAt: new Date().toISOString(),
    items,
  };

  // Approvers land on their inbox; pure requesters (empty inbox) land on "My requests".
  const initialTab: "inbox" | "mine" =
    initialModule || initialId || items.length > 0 ? "inbox" : myRequests.length > 0 ? "mine" : "inbox";

  return (
    <ActionsWorkspace
      inboxData={data}
      myRequests={myRequests}
      initialModule={initialModule}
      initialId={initialId}
      callerRole={access.role}
      initialTab={initialTab}
    />
  );
}
