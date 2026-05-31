/**
 * Workflow Control Center — Phase 3A PURE publish-governance utilities.
 *
 * PURE — no Supabase, no fetch, no API, no DB writes, no runtime changes.
 * Allow-list driven — unsafe fields cannot survive canonicalisation.
 * Deterministic — `canonicalizeWorkflowPayload` + `hashWorkflowPayload`
 * produce stable output so future publish flows can detect no-op publishes
 * and prevent version inflation.
 */

import { createHash } from "node:crypto";

import {
  diffDraftSteps,
  draftHiddenStepNames,
  isOrderChanged,
  type WorkflowDraft,
  type WorkflowDraftDiff,
  type WorkflowStepDraftOverride,
} from "@/lib/workflow-control/draft";
import type { WorkflowControlStep } from "@/lib/workflow-control/definitions";

export type WorkflowPublishPayload = {
  overrides: WorkflowDraft;
  orderIds: string[];
};

export const WORKFLOW_SAFE_OVERRIDE_KEYS: readonly (keyof WorkflowStepDraftOverride)[] = [
  "name",
  "description",
  "notificationEnabled",
  "emailEnabled",
  "reminderDays",
  "escalationLabel",
  "fallbackLabel",
  "actionLabel",
  "actionRequiredLabel",
  "fyiLabel",
  "knownGap",
  "optional",
  "hidden",
];

export const WORKFLOW_SAFE_PAYLOAD_KEYS: readonly (keyof WorkflowPublishPayload)[] = ["overrides", "orderIds"];

const FORBIDDEN_KEY_PATTERN = /^(?:actor|role|statusProduced|routesTo|sideEffects|runtimeAction|action|sql|js|jsCode|code|script|scriptHook|apiPath|httpUrl|payroll|salary|netSalary|grossSalary|wage|compensation|rls|policy|accessMutation|deactivateAccess|vacancy|employeeStatus|employmentStatus|terminate|hire|approvalLogic)$/i;

const MAX_FIELD_LENGTH = 1000;

export type WorkflowPublishValidation =
  | { ok: true; payload: WorkflowPublishPayload; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

function stripUnsafeOverride(raw: unknown): WorkflowStepDraftOverride {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: WorkflowStepDraftOverride = {};
  for (const key of WORKFLOW_SAFE_OVERRIDE_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === "notificationEnabled" || key === "emailEnabled" || key === "optional" || key === "hidden") {
      if (typeof value === "boolean") (out as Record<string, unknown>)[key] = value;
      continue;
    }
    if (typeof value === "string") {
      const trimmed = value.length > MAX_FIELD_LENGTH ? value.slice(0, MAX_FIELD_LENGTH) : value;
      (out as Record<string, unknown>)[key] = trimmed;
    }
  }
  return out;
}

export function stripUnsafeWorkflowDraftPayload(raw: unknown): WorkflowPublishPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { overrides: {}, orderIds: [] };
  const obj = raw as Record<string, unknown>;
  const overridesIn = obj.overrides && typeof obj.overrides === "object" && !Array.isArray(obj.overrides)
    ? (obj.overrides as Record<string, unknown>)
    : {};
  const overrides: WorkflowDraft = {};
  for (const [stepId, value] of Object.entries(overridesIn)) {
    const cleanedKey = String(stepId).trim();
    if (!cleanedKey) continue;
    const cleaned = stripUnsafeOverride(value);
    if (Object.keys(cleaned).length > 0) overrides[cleanedKey] = cleaned;
  }
  const orderIdsIn = Array.isArray(obj.orderIds) ? obj.orderIds : [];
  const orderIds: string[] = [];
  const seen = new Set<string>();
  for (const id of orderIdsIn) {
    if (typeof id !== "string") continue;
    const cleaned = id.trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    orderIds.push(cleaned);
  }
  return { overrides, orderIds };
}

function sortKeys<T extends Record<string, unknown>>(input: T): T {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) sorted[key] = input[key];
  return sorted as T;
}

