import { writeRequiredAuditLog } from "@/lib/admin/audit";
import {
  parseRoleStrict,
  type AccessContext,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type WorkflowRegistryStatus = {
  description?: string;
  key: string;
  label: string;
  terminal: boolean;
};

export type WorkflowRegistryAction = {
  allowedRoles: PhoenixRole[];
  auditLog: string;
  from: string[];
  key: string;
  label: string;
  notifications: string[];
  requiresReason: boolean;
  sideEffects: string[];
  tests: string[];
  to: string;
};

export type WorkflowRegistryModule = {
  actions: WorkflowRegistryAction[];
  createdAt: string;
  createdBy: string | null;
  description: string;
  id: string;
  isActive: boolean;
  moduleKey: string;
  moduleName: string;
  statuses: WorkflowRegistryStatus[];
  updatedAt: string;
  updatedBy: string | null;
  version: number;
};

export type WorkflowRegistryAuditRow = {
  actorLoginId: string | null;
  createdAt: string;
  entityId: string | null;
  id: string;
  newValues: Record<string, unknown> | null;
  oldValues: Record<string, unknown> | null;
  summary: string;
};

export type WorkflowRegistryDashboard = {
  auditLogs: WorkflowRegistryAuditRow[];
  modules: WorkflowRegistryModule[];
};

export type WorkflowRegistryMutationInput = {
  actions: unknown;
  description?: unknown;
  isActive?: unknown;
  moduleKey: unknown;
  moduleName: unknown;
  statuses: unknown;
};

export type WorkflowRegistryTransitionFailureReason =
  | "workflow_action_not_found"
  | "workflow_module_not_found"
  | "workflow_next_status_mismatch"
  | "workflow_role_not_allowed"
  | "workflow_status_not_allowed";

export class WorkflowRegistryTransitionError extends Error {
  actionKey: string;
  moduleKey: string;
  reason: WorkflowRegistryTransitionFailureReason;
  status: string;

  constructor(input: {
    actionKey: string;
    message: string;
    moduleKey: string;
    reason: WorkflowRegistryTransitionFailureReason;
    status: string;
  }) {
    super(input.message);
    this.name = "WorkflowRegistryTransitionError";
    this.actionKey = input.actionKey;
    this.moduleKey = input.moduleKey;
    this.reason = input.reason;
    this.status = input.status;
  }
}

export function isWorkflowRegistryTransitionError(error: unknown) {
  return error instanceof WorkflowRegistryTransitionError;
}

type WorkflowRegistryDbRow = {
  actions: unknown;
  created_at: string;
  created_by: string | null;
  description: string | null;
  id: string;
  is_active: boolean | null;
  module_key: string;
  module_name: string;
  statuses: unknown;
  updated_at: string;
  updated_by: string | null;
  version: number | null;
};

const workflowKeyPattern = /^[a-z][a-z0-9_]*$/;

function asRecord(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function normalizeKey(value: unknown, label: string) {
  const key = String(value ?? "").trim();
  if (!workflowKeyPattern.test(key)) {
    throw new Error(`${label} must start with a lowercase letter and use only lowercase letters, numbers, and underscores.`);
  }
  return key;
}

function normalizeRequiredText(value: unknown, label: string) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`${label} is required.`);
  }
  return text;
}

function normalizeOptionalText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeStringList(value: unknown, label: string, options: { allowEmpty?: boolean } = {}) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  const values = value.map((item) => normalizeRequiredText(item, label));
  if (!options.allowEmpty && values.length === 0) {
    throw new Error(`${label} cannot be empty.`);
  }
  return Array.from(new Set(values));
}

function normalizeStatuses(value: unknown): WorkflowRegistryStatus[] {
  if (!Array.isArray(value)) {
    throw new Error("Statuses must be an array.");
  }

  const statuses = value.map((item, index) => {
    const row = asRecord(item, `Status ${index + 1}`);
    return {
      description: normalizeOptionalText(row.description),
      key: normalizeKey(row.key, `Status ${index + 1} key`),
      label: normalizeRequiredText(row.label, `Status ${index + 1} label`),
      terminal: Boolean(row.terminal),
    };
  });

  if (statuses.length === 0) {
    throw new Error("At least one status is required.");
  }

  const keys = new Set<string>();
  for (const status of statuses) {
    if (keys.has(status.key)) {
      throw new Error(`Duplicate status key "${status.key}".`);
    }
    keys.add(status.key);
  }

  return statuses;
}

