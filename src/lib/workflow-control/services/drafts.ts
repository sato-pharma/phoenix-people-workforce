/**
 * Workflow Control Center — Phase 3C drafts service (DISABLED).
 */

import {
  WORKFLOW_CONTROL_DISABLED_MESSAGE,
  WORKFLOW_CONTROL_PERSISTENCE_ENABLED,
} from "@/lib/workflow-control/feature-flags";
import {
  canonicalizeWorkflowPayload,
  hashWorkflowPayload,
  validatePublishableWorkflowPayload,
  type WorkflowPublishPayload,
} from "@/lib/workflow-control/governance";
import type {
  WorkflowControlActor,
  WorkflowControlResult,
  WorkflowDraftRecord,
} from "@/lib/workflow-control/types";

function isSuperAdmin(actor: WorkflowControlActor): boolean {
  return actor.role === "Super Admin";
}

function forbidden<T>(actor: WorkflowControlActor): WorkflowControlResult<T> {
  return { ok: false, code: "forbidden", error: `Forbidden: ${actor.role} cannot manage workflow control drafts.` };
}

function disabled<T>(): WorkflowControlResult<T> {
  return { ok: false, code: "persistence_disabled", error: WORKFLOW_CONTROL_DISABLED_MESSAGE };
}

export type SaveWorkflowDraftInput = {
  domainKey: string;
  subflowKey: string;
  payload: WorkflowPublishPayload;
  validStepIds?: readonly string[];
};

export async function saveWorkflowDraft(
  actor: WorkflowControlActor,
  input: SaveWorkflowDraftInput,
): Promise<WorkflowControlResult<WorkflowDraftRecord>> {
  if (!isSuperAdmin(actor)) return forbidden(actor);

  const validation = validatePublishableWorkflowPayload(input.payload, { validStepIds: input.validStepIds });
  if (!validation.ok) {
    return { ok: false, code: "invalid_payload", error: validation.errors.join("; ") };
  }
  const canonical = canonicalizeWorkflowPayload(input.payload);
  void hashWorkflowPayload(canonical);

  if (!WORKFLOW_CONTROL_PERSISTENCE_ENABLED) return disabled();
  return disabled();
}

export async function loadWorkflowDraft(
  actor: WorkflowControlActor,
  _domainKey: string,
  _subflowKey: string,
): Promise<WorkflowControlResult<WorkflowDraftRecord | null>> {
  void _domainKey; void _subflowKey;
  if (!isSuperAdmin(actor)) return forbidden(actor);
  if (!WORKFLOW_CONTROL_PERSISTENCE_ENABLED) {
    return { ok: true, data: null };
  }
  return { ok: true, data: null };
}

export async function discardWorkflowDraft(
  actor: WorkflowControlActor,
  _draftId: string,
): Promise<WorkflowControlResult<{ discarded: boolean }>> {
  void _draftId;
  if (!isSuperAdmin(actor)) return forbidden(actor);
  if (!WORKFLOW_CONTROL_PERSISTENCE_ENABLED) return disabled();
  return disabled();
}
