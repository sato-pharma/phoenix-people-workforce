import crypto from "crypto";


import { writeAuditLog } from "@/lib/admin/audit";
import {
  safeSendNotificationEmail,
  type EmailNotificationType,
  type EmailRecipientMode,
  type NotificationEmailIdentityGuard,
  type NotificationEmailIdentitySource,
  type NotificationEmailInput,
  validateNotificationEmailIdentity,
} from "@/lib/notifications/email";
import {
  resolveNotificationPolicy,
  resolveNotificationRecipientsWithGovernance,
  type NotificationRecipient,
  type NotificationRecipientGovernanceWarning,
} from "@/lib/notifications/policy";
import { renderNotificationTemplate } from "@/lib/notifications/templates";
import { notificationHrefForViewerRole } from "@/lib/notifications/hrefs";
import { sendTelegramNotification } from "@/lib/notifications/telegram";
import { resolveTelegramGovernance } from "@/lib/notifications/telegram-governance";
import { GENERIC_NOTIFICATION_TITLE, GENERIC_PAYSLIP_MESSAGE, TelegramTemplateError } from "@/lib/notifications/telegram-template-types";
import { currentCairoMinutesOfDay } from "@/lib/i18n/format";
import { pickDeliverableEmail } from "@/lib/email/email-safety";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type SystemNotificationChannel = "in_app" | "email" | "telegram";
export type SystemNotificationPriority = "low" | "normal" | "high" | "critical";

export type CreateSystemNotificationInput = {
  actionUrl?: string | null;
  actorId?: string | null;
  category?: string | null;
  channels?: SystemNotificationChannel[];
  email?: Partial<NotificationEmailInput> & {
    notificationType?: EmailNotificationType;
    recipientMode?: EmailRecipientMode;
  };
  eventType: string;
  message: string;
  metadata?: Record<string, unknown>;
  module: string;
  priority?: SystemNotificationPriority;
  recordId?: string | null;
  recipientHrId?: string | null;
  recipientUserId?: string | null;
  subjectHrId?: string | null;
  telegram?: {
    buttons?: Array<{ label: string; url: string }> | null;
    ctaLabel?: string | null;
    ctaUrl?: string | null;
  };
  title: string;
};

export type SystemNotificationDeliveryResult = {
  channel: SystemNotificationChannel;
  error?: string;
  idempotencyKey: string;
  reason?: string;
  status: "pending" | "sent" | "failed" | "skipped" | "retrying";
};

export type SystemNotificationResult = {
  deliveries: SystemNotificationDeliveryResult[];
  eventId: string | null;
  eventKey: string;
};

/** Shared delivery-status shape for best-effort notification fan-outs. */
export type NotificationDeliveryStatus = {
  errored: boolean;
  fellBackToSuperAdmin: boolean;
  recipientCount: number;
};

type RecipientProfile = {
  email: string | null;
  hrId: string | null;
  name: string | null;
  role: string | null;
  userId: string | null;
};

type NotificationPreferenceRow = {
  email_enabled?: boolean | null;
  in_app_enabled?: boolean | null;
  module_preferences?: Record<string, unknown> | null;
  preferred_channel?: SystemNotificationChannel | null;
  quiet_hours_end?: string | null;
  quiet_hours_start?: string | null;
  telegram_enabled?: boolean | null;
};

type TelegramConnectionRow = {
  telegram_chat_id?: string | number | null;
  status?: "pending" | "connected" | "disabled" | "failed" | null;
};

type LoadedPreferences = {
  email_enabled: boolean;
  in_app_enabled: boolean;
  module_preferences: Record<string, unknown>;
  preferred_channel: SystemNotificationChannel;
  quiet_hours_end: string | null;
  quiet_hours_start: string | null;
  telegram_enabled: boolean;
};

const sensitivePayrollModules = new Set(["payroll", "payslip", "payslips"]);
const criticalWorkflowModules = new Set([
  "contracts",
  "contract_renewal",
  "excuse",
  "excuses",
  "offers",
  "payroll",
  "payslip",
  "payslips",
  "probation",
  "resignations",
  "vacation",
  "leave",
]);
const systemAnnouncementEvents = new Set(["announcement", "system_announcement"]);
const employeeSubjectWorkflowModules = new Set([
  "contract_renewal",
  "deductions",
  "excuse",
  "excuses",
  "leave",
  "marketing_requests",
  "outstation",
  "probation",
  "resignations",
  "support_requests",
  "vacation",
  "weekly_plans",
]);

const workflowEmailEnvelopeModules = new Set([
  ...employeeSubjectWorkflowModules,
  "coaching",
  "contracts",
  "expenses",
  "leave",
  "marketing_requests",
  "weekly_planning",
]);

// Aggregate digests (many employees rolled into one email) live in a
// per-employee workflow module but have no single subject by design — exempt
// them by event type so the module-level identity guard doesn't fail them.
const aggregateDigestEventTypes = new Set(["high_risk_digest"]);

function cleanText(value: string | null | undefined) {
  return String(value ?? "").trim();
}

function cleanHrId(value: string | null | undefined) {
  return cleanText(value).toUpperCase();
}

function metadataHrId(metadata: Record<string, unknown> | undefined, keys: string[]) {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value !== "string") continue;
    const hrId = cleanHrId(value);
    if (hrId) return hrId;
  }
  return "";
}

function employeeMetricHrId(metrics: NotificationEmailInput["metrics"]) {
  const employee = metrics?.find((metric) => metric.label.trim().toLowerCase() === "employee");
  const match = String(employee?.value ?? "").match(/\(([^)]+)\)\s*$/);
  return cleanHrId(match?.[1]);
}

function emailSubjectIdentityRequired(input: CreateSystemNotificationInput, hasSubjectCandidate: boolean) {
  if (hasSubjectCandidate) return true;
  if (aggregateDigestEventTypes.has(cleanText(input.eventType).toLowerCase())) return false;
  return employeeSubjectWorkflowModules.has(cleanText(input.module).toLowerCase());
}

function resolvedEmailIdentity(input: CreateSystemNotificationInput, recipient: RecipientProfile): {
  employeeHrId: string | undefined;
  error: string | null;
  guard: NotificationEmailIdentityGuard;
  source: NotificationEmailIdentitySource | null;
  status: "failed" | "not_required" | "verified";
} {
  const rawCandidates: Array<{ hrId: string; source: NotificationEmailIdentitySource }> = [
    { hrId: cleanHrId(input.email?.employeeHrId), source: "email.employeeHrId" },
    { hrId: cleanHrId(input.subjectHrId), source: "subjectHrId" },
    { hrId: metadataHrId(input.metadata, ["employeeHrId"]), source: "metadata.employeeHrId" },
    { hrId: metadataHrId(input.metadata, ["subjectHrId"]), source: "metadata.subjectHrId" },
    { hrId: metadataHrId(input.metadata, ["requestOwnerHrId"]), source: "metadata.requestOwnerHrId" },
    { hrId: employeeMetricHrId(input.email?.metrics), source: "metrics.Employee" },
  ];
  const candidates = rawCandidates.filter((candidate) => candidate.hrId);
  const required = emailSubjectIdentityRequired(input, candidates.length > 0);
  const guard: NotificationEmailIdentityGuard = required ? "subject_required" : "none";
  const unique = Array.from(new Set(candidates.map((candidate) => candidate.hrId)));

  if (unique.length > 1) {
    return {
      employeeHrId: unique[0],
      error: `Conflicting subject HR IDs were provided for email identity: ${unique.join(", ")}.`,
      guard,
      source: candidates[0]?.source ?? null,
      status: "failed",
    };
  }

  const subjectHrId = unique[0] ?? "";
  if (required && !subjectHrId) {
    return {
      employeeHrId: undefined,
      error: "Subject employee HR ID is missing for an official workflow email.",
      guard,
      source: null,
      status: "failed",
    };
  }

  if (!subjectHrId && input.metadata?.identityScope === "self") {
    const recipientHrId = cleanHrId(recipient.hrId);
    return {
      employeeHrId: recipientHrId || undefined,
      error: null,
      guard: recipientHrId ? "self" : "none",
      source: recipientHrId ? "recipient.self" : null,
      status: recipientHrId ? "verified" : "not_required",
    };
  }

  return {
    employeeHrId: subjectHrId || undefined,
    error: null,
    guard,
    source: candidates[0]?.source ?? null,
    status: subjectHrId ? "verified" : "not_required",
  };
}