export function canonicalizeWorkflowPayload(raw: unknown): WorkflowPublishPayload {
  const stripped = stripUnsafeWorkflowDraftPayload(raw);
  const overrides: WorkflowDraft = {};
  for (const stepId of Object.keys(stripped.overrides).sort()) {
    overrides[stepId] = sortKeys(stripped.overrides[stepId]);
  }
  return { overrides, orderIds: [...stripped.orderIds] };
}

export function hashWorkflowPayload(raw: unknown): string {
  const canonical = canonicalizeWorkflowPayload(raw);
  const json = JSON.stringify(canonical);
  return createHash("sha256").update(json).digest("hex");
}

export type WorkflowValidationOptions = {
  validStepIds?: readonly string[];
};

export function validatePublishableWorkflowPayload(
  raw: unknown,
  options: WorkflowValidationOptions = {},
): WorkflowPublishValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["Invalid payload: expected an object with `overrides` and `orderIds`."], warnings };
  }
  const obj = raw as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!(WORKFLOW_SAFE_PAYLOAD_KEYS as readonly string[]).includes(key)) {
      errors.push(`Unsafe top-level field "${key}" is not allowed.`);
    }
    if (FORBIDDEN_KEY_PATTERN.test(key)) {
      errors.push(`Forbidden top-level field "${key}" (runtime/security/data — not editable).`);
    }
  }

  const overrides = obj.overrides;
  if (overrides !== undefined) {
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
      errors.push("`overrides` must be a plain object map of stepId → override.");
    } else {
      const validStepIds = options.validStepIds ? new Set(options.validStepIds) : null;
      for (const [stepId, value] of Object.entries(overrides as Record<string, unknown>)) {
        if (typeof stepId !== "string" || !stepId.trim()) {
          errors.push("Override has an empty stepId.");
          continue;
        }
        if (validStepIds && !validStepIds.has(stepId)) {
          errors.push(`Override targets unknown step "${stepId}".`);
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          errors.push(`Override for "${stepId}" must be a plain object.`);
          continue;
        }
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (FORBIDDEN_KEY_PATTERN.test(k)) {
            errors.push(`Forbidden field "${k}" on step "${stepId}" (runtime/security/data — not editable).`);
            continue;
          }
          if (!(WORKFLOW_SAFE_OVERRIDE_KEYS as readonly string[]).includes(k)) {
            errors.push(`Unknown field "${k}" on step "${stepId}" (not in the safe allow-list).`);
            continue;
          }
          const isBool = k === "notificationEnabled" || k === "emailEnabled" || k === "optional" || k === "hidden";
          if (isBool && typeof v !== "boolean") {
            errors.push(`Field "${k}" on step "${stepId}" must be a boolean.`);
          } else if (!isBool && v !== undefined && typeof v !== "string") {
            errors.push(`Field "${k}" on step "${stepId}" must be a string.`);
          } else if (typeof v === "string" && v.length > MAX_FIELD_LENGTH) {
            errors.push(`Field "${k}" on step "${stepId}" exceeds ${MAX_FIELD_LENGTH} characters (defence-in-depth).`);
          }
        }
      }
    }
  }

  const orderIds = obj.orderIds;
  if (orderIds !== undefined) {
    if (!Array.isArray(orderIds)) {
      errors.push("`orderIds` must be an array of step ids.");
    } else {
      const validStepIds = options.validStepIds ? new Set(options.validStepIds) : null;
      const seen = new Set<string>();
      for (const id of orderIds) {
        if (typeof id !== "string" || !id.trim()) {
          errors.push("`orderIds` contains a non-string or empty entry.");
          continue;
        }
        if (seen.has(id)) errors.push(`Duplicate stepId in orderIds: "${id}".`);
        seen.add(id);
        if (validStepIds && !validStepIds.has(id)) {
          errors.push(`orderIds references unknown step "${id}".`);
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, payload: canonicalizeWorkflowPayload(obj), warnings };
}

export type WorkflowPublishDiffSummary = {
  changeCount: number;
  changedFields: WorkflowDraftDiff["changes"];
  changedStepNames: string[];
  changedStepIds: string[];
  hiddenStepIds: string[];
  hiddenStepNames: string[];
  orderChanged: boolean;
  warningCount: number;
};

export function buildWorkflowPublishDiffSummary(
  currentPayload: WorkflowPublishPayload | null | undefined,
  draftPayload: WorkflowPublishPayload,
  options: { steps?: readonly WorkflowControlStep[]; warningCount?: number } = {},
): WorkflowPublishDiffSummary {
  const current = canonicalizeWorkflowPayload(currentPayload ?? { overrides: {}, orderIds: [] });
  const draft = canonicalizeWorkflowPayload(draftPayload);

  const steps = options.steps ?? [];
  const diff: WorkflowDraftDiff = steps.length > 0
    ? diffDraftSteps(steps, draft.overrides)
    : { changes: [], changeCount: 0, changedStepIds: [], changedStepNames: [] };

  if (steps.length === 0) {
    const changes: WorkflowDraftDiff["changes"] = [];
    for (const [stepId, override] of Object.entries(draft.overrides)) {
      for (const [field, value] of Object.entries(override)) {
        const before = (current.overrides[stepId] as Record<string, unknown> | undefined)?.[field];
        if (JSON.stringify(before ?? null) !== JSON.stringify(value ?? null)) {
          changes.push({ stepId, stepName: stepId, field, current: String(before ?? "—"), draft: String(value ?? "—") });
        }
      }
    }
    diff.changes = changes;
    diff.changeCount = changes.length;
    diff.changedStepIds = Array.from(new Set(changes.map((c) => c.stepId)));
    diff.changedStepNames = diff.changedStepIds;
  }

  const hiddenStepIds = Object.entries(draft.overrides)
    .filter(([, o]) => o?.hidden === true)
    .map(([id]) => id);
  const hiddenStepNames = steps.length > 0
    ? draftHiddenStepNames(steps, draft.overrides)
    : hiddenStepIds;

  const orderChanged = steps.length > 0
    ? isOrderChanged(steps, draft.orderIds.length > 0 ? draft.orderIds : steps.map((s) => s.id))
    : JSON.stringify(current.orderIds) !== JSON.stringify(draft.orderIds);

  return {
    changeCount: diff.changeCount,
    changedFields: diff.changes,
    changedStepNames: diff.changedStepNames,
    changedStepIds: diff.changedStepIds,
    hiddenStepIds,
    hiddenStepNames,
    orderChanged,
    warningCount: Math.max(0, options.warningCount ?? 0),
  };
}

export function isNoopPublish(currentPayload: unknown, draftPayload: unknown): boolean {
  return hashWorkflowPayload(currentPayload) === hashWorkflowPayload(draftPayload);
}

export type WorkflowPublishBlockersInput = {
  validation: WorkflowPublishValidation;
  publishDisabled?: boolean;
  validationWarnings?: string[];
};

export function getWorkflowPublishBlockers(input: WorkflowPublishBlockersInput): string[] {
  const blockers: string[] = [];
  if (input.publishDisabled) {
    blockers.push("Publish is disabled (Phase 3B/Phase 4 will enable governed publish).");
  }
  if (!input.validation.ok) {
    blockers.push("Invalid payload — cannot publish.");
    for (const err of input.validation.errors) {
      if (/forbidden/i.test(err)) blockers.push(`Unsafe field: ${err}`);
      else if (/unknown step/i.test(err) || /unknown field/i.test(err)) blockers.push(`Unknown step or field: ${err}`);
      else blockers.push(err);
    }
  }
  for (const w of input.validationWarnings ?? []) {
    blockers.push(`Validation warning: ${w}`);
  }
  return blockers;
}
