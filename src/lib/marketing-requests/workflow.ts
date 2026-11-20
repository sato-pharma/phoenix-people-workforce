import type { AccessContext } from "@/lib/auth/permissions";
import type { MarketingRequestStatus } from "@/lib/marketing-requests/types";
import { assertWorkflowRegistryRuntimeTransition } from "@/lib/workflow-registry/runtime";

export const marketingWorkflowRegistryModuleKey = "marketing_requests";

export type MarketingWorkflowActionKey =
  | "create_draft"
  | "create_validation_record"
  | "update_control_step"
  | "upload_finance_evidence";

export function toMarketingRequestWorkflowStatus(status: MarketingRequestStatus | string | null | undefined) {
  const normalized = String(status ?? "draft").trim().toLowerCase();
  return normalized || "draft";
}

export async function assertMarketingWorkflowTransition(input: {
  access: Pick<AccessContext, "role">;
  actionKey: MarketingWorkflowActionKey;
  expectedNextStatus?: string;
  status: string;
}) {
  return assertWorkflowRegistryRuntimeTransition({
    access: input.access,
    actionKey: input.actionKey,
    expectedNextStatus: input.expectedNextStatus,
    moduleKey: marketingWorkflowRegistryModuleKey,
    status: input.status,
  });
}
