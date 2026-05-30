/**
 * Workflow Control Center — Phase 3C shared service types (pure).
 */

import type { WorkflowDraftDiff } from "@/lib/workflow-control/draft";
import type { WorkflowPublishPayload } from "@/lib/workflow-control/governance";

export type WorkflowControlActor = {
  hrId: string | null;
  loginId?: string | null;
  role: string;
};

export type WorkflowDraftRecord = {
  id: string;
  definitionId: string;
  domainKey: string;
  subflowKey: string;
  ownerHrId: string;
  baseVersionId: string | null;
  payload: WorkflowPublishPayload;
  validationStatus: "valid" | "warnings" | "invalid";
  createdAt: string;
  updatedAt: string;
};

export type WorkflowVersionRecord = {
  id: string;
  definitionId: string;
  domainKey: string;
  subflowKey: string;
  versionNumber: number;
  payload: WorkflowPublishPayload;
  payloadHash: string;
  publishedAt: string;
  publishedByHrId: string;
  notes: string | null;
  supersededAt: string | null;
  supersededByVersionId: string | null;
};

export type WorkflowPublishResult = {
  definitionId: string;
  versionId: string;
  versionNumber: number;
  payloadHash: string;
  noop: boolean;
  diff: WorkflowDraftDiff | null;
};

export type WorkflowControlAuditAction =
  | "create_draft"
  | "save_draft"
  | "discard_draft"
  | "validate_draft"
  | "publish_version"
  | "rollback"
  | "view_history"
  | "compare"
  | "access_denied"
  | "noop_publish";

export type WorkflowControlAuditPayload = {
  action: WorkflowControlAuditAction;
  actorHrId: string | null;
  actorRole: string;
  definitionId?: string | null;
  versionId?: string | null;
  draftId?: string | null;
  payloadHash?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type WorkflowControlResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: WorkflowControlErrorCode; error: string };

export type WorkflowControlErrorCode =
  | "forbidden"
  | "persistence_disabled"
  | "publish_disabled"
  | "rollback_disabled"
  | "invalid_payload"
  | "not_found"
  | "noop";