function normalizeActions(value: unknown, statusKeys: Set<string>): WorkflowRegistryAction[] {
  if (!Array.isArray(value)) {
    throw new Error("Actions must be an array.");
  }

  const actions = value.map((item, index) => {
    const row = asRecord(item, `Action ${index + 1}`);
    const from = normalizeStringList(row.from, `Action ${index + 1} from`);
    const to = normalizeKey(row.to, `Action ${index + 1} to`);
    if (to !== "deleted" && to !== "unchanged" && !statusKeys.has(to)) {
      throw new Error(`Action ${index + 1} target status "${to}" is not defined.`);
    }
    for (const sourceStatus of from) {
      if (!statusKeys.has(sourceStatus)) {
        throw new Error(`Action ${index + 1} source status "${sourceStatus}" is not defined.`);
      }
    }

    return {
      allowedRoles: normalizeStringList(row.allowedRoles, `Action ${index + 1} allowedRoles`)
        .map((role) => parseRoleStrict(role)),
      auditLog: normalizeRequiredText(row.auditLog, `Action ${index + 1} auditLog`),
      from,
      key: normalizeKey(row.key, `Action ${index + 1} key`),
      label: normalizeRequiredText(row.label, `Action ${index + 1} label`),
      notifications: normalizeStringList(row.notifications ?? [], `Action ${index + 1} notifications`, { allowEmpty: true }),
      requiresReason: Boolean(row.requiresReason),
      sideEffects: normalizeStringList(row.sideEffects ?? [], `Action ${index + 1} sideEffects`, { allowEmpty: true }),
      tests: normalizeStringList(row.tests ?? [], `Action ${index + 1} tests`, { allowEmpty: true }),
      to,
    };
  });

  const keys = new Set<string>();
  for (const action of actions) {
    if (keys.has(action.key)) {
      throw new Error(`Duplicate action key "${action.key}".`);
    }
    keys.add(action.key);
  }

  return actions;
}

function normalizeModuleInput(input: WorkflowRegistryMutationInput) {
  const moduleKey = normalizeKey(input.moduleKey, "Module key");
  const moduleName = normalizeRequiredText(input.moduleName, "Module name");
  const statuses = normalizeStatuses(input.statuses);
  const statusKeys = new Set(statuses.map((status) => status.key));
  const actions = normalizeActions(input.actions, statusKeys);

  return {
    actions,
    description: normalizeOptionalText(input.description),
    isActive: typeof input.isActive === "boolean" ? input.isActive : true,
    moduleKey,
    moduleName,
    statuses,
  };
}

function toModule(row: WorkflowRegistryDbRow): WorkflowRegistryModule {
  const statuses = normalizeStatuses(row.statuses);
  const actions = normalizeActions(row.actions, new Set(statuses.map((status) => status.key)));

  return {
    actions,
    createdAt: row.created_at,
    createdBy: row.created_by,
    description: row.description ?? "",
    id: row.id,
    isActive: Boolean(row.is_active),
    moduleKey: row.module_key,
    moduleName: row.module_name,
    statuses,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    version: Number(row.version ?? 1),
  };
}

function toDbPayload(input: ReturnType<typeof normalizeModuleInput>, actor: WorkflowRegistryActor) {
  return {
    actions: input.actions,
    description: input.description,
    is_active: input.isActive,
    module_key: input.moduleKey,
    module_name: input.moduleName,
    statuses: input.statuses,
    updated_by: actor.loginId,
  };
}

type WorkflowRegistryActor = Pick<AccessContext, "loginId" | "role">;

function assertSuperAdmin(actor: WorkflowRegistryActor) {
  if (actor.role !== "Super Admin") {
    throw new Error("Forbidden: only Super Admin can manage the Workflow Registry.");
  }
}

async function listWorkflowRegistryAuditLogs(): Promise<WorkflowRegistryAuditRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("audit_logs")
    .select("id,actor_login_id,entity_id,summary,old_values,new_values,created_at")
    .eq("entity_type", "workflow_registry")
    .order("created_at", { ascending: false })
    .limit(30);

  if (error || !data) {
    return [];
  }

  return data.map((row) => {
    const item = row as Record<string, unknown>;
    return {
      actorLoginId: item.actor_login_id ? String(item.actor_login_id) : null,
      createdAt: String(item.created_at),
      entityId: item.entity_id ? String(item.entity_id) : null,
      id: String(item.id),
      newValues: (item.new_values as Record<string, unknown> | null) ?? null,
      oldValues: (item.old_values as Record<string, unknown> | null) ?? null,
      summary: String(item.summary ?? "Workflow registry change"),
    };
  });
}

