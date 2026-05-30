/**
 * Workflow Control Center — Phase 2A Controlled Draft layer (PURE, client-safe).
 *
 * This is a SAFE, in-memory draft model: it lets the Draft Editor change only
 * DISPLAY / CONFIG fields of a workflow's steps and produce a "draft" step list
 * for read-only simulation. It does NOT touch the canonical definitions, the
 * runtime workflow engine, the database, or any approval/role/security logic.
 *
 * No DB, no API, no server imports — importable from client components + tests.
 * Phase 3 (not here) will add persistence, versioning, publish and rollback.
 */

import type { WorkflowControlStep } from "@/lib/workflow-control/definitions";

/** Safe per-step overrides a Phase 2A draft may set (display/config only). */
export type WorkflowStepDraftOverride = {
  name?: string;
  description?: string;
  notificationEnabled?: boolean;
  emailEnabled?: boolean;
  reminderDays?: string;
  escalationLabel?: string;
  fallbackLabel?: string;
  actionLabel?: string;
  actionRequiredLabel?: string;
  fyiLabel?: string;
  knownGap?: string;
  optional?: boolean;
};

/** A draft is a map of stepId -> safe overrides, kept in client state only. */
export type WorkflowDraft = Record<string, WorkflowStepDraftOverride>;

/** Fields a Phase 2A draft IS allowed to change (display/config only). */
export const WORKFLOW_DRAFT_EDITABLE_FIELDS = [
  "Step display name",
  "Step description",
  "Notification enabled/disabled",
  "Email enabled/disabled",
  "Reminder days",
  "Escalation label",
  "Fallback label",
  "Action label",
  "Action-required recipients label",
  "FYI recipients label",
  "Known gap note",
  "Optional/required (display only)",
  "UI labels / copy",
] as const;

/** Fields a Phase 2A draft must NEVER change (runtime / security / data). */
export const WORKFLOW_DRAFT_FORBIDDEN_FIELDS = [
  "Approval role logic",
  "Runtime execution logic",
  "Salary / payroll calculations",
  "RLS / security rules",
  "Access deactivation",
  "Vacancy creation",
  "Employee status changes",
  "Database mutation",
  "Destructive side effects",
  "Publish to production",
] as const;

function isBlank(value?: string): boolean {
  return !value || !value.trim();
}

/**
 * Apply a step's safe overrides, returning a NEW step. Only display/config
 * fields change — actor, role, statusProduced, routesTo, sideEffects and
 * notificationGap (i.e. anything tied to runtime/approval logic) are preserved.
 */
export function applyDraftToStep(step: WorkflowControlStep, override?: WorkflowStepDraftOverride): WorkflowControlStep {
  if (!override) return step;
  const notificationEnabled = override.notificationEnabled !== false;
  const emailEnabled = override.emailEnabled !== false;
  return {
    ...step,
    name: isBlank(override.name) ? step.name : override.name!.trim(),
    notificationRecipients: notificationEnabled ? step.notificationRecipients : [],
    emailRecipients: emailEnabled ? step.emailRecipients : [],
    actionRequiredRecipients: isBlank(override.actionRequiredLabel)
      ? step.actionRequiredRecipients
      : [override.actionRequiredLabel!.trim()],
    fyiRecipients: isBlank(override.fyiLabel) ? step.fyiRecipients : [override.fyiLabel!.trim()],
    fallbackEscalation: isBlank(override.escalationLabel ?? override.fallbackLabel)
      ? step.fallbackEscalation
      : (override.escalationLabel ?? override.fallbackLabel)!.trim(),
    knownGap: isBlank(override.knownGap) ? step.knownGap : override.knownGap!.trim(),
  };
}

/** Apply the whole draft to a step list (for read-only draft simulation). */
export function applyDraftToSteps(steps: readonly WorkflowControlStep[], draft: WorkflowDraft): WorkflowControlStep[] {
  return steps.map((step) => applyDraftToStep(step, draft[step.id]));
}

export type WorkflowDraftValidation = {
  status: "valid" | "warnings";
  warnings: string[];
  /** Static list of fields the editor refuses to touch (shown to the user). */
  blockedFields: readonly string[];
};

/** Validate a draft (display/config sanity only). Never mutates anything. */
export function validateWorkflowDraft(steps: readonly WorkflowControlStep[], draft: WorkflowDraft): WorkflowDraftValidation {
  const warnings: string[] = [];
  for (const step of steps) {
    const override = draft[step.id];
    if (!override) continue;
    if (override.name !== undefined && isBlank(override.name)) {
      warnings.push(`"${step.name}": display name cannot be empty.`);
    }
    if (override.reminderDays !== undefined && override.reminderDays.trim() && !/^\d+$/.test(override.reminderDays.trim())) {
      warnings.push(`"${step.name}": reminder days must be a whole number.`);
    }
    if (
      override.notificationEnabled === true &&
      isBlank(override.actionRequiredLabel) &&
      isBlank(override.fyiLabel) &&
      step.notificationRecipients.length === 0
    ) {
      warnings.push(`"${step.name}": notifications enabled but no recipients are defined.`);
    }
  }
  return {
    status: warnings.length > 0 ? "warnings" : "valid",
    warnings,
    blockedFields: WORKFLOW_DRAFT_FORBIDDEN_FIELDS,
  };
}

/** True when the draft has at least one non-empty override (used to enable buttons). */
export function isDraftDirty(draft: WorkflowDraft): boolean {
  return Object.values(draft).some((override) => override && Object.keys(override).length > 0);
}
