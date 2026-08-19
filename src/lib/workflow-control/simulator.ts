/**
 * Workflow Control Center — Phase 1.5 READ-ONLY simulator.
 *
 * Given a domain + subflow and a hypothetical request context, this returns the
 * route path, step sequence, responsible person/approver, notification + email
 * recipients (with action-required vs FYI), final status, side effects, and
 * warnings (missing manager/HR, unimplemented notification producers, read-only
 * domains, and the Phase-1 runtime-edit lock).
 *
 * PURE function over the static definitions — NO database access, NO service
 * calls, NO real requests, NO server-only imports. It cannot mutate data.
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
  /** Whether an HR Manager recipient exists. Defaults true. */
  hrManagerAvailable?: boolean;
  /**
   * Phase 2A: simulate a DRAFT step list (display/config overrides applied)
   * instead of the canonical subflow steps. Read-only — never persisted.
   */
  overrideSteps?: WorkflowControlStep[];
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
  actionRequiredRecipients: string[];
  fyiRecipients: string[];
  notificationGap: boolean;
  fallbackEscalation?: string;
  sideEffects?: string;
  knownGap?: string;
  warnings: string[];
};

export type WorkflowSimulationResult = {
  domainKey: string;
  domainName: string;
  subflowKey: string;
  subflowName: string;
  found: boolean;
  /** Ordered list of "where each step routes" — the route path. */
  routePath: string[];
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
        `Missing direct manager${input.employeeHrId ? ` for ${input.employeeHrId}` : ""} — this step cannot reach a manager.`,
      );
      return text;
    }
    return text.replace(/direct manager|manager chain|manager/i, `Manager ${manager}`);
  }

  if (lower.includes("employee") || lower.includes("requester") || lower.includes("rep")) {
    const employee = trimmed(input.employeeHrId);
    return employee ? `${text} [${employee}]` : text;
  }

  if (lower.includes("hr manager") || lower === "hr" || lower.startsWith("hr ")) {
    if (input.hrManagerAvailable === false) {
      warnings.push("Missing HR Manager recipient - the HR step cannot notify HR.");
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

function withManager(text: string, input: WorkflowSimulationInput): string {
  if (!/direct manager/i.test(text)) return text;
  const manager = resolvedManager(input);
  return manager ? text.replace(/direct manager/i, `Direct manager (${manager})`) : text;
}

/**
 * Where a step routes / who acts on it, in business-friendly terms. Prefers
 * EXPLICIT step.routesTo; otherwise describes the performer from the actor —
 * without falsely inferring "Direct manager" from a role list.
 */
function routeFor(step: WorkflowControlStep, input: WorkflowSimulationInput): string {
  const explicit = step.routesTo?.trim();
  if (explicit) return withManager(explicit, input);

  const actor = step.actor.trim();
  const lower = actor.toLowerCase();
  if (lower.startsWith("direct manager") || lower === "manager") {
    const manager = resolvedManager(input);
    return manager ? `Direct manager (${manager})` : "Direct manager";
  }
  if (lower.startsWith("hr")) return "HR Manager";
  if (lower.startsWith("employee") || lower.startsWith("candidate") || lower.startsWith("medical rep")) {
    const employee = trimmed(input.employeeHrId);
    return employee ? `${actor} (${employee})` : actor;
  }
  return actor;
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
      routePath: [],
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
      routePath: [],
      steps: [],
      finalStatus: "unknown",
      sideEffects: [],
      warnings: [`Unknown subflow "${input.subflowKey}" in domain "${domain.name}".`],
    };
  }

  const warnings: string[] = [];
  const sideEffects: string[] = [];

  // Phase 2A draft simulation uses the supplied override steps; otherwise the
  // canonical subflow steps. Either way this is pure and read-only.
  const baseSteps = input.overrideSteps ?? subflow.steps;

  const steps: SimulatedWorkflowStep[] = baseSteps.map((step, index) => {
    const stepWarnings: string[] = [];
    const notificationRecipients = resolveList(step.notificationRecipients, input, stepWarnings);
    const emailRecipients = resolveList(step.emailRecipients, input, stepWarnings);
    const actionRequiredRecipients = resolveList(step.actionRequiredRecipients ?? [], input, stepWarnings);
    const fyiRecipients = resolveList(step.fyiRecipients ?? [], input, stepWarnings);

    if (step.notificationGap) {
      stepWarnings.push(`No in-app notification producer for "${step.name}" (declared, not implemented).`);
    }
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
      actionRequiredRecipients,
      fyiRecipients,
      notificationGap: Boolean(step.notificationGap),
      fallbackEscalation: step.fallbackEscalation,
      sideEffects: step.sideEffects,
      knownGap: step.knownGap,
      warnings: stepWarnings,
    };
  });

  if (typeof input.amount === "number" && Number.isFinite(input.amount)) {
    sideEffects.push(`Simulated amount: ${input.amount} (read-only; no payroll record created).`);
  }

  // Domain-level informational warnings.
  if (domain.status === "Not implemented") {
    warnings.push(
      "This domain is NOT IMPLEMENTED — nothing in the system runs these steps. The simulation below is the intended design, not live behavior.",
    );
  }
  if (domain.status === "Read-only map" || domain.crossCutting) {
    warnings.push("This domain is a read-only map only — it has no live request flow to simulate.");
  }
  if (domain.beta) {
    warnings.push("This domain is Beta — some declared steps are not fully wired up.");
  }
  warnings.push("Runtime editing is disabled in Phase 1 (no live workflow behavior is changed).");

  const routePath = steps.map((s) => s.routesTo);
  const finalStatus = steps.length > 0 ? steps[steps.length - 1].statusProduced : "unknown";

  return {
    domainKey: domain.key,
    domainName: domain.name,
    subflowKey: subflow.key,
    subflowName: subflow.name,
    found: true,
    routePath,
    steps,
    finalStatus,
    sideEffects,
    warnings: Array.from(new Set(warnings)),
  };
}