function schemaMissing(error: unknown, table: string) {
  const text = (error instanceof Error ? error.message : `${String(error)} ${JSON.stringify(error)}`).toLowerCase();
  return (
    text.includes(table.toLowerCase()) ||
    text.includes("could not find the table") ||
    text.includes("schema cache") ||
    text.includes("column") && text.includes("does not exist") ||
    text.includes("42703") ||
    (text.includes("relation") && text.includes("does not exist"))
  );
}

function categoryFor(input: CreateSystemNotificationInput) {
  const explicit = cleanText(input.category).toLowerCase();
  if (explicit) return explicit;

  const moduleName = cleanText(input.module).toLowerCase();
  if (moduleName === "vacation" || moduleName === "leave") return "vacation_request";
  if (moduleName === "excuse" || moduleName === "excuses") return "excuse";
  if (moduleName === "coaching") return "coaching_report";
  if (moduleName === "internal_message" || moduleName === "internal_messages") return "internal_message";
  if (moduleName === "probation") return "probation";
  if (moduleName === "recruitment") return "recruitment";
  if (moduleName === "marketing_requests") return "general";
  return "general";
}

function notificationTypeFor(moduleName: string): EmailNotificationType {
  const moduleKey = moduleName.toLowerCase();
  if (moduleKey.includes("probation")) return "probation";
  if (moduleKey.includes("contract")) return "contract_renewal";
  if (moduleKey.includes("birthday")) return "birthday";
  if (moduleKey.includes("offer")) return "offer";
  if (moduleKey.includes("resignation")) return "resignation";
  if (moduleKey.includes("payroll")) return "general";
  if (moduleKey.includes("password_reset")) return "password_reset";
  if (moduleKey.includes("user_created") || moduleKey.includes("password_setup")) return "user_created";
  return "general";
}

function isSensitivePayroll(input: CreateSystemNotificationInput) {
  const moduleName = cleanText(input.module).toLowerCase();
  const eventType = cleanText(input.eventType).toLowerCase();
  return sensitivePayrollModules.has(moduleName) || eventType.includes("payslip") || input.metadata?.sensitivity === "payroll";
}

// Modules whose full content is sensitive enough that an EXPLICIT recipient (one the
// caller passed directly, bypassing governed recipient resolution) must be the data
// subject themselves — unless the trusted server caller explicitly opts in via
// metadata.authorizedRecipient. This closes the "explicit path skips governance" gap
// without breaking self-notifications (module "system") or governed sends.
const explicitSensitiveModules = new Set(["payroll", "payslip", "payslips", "deductions"]);

function explicitRecipientAllowed(input: CreateSystemNotificationInput): boolean {
  const moduleName = cleanText(input.module).toLowerCase();
  if (!explicitSensitiveModules.has(moduleName) && !isSensitivePayroll(input)) return true;
  if (input.metadata?.authorizedRecipient === true) return true;
  const recipientHr = cleanHrId(input.recipientHrId);
  const subjectHr = cleanHrId(input.subjectHrId);
  // Only allow sensitive content on the explicit path when it targets the subject.
  return Boolean(recipientHr && subjectHr && recipientHr === subjectHr);
}

function isCriticalWorkflow(input: CreateSystemNotificationInput) {
  if (input.priority === "critical" || input.priority === "high") return true;
  return criticalWorkflowModules.has(cleanText(input.module).toLowerCase());
}

function dedupeChannels(channels: SystemNotificationChannel[]) {
  return Array.from(new Set(channels));
}

function basePolicyChannels(input: CreateSystemNotificationInput, preferred: SystemNotificationChannel) {
  if (input.channels?.length) return dedupeChannels(input.channels);
  const policy = resolveNotificationPolicy(input);
  if (policy.channels.length > 0) {
    const channels = isSensitivePayroll(input) && !policy.telegramGenericOnly
      ? policy.channels.filter((channel) => channel !== "telegram")
      : policy.channels;
    return dedupeChannels(channels.length > 0 ? channels : ["in_app", preferred]);
  }

  if (isSensitivePayroll(input)) {
    return input.metadata?.telegramGenericAllowed === true
      ? ["in_app", "email", "telegram"] satisfies SystemNotificationChannel[]
      : ["in_app", "email"] satisfies SystemNotificationChannel[];
  }

  if (isCriticalWorkflow(input)) return ["in_app", "email", "telegram"] satisfies SystemNotificationChannel[];

  if (systemAnnouncementEvents.has(cleanText(input.eventType).toLowerCase())) {
    return input.metadata?.telegramOptional === true
      ? ["in_app", "email", "telegram"] satisfies SystemNotificationChannel[]
      : ["in_app", "email"] satisfies SystemNotificationChannel[];
  }

  return dedupeChannels(["in_app", preferred]);
}

function requestedChannelsForEnvelope(input: CreateSystemNotificationInput) {
  if (input.channels?.length) return dedupeChannels(input.channels);
  const policy = resolveNotificationPolicy(input);
  return dedupeChannels(policy.channels.length > 0 ? policy.channels : ["in_app", "email"]);
}

function shouldUseWorkflowEmailEnvelope(input: CreateSystemNotificationInput, recipients: NotificationRecipient[]) {
  if (recipients.length <= 1) return false;
  if (!requestedChannelsForEnvelope(input).includes("email")) return false;
  if (isSensitivePayroll(input)) return false;
  const moduleName = cleanText(input.module).toLowerCase();
  if (!workflowEmailEnvelopeModules.has(moduleName)) return false;
  return Boolean(
    cleanHrId(input.email?.employeeHrId) ||
    cleanHrId(input.subjectHrId) ||
    metadataHrId(input.metadata, ["employeeHrId", "subjectHrId", "requestOwnerHrId"]),
  );
}

function recipientKey(recipient: Pick<NotificationRecipient, "email" | "hrId" | "userId">) {
  return cleanText(recipient.userId ?? recipient.hrId ?? recipient.email ?? null).toLowerCase();
}

function deliverableAddresses(recipients: NotificationRecipient[]) {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const recipient of recipients) {
    const email = pickDeliverableEmail(recipient.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    output.push(email);
  }
  return output;
}

function emailDeliveryMetadata(
  identity: ReturnType<typeof validateNotificationEmailIdentity>,
  emailInput: NotificationEmailInput,
) {
  const envelope = {
    bcc: emailInput.bcc ?? [],
    cc: emailInput.cc ?? [],
    recipientHrId: emailInput.recipientHrId ?? null,
    to: emailInput.recipients ?? [],
  };
  return {
    emailEnvelope: envelope,
    emailIdentity: identity.metadata,
  };
}

function eventKeyFor(input: CreateSystemNotificationInput) {
  const metadataKey = typeof input.metadata?.idempotencyKey === "string" ? cleanText(input.metadata.idempotencyKey) : "";
  if (metadataKey) return metadataKey;

  return crypto
    .createHash("sha256")
    .update(JSON.stringify({
      actionUrl: input.actionUrl ?? null,
      eventType: input.eventType,
      module: input.module,
      recipientHrId: cleanHrId(input.recipientHrId),
      recipientUserId: cleanText(input.recipientUserId),
      title: input.title,
    }))
    .digest("hex");
}

async function loadRecipientProfile(input: CreateSystemNotificationInput): Promise<RecipientProfile> {
  const userId = cleanText(input.recipientUserId);
  const hrId = cleanHrId(input.recipientHrId);

  try {
    const supabase = getSupabaseAdmin();
    const query = supabase
      .from("app_auth_users")
      .select("login_id,hr_id,name,auth_email,role")
      .limit(1);
    const { data, error } = userId
      ? await query.ilike("login_id", userId).maybeSingle()
      : hrId
        ? await query.eq("hr_id", hrId).maybeSingle()
        : { data: null, error: null };

    if (error) throw error;
    const row = data as { auth_email?: string | null; hr_id?: string | null; login_id?: string | null; name?: string | null; role?: string | null } | null;
    const resolvedHrId = cleanHrId(row?.hr_id) || hrId || null;

    // app_auth_users.auth_email is the synthetic Supabase-auth login key
    // (phx-<hex>@auth.phoenix.local), never a real mailbox. The deliverable address lives on
    // employees.work_email. Resolve it; degrade to in-app only (null) when there is none.
    let workEmail: string | null = null;
    if (resolvedHrId) {
      try {
        const { data: employee } = await supabase
          .from("employees")
          .select("work_email")
          .eq("hr_id", resolvedHrId)
          .maybeSingle();
        workEmail = (employee as { work_email?: string | null } | null)?.work_email ?? null;
      } catch (employeeError) {
        if (!schemaMissing(employeeError, "employees")) {
          console.error("Notification recipient work email lookup failed", employeeError);
        }
      }
    }

    return {
      email: pickDeliverableEmail(workEmail, row?.auth_email),
      hrId: resolvedHrId,
      name: row?.name ?? null,
      role: row?.role ?? null,
      userId: row?.login_id ?? (userId || null),
    };
  } catch (error) {
    if (!schemaMissing(error, "app_auth_users")) {
      console.error("Notification recipient profile lookup failed", error);
    }
    return { email: null, hrId: hrId || null, name: null, role: null, userId: userId || null };
  }
}

