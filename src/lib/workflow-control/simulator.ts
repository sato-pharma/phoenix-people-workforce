/**
 * Workflow Control Center — Phase 1 READ-ONLY simulator.
 *
 * Given a workflow and a hypothetical request context, this returns the steps a
 * request WOULD pass through, who would be notified/emailed, the final status,
 * side effects, and warnings (e.g. a missing manager/HR recipient).
 *
 * It is a PURE function over the static definitions — it performs NO database
 * access, calls NO services, and creates NO real requests. It never imports a
 * server-only module. This guarantees the simulator cannot mutate production
 * data. Phase 2 may layer live directory resolution on top read-only.
 */

import {
  getWorkflowDefinition,
  type WorkflowControlDefinition,
  type WorkflowControlStep,
} from "@/lib/workflow-control/definitions";

export type WorkflowSimulationInput = {
  workflowKey: string;
  employeeHrId?: string;
  requestType?: string;
  amount?: number;
  line?: string;
  department?: string;
  managerName?: string;
  managerHrId?: string;
  managerOfManagerName?: string;
  managerOfManagerHrId?: string;
  /** Whether a designated HR Specialist (A-16) recipient exists. Defaults true. */
  hrSpecialistAvailable?: boolean;
};

export type SimulatedWorkflowStep = {
  id: string;
  index: number;
  name: string;
  /** Resolved actor/owner this step routes to. */
  routesTo: string;
  role: string;
  statusProduced: string;
  notificationRecipients: string[];
  emailRecipients: string[];
  fallbackEscalation?: string;
  sideEffects?: string;
  warnings: string[];
};

export type WorkflowSimulationResult = {
  workflowKey: string;
  workflowName: string;
  found: boolean;
  steps: SimulatedWorkflowStep[];
  finalStatus: string;
  sideEffects: string[];
  warnings: string[];
};

function trimmed(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function resolvedManager(input: WorkflowSimulationInput): string {
  return trimmed(input.managerName) || trimmed(input.managerHrId);
}

function resolvedManagerOfManager(input: WorkflowSimulationInput): string {
  return trimmed(input.managerOfManagerName) || trimmed(input.managerOfManagerHrId);
}

/**
 * Resolve a recipient placeholder against the simulation context, pushing a
 * warning when a required manager/HR recipient cannot be resolved.
 */
function resolveRecipient(
  raw: string,
  input: WorkflowSimulationInput,
  warnings: string[],
): string | null {
  const text = raw.trim();
  const lower = text.toLowerCase();

  if (lower.includes("manager-of-manager")) {
    const mom = resolvedManagerOfManager(input);
    // Conditional recipient — omit silently when there is no manager-of-manager.
    return mom ? `Manager-of-manager: ${mom}` : null;
  }

  if (lower.includes("direct manager") || lower === "manager" || lower.includes("manager chain")) {
    const manager = resolvedManager(input);
    if (!manager) {
      warnings.push(
        `Direct manager not resolved${input.employeeHrId ? ` for ${input.employeeHrId}` : ""} — this step cannot reach a manager.`,
      );
      return text;
    }
    return text.replace(/direct manager|manager chain|manager/i, `Manager ${manager}`);
  }

  if (lower.includes("employee") || lower.includes("requester") || lower.includes("rep")) {
    const employee = trimmed(input.employeeHrId);
    return employee ? `${text} [${employee}]` : text;
  }

  if (lower.includes("hr specialist") || lower === "hr" || lower.includes("hr ")) {
    if (input.hrSpecialistAvailable === false) {
      warnings.push("No HR Specialist (A-16) recipient is configured — the HR step cannot notify HR.");
    }
    return text;
  }

  return text;
}

function resolveList(
  list: readonly string[],
  input: WorkflowSimulationInput,
  warnings: string[],
): string[] {
  const out: string[] = [];
  for (const entry of list) {
    const resolved = resolveRecipient(entry, input, warnings);
    if (resolved) out.push(resolved);
  }
  return out;
}

function routeFor(step: WorkflowControlStep, input: WorkflowSimulationInput): string {
  const lower = step.actor.toLowerCase();
  if (lower.includes("manager")) {
    const manager = resolvedManager(input);
    return manager ? `Direct manager (${manager})` : "Direct manager";
  }
  if (lower.includes("hr")) return "HR Specialist";
  if (lower.includes("employee") || lower.includes("candidate") || lower.includes("rep")) {
    const employee = trimmed(input.employeeHrId);
    return employee ? `${step.actor} (${employee})` : step.actor;
  }
  return step.actor;
}

/** Run a read-only simulation of a workflow for a hypothetical request context. */
export function simulateWorkflow(input: WorkflowSimulationInput): WorkflowSimulationResult {
  const definition: WorkflowControlDefinition | undefined = getWorkflowDefinition(input.workflowKey);

  if (!definition) {
    return {
      workflowKey: input.workflowKey,
      workflowName: input.workflowKey,
      found: false,
      steps: [],
      finalStatus: "unknown",
      sideEffects: [],
      warnings: [`Unknown workflow: "${input.workflowKey}".`],
    };
  }

  const warnings: string[] = [];
  const sideEffects: string[] = [];

  const steps: SimulatedWorkflowStep[] = definition.steps.map((step, index) => {
    const stepWarnings: string[] = [];
    const notificationRecipients = resolveList(step.notificationRecipients, input, stepWarnings);
    const emailRecipients = resolveList(step.emailRecipients, input, stepWarnings);

    if (step.sideEffects) sideEffects.push(`${step.name}: ${step.sideEffects}`);
    warnings.push(...stepWarnings);

    return {
      id: step.id,
      index,
      name: step.name,
      routesTo: routeFor(step, input),
      role: step.role,
      statusProduced: step.statusProduced,
      notificationRecipients,
      emailRecipients,
      fallbackEscalation: step.fallbackEscalation,
      sideEffects: step.sideEffects,
      warnings: stepWarnings,
    };
  });

  // Amount context note for expense/outstation (read-only — no policy mutation).
  if (typeof input.amount === "number" && Number.isFinite(input.amount)) {
    sideEffects.push(`Simulated amount: ${input.amount} (read-only; no payroll record created).`);
  }

  const finalStatus = steps.length > 0 ? steps[steps.length - 1].statusProduced : "unknown";

  // De-duplicate warnings while preserving order.
  const dedupedWarnings = Array.from(new Set(warnings));

  return {
    workflowKey: definition.key,
    workflowName: definition.name,
    found: true,
    steps,
    finalStatus,
    sideEffects,
    warnings: dedupedWarnings,
  };
}
