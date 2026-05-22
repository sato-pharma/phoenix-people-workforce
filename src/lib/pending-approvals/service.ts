import { writeRequiredAuditLog } from "@/lib/admin/audit";
import {
  assertPermission,
  canAccess,
  isDesignatedHrSpecialist,
  normalizeHrIdForAccess,
  resolveEmployeeIdentityId,
  type AccessContext,
  type PermissionResource,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import {
  decideExcuseRequest,
  isExcusesSchemaMissing,
  listPendingExcuseApprovals,
} from "@/lib/excuses/service";
import { getContractRenewalDashboardData, runContractRenewalWorkflow } from "@/lib/contracts/service";
import { getOfferDashboard, approveAcceptedOffer } from "@/lib/offers/service";
import {
  approveOutstationRequestForPayroll,
  listOutstationRequests,
  rejectOutstationRequestForPayroll,
} from "@/lib/outstation/service";
import {
  canApprovePayrollExpenses,
  decidePayrollExpenseApproval,
  isPayrollExpensesSchemaMissing,
  listPayrollExpenses,
} from "@/lib/payroll/expenses";
import { listSalaryBatches, runPayrollWorkflow } from "@/lib/payroll/service";
import { getResignationsDashboardData, runResignationWorkflow } from "@/lib/resignations/service";
import { listSalesQueue, updateSalesBatchStatus } from "@/lib/sales/service";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { decideVacationRequest, getVacationReportData } from "@/lib/vacation/service";
import { getEmployeeDirectory, type EmployeeDirectoryData, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";

export type PendingApprovalWorkflow =
  | "contract-renewal"
  | "excuse"
  | "expense"
  | "offer"
  | "outstation"
  | "payroll-batch"
  | "resignation"
  | "sales-import"
  | "vacation";

export type PendingApprovalItem = {
  currentStep: string;
  detailHref: string;
  id: string;
  requester: string;
  requesterHrId: string | null;
  requiresRejectComment: boolean;
  shortSummary: string;
  submittedAt: string;
  workflow: PendingApprovalWorkflow;
  workflowLabel: string;
};

export type PendingApprovalDecision = {
  comment?: string | null;
  decision: "approve" | "reject";
};

const rejectCommentRequired = new Set<PendingApprovalWorkflow>([
  "contract-renewal",
  "expense",
  "outstation",
  "payroll-batch",
  "resignation",
]);

const financeApprovalRoles = new Set<PhoenixRole>(["CEO", "Finance Manager", "Super Admin"]);
const hrApprovalRoles = new Set<PhoenixRole>(["CEO", "HR Specialist", "Super Admin"]);

function actorId(access: AccessContext) {
  return resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
}

function actorIdentityCandidates(access: AccessContext) {
  const values = [access.hrId, access.loginId, resolveEmployeeIdentityId(access)];
  const seen = new Set<string>();

  return values
    .map((value) => normalizeHrIdForAccess(value))
    .filter((value): value is string => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function actorMatchesHrId(access: AccessContext, hrId: string | null | undefined) {
  const target = normalizeHrIdForAccess(hrId);
  if (!target) return false;
  return actorIdentityCandidates(access).includes(target);
}

function actorMatchesText(access: AccessContext, value: string | null | undefined) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  const normalizedText = normalizeHrIdForAccess(text);
  return Boolean(normalizedText && actorIdentityCandidates(access).includes(normalizedText));
}

function employeeMapByHrId(directory: EmployeeDirectoryData) {
  const employeesByHrId = new Map<string, EmployeeDirectoryRow>();
  for (const employee of directory.employees) {
    const employeeHrId = normalizeHrIdForAccess(employee.hrId);
    if (employeeHrId) employeesByHrId.set(employeeHrId, employee);
  }
  return employeesByHrId;
}

function isRequesterInActorHierarchy(
  access: AccessContext,
  directory: EmployeeDirectoryData,
  requesterHrId: string | null | undefined,
) {
  const requesterId = normalizeHrIdForAccess(requesterHrId);
  if (!requesterId) return false;

  const actorIds = new Set(actorIdentityCandidates(access));
  if (actorIds.has(requesterId)) return false;

  const employeesByHrId = employeeMapByHrId(directory);
  let managerHrId = normalizeHrIdForAccess(employeesByHrId.get(requesterId)?.managerHrId);
  const visited = new Set<string>();

  while (managerHrId && !visited.has(managerHrId)) {
    if (actorIds.has(managerHrId)) return true;
    visited.add(managerHrId);
    managerHrId = normalizeHrIdForAccess(employeesByHrId.get(managerHrId)?.managerHrId);
  }

  return false;
}

function canApproveHierarchyItem(input: {
  access: AccessContext;
  companyRoles?: ReadonlySet<PhoenixRole>;
  directory: EmployeeDirectoryData | null;
  requesterHrId: string | null | undefined;
}) {
  if (!input.requesterHrId || actorMatchesHrId(input.access, input.requesterHrId)) return false;
  if (input.access.scope === "system") return true;
  if (input.companyRoles?.has(input.access.role)) {
    if (input.access.role !== "HR Specialist" || isDesignatedHrSpecialist(input.access)) return true;
  }
  if (!input.directory) return false;
  return isRequesterInActorHierarchy(input.access, input.directory, input.requesterHrId);
}

function canApproveHrItem(access: AccessContext, requesterHrId: string | null | undefined) {
  if (requesterHrId && actorMatchesHrId(access, requesterHrId)) return false;
  if (access.scope === "system" || access.role === "Super Admin" || access.role === "CEO") return true;
  return isDesignatedHrSpecialist(access);
}

function isSelfApproval(access: AccessContext, requesterHrId: string | null | undefined) {
  return Boolean(requesterHrId && actorMatchesHrId(access, requesterHrId));
}

async function assertAssignedPendingApproval(
  access: AccessContext,
  workflow: PendingApprovalWorkflow,
  id: string,
) {
  const visibleItems = await listPendingApprovals(access);
  const isAssigned = visibleItems.some((item) => item.workflow === workflow && item.id === id);
  if (!isAssigned) {
    throw new Error("Forbidden: this approval is not assigned to your hierarchy or current workflow step.");
  }
}

function safeDate(value: string | null | undefined) {
  if (!value) return new Date(0).toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
    style: "currency",
    currency: "EGP",
  }).format(value || 0);
}

async function safeApprovalList(loader: () => Promise<PendingApprovalItem[]>) {
  try {
    return await loader();
  } catch (error) {
    if (isExcusesSchemaMissing(error) || isPayrollExpensesSchemaMissing(error)) return [];
    return [];
  }
}

async function canApprove(access: AccessContext, resource: PermissionResource) {
  return canAccess(access, resource, "approve");
}

export async function listPendingApprovals(access: AccessContext): Promise<PendingApprovalItem[]> {
  const directoryPromise = getEmployeeDirectory().catch(() => null);

  const lists = await Promise.all([
    safeApprovalList(async () => {
      if (!await canApprove(access, "leave")) return [];
      const data = await getVacationReportData(access, { status: "all" });
      return data.rows
        .filter((request) => request.canDecide && (request.status === "pending_manager" || request.status === "pending_hr"))
        .filter((request) => !isSelfApproval(access, request.employeeHrId))
        .map((request) => ({
          currentStep: request.status === "pending_hr" ? "HR final approval" : "Manager approval",
          detailHref: `/leave-management/vacation-report?tab=requests&requestId=${encodeURIComponent(request.id)}`,
          id: request.id,
          requester: request.employeeName,
          requesterHrId: request.employeeHrId,
          requiresRejectComment: false,
          shortSummary: `${request.employeeName} submitted ${request.vacationType.replace(/_/g, " ")} vacation from ${request.startDate} to ${request.endDate}.`,
          submittedAt: safeDate(request.createdAt),
          workflow: "vacation" as const,
          workflowLabel: "Vacation",
        }));
    }),
    safeApprovalList(async () => {
      if (!await canApprove(access, "leave")) return [];
      const requests = await listPendingExcuseApprovals(access);
      return requests
        .filter((request) => !isSelfApproval(access, request.employeeHrId))
        .map((request) => ({
          currentStep: "Manager approval",
          detailHref: "/employee-portals/excuses",
          id: request.id,
          requester: request.employeeName,
          requesterHrId: request.employeeHrId,
          requiresRejectComment: false,
          shortSummary: `${request.employeeName} submitted a ${request.excuseType} excuse for ${request.excuseDate}.`,
          submittedAt: safeDate(request.createdAt),
          workflow: "excuse" as const,
          workflowLabel: "Employee Excuse",
        }));
    }),
    safeApprovalList(async () => {
      if (!await canApprovePayrollExpenses(access)) return [];
      const expenses = await listPayrollExpenses(undefined, undefined, undefined, access);
      return expenses
        .filter((expense) => {
          const status = `${expense.status} ${expense.hr}`.toLowerCase();
          return !expense.hrApproved && !status.includes("reject");
        })
        .filter((expense) => !isSelfApproval(access, expense.hrId))
        .slice(0, 100)
        .map((expense) => ({
          currentStep: "Expense approval",
          detailHref: "/payroll/expenses",
          id: expense.tripId,
          requester: expense.specialist || expense.hrId || "Unknown employee",
          requesterHrId: expense.hrId,
          requiresRejectComment: true,
          shortSummary: `${expense.specialist || "Employee"} submitted ${expense.description || expense.requestType || "expense"} for ${money(expense.total)}.`,
          submittedAt: safeDate(expense.date),
          workflow: "expense" as const,
          workflowLabel: "Expense",
        }));
    }),
    safeApprovalList(async () => {
      if (!await canApprove(access, "outstation")) return [];
      const directory = await directoryPromise;
      const requests = await listOutstationRequests();
      return requests
        .filter((request) => request.status === "submitted")
        .filter((request) => canApproveHierarchyItem({
          access,
          companyRoles: financeApprovalRoles,
          directory,
          requesterHrId: request.employeeHrId,
        }))
        .map((request) => ({
          currentStep: "Outstation approval",
          detailHref: `/admin/outstation/requests?requestId=${request.id}`,
          id: String(request.id),
          requester: request.employeeName,
          requesterHrId: request.employeeHrId,
          requiresRejectComment: true,
          shortSummary: `${request.employeeName} submitted ${request.expenseType} outstation from ${request.tripStartDate} to ${request.tripEndDate}.`,
          submittedAt: safeDate(request.submittedAt ?? request.createdAt),
          workflow: "outstation" as const,
          workflowLabel: "Outstation",
        }));
    }),
    safeApprovalList(async () => {
      if (!await canApprove(access, "sales")) return [];
      const batches = await listSalesQueue(access);
      return batches
        .filter((batch) => batch.canApprove && batch.status !== "approved" && batch.status !== "rejected" && batch.status !== "replaced")
        .filter((batch) => !actorMatchesText(access, batch.uploadedBy))
        .map((batch) => ({
          currentStep: batch.approvalBlockedReason ? "Approval blocked" : "Sales import approval",
          detailHref: `/sales/queue/${encodeURIComponent(batch.id)}`,
          id: batch.id,
          requester: batch.uploadedBy || "Sales import",
          requesterHrId: null,
          requiresRejectComment: false,
          shortSummary: `${batch.fileName} for ${batch.period} (${batch.line}) has ${batch.totalRecords} rows.`,
          submittedAt: safeDate(batch.createdAt),
          workflow: "sales-import" as const,
          workflowLabel: "Sales Import",
        }));
    }),
    safeApprovalList(async () => {
      if (!await canApprove(access, "offers")) return [];
      const dashboard = await getOfferDashboard();
      return dashboard.rows
        .filter((offer) => offer.status === "accepted" && offer.onboardingStatus === "pending_hr_approval")
        .filter((offer) => canApproveHrItem(access, offer.employeeHrId))
        .map((offer) => ({
          currentStep: "HR offer approval",
          detailHref: `/offers?offerId=${encodeURIComponent(offer.id)}`,
          id: offer.id,
          requester: offer.candidateName,
          requesterHrId: offer.employeeHrId,
          requiresRejectComment: false,
          shortSummary: `${offer.candidateName} accepted the ${offer.jobTitle} offer.`,
          submittedAt: safeDate(offer.acceptedAt ?? offer.updatedAt),
          workflow: "offer" as const,
          workflowLabel: "Accepted Offer",
        }));
    }),
    safeApprovalList(async () => {
      if (!await canApprove(access, "contracts")) return [];
      const directory = await directoryPromise;
      const dashboard = await getContractRenewalDashboardData(access);
      return dashboard.rows
        .map((row) => row.workflow)
        .filter((workflow): workflow is NonNullable<typeof workflow> => Boolean(workflow))
        .filter((workflow) => ["requested", "manager_review", "hr_review"].includes(workflow.status))
        .filter((workflow) => canApproveHierarchyItem({
          access,
          companyRoles: hrApprovalRoles,
          directory,
          requesterHrId: workflow.employeeHrId,
        }))
        .map((workflow) => ({
          currentStep: workflow.status.replace(/_/g, " "),
          detailHref: `/contracts?requestId=${encodeURIComponent(workflow.id)}`,
          id: workflow.id,
          requester: workflow.employeeName,
          requesterHrId: workflow.employeeHrId,
          requiresRejectComment: true,
          shortSummary: `${workflow.employeeName} contract renewal requested for ${workflow.requestedRenewalDate}.`,
          submittedAt: safeDate(workflow.createdAt),
          workflow: "contract-renewal" as const,
          workflowLabel: "Contract Renewal",
        }));
    }),
    safeApprovalList(async () => {
      if (!await canApprove(access, "resignations")) return [];
      const directory = await directoryPromise;
      const dashboard = await getResignationsDashboardData();
      return dashboard.records
        .filter((record) => ["submitted", "under_review"].includes(record.status))
        .filter((record) => canApproveHierarchyItem({
          access,
          companyRoles: hrApprovalRoles,
          directory,
          requesterHrId: record.employeeHrId,
        }))
        .map((record) => ({
          currentStep: record.status.replace(/_/g, " "),
          detailHref: `/resignations?requestId=${encodeURIComponent(record.id)}`,
          id: record.id,
          requester: record.employeeName,
          requesterHrId: record.employeeHrId,
          requiresRejectComment: true,
          shortSummary: `${record.employeeName} resignation is effective ${record.effectiveDate}.`,
          submittedAt: safeDate(record.submittedDate ?? record.createdAt),
          workflow: "resignation" as const,
          workflowLabel: "Resignation",
        }));
    }),
    safeApprovalList(async () => {
      if (!await canApprove(access, "payroll")) return [];
      const batches = await listSalaryBatches();
      return batches
        .filter((batch) => batch.status === "under_review")
        .filter((batch) => !actorMatchesText(access, batch.uploadedBy))
        .map((batch) => ({
          currentStep: "Payroll approval",
          detailHref: `/payroll?batchId=${encodeURIComponent(batch.id)}`,
          id: batch.id,
          requester: batch.uploadedBy || "Payroll",
          requesterHrId: null,
          requiresRejectComment: true,
          shortSummary: `${batch.fileName} payroll batch for ${batch.month}/${batch.year} is under review.`,
          submittedAt: safeDate(batch.createdAt),
          workflow: "payroll-batch" as const,
          workflowLabel: "Payroll Batch",
        }));
    }),
  ]);

  return lists
    .flat()
    .sort((left, right) => String(right.submittedAt).localeCompare(String(left.submittedAt)));
}

export async function decidePendingApproval(
  access: AccessContext,
  workflow: PendingApprovalWorkflow,
  id: string,
  input: PendingApprovalDecision,
) {
  if (input.decision === "reject" && rejectCommentRequired.has(workflow) && !String(input.comment ?? "").trim()) {
    throw new Error("A rejection comment is required.");
  }

  await assertAssignedPendingApproval(access, workflow, id);

  switch (workflow) {
    case "vacation":
      return decideVacationRequest(access, {
        decision: input.decision,
        decisionComment: input.comment,
        requestId: id,
      });
    case "excuse":
      return decideExcuseRequest(access, {
        decision: input.decision,
        decisionComment: input.comment,
        requestId: id,
      });
    case "expense":
      return decidePayrollExpenseApproval(id, access, input);
    case "outstation": {
      await assertPermission(access, "outstation", "approve");
      const requestId = Number(id);
      if (!Number.isFinite(requestId)) throw new Error("Outstation request ID is invalid.");
      return input.decision === "approve"
        ? approveOutstationRequestForPayroll(requestId, access, { comment: input.comment })
        : rejectOutstationRequestForPayroll(requestId, access, { comment: input.comment });
    }
    case "sales-import": {
      await assertPermission(access, "sales", "approve");
      return updateSalesBatchStatus(
        id,
        input.decision === "approve" ? "approved" : "rejected",
        access.loginId ?? actorId(access),
        actorId(access),
      );
    }
    case "offer": {
      await assertPermission(access, "offers", "approve");
      if (input.decision === "approve") {
        return approveAcceptedOffer(id, actorId(access));
      }
      return rejectAcceptedOffer(id, actorId(access), input.comment);
    }
    case "contract-renewal":
      await assertPermission(access, "contracts", "approve");
      return runContractRenewalWorkflow(
        id,
        input.decision === "approve" ? "renew" : "not_renew",
        actorId(access),
        { decisionReason: input.comment },
      );
    case "resignation":
      await assertPermission(access, "resignations", "approve");
      return runResignationWorkflow(
        id,
        input.decision === "approve" ? "approve" : "reject",
        actorId(access),
        input.comment,
        input.comment,
      );
    case "payroll-batch":
      await assertPermission(access, "payroll", input.decision === "approve" ? "approve" : "update");
      return runPayrollWorkflow(
        id,
        input.decision === "approve" ? "approve" : "reject",
        actorId(access),
        input.comment ?? undefined,
      );
    default:
      throw new Error("Unsupported pending approval workflow.");
  }
}

async function rejectAcceptedOffer(id: string, actor: string, comment?: string | null) {
  const now = new Date().toISOString();
  const { data: existing, error: existingError } = await getSupabaseAdmin()
    .from("job_offers")
    .select("id,status,candidate_name,job_title,onboarding_status")
    .eq("id", id)
    .maybeSingle();

  if (existingError) throw existingError;
  if (!existing) throw new Error("Offer not found.");
  if (String((existing as Record<string, unknown>).status) !== "accepted") {
    throw new Error("Only accepted offers can be rejected.");
  }

  const { data, error } = await getSupabaseAdmin()
    .from("job_offers")
    .update({
      onboarding_status: "not_started",
      rejected_at: now,
      status: "rejected",
      updated_at: now,
    })
    .eq("id", id)
    .select("id,status,candidate_name,job_title,onboarding_status")
    .single();

  if (error) throw error;

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: id,
    entityType: "job_offer",
    newValues: {
      comment: comment ?? null,
      status: "rejected",
    },
    oldValues: {
      status: "accepted",
    },
    summary: "Accepted offer rejected before HR approval.",
  });

  return data;
}
