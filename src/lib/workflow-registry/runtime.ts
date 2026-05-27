import type { AccessContext } from "@/lib/auth/permissions";
import {
  assertWorkflowRegistryTransition,
  WorkflowRegistryTransitionError,
} from "@/lib/workflow-registry/service";

export async function assertWorkflowRegistryRuntimeTransition(input: {
  access: Pick<AccessContext, "role">;
  actionKey: string;
  expectedNextStatus?: string;
  moduleKey: string;
  status: string;
}) {
  const transition = await assertWorkflowRegistryTransition({
    actionKey: input.actionKey,
    moduleKey: input.moduleKey,
    role: input.access.role,
    status: input.status,
  });

  if (input.expectedNextStatus && transition.nextStatus !== input.expectedNextStatus) {
    throw new WorkflowRegistryTransitionError({
      actionKey: input.actionKey,
      message:
        `Workflow Registry blocked ${input.moduleKey}.${input.actionKey}: ` +
        `expected next status "${input.expectedNextStatus}" but registry points to "${transition.nextStatus}".`,
      moduleKey: input.moduleKey,
      reason: "workflow_next_status_mismatch",
      status: input.status,
    });
  }

  return transition;
}