export async function listWorkflowRegistryModules() {
  const { data, error } = await getSupabaseAdmin()
    .from("workflow_registry_modules")
    .select("id,module_key,module_name,description,statuses,actions,is_active,version,created_by,updated_by,created_at,updated_at")
    .order("module_key", { ascending: true });

  if (error) {
    throw error;
  }

  // One malformed row must never take down every OTHER module's workflow
  // transitions: a bad record here previously threw synchronously out of the
  // shared .map(), which blocked resolveWorkflowRegistryTransition for every
  // module in the app (payroll, resignations, probation, contracts,
  // outstation, offers, marketing requests), not just the broken one. A
  // module that fails validation is skipped (and loudly logged) instead,
  // which surfaces to callers as the existing "workflow_module_not_found"
  // failure mode for that module only.
  const modules: WorkflowRegistryModule[] = [];
  for (const row of (data ?? []) as WorkflowRegistryDbRow[]) {
    try {
      modules.push(toModule(row));
    } catch (validationError) {
      logError(`Workflow registry module "${row.module_key}" failed validation and was skipped`, {
        error: validationError,
        labels: { event: "workflow_registry_module_invalid", moduleKey: row.module_key },
      });
    }
  }
  return modules;
}

export async function getWorkflowRegistryDashboard(): Promise<WorkflowRegistryDashboard> {
  const [modules, auditLogs] = await Promise.all([
    listWorkflowRegistryModules(),
    listWorkflowRegistryAuditLogs(),
  ]);

  return { auditLogs, modules };
}

async function writeRegistryAudit(input: {
  actor: WorkflowRegistryActor;
  entityId: string;
  newValues?: Record<string, unknown> | null;
  oldValues?: Record<string, unknown> | null;
  summary: string;
}) {
  await writeRequiredAuditLog({
    actorLoginId: input.actor.loginId ?? null,
    entityId: input.entityId,
    entityType: "workflow_registry",
    newValues: input.newValues,
    oldValues: input.oldValues,
    summary: input.summary,
  });
}

export async function createWorkflowRegistryModule(
  input: WorkflowRegistryMutationInput,
  actor: WorkflowRegistryActor,
) {
  assertSuperAdmin(actor);
  const normalized = normalizeModuleInput(input);
  const payload = {
    ...toDbPayload(normalized, actor),
    created_by: actor.loginId,
  };
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("workflow_registry_modules")
    .insert(payload)
    .select("id,module_key,module_name,description,statuses,actions,is_active,version,created_by,updated_by,created_at,updated_at")
    .single();

  if (error) {
    throw error;
  }

  try {
    await writeRegistryAudit({
      actor,
      entityId: normalized.moduleKey,
      newValues: data as Record<string, unknown>,
      oldValues: null,
      summary: `Created workflow registry module ${normalized.moduleKey}`,
    });
  } catch (auditError) {
    await supabase.from("workflow_registry_modules").delete().eq("module_key", normalized.moduleKey);
    throw auditError;
  }

  return getWorkflowRegistryDashboard();
}

export async function updateWorkflowRegistryModule(
  currentModuleKey: string,
  input: WorkflowRegistryMutationInput,
  actor: WorkflowRegistryActor,
) {
  assertSuperAdmin(actor);
  const normalized = normalizeModuleInput(input);
  const supabase = getSupabaseAdmin();
  const { data: previous, error: previousError } = await supabase
    .from("workflow_registry_modules")
    .select("*")
    .eq("module_key", currentModuleKey)
    .maybeSingle();

  if (previousError) {
    throw previousError;
  }
  if (!previous) {
    throw new Error(`Workflow registry module "${currentModuleKey}" was not found.`);
  }

  const { data, error } = await supabase
    .from("workflow_registry_modules")
    .update(toDbPayload(normalized, actor))
    .eq("module_key", currentModuleKey)
    .select("id,module_key,module_name,description,statuses,actions,is_active,version,created_by,updated_by,created_at,updated_at")
    .single();

  if (error) {
    throw error;
  }

  try {
    await writeRegistryAudit({
      actor,
      entityId: normalized.moduleKey,
      newValues: data as Record<string, unknown>,
      oldValues: previous as Record<string, unknown>,
      summary: `Updated workflow registry module ${normalized.moduleKey}`,
    });
  } catch (auditError) {
    await supabase
      .from("workflow_registry_modules")
      .upsert(previous as Record<string, unknown>, { onConflict: "module_key" });
    throw auditError;
  }

  return getWorkflowRegistryDashboard();
}

