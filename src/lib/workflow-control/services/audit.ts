/**
 * Workflow Control Center — Phase 3C audit service (NO-OP).
 */

import {
  WORKFLOW_CONTROL_PERSISTENCE_ENABLED,
} from "@/lib/workflow-control/feature-flags";
import type {
  WorkflowControlActor,
  WorkflowControlAuditAction,
  WorkflowControlAuditPayload,
  WorkflowControlResult,
} from "@/lib/workflow-control/types";

export type WriteWorkflowControlAuditInput = {
  action: WorkflowControlAuditAction;
  definitionId?: string | null;
  versionId?: string | null;
  draftId?: string | null;
  payloadHash?: string | null;
  metadata?: Record<string, unknown> | null;
};

export function buildWorkflowControlAuditPayload(
  actor: WorkflowControlActor,
  input: WriteWorkflowControlAuditInput,
): WorkflowControlAuditPayload {
  return {
    action: input.action,
    actorHrId: actor.hrId,
    actorRole: actor.role,
    definitionId: input.definitionId ?? null,
    versionId: input.versionId ?? null,
    draftId: input.draftId ?? null,
    payloadHash: input.payloadHash ?? null,
    metadata: input.metadata ?? null,
  };
}

export async function writeWorkflowControlAudit(
  actor: WorkflowControlActor,
  input: WriteWorkflowControlAuditInput,
): Promise<WorkflowControlResult<{ written: boolean; payload: WorkflowControlAuditPayload }>> {
  const payload = buildWorkflowControlAuditPayload(actor, input);
  if (!WORKFLOW_CONTROL_PERSISTENCE_ENABLED) {
    return { ok: true, data: { written: false, payload } };
  }
  return { ok: true, data: { written: false, payload } };
}
