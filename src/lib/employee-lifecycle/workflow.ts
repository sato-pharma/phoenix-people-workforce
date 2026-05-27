import type { AccessContext } from "@/lib/auth/permissions";
import { systemAccessContext } from "@/lib/auth/permissions";
import type { ContractRenewalAction, ContractRenewalStatus } from "@/lib/contracts/types";
import type { OfferStatus } from "@/lib/offers/service";
import type { ProbationWorkflowAction } from "@/lib/probation/types";
import type { ResignationStatus, ResignationWorkflowAction } from "@/lib/resignations/types";
import { assertWorkflowRegistryRuntimeTransition } from "@/lib/workflow-registry/runtime";

export const resignationWorkflowRegistryModuleKey = "resignations";
export const probationWorkflowRegistryModuleKey = "probation";
export const contractWorkflowRegistryModuleKey = "contracts";
export const offerWorkflowRegistryModuleKey = "offers";

type LifecycleAccess = Pick<AccessContext, "role">;

export function toResignationWorkflowStatus(status: ResignationStatus | string | null | undefined) {
  const normalized = String(status ?? "submitted").trim().toLowerCase();
  return `resignation_${normalized || "submitted"}`;
}

export function resignationActionKey(action: ResignationWorkflowAction) {
  return `resignation_${action}`;
}

export async function assertResignationWorkflowTransition(input: {
  access?: LifecycleAccess;
  action: ResignationWorkflowAction | "submit";
  expectedNextStatus?: string;
  status: ResignationStatus | string | null | undefined;
}) {
  return assertWorkflowRegistryRuntimeTransition({
    access: input.access ?? systemAccessContext,
    actionKey: input.action === "submit" ? "resignation_submit" : resignationActionKey(input.action),
    expectedNextStatus: input.expectedNextStatus,
    moduleKey: resignationWorkflowRegistryModuleKey,
    status: input.action === "submit" ? "resignation_new" : toResignationWorkflowStatus(input.status),
  });
}

export function toProbationWorkflowStatus(input: {
  decision?: string | null;
  status?: string | null;
}) {
  const decision = String(input.decision ?? "").trim().toLowerCase();
  if (decision === "pass") return "probation_passed";
  if (decision === "terminate") return "probation_terminated";
  if (decision === "extend") return "probation_extended";

  const status = String(input.status ?? "evaluation_requested").trim().toLowerCase();
  if (status === "manager_feedback") return "probation_manager_feedback";
  if (status === "completed") return "probation_passed";
  if (status === "cancelled") return "probation_cancelled";
  return "probation_evaluation_requested";
}

export async function assertProbationWorkflowTransition(input: {
  access: LifecycleAccess;
  action: ProbationWorkflowAction | "create";
  decision?: string | null;
  expectedNextStatus?: string;
  status?: string | null;
}) {
  return assertWorkflowRegistryRuntimeTransition({
    access: input.access,
    actionKey: input.action === "create" ? "probation_create" : `probation_${input.action}`,
    expectedNextStatus: input.expectedNextStatus,
    moduleKey: probationWorkflowRegistryModuleKey,
    status: input.action === "create"
      ? "probation_new"
      : toProbationWorkflowStatus({ decision: input.decision, status: input.status }),
  });
}

export function toContractWorkflowStatus(status: ContractRenewalStatus | string | null | undefined) {
  const normalized = String(status ?? "requested").trim().toLowerCase();
  return `contract_${normalized || "requested"}`;
}

export async function assertContractWorkflowTransition(input: {
  access?: LifecycleAccess;
  action: ContractRenewalAction | "create";
  expectedNextStatus?: string;
  status: ContractRenewalStatus | string | null | undefined;
}) {
  return assertWorkflowRegistryRuntimeTransition({
    access: input.access ?? systemAccessContext,
    actionKey: input.action === "create" ? "contract_create" : `contract_${input.action}`,
    expectedNextStatus: input.expectedNextStatus,
    moduleKey: contractWorkflowRegistryModuleKey,
    status: input.action === "create" ? "contract_new" : toContractWorkflowStatus(input.status),
  });
}

export function toOfferWorkflowStatus(input: {
  onboardingStatus?: string | null;
  status?: OfferStatus | string | null;
}) {
  const status = String(input.status ?? "draft").trim().toLowerCase();
  const onboardingStatus = String(input.onboardingStatus ?? "").trim().toLowerCase();
  if (status === "accepted" && ["employee_created", "hired", "active"].includes(onboardingStatus)) {
    return "offer_hired";
  }
  return `offer_${status || "draft"}`;
}

export async function assertOfferWorkflowTransition(input: {
  access?: LifecycleAccess;
  action:
    | "candidate_accept"
    | "candidate_reject"
    | "create"
    | "expire"
    | "hire_approve";
  expectedNextStatus?: string;
  onboardingStatus?: string | null;
  status: OfferStatus | string | null | undefined;
}) {
  return assertWorkflowRegistryRuntimeTransition({
    access: input.access ?? systemAccessContext,
    actionKey: `offer_${input.action}`,
    expectedNextStatus: input.expectedNextStatus,
    moduleKey: offerWorkflowRegistryModuleKey,
    status: input.action === "create"
      ? "offer_draft"
      : toOfferWorkflowStatus({ onboardingStatus: input.onboardingStatus, status: input.status }),
  });
}