export async function deleteWorkflowRegistryModule(moduleKey: string, actor: WorkflowRegistryActor) {
  assertSuperAdmin(actor);
  const normalizedModuleKey = normalizeKey(moduleKey, "Module key");
  const supabase = getSupabaseAdmin();
  const { data: previous, error: previousError } = await supabase
    .from("workflow_registry_modules")
    .select("*")
    .eq("module_key", normalizedModuleKey)
    .maybeSingle();

  if (previousError) {
    throw previousError;
  }
  if (!previous) {
    throw new Error(`Workflow registry module "${normalizedModuleKey}" was not found.`);
  }

  const { error } = await supabase
    .from("workflow_registry_modules")
    .delete()
    .eq("module_key", normalizedModuleKey);

  if (error) {
    throw error;
  }

  try {
    await writeRegistryAudit({
      actor,
      entityId: normalizedModuleKey,
      newValues: null,
      oldValues: previous as Record<string, unknown>,
      summary: `Deleted workflow registry module ${normalizedModuleKey}`,
    });
  } catch (auditError) {
    await supabase
      .from("workflow_registry_modules")
      .upsert(previous as Record<string, unknown>, { onConflict: "module_key" });
    throw auditError;
  }

  return getWorkflowRegistryDashboard();
}

export async function resolveWorkflowRegistryTransition(input: {
  actionKey: string;
  moduleKey: string;
  role: PhoenixRole;
  status: string;
}) {
  const modules = await listWorkflowRegistryModules();
  const moduleDefinition = modules.find((module) => module.isActive && module.moduleKey === input.moduleKey);
  if (!moduleDefinition) {
    return { allowed: false, reason: "workflow_module_not_found" as const };
  }

  const action = moduleDefinition.actions.find((item) => item.key === input.actionKey);
  if (!action) {
    return { allowed: false, module: moduleDefinition, reason: "workflow_action_not_found" as const };
  }
  if (!action.from.includes(input.status)) {
    return { action, allowed: false, module: moduleDefinition, reason: "workflow_status_not_allowed" as const };
  }
  if (!action.allowedRoles.includes(input.role)) {
    return { action, allowed: false, module: moduleDefinition, reason: "workflow_role_not_allowed" as const };
  }

  return { action, allowed: true, module: moduleDefinition, nextStatus: action.to };
}

function workflowTransitionBlockedMessage(input: {
  actionKey: string;
  moduleKey: string;
  reason: WorkflowRegistryTransitionFailureReason;
  role: PhoenixRole;
  status: string;
}) {
  if (input.reason === "workflow_module_not_found") {
    return `Workflow Registry blocked ${input.moduleKey}.${input.actionKey}: module is missing or inactive.`;
  }
  if (input.reason === "workflow_action_not_found") {
    return `Workflow Registry blocked ${input.moduleKey}.${input.actionKey}: action is not defined.`;
  }
  if (input.reason === "workflow_status_not_allowed") {
    return `Workflow Registry blocked ${input.moduleKey}.${input.actionKey}: status "${input.status}" is not allowed.`;
  }
  if (input.reason === "workflow_role_not_allowed") {
    return `Forbidden: Workflow Registry does not allow ${input.role} to run ${input.moduleKey}.${input.actionKey} from "${input.status}".`;
  }
  return `Workflow Registry blocked ${input.moduleKey}.${input.actionKey}.`;
}

export async function assertWorkflowRegistryTransition(input: {
  actionKey: string;
  moduleKey: string;
  role: PhoenixRole;
  status: string;
}) {
  const result = await resolveWorkflowRegistryTransition(input);

  if (result.allowed) {
    return result;
  }

  const reason: WorkflowRegistryTransitionFailureReason =
    result.reason ?? "workflow_module_not_found";
  const message = workflowTransitionBlockedMessage({
    ...input,
    reason,
  });

  if (reason === "workflow_role_not_allowed") {
    throw new Error(message);
  }

  throw new WorkflowRegistryTransitionError({
    actionKey: input.actionKey,
    message,
    moduleKey: input.moduleKey,
    reason,
    status: input.status,
  });
}
