/**
 * Workflow Control Center — Phase 3C versions service.
 *   listWorkflowVersions / getWorkflowVersion: DISABLED until Phase 3D.
 *   compareWorkflowVersions: PURE, works today.
 */

import {
  WORKFLOW_CONTROL_DISABLED_MESSAGE,
  WORKFLOW_CONTROL_PERSISTENCE_ENABLED,
} from "@/lib/workflow-control/feature-flags";
import {
  buildWorkflowPublishDiffSummary,
  canonicalizeWorkflowPayload,
  type WorkflowPublishDiffSummary,
  type WorkflowPublishPayload,
} from "@/lib/workflow-control/governance";
import type { WorkflowControlStep } from "@/lib/workflow-control/definitions";
import type {
  WorkflowControlActor,
  WorkflowControlResult,
  WorkflowVersionRecord,
} from "@/lib/workflow-control/types";

function isSuperAdmin(actor: WorkflowControlActor): boolean {
  return actor.role === "Super Admin";
}

function forbidden<T>(actor: WorkflowControlActor): WorkflowControlResult<T> {
  return { ok: false, code: "forbidden", error: `Forbidden: ${actor.role} cannot read workflow control versions.` };
}

function disabled<T>(): WorkflowControlResult<T> {
  return { ok: false, code: "persistence_disabled", error: WORKFLOW_CONTROL_DISABLED_MESSAGE };
}

export async function listWorkflowVersions(
  actor: WorkflowControlActor,
  _domainKey: string,
  _subflowKey: string,
  _limit = 50,
): Promise<WorkflowControlResult<WorkflowVersionRecord[]>> {
  void _domainKey; void _subflowKey; void _limit;
  if (!isSuperAdmin(actor)) return forbidden(actor);
  if (!WORKFLOW_CONTROL_PERSISTENCE_ENABLED) {
    return { ok: true, data: [] };
  }
  return { ok: true, data: [] };
}

export async function getWorkflowVersion(
  actor: WorkflowControlActor,
  _versionId: string,
): Promise<WorkflowControlResult<WorkflowVersionRecord | null>> {
  void _versionId;
  if (!isSuperAdmin(actor)) return forbidden(actor);
  if (!WORKFLOW_CONTROL_PERSISTENCE_ENABLED) return disabled();
  return { ok: true, data: null };
}

export function compareWorkflowVersions(
  actor: WorkflowControlActor,
  fromPayload: WorkflowPublishPayload | null,
  toPayload: WorkflowPublishPayload,
  options: { steps?: readonly WorkflowControlStep[]; warningCount?: number } = {},
): WorkflowControlResult<WorkflowPublishDiffSummary> {
  if (!isSuperAdmin(actor)) return forbidden(actor);
  const from = canonicalizeWorkflowPayload(fromPayload ?? { overrides: {}, orderIds: [] });
  const to = canonicalizeWorkflowPayload(toPayload);
  return { ok: true, data: buildWorkflowPublishDiffSummary(from, to, options) };
}
