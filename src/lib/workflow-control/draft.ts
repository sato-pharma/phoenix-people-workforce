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
  /** Static publish-blocked message (publish is a Phase 3 capability). */
  publishBlocked: string;
};

/**
 * Validate a draft (display/config sanity only). Never mutates anything.
 * Surfaces missing notification/email recipients, missing fallback/escalation,
 * notification gaps, and the static blocked-field / publish-blocked notices.
 */
export function validateWorkflowDraft(steps: readonly WorkflowControlStep[], draft: WorkflowDraft): WorkflowDraftValidation {
  const warnings: string[] = [];
  for (const step of steps) {
    const override = draft[step.id];
    if (!override) continue;
    const applied = applyDraftToStep(step, override);

    if (override.name !== undefined && isBlank(override.name)) {
      warnings.push(`"${step.name}": display name cannot be empty.`);
    }
    if (override.reminderDays !== undefined && override.reminderDays.trim() && !/^\d+$/.test(override.reminderDays.trim())) {
      warnings.push(`"${step.name}": reminder days must be a whole number.`);
    }
    // Missing notification recipient (notifications turned on but nobody set).
    if (override.notificationEnabled === true && applied.notificationRecipients.length === 0) {
      warnings.push(`"${step.name}": notifications enabled but no recipients are defined.`);
    }
    // Missing email recipient (email turned on but nobody set).
    if (override.emailEnabled === true && applied.emailRecipients.length === 0) {
      warnings.push(`"${step.name}": email enabled but no email recipients are defined.`);
    }
    // Missing fallback/escalation (user cleared the escalation/fallback label).
    if ((override.escalationLabel !== undefined || override.fallbackLabel !== undefined) && isBlank(applied.fallbackEscalation)) {
      warnings.push(`"${step.name}": fallback/escalation label is empty.`);
    }
    // Notification gap (the underlying producer is not implemented yet).
    if (applied.notificationGap) {
      warnings.push(`"${step.name}": notification producer is not implemented yet (gap).`);
    }
  }
  return {
    status: warnings.length > 0 ? "warnings" : "valid",
    warnings,
    blockedFields: WORKFLOW_DRAFT_FORBIDDEN_FIELDS,
    publishBlocked: "Publishing requires Phase 3 versioning and approval.",
  };
}

export type WorkflowDraftFieldChange = {
  stepId: string;
  stepName: string;
  field: string;
  current: string;
  draft: string;
};

export type WorkflowDraftDiff = {
  changes: WorkflowDraftFieldChange[];
  changeCount: number;
  changedStepIds: string[];
  changedStepNames: string[];
};

function boolLabel(on: boolean): string {
  return on ? "On" : "Off";
}

/**
 * Compute the Current-vs-Draft diff (safe display/config fields only). A field
 * counts as changed only when the override produces a DIFFERENT effective value
 * — blank overrides that "keep current" are not changes.
 */
export function diffDraftSteps(steps: readonly WorkflowControlStep[], draft: WorkflowDraft): WorkflowDraftDiff {
  const changes: WorkflowDraftFieldChange[] = [];

  for (const step of steps) {
    const o = draft[step.id];
    if (!o) continue;
    const push = (field: string, current: string, draftValue: string) => {
      changes.push({ stepId: step.id, stepName: step.name, field, current, draft: draftValue });
    };

    if (o.name !== undefined && !isBlank(o.name) && o.name.trim() !== step.name) {
      push("Display name", step.name, o.name.trim());
    }
    if (o.description !== undefined && !isBlank(o.description)) {
      push("Description", "—", o.description.trim());
    }
    if (o.actionLabel !== undefined && !isBlank(o.actionLabel)) {
      push("Action label", "—", o.actionLabel.trim());
    }
    if (o.reminderDays !== undefined && !isBlank(o.reminderDays)) {
      push("Reminder days", "—", o.reminderDays.trim());
    }
    const curActionReq = (step.actionRequiredRecipients ?? []).join(", ");
    if (o.actionRequiredLabel !== undefined && !isBlank(o.actionRequiredLabel) && o.actionRequiredLabel.trim() !== curActionReq) {
      push("Action-required recipients", curActionReq || "—", o.actionRequiredLabel.trim());
    }
    const curFyi = (step.fyiRecipients ?? []).join(", ");
    if (o.fyiLabel !== undefined && !isBlank(o.fyiLabel) && o.fyiLabel.trim() !== curFyi) {
      push("FYI recipients", curFyi || "—", o.fyiLabel.trim());
    }
    const curEsc = step.fallbackEscalation ?? "";
    const newEsc = (o.escalationLabel ?? o.fallbackLabel);
    if (newEsc !== undefined && !isBlank(newEsc) && newEsc.trim() !== curEsc) {
      push("Escalation / fallback", curEsc || "—", newEsc.trim());
    }
    if (o.knownGap !== undefined && !isBlank(o.knownGap) && o.knownGap.trim() !== (step.knownGap ?? "")) {
      push("Known gap", step.knownGap ?? "—", o.knownGap.trim());
    }
    const curNotif = step.notificationRecipients.length > 0;
    if (o.notificationEnabled !== undefined && o.notificationEnabled !== curNotif) {
      push("In-app notifications", boolLabel(curNotif), boolLabel(o.notificationEnabled));
    }
    const curEmail = step.emailRecipients.length > 0;
    if (o.emailEnabled !== undefined && o.emailEnabled !== curEmail) {
      push("Email", boolLabel(curEmail), boolLabel(o.emailEnabled));
    }
    if (o.optional === true) {
      push("Optional (display only)", "No", "Yes");
    }
  }

  const changedStepIds = Array.from(new Set(changes.map((c) => c.stepId)));
  const changedStepNames = Array.from(new Set(changes.map((c) => c.stepName)));
  return { changes, changeCount: changes.length, changedStepIds, changedStepNames };
}

/** Quick lookup set of "stepId::Field" keys for highlighting changed inputs. */
export function changedFieldKeys(diff: WorkflowDraftDiff): Set<string> {
  return new Set(diff.changes.map((c) => `${c.stepId}::${c.field}`));
}

/** True when the draft has at least one non-empty override (used to enable buttons). */
export function isDraftDirty(draft: WorkflowDraft): boolean {
  return Object.values(draft).some((override) => override && Object.keys(override).length > 0);
}
