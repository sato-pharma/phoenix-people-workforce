import type { AccessContext } from "@/lib/auth/permissions";
import type { CoachingReportStatus } from "@/lib/coaching/types";
import { assertWorkflowRegistryRuntimeTransition } from "@/lib/workflow-registry/runtime";

export const coachingWorkflowRegistryModuleKey = "coaching_reports";

export type CoachingWorkflowActionKey =
  | "acknowledge"
  | "create_draft"
  | "lock"
  | "submit"
  | "update_draft";

export function toCoachingWorkflowStatus(status: CoachingReportStatus | string | null | undefined) {
  const normalized = String(status ?? "").trim().toLowerCase();
  return normalized || "draft";
}

export async function assertCoachingWorkflowTransition(input: {
  access: Pick<AccessContext, "role">;
  actionKey: CoachingWorkflowActionKey;
  expectedNextStatus?: string;
  status: CoachingReportStatus | string | null | undefined;
}) {
  return assertWorkflowRegistryRuntimeTransition({
    access: input.access,
    actionKey: input.actionKey,
    expectedNextStatus: input.expectedNextStatus,
    moduleKey: coachingWorkflowRegistryModuleKey,
    status: toCoachingWorkflowStatus(input.status),
  });
}
