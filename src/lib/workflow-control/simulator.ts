/**
 * Workflow Control Center — Phase 1 READ-ONLY simulator.
 *
 * Given a domain + subflow and a hypothetical request context, this returns the
 * steps a request WOULD pass through, who would be notified/emailed, the final
 * status, side effects, and warnings (e.g. a missing manager/HR recipient).
 *
 * It is a PURE function over the static definitions — NO database access, NO
 * service calls, NO real requests, and NO server-only imports. This guarantees
 * the simulator cannot mutate production data.
 */

import {
  getWorkflowDomain,
  getWorkflowSubflow,
  type WorkflowControlStep,
  type WorkflowSubflow,
} from "@/lib/workflow-control/definitions";

export type WorkflowSimulationInput = {
  domainKey: string;
  /** Defaults to the domain's first subflow when omitted. */
  subflowKey?: string;
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
  domainKey: string;
  domainName: string;
  subflowKey: string;
  subflowName: string;
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

function resolveRecipient(raw: string, input: WorkflowSimulationInput, warnings: string[]): string | null {
  const text = raw.trim();
  const lower = text.toLowerCase();

  if (lower.includes("manager-of-manager")) {
    const mom = resolvedManagerOfManager(input);
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

  if (lower.includes("hr specialist") || lower === "hr" || lower.startsWith("hr ")) {
    if (input.hrSpecialistAvailable === false) {
      warnings.push("No HR Specialist (A-16) recipient is configured — the HR step cannot notify HR.");
    }
    return text;
  }

  return text;
}

function resolveList(list: readonly string[], input: WorkflowSimulationInput, warnings: string[]): string[] {
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

/** Run a read-only simulation of a domain subflow for a hypothetical context. */
export function simulateWorkflow(input: WorkflowSimulationInput): WorkflowSimulationResult {
  const domain = getWorkflowDomain(input.domainKey);
  if (!domain) {
    return {
      domainKey: input.domainKey,
      domainName: input.domainKey,
      subflowKey: input.subflowKey ?? "",
      subflowName: input.subflowKey ?? "",
      found: false,
      steps: [],
      finalStatus: "unknown",
      sideEffects: [],
      warnings: [`Unknown workflow domain: "${input.domainKey}".`],
    };
  }

  const subflow: WorkflowSubflow | undefined = input.subflowKey
    ? getWorkflowSubflow(domain.key, input.subflowKey)
    : domain.subflows[0];

  if (!subflow) {
    return {
      domainKey: domain.key,
      domainName: domain.name,
      subflowKey: input.subflowKey ?? "",
      subflowName: input.subflowKey ?? "",
      found: false,
      steps: [],
      finalStatus: "unknown",
      sideEffects: [],
      warnings: [`Unknown subflow "${input.subflowKey}" in domain "${domain.name}".`],
    };
  }

  const warnings: string[] = [];
  const sideEffects: string[] = [];

  const steps: SimulatedWorkflowStep[] = subflow.steps.map((step, index) => {
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

  if (typeof input.amount === "number" && Number.isFinite(input.amount)) {
    sideEffects.push(`Simulated amount: ${input.amount} (read-only; no payroll record created).`);
  }

  const finalStatus = steps.length > 0 ? steps[steps.length - 1].statusProduced : "unknown";

  return {
    domainKey: domain.key,
    domainName: domain.name,
    subflowKey: subflow.key,
    subflowName: subflow.name,
    found: true,
    steps,
    finalStatus,
    sideEffects,
    warnings: Array.from(new Set(warnings)),
  };
}
