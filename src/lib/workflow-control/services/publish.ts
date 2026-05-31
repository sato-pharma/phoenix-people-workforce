/**
 * Workflow Control Center — Phase 3C publish + rollback (DISABLED).
 */

import {
  WORKFLOW_CONTROL_PUBLISH_DISABLED_MESSAGE,
  WORKFLOW_CONTROL_PUBLISH_ENABLED,
  WORKFLOW_CONTROL_ROLLBACK_DISABLED_MESSAGE,
  WORKFLOW_CONTROL_ROLLBACK_ENABLED,
  WORKFLOW_CONTROL_DISABLED_MESSAGE,
  WORKFLOW_CONTROL_PERSISTENCE_ENABLED,
} from "@/lib/workflow-control/feature-flags";
import {
  buildWorkflowPublishDiffSummary,
  canonicalizeWorkflowPayload,
  getWorkflowPublishBlockers,
  hashWorkflowPayload,
  isNoopPublish,
  validatePublishableWorkflowPayload,
  type WorkflowPublishPayload,
} from "@/lib/workflow-control/governance";
import type { WorkflowControlStep } from "@/lib/workflow-control/definitions";
import type {
  WorkflowControlActor,
  WorkflowControlResult,
  WorkflowPublishResult,
} from "@/lib/workflow-control/types";

function isSuperAdmin(actor: WorkflowControlActor): boolean {
  return actor.role === "Super Admin";
}

function forbidden<T>(actor: WorkflowControlActor, what: string): WorkflowControlResult<T> {
  return { ok: false, code: "forbidden", error: `Forbidden: ${actor.role} cannot ${what}.` };
}

export type PublishDraftInput = {
  draftId: string;
  domainKey: string;
  subflowKey: string;
  draftPayload: WorkflowPublishPayload;
  currentPayload: WorkflowPublishPayload | null;
  validStepIds?: readonly string[];
  steps?: readonly WorkflowControlStep[];
  notes?: string;
};

export async function publishWorkflowDraft(
  actor: WorkflowControlActor,
  input: PublishDraftInput,
): Promise<WorkflowControlResult<WorkflowPublishResult>> {
  if (!isSuperAdmin(actor)) return forbidden(actor, "publish workflow versions");

  const validation = validatePublishableWorkflowPayload(input.draftPayload, { validStepIds: input.validStepIds });
  const blockers = getWorkflowPublishBlockers({
    validation,
    publishDisabled: !WORKFLOW_CONTROL_PUBLISH_ENABLED,
  });
  if (!validation.ok) {
    return { ok: false, code: "invalid_payload", error: blockers.join("; ") || validation.errors.join("; ") };
  }

  const payloadHash = hashWorkflowPayload(input.draftPayload);
  const noop = isNoopPublish(input.currentPayload ?? { overrides: {}, orderIds: [] }, input.draftPayload);
  const diff = buildWorkflowPublishDiffSummary(input.currentPayload ?? { overrides: {}, orderIds: [] }, canonicalizeWorkflowPayload(input.draftPayload), { steps: input.steps });

  if (noop) {
    return { ok: false, code: "noop", error: "No content changes vs the current active version — nothing to publish." };
  }

  if (!WORKFLOW_CONTROL_PUBLISH_ENABLED || !WORKFLOW_CONTROL_PERSISTENCE_ENABLED) {
    const msg = !WORKFLOW_CONTROL_PERSISTENCE_ENABLED ? WORKFLOW_CONTROL_DISABLED_MESSAGE : WORKFLOW_CONTROL_PUBLISH_DISABLED_MESSAGE;
    return { ok: false, code: "publish_disabled", error: msg };
  }

  return {
    ok: false,
    code: "publish_disabled",
    error: `${WORKFLOW_CONTROL_PUBLISH_DISABLED_MESSAGE} (validated: ${payloadHash.slice(0, 12)}, ${diff.changeCount} field change(s))`,
  };
}

export type RollbackInput = {
  definitionId: string;
  versionId: string;
  reason?: string;
};

export async function rollbackWorkflowVersion(
  actor: WorkflowControlActor,
  _input: RollbackInput,
): Promise<WorkflowControlResult<WorkflowPublishResult>> {
  void _input;
  if (!isSuperAdmin(actor)) return forbidden(actor, "rollback workflow versions");
  if (!WORKFLOW_CONTROL_ROLLBACK_ENABLED || !WORKFLOW_CONTROL_PERSISTENCE_ENABLED) {
    return { ok: false, code: "rollback_disabled", error: WORKFLOW_CONTROL_ROLLBACK_DISABLED_MESSAGE };
  }
  return { ok: false, code: "rollback_disabled", error: WORKFLOW_CONTROL_ROLLBACK_DISABLED_MESSAGE };
}