/**
 * "Dr. " for managerial/professional roles; "" for Medical Rep, Employee, and Super
 * Admin. Also "" when the recipient's stored name already carries a "Dr" title, so the
 * "Dear {{honorific}}{{recipientName}}" greeting never doubles up into "Dear Dr. Dr Name".
 */
function managerHonorific(role: string | null, name: string | null): string {
  if (!role) return "";
  if (role === "Employee" || role === "Medical Rep" || role === "Super Admin") return "";
  if (/^dr\.?\s/i.test(cleanText(name))) return "";
  return "Dr. ";
}

async function loadPreferences(input: CreateSystemNotificationInput): Promise<LoadedPreferences> {
  const userId = cleanText(input.recipientUserId);
  const hrId = cleanHrId(input.recipientHrId);
  const defaults = {
    email_enabled: true,
    in_app_enabled: true,
    module_preferences: {} as Record<string, unknown>,
    preferred_channel: "email" as SystemNotificationChannel,
    quiet_hours_end: null,
    quiet_hours_start: null,
    telegram_enabled: false,
  };

  try {
    let query = getSupabaseAdmin()
      .from("notification_preferences")
      .select("email_enabled,in_app_enabled,telegram_enabled,preferred_channel,module_preferences,quiet_hours_start,quiet_hours_end")
      .limit(1);
    if (userId) query = query.ilike("user_id", userId);
    else if (hrId) query = query.eq("hr_id", hrId);
    else return defaults;

    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    const row = data as NotificationPreferenceRow | null;
    return {
      email_enabled: row?.email_enabled ?? defaults.email_enabled,
      in_app_enabled: row?.in_app_enabled ?? defaults.in_app_enabled,
      module_preferences: row?.module_preferences && typeof row.module_preferences === "object" && !Array.isArray(row.module_preferences)
        ? row.module_preferences
        : defaults.module_preferences,
      preferred_channel: row?.preferred_channel ?? defaults.preferred_channel,
      quiet_hours_end: row?.quiet_hours_end ?? defaults.quiet_hours_end,
      quiet_hours_start: row?.quiet_hours_start ?? defaults.quiet_hours_start,
      telegram_enabled: row?.telegram_enabled ?? defaults.telegram_enabled,
    };
  } catch (error) {
    if (!schemaMissing(error, "notification_preferences")) throw error;
    return defaults;
  }
}

async function loadTelegramConnection(input: CreateSystemNotificationInput) {
  const userId = cleanText(input.recipientUserId);
  const hrId = cleanHrId(input.recipientHrId);
  try {
    let query = getSupabaseAdmin()
      .from("telegram_connections")
      .select("telegram_chat_id,status")
      .order("created_at", { ascending: false })
      .limit(1);
    if (userId) query = query.ilike("user_id", userId);
    else if (hrId) query = query.eq("hr_id", hrId);
    else return null;

    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    return data as TelegramConnectionRow | null;
  } catch (error) {
    if (!schemaMissing(error, "telegram_connections")) throw error;
    return null;
  }
}

async function createNotificationEvent(input: CreateSystemNotificationInput, eventKey: string, recipient: RecipientProfile) {
  const now = new Date().toISOString();
  const category = categoryFor(input);
  const inAppContent = await renderChannelContent(input, "in_app");
  const metadata = {
    ...(input.metadata ?? {}),
    href: input.actionUrl ?? null,
    message: inAppContent.message,
    title: inAppContent.title,
  };
  const row = {
    action_url: input.actionUrl ?? null,
    actor_id: input.actorId ?? null,
    category,
    employee_hr_id: recipient.hrId,
    event_key: eventKey,
    event_type: input.eventType,
    metadata,
    module: input.module,
    priority: input.priority ?? "normal",
    recipient_user_id: recipient.userId,
    recipients: recipient.hrId ? [recipient.hrId] : [],
    scheduled_for: now.slice(0, 10),
    sent_at: now,
    status: "sent",
    subject: inAppContent.title,
    updated_at: now,
  };

  try {
    const { data, error } = await getSupabaseAdmin()
      .from("notification_events")
      .upsert(row, { onConflict: "event_key" })
      .select("id")
      .single();
    if (error) throw error;
    return String((data as { id?: string | number } | null)?.id ?? "");
  } catch (error) {
    if (!schemaMissing(error, "notification_events")) throw error;

    const { data, error: fallbackError } = await getSupabaseAdmin()
      .from("notification_events")
      .upsert({
        category,
        employee_hr_id: recipient.hrId,
        event_key: eventKey,
        metadata,
        recipients: recipient.hrId ? [recipient.hrId] : [],
        scheduled_for: now.slice(0, 10),
        sent_at: now,
        status: "sent",
        subject: inAppContent.title,
        updated_at: now,
      }, { onConflict: "event_key" })
      .select("id")
      .single();
    if (fallbackError) throw fallbackError;
    return String((data as { id?: string | number } | null)?.id ?? "");
  }
}

async function upsertDelivery(input: {
  channel: SystemNotificationChannel;
  eventId: string | null;
  idempotencyKey: string;
  lastError?: string | null;
  metadata?: Record<string, unknown>;
  nextAttemptAt?: string | null;
  provider?: string | null;
  providerMessageId?: string | null;
  recipient: RecipientProfile;
  recipientAddress?: string | null;
  status: SystemNotificationDeliveryResult["status"];
}) {
  if (!input.eventId) return;
  try {
    const now = new Date().toISOString();
    await getSupabaseAdmin()
      .from("notification_deliveries")
      .upsert({
        channel: input.channel,
        idempotency_key: input.idempotencyKey,
        last_error: input.lastError ?? null,
        metadata: input.metadata ?? {},
        next_attempt_at: input.nextAttemptAt ?? null,
        notification_event_id: input.eventId,
        provider: input.provider ?? input.channel,
        provider_message_id: input.providerMessageId ?? null,
        recipient_address: input.recipientAddress ?? null,
        recipient_hr_id: input.recipient.hrId,
        recipient_user_id: input.recipient.userId,
        sent_at: input.status === "sent" ? now : null,
        status: input.status,
        updated_at: now,
      }, { onConflict: "idempotency_key" });
  } catch (error) {
    if (!schemaMissing(error, "notification_deliveries")) {
      console.error("Notification delivery audit failed", error);
    }
  }
}

function isUniqueViolation(error: unknown) {
  const code = (error as { code?: string } | null)?.code;
  if (code === "23505") return true;
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return text.includes("duplicate key") || text.includes("unique constraint") || text.includes("already exists");
}

// Atomically claim an idempotency key by INSERTing a pending delivery row. The
// notification_deliveries_idempotency_uniq unique constraint makes this race-free: if
// two concurrent fan-out sends target the same key, exactly one INSERT lands a row and
// the other is ignored. This replaces the old read-then-write check (TOCTOU) so a key
// can never be double-sent. Returns whether THIS call claimed the key.
//
// The insert is conflict-tolerant at the DB level: idempotency_key is a simple
// (non-partial) unique, so ON CONFLICT DO NOTHING can target it directly via
// .upsert({ onConflict, ignoreDuplicates }). A duplicate is silently ignored by Postgres
// with NO 23505 ERROR logged — the previous plain INSERT logged one duplicate-key ERROR
// per re-fanned delivery, flooding the production logs and burying real errors.
async function claimDelivery(input: {
  channel: SystemNotificationChannel;
  eventId: string | null;
  idempotencyKey: string;
  recipient: RecipientProfile;
}): Promise<{ alreadySent: boolean; claimed: boolean }> {
  // No event row to anchor against (e.g. schema missing) — nothing durable to dedupe on.
  if (!input.eventId) return { alreadySent: false, claimed: true };
  const now = new Date().toISOString();
  try {
    // ON CONFLICT DO NOTHING returns the row only when THIS call inserted it, so a row
    // coming back means we won the race and own the claim.
    const { data, error } = await getSupabaseAdmin()
      .from("notification_deliveries")
      .upsert({
        channel: input.channel,
        idempotency_key: input.idempotencyKey,
        notification_event_id: input.eventId,
        provider: input.channel,
        recipient_hr_id: input.recipient.hrId,
        recipient_user_id: input.recipient.userId,
        status: "pending",
        updated_at: now,
      }, { ignoreDuplicates: true, onConflict: "idempotency_key" })
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (data) return { alreadySent: false, claimed: true };
    // No row returned → the key already existed and the insert was a no-op. Read the
    // existing status so the caller can report whether it was already sent or in progress.
    const existing = await getSupabaseAdmin()
      .from("notification_deliveries")
      .select("status")
      .eq("idempotency_key", input.idempotencyKey)
      .maybeSingle();
    return { alreadySent: (existing.data as { status?: string } | null)?.status === "sent", claimed: false };
  } catch (error) {
    // Defensive: ON CONFLICT DO NOTHING should no longer surface a unique violation, but
    // if one ever does, treat it as a lost race (not claimed) rather than a hard failure.
    if (isUniqueViolation(error)) return { alreadySent: false, claimed: false };
    if (schemaMissing(error, "notification_deliveries")) return { alreadySent: false, claimed: true };
    // Fail-open on unexpected errors so a legitimate notification isn't silently dropped.
    console.error("Notification delivery claim failed", error);
    return { alreadySent: false, claimed: true };
  }
}

