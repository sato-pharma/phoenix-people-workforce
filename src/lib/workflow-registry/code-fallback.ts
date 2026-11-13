import { logWarning } from "@/lib/observability/log";
import {
  listWorkflowRegistryModules,
  WorkflowRegistryTransitionError,
  type WorkflowRegistryModule,
} from "@/lib/workflow-registry/service";

/**
 * THE REGISTRY GATE FOR A MACHINE WHOSE TRANSITION TABLE ALSO LIVES IN CODE (audit item REC-005).
 *
 * Employee plans and market awareness were registered in `workflow_registry_modules` long after
 * their code tables were written (migration 20261113201813 seeds exact copies of
 * EMPLOYEE_PLAN_TRANSITIONS and MARKET_AWARENESS_TRANSITIONS). Their services now ask the registry
 * the same question the code table already answered, as a SECOND gate after the code's own check,
 * the way payroll batches ask both getPayrollWorkflowTransition and the registry.
 *
 * Two deliberate differences from assertWorkflowRegistryTransition:
 *
 *  1. THE CODE TABLE IS THE FALLBACK. When the registry cannot be read, or has no active row for the
 *     module (the migration not applied yet, or the module switched off on the Workflow Registry
 *     screen), this answers `source: "code"` and refuses nothing — the code table, which the caller
 *     has already checked, stays the whole rule. The older modules fail CLOSED on a missing row;
 *     these two must not, because they ran for months on the code table alone.
 *
 *  2. ROLES ARE NOT READ. Who may act on a plan or an awareness activity is decided by identity in
 *     the service (the plan's assigned manager, the named second approver, the activity's approver
 *     slots), never by a role list, so the seeded `allowedRoles` name every role and this gate
 *     checks only the status the action leaves from and the status it lands on.
 *
 * When the row IS there it is authoritative for those two things: an action it does not define, a
 * status it does not allow, or a destination that disagrees with the code's is refused — that is
 * what lets a Super Admin's edit on the Workflow Registry screen take effect.
 */

export type RegistryOrCodeVerdict =
  | { source: "code"; reason: "registry_unreadable" | "module_not_registered" }
  | { source: "registry"; nextStatus: string };

export type WorkflowRegistryModuleLoader = () => Promise<WorkflowRegistryModule[]>;

export async function assertRegistryAgreesWithCodeTransition(input: {
  moduleKey: string;
  actionKey: string;
  status: string;
  /** Where the CODE table sends this action — the registry must send it to the same place. */
  codeNextStatus: string;
  /** Injected by tests; production reads the table. */
  loadModules?: WorkflowRegistryModuleLoader;
}): Promise<RegistryOrCodeVerdict> {
  let modules: WorkflowRegistryModule[];
  try {
    modules = await (input.loadModules ?? listWorkflowRegistryModules)();
  } catch (error) {
    logWarning(`Workflow registry unreadable; ${input.moduleKey}.${input.actionKey} falls back to its code table`, {
      error,
      labels: { event: "workflow_registry_code_fallback", moduleKey: input.moduleKey },
    });
    return { reason: "registry_unreadable", source: "code" };
  }

  const registered = modules.find((module) => module.isActive && module.moduleKey === input.moduleKey);
  if (!registered) return { reason: "module_not_registered", source: "code" };

  const action = registered.actions.find((item) => item.key === input.actionKey);
  if (!action) {
    throw new WorkflowRegistryTransitionError({
      actionKey: input.actionKey,
      message: `Workflow Registry blocked ${input.moduleKey}.${input.actionKey}: action is not defined.`,
      moduleKey: input.moduleKey,
      reason: "workflow_action_not_found",
      status: input.status,
    });
  }
  if (!action.from.includes(input.status)) {
    throw new WorkflowRegistryTransitionError({
      actionKey: input.actionKey,
      message: `Workflow Registry blocked ${input.moduleKey}.${input.actionKey}: status "${input.status}" is not allowed.`,
      moduleKey: input.moduleKey,
      reason: "workflow_status_not_allowed",
      status: input.status,
    });
  }
  if (action.to !== input.codeNextStatus) {
    throw new WorkflowRegistryTransitionError({
      actionKey: input.actionKey,
      message:
        `Workflow Registry blocked ${input.moduleKey}.${input.actionKey}: ` +
        `expected next status "${input.codeNextStatus}" but registry points to "${action.to}".`,
      moduleKey: input.moduleKey,
      reason: "workflow_next_status_mismatch",
      status: input.status,
    });
  }
  return { nextStatus: action.to, source: "registry" };
}
