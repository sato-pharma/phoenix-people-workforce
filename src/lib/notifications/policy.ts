import { getSupabaseAdmin } from "@/lib/supabase/server";
import { pickDeliverableEmail } from "@/lib/email/email-safety";
import {
  canAccess,
  parseRoleStrict,
  scopeForRole,
  type AccessContext,
  type PermissionAction,
  type PermissionResource,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import type { SystemNotificationChannel, SystemNotificationPriority } from "@/lib/notifications/system";

export type NotificationRecipientStrategy =
  | "actor"
  | "admin"
  | "area_manager"
  | "assigned_approver"
  | "cc"
  | "department_head"
  | "direct_manager"
  | "employee"
  | "hr"
  | "line_manager"
  | "manager_chain"
  | "module_owner"
  | "permission_based"
  | "request_owner"
  | "role_based"
  | "team_manager"
  | "workflow_step_approver";

export type NotificationPolicy = {
  actionUrlRequired: boolean;
  auditRequired: boolean;
  bypassQuietHours: boolean;
  channels: SystemNotificationChannel[];
  fallbackChannels: SystemNotificationChannel[];
  permissionAction: PermissionAction;
  permissionResource: PermissionResource | null;
  priority: SystemNotificationPriority;
  recipientStrategy: NotificationRecipientStrategy[];
  sensitive: "none" | "payroll";
  strictRecipients: boolean;
  telegramAllowed: boolean;
  telegramGenericOnly: boolean;
};

export type NotificationRecipient = {
  email?: string | null;
  hrId?: string | null;
  name?: string | null;
  userId?: string | null;
};

export type ResolveNotificationRecipientsInput = {
  actorId?: string | null;
  eventType: string;
  metadata?: Record<string, unknown>;
  module: string;
  recordId?: string | null;
  subjectHrId?: string | null;
};

export type NotificationRecipientGovernanceWarning = {
  code: string;
  detail: string;
  strategy?: NotificationRecipientStrategy;
};

export type NotificationRecipientResolution = {
  recipients: NotificationRecipient[];
  warnings: NotificationRecipientGovernanceWarning[];
};

const defaultPolicy: NotificationPolicy = {
  actionUrlRequired: false,
  auditRequired: true,
  bypassQuietHours: false,
  channels: ["in_app", "email"],
  fallbackChannels: ["in_app", "email"],
  permissionAction: "read",
  permissionResource: null,
  priority: "normal",
  recipientStrategy: ["employee"],
  sensitive: "none",
  strictRecipients: true,
  telegramAllowed: false,
  telegramGenericOnly: false,
};

const policyTable: Record<string, Partial<NotificationPolicy>> = {
  // Ops health alert, not a per-employee workflow notification — there is no employee
  // subject to resolve "employee" against (the attendance.* wildcard below), so this
  // exact-key override targets whichever admins the caller names explicitly via
  // metadata.moduleOwnerHrIds (see runAttendanceIngestionAlert), bypassing the
  // subject/org-scope matching permission_based normally requires.
  "attendance.attendance_agent_ingestion_stalled": { channels: ["in_app", "email"], permissionResource: "admin", priority: "high", recipientStrategy: ["permission_based"] },
  "attendance.*": { channels: ["in_app", "email"], recipientStrategy: ["employee"] },
  "birthday.*": { channels: ["in_app", "email"], recipientStrategy: ["employee"] },
  "contract_renewal.renewal_reminder": { actionUrlRequired: true, channels: ["in_app", "email", "telegram"], permissionResource: null, priority: "high", recipientStrategy: ["direct_manager", "workflow_step_approver"], telegramAllowed: true },
  "contract_renewal.*": { channels: ["in_app", "email", "telegram"], permissionResource: "contracts", priority: "high", recipientStrategy: ["manager_chain", "permission_based"], telegramAllowed: true },
  "employee_import.*": { channels: ["in_app", "email"], permissionAction: "import", permissionResource: "imports", recipientStrategy: ["permission_based"] },
  "expenses.*": { channels: ["in_app", "email"], recipientStrategy: ["direct_manager"] },
  "excuse.*": { actionUrlRequired: true, channels: ["in_app", "email", "telegram"], priority: "high", recipientStrategy: ["direct_manager"], telegramAllowed: true },
  "internal_messages.*": { channels: ["in_app", "email"], recipientStrategy: ["employee"] },
  "marketing_requests.due_date_reminder": { channels: ["in_app", "email", "telegram"], priority: "high", recipientStrategy: ["assigned_approver", "request_owner"], telegramAllowed: true },
  "marketing_requests.escalation": { bypassQuietHours: true, channels: ["in_app", "email", "telegram"], priority: "critical", recipientStrategy: ["workflow_step_approver"], telegramAllowed: true },
  "marketing_requests.overdue_reminder": { channels: ["in_app", "email", "telegram"], priority: "high", recipientStrategy: ["assigned_approver", "request_owner"], telegramAllowed: true },
  "marketing_requests.request_approved": { channels: ["in_app", "email", "telegram"], recipientStrategy: ["request_owner", "workflow_step_approver"], telegramAllowed: true },
  "marketing_requests.request_assigned": { channels: ["in_app", "email", "telegram"], priority: "high", recipientStrategy: ["assigned_approver", "cc"], telegramAllowed: true },
  "marketing_requests.request_completed": { channels: ["in_app", "email", "telegram"], recipientStrategy: ["request_owner", "workflow_step_approver"], telegramAllowed: true },
  "marketing_requests.request_rejected": { channels: ["in_app", "email", "telegram"], priority: "high", recipientStrategy: ["request_owner"], telegramAllowed: true },
  "marketing_requests.request_returned": { channels: ["in_app", "email", "telegram"], priority: "high", recipientStrategy: ["request_owner"], telegramAllowed: true },
  "marketing_requests.request_submitted": { actionUrlRequired: true, channels: ["in_app", "email", "telegram"], recipientStrategy: ["workflow_step_approver"], telegramAllowed: true },
  "offers.*": { channels: ["in_app", "email"], permissionResource: "offers", priority: "high", recipientStrategy: ["permission_based"] },
  "outstation.*": { channels: ["in_app", "email", "telegram"], priority: "high", recipientStrategy: ["direct_manager"], telegramAllowed: true },
  "payroll.payslip_available": { channels: ["in_app", "email"], recipientStrategy: ["employee"], sensitive: "payroll", telegramGenericOnly: true },
  "payroll.*": { bypassQuietHours: true, channels: ["in_app", "email"], permissionResource: "payroll", priority: "critical", recipientStrategy: ["permission_based"], sensitive: "payroll" },
  "password_reset.*": { channels: ["email"], priority: "high", recipientStrategy: ["employee"] },
  "password_setup.*": { channels: ["email"], priority: "high", recipientStrategy: ["employee"] },
  "probation.reminder_due": { actionUrlRequired: true, channels: ["in_app", "email", "telegram"], permissionResource: null, priority: "high", recipientStrategy: ["direct_manager", "workflow_step_approver"], telegramAllowed: true },
  "probation.*": { channels: ["in_app", "email", "telegram"], permissionResource: "probation", priority: "high", recipientStrategy: ["direct_manager", "permission_based"], telegramAllowed: true },
  "recruitment.*": { channels: ["in_app", "email"], permissionResource: "recruitment", recipientStrategy: ["assigned_approver", "permission_based"] },
  "resignations.*": { channels: ["in_app", "email", "telegram"], permissionResource: "resignations", priority: "high", recipientStrategy: ["manager_chain", "permission_based"], telegramAllowed: true },
  "system.announcement": { channels: ["in_app", "email"], recipientStrategy: ["employee"] },
  "telegram.daily_hr_digest": { actionUrlRequired: true, channels: ["in_app", "telegram"], priority: "normal", recipientStrategy: ["workflow_step_approver"], telegramAllowed: true },
  "telegram.delivery_escalation": { actionUrlRequired: true, bypassQuietHours: true, channels: ["in_app", "email", "telegram"], priority: "high", recipientStrategy: ["workflow_step_approver"], telegramAllowed: true },
  "vacation.request_submitted": { actionUrlRequired: true, channels: ["in_app", "email", "telegram"], recipientStrategy: [], telegramAllowed: true },
  "vacation.*": { channels: ["in_app", "email", "telegram"], permissionResource: "leave", priority: "high", recipientStrategy: ["manager_chain", "permission_based"], telegramAllowed: true },
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function cleanHrId(value: unknown) {
  return cleanText(value).toUpperCase();
}

function policyKey(moduleName: string, eventType: string) {
  return `${cleanText(moduleName).toLowerCase()}.${cleanText(eventType).toLowerCase()}`;
}

export function resolveNotificationPolicy(input: Pick<ResolveNotificationRecipientsInput, "eventType" | "module">): NotificationPolicy {
  const exact = policyTable[policyKey(input.module, input.eventType)];
  const wildcard = policyTable[`${cleanText(input.module).toLowerCase()}.*`];
  const merged = { ...defaultPolicy, ...(wildcard ?? {}), ...(exact ?? {}) };
  return {
    ...merged,
    channels: Array.from(new Set(merged.channels)),
    fallbackChannels: Array.from(new Set(merged.fallbackChannels)),
    recipientStrategy: Array.from(new Set(merged.recipientStrategy)),
  };
}

function schemaMissing(error: unknown) {
  const text = (error instanceof Error ? error.message : `${String(error)} ${JSON.stringify(error)}`).toLowerCase();
  return text.includes("schema cache") || text.includes("does not exist") || text.includes("could not find the table");
}

function metadataText(metadata: Record<string, unknown> | undefined, keys: string[]) {
  for (const key of keys) {
    const value = cleanText(metadata?.[key]);
    if (value) return value;
  }
  return "";
}

function metadataTexts(metadata: Record<string, unknown> | undefined, keys: string[]) {
  const output: string[] = [];
  for (const key of keys) {
    const value = metadata?.[key];
    if (Array.isArray(value)) {
      output.push(...value.map(cleanHrId).filter(Boolean));
    } else {
      const text = cleanHrId(value);
      if (text) output.push(text);
    }
  }
  return Array.from(new Set(output));
}

type EmployeeRecipientRow = {
  area_id?: number | null;
  department_id?: number | null;
  employment_status?: string | null;
  full_name?: string | null;
  hr_id?: string | null;
  line_id?: number | null;
  manager_hr_id?: string | null;
  team_id?: number | null;
  work_email?: string | null;
};

type AuthRecipientRow = {
  auth_email?: string | null;
  hr_id?: string | null;
  is_active?: boolean | null;
  line?: string | null;
  login_id?: string | null;
  manager_hr_id?: string | null;
  name?: string | null;
  role?: string | null;
};

type RecipientCandidate = {
  auth: AuthRecipientRow | null;
  employee: EmployeeRecipientRow | null;
  recipient: NotificationRecipient;
  role: PhoenixRole | null;
};

function isActiveEmployee(employee: EmployeeRecipientRow | null | undefined) {
  const status = cleanText(employee?.employment_status).toLowerCase();
  return !status || status === "active" || status === "on_leave";
}

function roleFrom(value: unknown) {
  const normalized = cleanText(value);
  if (!normalized) return null;
  try {
    return parseRoleStrict(normalized);
  } catch {
    return null;
  }
}

function recipientFromCandidate(candidate: Pick<RecipientCandidate, "auth" | "employee" | "role">): NotificationRecipient {
  return {
    // The employee work_email is the only deliverable address. `auth_email` is the synthetic
    // Supabase-auth login key (phx-<hex>@auth.phoenix.local) and must NEVER be emailed — it
    // hard-bounces. No real email → null (recipient still gets the in-app notification).
    email: pickDeliverableEmail(candidate.employee?.work_email, candidate.auth?.auth_email),
    hrId: cleanHrId(candidate.auth?.hr_id ?? candidate.employee?.hr_id) || null,
    name: candidate.auth?.name ?? candidate.employee?.full_name ?? null,
    userId: candidate.auth?.login_id ?? null,
  };
}

async function authUserByHrId(hrId: string | null | undefined): Promise<AuthRecipientRow | null> {
  const normalized = cleanHrId(hrId);
  if (!normalized) return null;

  try {
    const { data, error } = await getSupabaseAdmin()
      .from("app_auth_users")
      .select("login_id,hr_id,name,auth_email,role,is_active,line,manager_hr_id")
      .eq("hr_id", normalized)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data as AuthRecipientRow | null;
  } catch (error) {
    if (!schemaMissing(error)) console.error("Notification auth recipient lookup failed", error);
    return null;
  }
}

async function candidateByHrId(hrId: string | null | undefined): Promise<RecipientCandidate | null> {
  const normalized = cleanHrId(hrId);
  if (!normalized) return null;

  try {
    const [{ data: employeeData, error: employeeError }, auth] = await Promise.all([
      getSupabaseAdmin()
      .from("employees")
        .select("hr_id,full_name,work_email,manager_hr_id,department_id,line_id,area_id,team_id,employment_status")
      .eq("hr_id", normalized)
      .limit(1)
        .maybeSingle(),
      authUserByHrId(normalized),
    ]);
    if (employeeError) throw employeeError;
    const employee = employeeData as EmployeeRecipientRow | null;
    if (!employee || !isActiveEmployee(employee)) return null;
    const role = roleFrom(auth?.role);
    const candidate = { auth, employee, role };
    return { ...candidate, recipient: recipientFromCandidate(candidate) };
  } catch (error) {
    if (!schemaMissing(error)) console.error("Notification employee recipient lookup failed", error);
    return null;
  }
}

async function employeeByHrId(hrId: string | null | undefined): Promise<NotificationRecipient | null> {
  return (await candidateByHrId(hrId))?.recipient ?? null;
}

async function candidatesByHrIds(hrIds: string[]): Promise<Map<string, RecipientCandidate>> {
  const normalized = Array.from(new Set(hrIds.map(cleanHrId).filter(Boolean)));
  const output = new Map<string, RecipientCandidate>();
  if (normalized.length === 0) return output;

  try {
    const [{ data: employeeData, error: employeeError }, { data: authData, error: authError }] = await Promise.all([
      getSupabaseAdmin()
        .from("employees")
        .select("hr_id,full_name,work_email,manager_hr_id,department_id,line_id,area_id,team_id,employment_status")
        .in("hr_id", normalized),
      getSupabaseAdmin()
        .from("app_auth_users")
        .select("login_id,hr_id,name,auth_email,role,is_active,line,manager_hr_id")
        .in("hr_id", normalized)
        .eq("is_active", true),
    ]);
    if (employeeError) throw employeeError;
    if (authError) throw authError;

    const employeesByHrId = new Map(((employeeData ?? []) as EmployeeRecipientRow[]).map((row) => [cleanHrId(row.hr_id), row] as const));
    const authByHrId = new Map(((authData ?? []) as AuthRecipientRow[]).map((row) => [cleanHrId(row.hr_id), row] as const));

    for (const hrId of normalized) {
      const employee = employeesByHrId.get(hrId) ?? null;
      if (!employee || !isActiveEmployee(employee)) continue;
      const auth = authByHrId.get(hrId) ?? null;
      const role = roleFrom(auth?.role);
      const candidate = { auth, employee, role };
      output.set(hrId, { ...candidate, recipient: recipientFromCandidate(candidate) });
    }
    return output;
  } catch (error) {
    if (!schemaMissing(error)) console.error("Notification batch recipient lookup failed", error);
    return output;
  }
}

async function activeAuthCandidates() {
  try {
    const [{ data: authData, error: authError }, { data: employeeData, error: employeeError }] = await Promise.all([
      getSupabaseAdmin()
      .from("app_auth_users")
        .select("login_id,hr_id,name,auth_email,role,is_active,line,manager_hr_id")
        .eq("is_active", true),
      getSupabaseAdmin()
        .from("employees")
        .select("hr_id,full_name,work_email,manager_hr_id,department_id,line_id,area_id,team_id,employment_status"),
    ]);
    if (authError) throw authError;
    if (employeeError) throw employeeError;
    const employeesByHrId = new Map(
      ((employeeData ?? []) as EmployeeRecipientRow[])
        .map((row) => [cleanHrId(row.hr_id), row] as const)
        .filter((entry): entry is [string, EmployeeRecipientRow] => Boolean(entry[0]) && isActiveEmployee(entry[1])),
    );

    return ((authData ?? []) as AuthRecipientRow[])
      .map((auth) => {
        const role = roleFrom(auth.role);
        const employee = employeesByHrId.get(cleanHrId(auth.hr_id)) ?? null;
        const candidate = { auth, employee, role };
        return { ...candidate, recipient: recipientFromCandidate(candidate) };
      })
      .filter((candidate) => candidate.role && candidate.recipient.hrId);
  } catch (error) {
    if (!schemaMissing(error)) console.error("Notification active auth recipient lookup failed", error);
    return [];
  }
}

async function managerFor(hrId: string | null | undefined) {
  const employee = await employeeByHrId(hrId);
  if (!employee?.hrId) return [];
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("employees")
      .select("manager_hr_id")
      .eq("hr_id", employee.hrId)
      .maybeSingle();
    if (error) throw error;
    const managerHrId = (data as { manager_hr_id?: string | null } | null)?.manager_hr_id;
    const manager = await employeeByHrId(managerHrId);
    return manager ? [manager] : [];
  } catch (error) {
    if (!schemaMissing(error)) console.error("Notification manager recipient lookup failed", error);
    return [];
  }
}

async function managerChainFor(hrId: string | null | undefined, maxDepth = 4) {
  const output: NotificationRecipient[] = [];
  const visited = new Set<string>();
  let current = cleanHrId(hrId);

  for (let depth = 0; depth < maxDepth && current; depth += 1) {
    const managers = await managerFor(current);
    const manager = managers[0];
    const managerHrId = cleanHrId(manager?.hrId);
    if (!managerHrId || visited.has(managerHrId)) break;
    output.push(manager);
    visited.add(managerHrId);
    current = managerHrId;
  }

  return output;
}

async function explicitRecipientCandidates(input: ResolveNotificationRecipientsInput, keys: string[]) {
  const hrIds = metadataTexts(input.metadata, keys);
  const candidateMap = await candidatesByHrIds(hrIds);
  return hrIds
    .map((hrId) => candidateMap.get(cleanHrId(hrId)))
    .filter((candidate): candidate is RecipientCandidate => Boolean(candidate?.recipient.hrId));
}

function accessContextFor(candidate: RecipientCandidate): AccessContext | null {
  if (!candidate.role || !candidate.recipient.hrId) return null;
  return {
    hrId: candidate.recipient.hrId,
    loginId: candidate.recipient.userId,
    role: candidate.role,
    scope: scopeForRole(candidate.role),
    source: "session",
  };
}

function sameNullableNumber(left: unknown, right: unknown) {
  const l = left === null || left === undefined || left === "" ? null : Number(left);
  const r = right === null || right === undefined || right === "" ? null : Number(right);
  return l !== null && r !== null && Number.isFinite(l) && Number.isFinite(r) && l === r;
}

function reportsTo(candidate: RecipientCandidate, subject: RecipientCandidate | null) {
  return Boolean(subject?.employee?.manager_hr_id && cleanHrId(subject.employee.manager_hr_id) === candidate.recipient.hrId);
}

function inManagerChain(candidate: RecipientCandidate, subject: RecipientCandidate | null, employeesByHrId: Map<string, EmployeeRecipientRow>) {
  if (!candidate.recipient.hrId || !subject?.recipient.hrId) return false;
  const visited = new Set<string>();
  let managerHrId = cleanHrId(subject.employee?.manager_hr_id);
  while (managerHrId) {
    if (managerHrId === candidate.recipient.hrId) return true;
    if (visited.has(managerHrId)) return false;
    visited.add(managerHrId);
    managerHrId = cleanHrId(employeesByHrId.get(managerHrId)?.manager_hr_id);
  }
  return false;
}

function hasOrgScope(candidate: RecipientCandidate, subject: RecipientCandidate | null, scope: "area" | "department" | "line" | "team") {
  if (!candidate.employee || !subject?.employee) return false;
  if (scope === "area") return sameNullableNumber(candidate.employee.area_id, subject.employee.area_id);
  if (scope === "department") return sameNullableNumber(candidate.employee.department_id, subject.employee.department_id);
  if (scope === "line") return sameNullableNumber(candidate.employee.line_id, subject.employee.line_id);
  return sameNullableNumber(candidate.employee.team_id, subject.employee.team_id);
}

async function permissionBasedRecipients(input: ResolveNotificationRecipientsInput, policy: NotificationPolicy, subject: RecipientCandidate | null) {
  if (!policy.permissionResource) return [];
  const explicit = await explicitRecipientCandidates(input, ["permissionRecipientHrId", "permissionRecipientHrIds", "moduleOwnerHrId", "moduleOwnerHrIds"]);
  const candidates = explicit.length > 0 ? explicit : await activeAuthCandidates();
  const employeesByHrId = new Map(
    candidates
      .map((candidate) => [candidate.recipient.hrId ?? "", candidate.employee] as const)
      .filter((entry): entry is [string, EmployeeRecipientRow] => Boolean(entry[0] && entry[1])),
  );
  if (subject?.employee && subject.recipient.hrId) employeesByHrId.set(subject.recipient.hrId, subject.employee);

  const output: NotificationRecipient[] = [];
  for (const candidate of candidates) {
    const context = accessContextFor(candidate);
    if (!context || !await canAccess(context, policy.permissionResource, policy.permissionAction)) continue;
    if (explicit.length > 0) {
      output.push(candidate.recipient);
      continue;
    }
    if (!subject) continue;
    if (
      candidate.recipient.hrId === subject.recipient.hrId ||
      reportsTo(candidate, subject) ||
      inManagerChain(candidate, subject, employeesByHrId) ||
      hasOrgScope(candidate, subject, "line") ||
      hasOrgScope(candidate, subject, "department") ||
      hasOrgScope(candidate, subject, "area") ||
      hasOrgScope(candidate, subject, "team") ||
      // Company/system-scope roles (e.g. Super Admin, CEO) already see every
      // employee — never require them to also match the subject's org chain.
      context.scope === "company" ||
      context.scope === "system"
    ) {
      output.push(candidate.recipient);
    }
  }
  return output;
}

export async function resolveNotificationRecipientsWithGovernance(input: ResolveNotificationRecipientsInput): Promise<NotificationRecipientResolution> {
  const policy = resolveNotificationPolicy(input);
  const subjectHrId = cleanHrId(input.subjectHrId || metadataText(input.metadata, ["employeeHrId", "subjectHrId", "requestOwnerHrId"]));
  const subject = subjectHrId ? await candidateByHrId(subjectHrId) : null;
  const recipients: NotificationRecipient[] = [];
  const warnings: NotificationRecipientGovernanceWarning[] = [];

  for (const strategy of policy.recipientStrategy) {
    if (strategy === "employee" || strategy === "request_owner") {
      const ownerHrId = strategy === "request_owner" ? metadataText(input.metadata, ["requestOwnerHrId"]) : subjectHrId;
      const employee = await employeeByHrId(ownerHrId);
      if (employee) recipients.push(employee);
      else warnings.push({ code: "recipient_not_resolved", detail: `${strategy} was not resolved.`, strategy });
    } else if (strategy === "direct_manager") {
      const managers = await managerFor(subjectHrId);
      if (managers.length > 0) recipients.push(...managers);
      else warnings.push({ code: "direct_manager_missing", detail: "Direct manager could not be resolved.", strategy });
    } else if (strategy === "manager_chain") {
      const chain = await managerChainFor(subjectHrId);
      if (chain.length > 0) recipients.push(...chain);
      else warnings.push({ code: "manager_chain_missing", detail: "Manager chain could not be resolved.", strategy });
    } else if (strategy === "line_manager") {
      const scoped = await explicitRecipientCandidates(input, ["lineManagerHrId", "lineManagerHrIds"]);
      recipients.push(...scoped.map((candidate) => candidate.recipient).filter((recipient) => recipient.hrId));
      if (scoped.length === 0) warnings.push({ code: "line_manager_missing", detail: "Line manager must be explicit; no broad line fallback was used.", strategy });
    } else if (strategy === "department_head") {
      const scoped = await explicitRecipientCandidates(input, ["departmentHeadHrId", "departmentHeadHrIds"]);
      recipients.push(...scoped.map((candidate) => candidate.recipient).filter((recipient) => recipient.hrId));
      if (scoped.length === 0) warnings.push({ code: "department_head_missing", detail: "Department head must be explicit; no broad department fallback was used.", strategy });
    } else if (strategy === "area_manager") {
      const scoped = await explicitRecipientCandidates(input, ["areaManagerHrId", "areaManagerHrIds"]);
      recipients.push(...scoped.map((candidate) => candidate.recipient).filter((recipient) => recipient.hrId));
      if (scoped.length === 0) warnings.push({ code: "area_manager_missing", detail: "Area manager must be explicit; no broad area fallback was used.", strategy });
    } else if (strategy === "team_manager") {
      const scoped = await explicitRecipientCandidates(input, ["teamManagerHrId", "teamManagerHrIds"]);
      recipients.push(...scoped.map((candidate) => candidate.recipient).filter((recipient) => recipient.hrId));
      if (scoped.length === 0) warnings.push({ code: "team_manager_missing", detail: "Team manager must be explicit; no broad team fallback was used.", strategy });
    } else if (strategy === "cc") {
      const scoped = await explicitRecipientCandidates(input, ["ccHrIds"]);
      recipients.push(...scoped.map((candidate) => candidate.recipient).filter((recipient) => recipient.hrId));
      if (scoped.length === 0) warnings.push({ code: "cc_recipient_missing", detail: "CC recipients must be explicit; no fallback was used.", strategy });
    } else if (strategy === "hr" || strategy === "admin" || strategy === "module_owner" || strategy === "permission_based") {
      const scoped = await permissionBasedRecipients(input, policy, subject);
      if (scoped.length > 0) recipients.push(...scoped);
      else warnings.push({ code: "permission_recipient_missing", detail: `${strategy} requires exact permission and organizational scope; no broad fallback was used.`, strategy });
    } else if (strategy === "assigned_approver" || strategy === "workflow_step_approver" || strategy === "role_based") {
      const keys = strategy === "assigned_approver"
        ? ["assignedApproverHrId", "assignedApproverHrIds"]
        : strategy === "workflow_step_approver"
          ? ["workflowApproverHrId", "workflowApproverHrIds", "workflowStepApproverHrId", "workflowStepApproverHrIds", "approverHrId", "approverHrIds", "escalationOwnerHrId", "workflowParticipantHrIds"]
          : ["roleRecipientHrId", "roleRecipientHrIds", "recipientHrId", "recipientHrIds"];
      const explicit = await explicitRecipientCandidates(input, keys);
      if (explicit.length > 0) recipients.push(...explicit.map((candidate) => candidate.recipient));
      else warnings.push({ code: "explicit_recipient_missing", detail: `${strategy} requires an explicit recipient; no manager/HR fallback was used.`, strategy });
    } else if (strategy === "actor") {
      const actor = await employeeByHrId(input.actorId);
      if (actor) recipients.push(actor);
      else warnings.push({ code: "actor_missing", detail: "Actor recipient could not be resolved.", strategy });
    }
  }

  const seen = new Set<string>();
  const resolved = recipients.filter((recipient) => {
    const key = cleanText(recipient.userId || recipient.hrId || recipient.email).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (policy.strictRecipients && resolved.length === 0) {
    warnings.push({ code: "notification_governance_fail_closed", detail: "No exact authorized recipient resolved; notification must be skipped." });
  }
  return { recipients: resolved, warnings };
}

export async function resolveNotificationRecipients(input: ResolveNotificationRecipientsInput): Promise<NotificationRecipient[]> {
  return (await resolveNotificationRecipientsWithGovernance(input)).recipients;
}