function telegramMessageFor(input: CreateSystemNotificationInput) {
  if (isSensitivePayroll(input)) return GENERIC_PAYSLIP_MESSAGE;
  const moduleLabel = cleanText(input.module).replace(/_/g, " ");
  return [
    `Module: ${moduleLabel.charAt(0).toUpperCase()}${moduleLabel.slice(1)}`,
    input.message,
  ].filter(Boolean).join("\n");
}

function timeMinutes(value: string | null | undefined) {
  const match = String(value ?? "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function isWithinQuietHours(preferences: LoadedPreferences, now = new Date()) {
  const start = timeMinutes(preferences.quiet_hours_start);
  const end = timeMinutes(preferences.quiet_hours_end);
  if (start === null || end === null || start === end) return false;
  // Quiet hours are the user's LOCAL window. The server runs in UTC on Vercel, so
  // compare against Africa/Cairo wall-clock minutes, not the server clock.
  const current = currentCairoMinutesOfDay(now);
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function modulePreferenceDisabled(preferences: LoadedPreferences, input: CreateSystemNotificationInput, channel: SystemNotificationChannel) {
  const modulePrefs = preferences.module_preferences?.[input.module];
  if (!modulePrefs || typeof modulePrefs !== "object" || Array.isArray(modulePrefs)) return false;
  const value = (modulePrefs as Record<string, unknown>)[channel];
  return value === false;
}

async function renderChannelContent(input: CreateSystemNotificationInput, channel: SystemNotificationChannel) {
  return renderNotificationTemplate({
    actionUrl: input.actionUrl,
    channel,
    eventType: input.eventType,
    fallbackMessage: channel === "telegram" ? telegramMessageFor(input) : input.message,
    fallbackTitle: input.title,
    metadata: input.metadata,
    module: input.module,
  });
}

async function audit(summary: string, input: CreateSystemNotificationInput, eventId: string | null, values?: Record<string, unknown>) {
  await writeAuditLog({
    actorLoginId: input.actorId ?? "system",
    entityId: eventId ?? undefined,
    entityType: "notification",
    newValues: values ?? null,
    summary,
  });
}

async function createGovernanceSkippedNotification(
  input: CreateSystemNotificationInput,
  warnings: NotificationRecipientGovernanceWarning[],
): Promise<SystemNotificationResult> {
  const policy = resolveNotificationPolicy(input);
  const eventKey = eventKeyFor({
    ...input,
    metadata: {
      ...(input.metadata ?? {}),
      governanceSkip: true,
    },
  });
  const recipient: RecipientProfile = { email: null, hrId: null, name: null, role: null, userId: null };
  const eventId = await createNotificationEvent({
    ...input,
    metadata: {
      ...(input.metadata ?? {}),
      governance: {
        failClosed: true,
        warnings,
      },
    },
  }, eventKey, recipient);
  const warningPayload = {
    event: "notification_governance_fail_closed",
    eventId,
    eventType: input.eventType,
    module: input.module,
    recordId: input.recordId ?? null,
    warnings,
  };
  console.warn(JSON.stringify(warningPayload));
  await audit("notification governance fail-closed", input, eventId, warningPayload);

  const channels = dedupeChannels(policy.channels.length > 0 ? policy.channels : ["in_app", "email"]);
  const deliveries: SystemNotificationDeliveryResult[] = [];
  for (const channel of channels) {
    const idempotencyKey = `${eventKey}:${channel}:governance-skip`;
    await upsertDelivery({
      channel,
      eventId,
      idempotencyKey,
      lastError: "Notification skipped because no exact authorized recipient was resolved.",
      metadata: { governance: warningPayload },
      recipient,
      status: "skipped",
    });
    deliveries.push({
      channel,
      idempotencyKey,
      reason: "Notification skipped because no exact authorized recipient was resolved.",
      status: "skipped",
    });
  }

  return { deliveries, eventId, eventKey };
}

function telegramRetryDelayMinutes(attempt: number) {
  const delays = [5, 15, 60, 240];
  return delays[Math.min(Math.max(attempt - 1, 0), delays.length - 1)];
}

function nextTelegramRetryAt(attempt: number) {
  // ±20% jitter so a provider outage with many queued messages doesn't create a
  // thundering herd that all retry at the same instant.
  const base = telegramRetryDelayMinutes(attempt);
  const jittered = base * (0.8 + Math.random() * 0.4);
  const next = new Date();
  next.setMinutes(next.getMinutes() + Math.max(1, Math.round(jittered)));
  return next.toISOString();
}

/**
 * Drain quiet-hours-deferred EMAIL deliveries from notification_deliveries. These rows
 * are written `pending` when a recipient is inside their quiet-hours window; before this
 * existed, only telegram had a drainer, so deferred email was silently lost. Each row
 * carries metadata.emailInput (the exact payload). We re-dispatch via the email outbox
 * (idempotent on dedupe_key) and re-defer while the recipient is still in quiet hours.
 * (in_app is never deferred — line `channel !== "in_app"` — so this only handles email.)
 */
export async function processDeferredDeliveryRetries(limit = 10) {
  const nowIso = new Date().toISOString();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("notification_deliveries")
    .select("id,metadata,recipient_hr_id,recipient_user_id")
    .eq("channel", "email")
    .eq("status", "pending")
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
    .order("created_at", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 50)));

  if (error) {
    if (schemaMissing(error, "notification_deliveries")) return { attempted: 0, deferred: 0, sent: 0, skipped: 0 };
    throw error;
  }

  let attempted = 0;
  let sent = 0;
  let skipped = 0;
  let deferred = 0;

  for (const row of (data ?? []) as Array<{
    id: string;
    metadata?: Record<string, unknown> | null;
    recipient_hr_id?: string | null;
    recipient_user_id?: string | null;
  }>) {
    const storedEmailInput = row.metadata?.emailInput as NotificationEmailInput | undefined;
    const emailInput = storedEmailInput
      ? { ...storedEmailInput, recipientHrId: storedEmailInput.recipientHrId ?? row.recipient_hr_id ?? null }
      : undefined;
    if (!emailInput) {
      // No stored payload (legacy deferred row) — close it terminally so it never loops.
      await supabase
        .from("notification_deliveries")
        .update({ last_error: "Deferred email had no stored payload to re-dispatch.", next_attempt_at: null, status: "skipped", updated_at: new Date().toISOString() })
        .eq("id", row.id);
      console.log("Deferred email delivery had no stored payload", {
        level: "warning",
        tags: { component: "email", cron: "deferred-drain" },
        extra: { id: row.id },
      });
      skipped += 1;
      continue;
    }

    // Respect quiet hours: if the recipient is still inside their window, re-defer +1h.
    const preferences = await loadPreferences({
      eventType: "deferred_email",
      message: "",
      module: "system",
      recipientHrId: row.recipient_hr_id ?? null,
      recipientUserId: row.recipient_user_id ?? null,
      title: "",
    });
    if (isWithinQuietHours(preferences)) {
      await supabase
        .from("notification_deliveries")
        .update({ next_attempt_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), updated_at: new Date().toISOString() })
        .eq("id", row.id);
      deferred += 1;
      continue;
    }

    attempted += 1;
    const identity = validateNotificationEmailIdentity(emailInput);
    if (!identity.ok) {
      await supabase
        .from("notification_deliveries")
        .update({
          last_error: identity.reason,
          metadata: { ...(row.metadata ?? {}), emailIdentity: identity.metadata },
          next_attempt_at: null,
          status: "skipped",
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      console.log("Deferred email delivery blocked by identity guard", {
        level: "error",
        tags: { component: "email", cron: "deferred-drain" },
        extra: { id: row.id, ...identity.metadata },
      });
      skipped += 1;
      continue;
    }
    const result = await safeSendNotificationEmail(emailInput);
    if (!result.skipped) {
      await supabase
        .from("notification_deliveries")
        .update({ last_error: null, next_attempt_at: null, provider_message_id: result.id ?? null, sent_at: new Date().toISOString(), status: "sent", updated_at: new Date().toISOString() })
        .eq("id", row.id);
      sent += 1;
    } else if (result.reason.startsWith("Queued for retry:")) {
      // Handed off to the email outbox, which now owns retry + delivery (it tracks the
      // real outcome and emits its own terminal-failure alert). Mark this row done.
      await supabase
        .from("notification_deliveries")
        .update({ last_error: null, metadata: { ...(row.metadata ?? {}), handedOffToOutbox: true }, next_attempt_at: null, sent_at: new Date().toISOString(), status: "sent", updated_at: new Date().toISOString() })
        .eq("id", row.id);
      sent += 1;
    } else {
      // Deterministic skip (policy disabled, no recipients, …) — will not send.
      await supabase
        .from("notification_deliveries")
        .update({ last_error: result.reason, next_attempt_at: null, status: "skipped", updated_at: new Date().toISOString() })
        .eq("id", row.id);
      skipped += 1;
    }
  }

  return { attempted, deferred, sent, skipped };
}

export async function processTelegramDeliveryRetries(limit = 10) {
  const now = new Date().toISOString();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("notification_deliveries")
    .select("id,attempts,max_attempts,metadata,status,provider_message_id,recipient_hr_id,recipient_user_id")
    .eq("channel", "telegram")
    .in("status", ["failed", "pending", "retrying"])
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${now}`)
    .order("created_at", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 50)));

  if (error) {
    if (schemaMissing(error, "notification_deliveries")) return { attempted: 0, failed: 0, sent: 0 };
    throw error;
  }

  let attempted = 0;
  let failed = 0;
  let sent = 0;

  for (const row of (data ?? []) as Array<{ attempts?: number | null; id: string; max_attempts?: number | null; metadata?: Record<string, unknown> | null; recipient_hr_id?: string | null; recipient_user_id?: string | null }>) {
    const attempts = Number(row.attempts ?? 0);
    const maxAttempts = Number(row.max_attempts ?? 5);
    if (attempts >= maxAttempts) continue;
    const telegram = row.metadata?.telegram as Partial<TelegramRetryPayload> | undefined;
    if (!telegram?.chatId || !telegram?.title || !telegram?.message) continue;

    const recipientContext = {
      eventType: telegram.eventType ?? "telegram_retry",
      message: String(telegram.message),
      module: telegram.module ?? "system",
      recipientHrId: row.recipient_hr_id ?? null,
      recipientUserId: row.recipient_user_id ?? null,
      title: String(telegram.title),
    };

    attempted += 1;
    try {
      const governance = await resolveTelegramGovernance({
        eventType: telegram.eventType ?? null,
        module: telegram.module ?? "system",
      });
      if (!governance.enabled) {
        await supabase
          .from("notification_deliveries")
          .update({
            attempts,
            last_error: governance.reason ?? "Telegram is not allowed by current policy.",
            next_attempt_at: null,
            status: "skipped",
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        continue;
      }

      // Re-check user preference + live connection (mirrors retryTelegramDeliveryById):
      // a user who disabled Telegram or disconnected after the failure must not receive
      // the retry, and we send to the CURRENT chat id, never a stale one from metadata.
      const preferences = await loadPreferences(recipientContext);
      if (!preferences.telegram_enabled) {
        await supabase
          .from("notification_deliveries")
          .update({ attempts, last_error: "Telegram disabled by user preference.", next_attempt_at: null, status: "skipped", updated_at: new Date().toISOString() })
          .eq("id", row.id);
        continue;
      }
      const connection = await loadTelegramConnection(recipientContext);
      if (connection?.status !== "connected" || !connection.telegram_chat_id) {
        await supabase
          .from("notification_deliveries")
          .update({ attempts, last_error: "Telegram is not connected.", next_attempt_at: null, status: "skipped", updated_at: new Date().toISOString() })
          .eq("id", row.id);
        continue;
      }

      const result = await sendTelegramNotification({
        actionUrl: telegram.actionUrl ?? null,
        buttons: governance.genericOnly ? null : telegram.buttons ?? null,
        chatId: String(connection.telegram_chat_id),
        ctaLabel: governance.genericOnly ? null : telegram.ctaLabel ?? null,
        ctaUrl: governance.genericOnly ? null : telegram.ctaUrl ?? null,
        message: governance.genericOnly ? GENERIC_PAYSLIP_MESSAGE : String(telegram.message),
        title: governance.genericOnly ? GENERIC_NOTIFICATION_TITLE : String(telegram.title),
      });
      if (result.skipped) throw new Error(result.reason);
      await supabase
        .from("notification_deliveries")
        .update({
          attempts: attempts + 1,
          last_error: null,
          next_attempt_at: null,
          provider_message_id: result.providerMessageId ?? null,
          sent_at: new Date().toISOString(),
          status: "sent",
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      sent += 1;
    } catch (retryError) {
      const nextAttempts = attempts + 1;
      const terminal = nextAttempts >= maxAttempts;
      await supabase
        .from("notification_deliveries")
        .update({
          attempts: nextAttempts,
          last_error: retryError instanceof Error ? retryError.message : "Telegram retry failed.",
          next_attempt_at: terminal ? null : nextTelegramRetryAt(nextAttempts),
          status: terminal ? "failed" : "retrying",
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      if (terminal) {
        await triggerTelegramRetryExhaustionFallback({
          deliveryId: row.id,
          recipientHrId: row.recipient_hr_id ?? null,
          recipientUserId: row.recipient_user_id ?? null,
          telegram,
        });
      }
      failed += 1;
    }
  }

  return { attempted, failed, sent };
}

export async function retryTelegramDeliveryById(id: string): Promise<SystemNotificationDeliveryResult> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("notification_deliveries")
    .select("id,attempts,channel,idempotency_key,max_attempts,metadata,recipient_hr_id,recipient_user_id,status")
    .eq("id", id)
    .eq("channel", "telegram")
    .maybeSingle();
  if (error) throw error;
  const row = data as {
    attempts?: number | null;
    id: string;
    idempotency_key?: string | null;
    max_attempts?: number | null;
    metadata?: Record<string, unknown> | null;
    recipient_hr_id?: string | null;
    recipient_user_id?: string | null;
    status?: string | null;
  } | null;
  const idempotencyKey = row?.idempotency_key ?? `telegram-retry:${id}`;
  if (!row) return { channel: "telegram", idempotencyKey, reason: "Delivery was not found.", status: "skipped" };
  if (row.status === "sent") return { channel: "telegram", idempotencyKey, reason: "Delivery already sent.", status: "skipped" };

  const telegram = row.metadata?.telegram as Partial<TelegramRetryPayload> | undefined;
  if (!telegram?.title || !telegram?.message) {
    return { channel: "telegram", idempotencyKey, reason: "Delivery does not contain a retry-safe Telegram payload.", status: "skipped" };
  }

  const governance = await resolveTelegramGovernance({
    eventType: telegram.eventType ?? null,
    module: telegram.module ?? "system",
  });
  if (!governance.enabled) {
    await supabase
      .from("notification_deliveries")
      .update({
        last_error: governance.reason ?? "Telegram is not allowed by current policy.",
        next_attempt_at: null,
        status: "skipped",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    return { channel: "telegram", idempotencyKey, reason: governance.reason, status: "skipped" };
  }

  const preferences = await loadPreferences({
    eventType: telegram.eventType ?? "telegram_retry",
    message: String(telegram.message),
    module: telegram.module ?? "system",
    recipientHrId: row.recipient_hr_id ?? null,
    recipientUserId: row.recipient_user_id ?? null,
    title: String(telegram.title),
  });
  if (!preferences.telegram_enabled) {
    await supabase
      .from("notification_deliveries")
      .update({
        last_error: "Telegram disabled by user preference.",
        next_attempt_at: null,
        status: "skipped",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    return { channel: "telegram", idempotencyKey, reason: "Telegram disabled by user preference.", status: "skipped" };
  }

  const connection = await loadTelegramConnection({
    eventType: telegram.eventType ?? "telegram_retry",
    message: String(telegram.message),
    module: telegram.module ?? "system",
    recipientHrId: row.recipient_hr_id ?? null,
    recipientUserId: row.recipient_user_id ?? null,
    title: String(telegram.title),
  });
  if (connection?.status !== "connected" || !connection.telegram_chat_id) {
    await supabase
      .from("notification_deliveries")
      .update({
        last_error: "Telegram is not connected.",
        next_attempt_at: null,
        status: "skipped",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    return { channel: "telegram", idempotencyKey, reason: "Telegram is not connected.", status: "skipped" };
  }

  const attempts = Number(row.attempts ?? 0);
  const maxAttempts = Number(row.max_attempts ?? 5);
  if (attempts >= maxAttempts) return { channel: "telegram", idempotencyKey, reason: "Maximum retry attempts reached.", status: "skipped" };

  try {
      const result = await sendTelegramNotification({
        actionUrl: telegram.actionUrl ?? null,
        buttons: governance.genericOnly ? null : telegram.buttons ?? null,
        chatId: String(connection.telegram_chat_id),
        ctaLabel: governance.genericOnly ? null : telegram.ctaLabel ?? null,
        ctaUrl: governance.genericOnly ? null : telegram.ctaUrl ?? null,
      message: governance.genericOnly ? GENERIC_PAYSLIP_MESSAGE : String(telegram.message),
      title: governance.genericOnly ? GENERIC_NOTIFICATION_TITLE : String(telegram.title),
    });
    if (result.skipped) throw new Error(result.reason);
    await supabase
      .from("notification_deliveries")
      .update({
        attempts: attempts + 1,
        last_error: null,
        next_attempt_at: null,
        provider_message_id: result.providerMessageId ?? null,
        sent_at: new Date().toISOString(),
        status: "sent",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    return { channel: "telegram", idempotencyKey, status: "sent" };
  } catch (retryError) {
    const nextAttempts = attempts + 1;
    const terminal = nextAttempts >= maxAttempts;
    const message = retryError instanceof Error ? retryError.message : "Telegram retry failed.";
    await supabase
      .from("notification_deliveries")
      .update({
        attempts: nextAttempts,
        last_error: message,
        next_attempt_at: terminal ? null : nextTelegramRetryAt(nextAttempts),
        status: terminal ? "failed" : "retrying",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (terminal) {
      await triggerTelegramRetryExhaustionFallback({
        deliveryId: row.id,
        recipientHrId: row.recipient_hr_id ?? null,
        recipientUserId: row.recipient_user_id ?? null,
        telegram,
      });
    }
    return { channel: "telegram", error: message, idempotencyKey, status: terminal ? "failed" : "retrying" };
  }
}

type TelegramRetryPayload = {
  actionUrl?: string | null;
  buttons?: Array<{ label: string; url: string }> | null;
  chatId: string;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  emailAttempted?: boolean;
  eventType?: string | null;
  message: string;
  module?: string | null;
  title: string;
};

// Shared logger for best-effort/fire-and-forget notification sends that must never
// throw into their caller. Console + Sentry so a swallowed failure still leaves a trace.
export function logNotificationSendFailure(context: string, error: unknown) {
  console.error(`[notifications] ${context} failed`, error);
  console.error(error, { tags: { component: "notifications", context } });
}

// Email/in-app fallback for a Telegram delivery that has exhausted its retries (cron
// worker or manual retry). Only fires when email wasn't already attempted in the
// original send, so a recipient is never double-emailed. Best-effort.
async function triggerTelegramRetryExhaustionFallback(input: {
  deliveryId: string;
  recipientHrId: string | null;
  recipientUserId: string | null;
  telegram: Partial<TelegramRetryPayload>;
}) {
  if (input.telegram.emailAttempted) return;
  if (!input.recipientHrId && !input.recipientUserId) return;
  try {
    await createSystemNotification({
      actionUrl: input.telegram.actionUrl ?? null,
      channels: ["email", "in_app"],
      eventType: input.telegram.eventType ?? "telegram_retry",
      message: String(input.telegram.message ?? ""),
      metadata: { fallbackFrom: "telegram_exhausted", idempotencyKey: `telegram-exhausted-fallback:${input.deliveryId}` },
      module: input.telegram.module ?? "system",
      recipientHrId: input.recipientHrId,
      recipientUserId: input.recipientUserId,
      title: String(input.telegram.title ?? "Phoenix notification"),
    });
  } catch (error) {
    logNotificationSendFailure("system.telegramRetryExhaustionFallback", error);
  }
}

/**
 * Build the email NotificationEmailInput for a single recipient. Extracted so the
 * quiet-hours deferral can persist the EXACT payload (metadata.emailInput) and the
 * deferred-delivery drain can re-dispatch it later without reconstructing context.
 */
async function buildChannelEmailInput(
  input: CreateSystemNotificationInput,
  recipient: RecipientProfile,
  resolvedPriority: string,
): Promise<NotificationEmailInput> {
  const ctaHref = notificationHrefForViewerRole({
    fallbackHref: input.actionUrl ?? input.email?.ctaHref ?? null,
    metadata: input.metadata,
    role: recipient.role,
  });
  const emailContent = await renderChannelContent({ ...input, actionUrl: ctaHref || input.actionUrl }, "email");
  const identity = resolvedEmailIdentity(input, recipient);
  return {
    bcc: input.email?.bcc,
    candidateEmail: input.email?.candidateEmail ?? null,
    cc: input.email?.cc,
    ctaHref,
    ctaLabel: input.email?.ctaLabel ?? "Open in Phoenix",
    employeeHrId: identity.employeeHrId,
    includeHrInbox: input.email?.includeHrInbox,
    identityError: identity.error,
    identityGuard: identity.guard,
    identityStatus: identity.status,
    metrics: input.email?.metrics,
    module: input.module,
    notificationType: input.email?.notificationType ?? notificationTypeFor(input.module),
    planTableHtml: input.email?.planTableHtml,
    planTableText: input.email?.planTableText,
    templateContext: input.email?.templateContext,
    // The notification recipient's own name, so templated greetings address the person
    // receiving the email rather than the employee the notification is about.
    recipientHonorific: managerHonorific(recipient.role, recipient.name),
    recipientName: input.email?.recipientName ?? recipient.name ?? undefined,
    recipientHrId: recipient.hrId ?? undefined,
    recipients: input.email?.recipients ?? (recipient.email ? [recipient.email] : undefined),
    recipientMode: input.email?.recipientMode ?? (recipient.email ? "candidate" : undefined),
    subject: input.email?.subject ?? emailContent.title,
    summary: input.email?.summary ?? emailContent.message,
    // Lets a domain pin the exact /admin/email-templates key that frames this event.
    subjectHrIdSource: identity.source,
    templateKey: input.email?.templateKey,
    title: input.email?.title ?? emailContent.title,
    tone: input.email?.tone ?? (resolvedPriority === "critical" ? "danger" : "neutral"),
  };
}

/**
 * Build the telegram retry payload for a quiet-hours-deferred telegram delivery, so the
 * existing processTelegramDeliveryRetries worker (which requires metadata.telegram with
 * chatId/title/message) can drain it after quiet hours. Returns null when telegram is
 * not deliverable for this recipient (disabled/not connected) — i.e. nothing to defer.
 */
async function buildDeferredTelegramPayload(
  input: CreateSystemNotificationInput,
  recipient: RecipientProfile,
  preferences: LoadedPreferences,
  emailAttempted: boolean,
): Promise<TelegramRetryPayload | null> {
  const governance = await resolveTelegramGovernance({ eventType: input.eventType, module: input.module });
  if (!governance.enabled || !preferences.telegram_enabled) return null;
  const connection = await loadTelegramConnection({ ...input, recipientHrId: recipient.hrId, recipientUserId: recipient.userId });
  if (connection?.status !== "connected" || !connection.telegram_chat_id) return null;
  const content = await renderChannelContent(input, "telegram");
  const generic = isSensitivePayroll(input) || governance.genericOnly;
  return {
    actionUrl: input.actionUrl ?? null,
    buttons: generic ? null : input.telegram?.buttons ?? content.buttons ?? null,
    chatId: String(connection.telegram_chat_id),
    ctaLabel: generic ? null : input.telegram?.ctaLabel ?? content.ctaLabel ?? null,
    ctaUrl: generic ? null : input.telegram?.ctaUrl ?? content.ctaUrl ?? null,
    emailAttempted,
    eventType: input.eventType,
    message: generic ? GENERIC_PAYSLIP_MESSAGE : content.message,
    module: input.module,
    title: generic ? GENERIC_NOTIFICATION_TITLE : content.title,
  };
}

async function createSystemNotificationForRecipient(input: CreateSystemNotificationInput): Promise<SystemNotificationResult> {
  const eventKey = eventKeyFor(input);
  const policy = resolveNotificationPolicy(input);
  const recipient = await loadRecipientProfile(input);
  const preferences = await loadPreferences({ ...input, recipientHrId: recipient.hrId, recipientUserId: recipient.userId });
  const eventId = await createNotificationEvent(input, eventKey, recipient);
  await audit("notification created", input, eventId, {
    channelPolicy: "unified",
    eventType: input.eventType,
    module: input.module,
    priority: input.priority ?? "normal",
  });

  const channels = basePolicyChannels({ ...input, priority: input.priority ?? policy.priority }, preferences.preferred_channel);
  const deliveries: SystemNotificationDeliveryResult[] = [];
  let emailAttempted = false;
  const quietHoursActive = isWithinQuietHours(preferences);

  for (const channel of channels) {
    const idempotencyKey = `${eventKey}:${channel}:${recipient.userId ?? recipient.hrId ?? "unknown"}`;
    const claim = await claimDelivery({ channel, eventId, idempotencyKey, recipient });
    if (!claim.claimed) {
      deliveries.push({ channel, idempotencyKey, reason: claim.alreadySent ? "Delivery already sent." : "Delivery already in progress.", status: "skipped" });
      continue;
    }

    if (modulePreferenceDisabled(preferences, input, channel)) {
      await upsertDelivery({ channel, eventId, idempotencyKey, lastError: "Channel disabled by module preference.", recipient, status: "skipped" });
      deliveries.push({ channel, idempotencyKey, reason: "Channel disabled by module preference.", status: "skipped" });
      continue;
    }

    if (quietHoursActive && !policy.bypassQuietHours && channel !== "in_app") {
      // Persist the channel payload so the deferred-delivery drain (email) and the
      // telegram retry worker (telegram) can re-dispatch this row after quiet hours.
      // Previously a deferred row was written `pending` with no payload and NEVER
      // drained — the notification was silently lost.
      const deferredMetadata: Record<string, unknown> = { quietHours: true };
      if (channel === "email" && preferences.email_enabled) {
        const emailInput = await buildChannelEmailInput(input, recipient, input.priority ?? policy.priority);
        const identity = validateNotificationEmailIdentity(emailInput);
        Object.assign(deferredMetadata, emailDeliveryMetadata(identity, emailInput));
        if (!identity.ok) {
          await upsertDelivery({
            channel,
            eventId,
            idempotencyKey,
            lastError: identity.reason,
            metadata: deferredMetadata,
            recipient,
            status: "skipped",
          });
          await audit("delivery skipped", input, eventId, { channel, emailIdentity: identity.metadata, error: identity.reason, reason: "email_identity_guard" });
          deliveries.push({ channel, idempotencyKey, reason: identity.reason, status: "skipped" });
          continue;
        }
        deferredMetadata.emailInput = emailInput;
      } else if (channel === "email") {
        // Email is disabled for this recipient — skip immediately rather than writing a
        // payload-less pending row that the deferred-drain cron can never re-dispatch.
        // Set emailAttempted so downstream Telegram fallback logic treats email as handled.
        emailAttempted = true;
        await upsertDelivery({ channel, eventId, idempotencyKey, lastError: "Email disabled by preference.", recipient, status: "skipped" });
        deliveries.push({ channel, idempotencyKey, reason: "Email notifications are disabled for this user.", status: "skipped" });
        continue;
      }
      if (channel === "telegram") {
        // Mirror the live branch: a broken saved template must degrade to a skipped
        // delivery, never reject the whole notification after the domain DB write.
        try {
          const telegramPayload = await buildDeferredTelegramPayload(input, recipient, preferences, emailAttempted);
          if (telegramPayload) {
            deferredMetadata.telegram = telegramPayload;
            deferredMetadata.retry = true;
          }
        } catch (error) {
          if (!(error instanceof TelegramTemplateError)) throw error;
          const message = error.message;
          await upsertDelivery({ channel, eventId, idempotencyKey, lastError: message, metadata: { skippedBy: "telegram_template_governance", templateErrorCode: error.code }, recipient, status: "skipped" });
          await audit("delivery skipped", input, eventId, { channel, error: message, reason: "telegram_template_governance" });
          deliveries.push({ channel, idempotencyKey, reason: message, status: "skipped" });
          continue;
        }
      }
      await upsertDelivery({
        channel,
        eventId,
        idempotencyKey,
        lastError: "Deferred by quiet hours.",
        metadata: deferredMetadata,
        nextAttemptAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        recipient,
        status: "pending",
      });
      deliveries.push({ channel, idempotencyKey, reason: "Deferred by quiet hours.", status: "pending" });
      continue;
    }

    if (channel === "in_app") {
      const status = preferences.in_app_enabled ? "sent" : "skipped";
      const reason = preferences.in_app_enabled ? undefined : "In-app notifications are disabled for this user.";
      await upsertDelivery({ channel, eventId, idempotencyKey, recipient, status });
      deliveries.push({ channel, idempotencyKey, reason, status });
      continue;
    }

    if (channel === "email") {
      emailAttempted = true;
      if (!preferences.email_enabled) {
        await upsertDelivery({ channel, eventId, idempotencyKey, lastError: "Email disabled by preference.", recipient, status: "skipped" });
        deliveries.push({ channel, idempotencyKey, reason: "Email notifications are disabled for this user.", status: "skipped" });
        continue;
      }

      const emailInput = await buildChannelEmailInput(input, recipient, input.priority ?? policy.priority);
      const identity = validateNotificationEmailIdentity(emailInput);
      if (!identity.ok) {
        await upsertDelivery({
          channel,
          eventId,
          idempotencyKey,
          lastError: identity.reason,
          metadata: emailDeliveryMetadata(identity, emailInput),
          provider: "email",
          recipient,
          recipientAddress: recipient.email,
          status: "skipped",
        });
        await audit("delivery skipped", input, eventId, { channel, emailIdentity: identity.metadata, error: identity.reason, reason: "email_identity_guard" });
        deliveries.push({ channel, idempotencyKey, reason: identity.reason, status: "skipped" });
        continue;
      }
      const result = await safeSendNotificationEmail(emailInput);
      // "skipped" here bundles genuine policy/guard skips together with a handoff to the
      // outbox for retry — mirror processDeferredDeliveryRetries' handling of the exact
      // same union (system.ts, "Deterministic skip (policy disabled, no recipients, …)"
      // vs. "handed off to outbox... mark this row done"): a retry handoff is delegated
      // delivery, not a failure, so it counts as sent; everything else is a deterministic
      // skip, never a "failed" (there is no send attempt to have failed here).
      const handedOffToOutbox = result.skipped && result.reason.startsWith("Queued for retry:");
      const status = !result.skipped || handedOffToOutbox ? "sent" : "skipped";
      const error = result.skipped && !handedOffToOutbox ? result.reason : undefined;
      await upsertDelivery({
        channel,
        eventId,
        idempotencyKey,
        lastError: error ?? null,
        metadata: emailDeliveryMetadata(identity, emailInput),
        provider: "email",
        providerMessageId: result.skipped ? null : result.id,
        recipient,
        recipientAddress: recipient.email,
        status,
      });
      await audit(status === "sent" ? "delivery sent" : "delivery skipped", input, eventId, { channel, error });
      deliveries.push({ channel, error, idempotencyKey, status });
      continue;
    }

    if (channel === "telegram") {
      const telegramGovernance = await resolveTelegramGovernance({
        eventType: input.eventType,
        module: input.module,
      });
      if (!telegramGovernance.enabled) {
        await upsertDelivery({
          channel,
          eventId,
          idempotencyKey,
          lastError: telegramGovernance.reason ?? "Telegram is not allowed by current policy.",
          metadata: {
            globalEnabled: telegramGovernance.globalEnabled,
            modulePolicy: telegramGovernance.modulePolicy,
          },
          recipient,
          status: "skipped",
        });
        deliveries.push({
          channel,
          idempotencyKey,
          reason: telegramGovernance.reason ?? "Telegram is not allowed by current policy.",
          status: "skipped",
        });
        continue;
      }

      if (!preferences.telegram_enabled) {
        await upsertDelivery({ channel, eventId, idempotencyKey, lastError: "Telegram disabled by preference.", recipient, status: "skipped" });
        deliveries.push({ channel, idempotencyKey, reason: "Telegram notifications are disabled for this user.", status: "skipped" });
        continue;
      }

      const connection = await loadTelegramConnection({ ...input, recipientHrId: recipient.hrId, recipientUserId: recipient.userId });
      if (connection?.status !== "connected" || !connection.telegram_chat_id) {
        await upsertDelivery({ channel, eventId, idempotencyKey, lastError: "Telegram is not connected.", recipient, status: "skipped" });
        deliveries.push({ channel, idempotencyKey, reason: "Telegram is not connected.", status: "skipped" });
        continue;
      }

      let telegramContent: Awaited<ReturnType<typeof renderChannelContent>> | null = null;
      try {
        telegramContent = await renderChannelContent(input, "telegram");
        const genericTelegram = isSensitivePayroll(input) || telegramGovernance.genericOnly;
        const result = await sendTelegramNotification({
          actionUrl: input.actionUrl ?? null,
          buttons: genericTelegram ? null : input.telegram?.buttons ?? telegramContent.buttons ?? null,
          chatId: String(connection.telegram_chat_id),
          ctaLabel: genericTelegram ? null : input.telegram?.ctaLabel ?? telegramContent.ctaLabel ?? null,
          ctaUrl: genericTelegram ? null : input.telegram?.ctaUrl ?? telegramContent.ctaUrl ?? null,
          message: genericTelegram ? GENERIC_PAYSLIP_MESSAGE : telegramContent.message,
          title: genericTelegram ? GENERIC_NOTIFICATION_TITLE : telegramContent.title,
        });
        const status = result.skipped ? "skipped" : "sent";
        const reason = result.skipped ? result.reason : undefined;
        await upsertDelivery({
          channel,
          eventId,
          idempotencyKey,
          lastError: reason ?? null,
          provider: "telegram",
          providerMessageId: result.skipped ? null : result.providerMessageId,
          recipient,
          recipientAddress: String(connection.telegram_chat_id),
          status,
        });
        await audit(status === "sent" ? "delivery sent" : "test notification sent/skipped", input, eventId, { channel, reason });
        deliveries.push({ channel, idempotencyKey, reason, status });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Telegram delivery failed.";
        if (error instanceof TelegramTemplateError) {
          await upsertDelivery({
            channel,
            eventId,
            idempotencyKey,
            lastError: message,
            metadata: { skippedBy: "telegram_template_governance", templateErrorCode: error.code },
            provider: "telegram",
            recipient,
            recipientAddress: String(connection.telegram_chat_id),
            status: "skipped",
          });
          await audit("delivery skipped", input, eventId, { channel, error: message, reason: "telegram_template_governance" });
          deliveries.push({ channel, idempotencyKey, reason: message, status: "skipped" });
          continue;
        }
        await upsertDelivery({
          channel,
          eventId,
          idempotencyKey,
          lastError: message,
          metadata: {
            fallback: "email_or_in_app",
            retry: true,
            telegram: {
              actionUrl: input.actionUrl ?? null,
              buttons: input.telegram?.buttons ?? telegramContent?.buttons ?? null,
              chatId: String(connection.telegram_chat_id),
              ctaLabel: input.telegram?.ctaLabel ?? telegramContent?.ctaLabel ?? null,
              ctaUrl: input.telegram?.ctaUrl ?? telegramContent?.ctaUrl ?? null,
              // Whether email was already attempted in the original send, so the retry
              // worker's exhaustion-fallback doesn't double-email this recipient.
              emailAttempted,
              eventType: input.eventType,
              message: isSensitivePayroll(input) || telegramGovernance.genericOnly ? GENERIC_PAYSLIP_MESSAGE : telegramContent?.message ?? telegramMessageFor(input),
              module: input.module,
              title: isSensitivePayroll(input) || telegramGovernance.genericOnly ? GENERIC_NOTIFICATION_TITLE : telegramContent?.title ?? input.title,
            },
          },
          provider: "telegram",
          recipient,
          recipientAddress: String(connection.telegram_chat_id),
          nextAttemptAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          status: "failed",
        });
        await audit("delivery failed", input, eventId, { channel, error: message, fallback: "email_or_in_app" });
        deliveries.push({ channel, error: message, idempotencyKey, status: "failed" });

        if (!emailAttempted && preferences.email_enabled) {
          const fallback = await createSystemNotification({
            ...input,
            channels: ["email", "in_app"],
            metadata: { ...(input.metadata ?? {}), fallbackFrom: "telegram", idempotencyKey: `${eventKey}:telegram-fallback` },
          });
          deliveries.push(...fallback.deliveries);
        }
      }
    }
  }

  return { deliveries, eventId, eventKey };
}

async function createWorkflowEmailEnvelopeNotification(
  input: CreateSystemNotificationInput,
  recipients: NotificationRecipient[],
  baseIdempotencyKey: string,
): Promise<SystemNotificationResult | null> {
  if (recipients.length === 0) return null;

  // Prefer the first recipient who actually has a deliverable email as "primary" — a
  // synthetic account (e.g. PHX-1, which has no work_email) landing first in the list
  // must not silently swallow the whole envelope email, cc'd real addresses included.
  const primaryIndex = Math.max(0, recipients.findIndex((recipient) => Boolean(pickDeliverableEmail(recipient.email))));
  const primary = recipients[primaryIndex];

  const ccRecipients = recipients.filter((_, index) => index !== primaryIndex);
  const primaryEmail = pickDeliverableEmail(primary.email);
  const cc = deliverableAddresses(ccRecipients);
  const primaryKey = recipientKey(primary);

  return createSystemNotificationForRecipient({
    ...input,
    channels: ["email"],
    email: {
      ...(input.email ?? {}),
      cc,
      recipients: primaryEmail ? [primaryEmail] : input.email?.recipients,
    },
    metadata: {
      ...(input.metadata ?? {}),
      emailEnvelope: {
        ccRecipientHrIds: ccRecipients.map((recipient) => recipient.hrId ?? null).filter(Boolean),
        primaryRecipientHrId: primary.hrId ?? null,
        routing: "primary_to_cc",
      },
      ...(baseIdempotencyKey ? { idempotencyKey: `${baseIdempotencyKey}:email-envelope:${primaryKey || "primary"}` } : {}),
    },
    recipientHrId: primary.hrId ?? null,
    recipientUserId: primary.userId ?? null,
  });
}

export async function createSystemNotification(input: CreateSystemNotificationInput): Promise<SystemNotificationResult> {
  const explicitRecipient = cleanText(input.recipientUserId) || cleanHrId(input.recipientHrId);
  if (explicitRecipient) {
    // Fail-closed: a sensitive module targeting a non-subject explicit recipient is
    // skipped (and audited) instead of leaking full content — use the governed path.
    if (!explicitRecipientAllowed(input)) {
      return createGovernanceSkippedNotification(input, []);
    }
    return createSystemNotificationForRecipient(input);
  }

  const resolution = await resolveNotificationRecipientsWithGovernance({
    actorId: input.actorId,
    eventType: input.eventType,
    metadata: input.metadata,
    module: input.module,
    recordId: input.recordId,
    subjectHrId: input.subjectHrId,
  });
  const recipients = resolution.recipients;

  if (recipients.length === 0) return createGovernanceSkippedNotification(input, resolution.warnings);

  const baseIdempotencyKey = typeof input.metadata?.idempotencyKey === "string" ? cleanText(input.metadata.idempotencyKey) : "";
  const useEmailEnvelope = shouldUseWorkflowEmailEnvelope(input, recipients);
  const nonEmailChannels = requestedChannelsForEnvelope(input).filter((channel) => channel !== "email");
  const results = await Promise.all(
    recipients.flatMap((recipient) => {
      if (useEmailEnvelope && nonEmailChannels.length === 0) return [];
      return [
        createSystemNotificationForRecipient({
          ...input,
          ...(useEmailEnvelope ? { channels: nonEmailChannels } : {}),
          metadata: {
            ...(input.metadata ?? {}),
            ...(baseIdempotencyKey ? { idempotencyKey: `${baseIdempotencyKey}:${recipient.userId ?? recipient.hrId ?? recipient.email}` } : {}),
          },
          recipientHrId: recipient.hrId ?? null,
          recipientUserId: recipient.userId ?? null,
        }),
      ];
    }),
  );
  if (useEmailEnvelope) {
    const emailEnvelope = await createWorkflowEmailEnvelopeNotification(input, recipients, baseIdempotencyKey);
    if (emailEnvelope) results.push(emailEnvelope);
  }

  return {
    deliveries: results.flatMap((result) => result.deliveries),
    eventId: results[0]?.eventId ?? null,
    eventKey: results[0]?.eventKey ?? "",
  };
}
