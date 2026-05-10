import crypto from "crypto";

import { getSupabaseAdmin } from "@/lib/supabase/server";

export const emailNotificationTypes = [
  "probation",
  "contract_renewal",
  "birthday",
  "offer",
  "resignation",
] as const;

export const emailRecipientModes = [
  "hr_notifications",
  "employee",
  "direct_manager",
  "manager_manager",
  "manager_chain",
  "employee_and_direct_manager",
  "candidate",
] as const;

export type EmailNotificationType = (typeof emailNotificationTypes)[number];
export type EmailRecipientMode = (typeof emailRecipientModes)[number];

type NotificationMetric = {
  label: string;
  value: string | number;
};

export type NotificationEmailInput = {
  candidateEmail?: string | null;
  ctaHref?: string;
  ctaLabel?: string;
  employeeHrId?: string | null;
  metrics?: NotificationMetric[];
  notificationType?: EmailNotificationType;
  recipients?: string[];
  recipientMode?: EmailRecipientMode;
  includeHrInbox?: boolean;
  subject: string;
  summary: string;
  title: string;
  tone?: "success" | "warning" | "danger" | "neutral";
};

type SendEmailResult =
  | { id?: string; skipped?: false }
  | { reason: string; skipped: true };

type NotificationOutboxRow = {
  attempts: number;
  created_at: string;
  dedupe_key: string;
  id: string;
  last_error: string | null;
  locked_at: string | null;
  max_attempts: number;
  next_attempt_at: string | null;
  payload: NotificationEmailInput;
  provider_message_id: string | null;
  sent_at: string | null;
  status: "pending" | "processing" | "sent" | "failed";
  updated_at: string;
};

type NotificationOutboxProcessResult = {
  attempted: number;
  failed: number;
  processedIds: string[];
  sent: number;
};

const resendEndpoint = "https://api.resend.com/emails";
const emailNotificationPolicyTable = "email_notification_policies";
const notificationOutboxTable = "notification_outbox";
const notificationOutboxMaxAttempts = 5;
const notificationOutboxBatchSize = 10;

export type EmailNotificationPolicy = {
  description: string;
  enabled: boolean;
  includeHrInbox: boolean;
  label: string;
  recipientMode: EmailRecipientMode;
  type: EmailNotificationType;
};

type EmailNotificationPolicyRow = {
  description: string | null;
  enabled: boolean | null;
  include_hr_inbox?: boolean | null;
  include_hr_notifications?: boolean | null;
  label: string | null;
  notification_type: EmailNotificationType;
  recipient_mode: EmailRecipientMode | null;
};

type EmailContactRow = {
  full_name: string | null;
  hr_id: string;
  manager_hr_id: string | null;
  work_email: string | null;
};

type NotificationDelivery =
  | { policy: EmailNotificationPolicy; recipients: string[]; skipped: false }
  | { reason: string; skipped: true };

export const defaultEmailNotificationPolicies: EmailNotificationPolicy[] = [
  {
    description: "Probation review alerts routed through the reporting hierarchy.",
    enabled: true,
    includeHrInbox: true,
    label: "Probation",
    recipientMode: "direct_manager",
    type: "probation",
  },
  {
    description: "Contract renewal workflow alerts routed to the manager chain.",
    enabled: true,
    includeHrInbox: true,
    label: "Contract renewal",
    recipientMode: "manager_chain",
    type: "contract_renewal",
  },
  {
    description: "Birthday reminders for employee care and people operations.",
    enabled: true,
    includeHrInbox: false,
    label: "Birthdays",
    recipientMode: "direct_manager",
    type: "birthday",
  },
  {
    description: "Offer lifecycle communication for candidates and HR follow-up.",
    enabled: true,
    includeHrInbox: false,
    label: "Offers",
    recipientMode: "candidate",
    type: "offer",
  },
  {
    description: "Resignation workflow alerts routed to the reporting chain.",
    enabled: true,
    includeHrInbox: true,
    label: "Resignations",
    recipientMode: "manager_chain",
    type: "resignation",
  },
];

function envFlag(value: string | undefined) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

function recipientsFromEnv() {
  return String(process.env.HR_NOTIFICATION_EMAILS ?? "")
    .split(/[;,]/)
    .map((email) => email.trim())
    .filter(Boolean);
}

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function cleanEmailList(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(
      values
        .flatMap((value) => String(value ?? "").split(/[;,]/))
        .map((email) => email.trim().toLowerCase())
        .filter((email) => email && validEmail(email)),
    ),
  );
}

function defaultPolicyForType(type: EmailNotificationType) {
  return defaultEmailNotificationPolicies.find((policy) => policy.type === type);
}

function isEmailNotificationType(value: unknown): value is EmailNotificationType {
  return emailNotificationTypes.includes(value as EmailNotificationType);
}

function isEmailRecipientMode(value: unknown): value is EmailRecipientMode {
  return emailRecipientModes.includes(value as EmailRecipientMode);
}

function mapPolicyRow(row: EmailNotificationPolicyRow): EmailNotificationPolicy {
  const fallback = defaultPolicyForType(row.notification_type);

  return {
    description: row.description ?? fallback?.description ?? "",
    enabled: row.enabled ?? fallback?.enabled ?? true,
    includeHrInbox: row.include_hr_inbox ?? row.include_hr_notifications ?? fallback?.includeHrInbox ?? false,
    label: row.label ?? fallback?.label ?? row.notification_type.replace(/_/g, " "),
    recipientMode: isEmailRecipientMode(row.recipient_mode) ? row.recipient_mode : fallback?.recipientMode ?? "hr_notifications",
    type: row.notification_type,
  };
}

function notificationPolicySchemaMissing(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes(emailNotificationPolicyTable) ||
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

export async function getEmailNotificationPolicies(): Promise<EmailNotificationPolicy[]> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from(emailNotificationPolicyTable)
      .select("notification_type,label,description,enabled,recipient_mode,include_hr_inbox")
      .order("notification_type", { ascending: true });

    if (error) throw error;

    const rowsByType = new Map(
      ((data ?? []) as EmailNotificationPolicyRow[])
        .filter((row) => isEmailNotificationType(row.notification_type))
        .map((row) => [row.notification_type, mapPolicyRow(row)]),
    );

    return defaultEmailNotificationPolicies.map((policy) => rowsByType.get(policy.type) ?? policy);
  } catch (error) {
    if (notificationPolicySchemaMissing(error)) {
      return defaultEmailNotificationPolicies;
    }
    throw error;
  }
}

async function getEmailNotificationPolicy(type: EmailNotificationType) {
  const policies = await getEmailNotificationPolicies();
  return policies.find((policy) => policy.type === type) ?? defaultPolicyForType(type);
}

export async function saveEmailNotificationPolicy(
  type: EmailNotificationType,
  input: {
    enabled: boolean;
    includeHrInbox: boolean;
    recipientMode: EmailRecipientMode;
  },
  actor?: string | null,
) {
  const fallback = defaultPolicyForType(type);
  if (!fallback) throw new Error("Unsupported email notification type.");

  const policy: EmailNotificationPolicy = {
    ...fallback,
    enabled: input.enabled,
    includeHrInbox: input.includeHrInbox,
    recipientMode: input.recipientMode,
  };
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from(emailNotificationPolicyTable)
    .upsert(
      {
        description: policy.description,
        enabled: policy.enabled,
        include_hr_inbox: policy.includeHrInbox,
        label: policy.label,
        notification_type: policy.type,
        recipient_mode: policy.recipientMode,
        updated_at: new Date().toISOString(),
        updated_by: actor ?? null,
      },
      { onConflict: "notification_type" },
    );

  if (error) throw error;
  return policy;
}

async function loadEmployeeContact(hrId: string | null | undefined) {
  const cleanHrId = String(hrId ?? "").trim().toUpperCase();
  if (!cleanHrId) return null;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employees")
    .select("hr_id,full_name,work_email,manager_hr_id")
    .eq("hr_id", cleanHrId)
    .maybeSingle();

  if (error) throw error;
  return (data as EmailContactRow | null) ?? null;
}

async function loadManagerChain(employeeHrId: string | null | undefined, maxDepth = 4) {
  const contacts: EmailContactRow[] = [];
  const visited = new Set<string>();
  let current = await loadEmployeeContact(employeeHrId);

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const managerHrId = current?.manager_hr_id?.trim().toUpperCase();
    if (!managerHrId || visited.has(managerHrId)) break;
    visited.add(managerHrId);
    const manager = await loadEmployeeContact(managerHrId);
    if (!manager) break;
    contacts.push(manager);
    current = manager;
  }

  return contacts;
}

async function resolveRecipientsForMode(mode: EmailRecipientMode, input: NotificationEmailInput) {
  if (mode === "hr_notifications") {
    return recipientsFromEnv();
  }

  if (mode === "candidate") {
    return cleanEmailList([input.candidateEmail, ...(input.recipients ?? [])]);
  }

  const employee = await loadEmployeeContact(input.employeeHrId);
  const managers = await loadManagerChain(input.employeeHrId);

  if (mode === "employee") return cleanEmailList([employee?.work_email]);
  if (mode === "direct_manager") return cleanEmailList([managers[0]?.work_email]);
  if (mode === "manager_manager") return cleanEmailList([managers[1]?.work_email]);
  if (mode === "manager_chain") return cleanEmailList(managers.map((manager) => manager.work_email));
  if (mode === "employee_and_direct_manager") return cleanEmailList([employee?.work_email, managers[0]?.work_email]);

  return [];
}

export async function resolveNotificationDelivery(input: NotificationEmailInput): Promise<NotificationDelivery> {
  if (!input.notificationType || !isEmailNotificationType(input.notificationType)) {
    return {
      reason: "Email skipped: notification type is not approved for automatic Resend delivery.",
      skipped: true,
    };
  }

  const storedPolicy = await getEmailNotificationPolicy(input.notificationType);
  if (!storedPolicy) {
    return { reason: "Email skipped: unsupported notification type.", skipped: true };
  }

  const policy = {
    ...storedPolicy,
    includeHrInbox: input.includeHrInbox ?? storedPolicy.includeHrInbox,
    recipientMode: input.recipientMode ?? storedPolicy.recipientMode,
  };

  if (!policy.enabled) {
    return { reason: `Email skipped: ${policy.label} notifications are disabled.`, skipped: true };
  }

  const policyRecipients = await resolveRecipientsForMode(policy.recipientMode, input);
  const hrRecipients = policy.includeHrInbox ? recipientsFromEnv() : [];
  const recipients = cleanEmailList([...policyRecipients, ...hrRecipients]);

  if (recipients.length === 0) {
    return { reason: `Email skipped: ${policy.label} routing resolved no recipient emails.`, skipped: true };
  }

  return { policy, recipients, skipped: false };
}

function dashboardUrl(path = "/") {
  const base = String(process.env.NOTIFICATION_DASHBOARD_URL ?? "").replace(/\/+$/, "");
  if (!base) return path;
  if (/^https?:\/\//.test(path)) return path;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function escapeHtml(value: string | number) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toneColor(tone: NotificationEmailInput["tone"]) {
  if (tone === "success") return "#16a34a";
  if (tone === "warning") return "#f97316";
  if (tone === "danger") return "#ef4444";
  return "#0f172a";
}

function renderText(input: NotificationEmailInput) {
  const lines = [
    input.title,
    "",
    input.summary,
    "",
    ...(input.metrics ?? []).map((metric) => `${metric.label}: ${metric.value}`),
  ];

  if (input.ctaHref) {
    lines.push("", `${input.ctaLabel ?? "Open dashboard"}: ${dashboardUrl(input.ctaHref)}`);
  }

  return lines.join("\n");
}

function renderHtml(input: NotificationEmailInput) {
  const color = toneColor(input.tone);
  const metrics = (input.metrics ?? [])
    .map(
      (metric) => `
        <tr>
          <td style="padding:10px 0;color:#64748b;font-size:13px">${escapeHtml(metric.label)}</td>
          <td style="padding:10px 0;color:#0f172a;font-size:14px;font-weight:700;text-align:right">${escapeHtml(metric.value)}</td>
        </tr>`,
    )
    .join("");
  const cta = input.ctaHref
    ? `<a href="${escapeHtml(dashboardUrl(input.ctaHref))}" style="display:inline-block;margin-top:22px;border:1px solid #fed7aa;border-radius:12px;background:#fff7ed;color:#ea580c;font-weight:700;text-decoration:none;padding:12px 18px">${escapeHtml(input.ctaLabel ?? "Open dashboard")}</a>`
    : "";

  return `
    <div style="margin:0;background:#f8fafc;padding:28px;font-family:Inter,Arial,sans-serif;color:#0f172a">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:20px;box-shadow:0 18px 46px rgba(15,23,42,0.08);overflow:hidden">
        <div style="padding:24px 28px;border-bottom:1px solid #f1f5f9">
          <div style="font-size:11px;letter-spacing:0.24em;font-weight:800;color:#ea580c;text-transform:uppercase">Phoenix Workforce</div>
          <h1 style="margin:12px 0 0;font-size:22px;line-height:1.25;color:#0f172a">${escapeHtml(input.title)}</h1>
        </div>
        <div style="padding:24px 28px">
          <div style="height:4px;width:72px;border-radius:999px;background:${color};box-shadow:0 0 18px ${color}66"></div>
          <p style="margin:18px 0 18px;color:#334155;font-size:15px;line-height:1.7">${escapeHtml(input.summary)}</p>
          ${
            metrics
              ? `<table style="width:100%;border-collapse:collapse;border-top:1px solid #f1f5f9;border-bottom:1px solid #f1f5f9">${metrics}</table>`
              : ""
          }
          ${cta}
        </div>
        <div style="padding:16px 28px;background:#f8fafc;color:#94a3b8;font-size:12px">
          Automated notification from Phoenix Workforce.
        </div>
      </div>
    </div>`;
}

export function buildEmailNotificationPreview(type: EmailNotificationType) {
  const samples: Record<EmailNotificationType, NotificationEmailInput> = {
    birthday: {
      ctaHref: "/hr-calendar",
      ctaLabel: "Open HR calendar",
      employeeHrId: "B-001",
      metrics: [
        { label: "Employee", value: "Mariam Nabil" },
        { label: "Birthday", value: "Today" },
        { label: "Routing", value: "Direct manager" },
      ],
      notificationType: "birthday",
      subject: "Phoenix Birthday Reminder - Mariam Nabil",
      summary: "Birthday reminder for Mariam Nabil. Prepare a timely people-care follow-up.",
      title: "Birthday Reminder",
      tone: "neutral",
    },
    contract_renewal: {
      ctaHref: "/contracts",
      ctaLabel: "Open contract renewals",
      employeeHrId: "B-001",
      metrics: [
        { label: "Employee", value: "Mariam Nabil (B-001)" },
        { label: "Status", value: "manager review" },
        { label: "Renewal date", value: "2026-06-15" },
      ],
      notificationType: "contract_renewal",
      subject: "Phoenix Contract Renewal Updated - Mariam Nabil",
      summary: "Contract renewal workflow for Mariam Nabil is now manager review.",
      title: "Contract Renewal Updated",
      tone: "warning",
    },
    offer: {
      candidateEmail: "candidate@example.com",
      ctaHref: "/offers",
      ctaLabel: "Open offers",
      metrics: [
        { label: "Candidate", value: "Youssef Ahmed" },
        { label: "Role", value: "Medical Representative" },
        { label: "Offer ID", value: "OFF-2026-001" },
      ],
      notificationType: "offer",
      subject: "Phoenix Offer Lifecycle Updated - Youssef Ahmed",
      summary: "Offer workflow for Youssef Ahmed requires HR follow-up.",
      title: "Offer Lifecycle Updated",
      tone: "success",
    },
    probation: {
      ctaHref: "/probation",
      ctaLabel: "Open probation tracker",
      employeeHrId: "B-001",
      metrics: [
        { label: "Employee", value: "Mariam Nabil (B-001)" },
        { label: "Status", value: "manager feedback" },
        { label: "Decision", value: "Pending" },
      ],
      notificationType: "probation",
      subject: "Phoenix Probation Workflow Updated - Mariam Nabil",
      summary: "Probation workflow for Mariam Nabil is now manager feedback.",
      title: "Probation Workflow Updated",
      tone: "warning",
    },
    resignation: {
      ctaHref: "/resignations",
      ctaLabel: "Open resignations",
      employeeHrId: "B-001",
      metrics: [
        { label: "Employee", value: "Mariam Nabil (B-001)" },
        { label: "Status", value: "under review" },
        { label: "Effective date", value: "2026-06-30" },
      ],
      notificationType: "resignation",
      subject: "Phoenix Resignation Workflow Updated - Mariam Nabil",
      summary: "Resignation workflow for Mariam Nabil is now under review.",
      title: "Resignation Workflow Updated",
      tone: "danger",
    },
  };
  const input = samples[type];

  return {
    html: renderHtml(input),
    plainText: renderText(input),
    subject: input.subject,
  };
}

export async function getEmailNotificationOutboxStats() {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from(notificationOutboxTable)
      .select("status,payload,created_at")
      .order("created_at", { ascending: false })
      .limit(500);

    if (error) throw error;

    const rows = (data ?? []) as Array<{
      created_at: string;
      payload: Partial<NotificationEmailInput> | null;
      status: NotificationOutboxRow["status"];
    }>;
    const allowed = new Set<EmailNotificationType>(emailNotificationTypes);

    return {
      failed: rows.filter((row) => row.status === "failed").length,
      lastSentAt: rows.find((row) => row.status === "sent")?.created_at ?? null,
      pending: rows.filter((row) => row.status === "pending").length,
      recentAllowed: rows.filter((row) => allowed.has(row.payload?.notificationType as EmailNotificationType)).length,
      recentTotal: rows.length,
      sent: rows.filter((row) => row.status === "sent").length,
    };
  } catch (error) {
    if (notificationSchemaMissing(error)) {
      return {
        failed: 0,
        lastSentAt: null,
        pending: 0,
        recentAllowed: 0,
        recentTotal: 0,
        sent: 0,
      };
    }
    throw error;
  }
}

export function emailNotificationsEnabled() {
  return envFlag(process.env.EMAIL_NOTIFICATIONS_ENABLED);
}

function notificationSchemaMissing(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes(notificationOutboxTable) ||
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

function normalizeNotificationPayload(input: NotificationEmailInput) {
  return {
    candidateEmail: input.candidateEmail?.trim().toLowerCase() ?? null,
    ctaHref: input.ctaHref ?? null,
    ctaLabel: input.ctaLabel ?? null,
    employeeHrId: input.employeeHrId?.trim().toUpperCase() ?? null,
    includeHrInbox: input.includeHrInbox ?? null,
    metrics: (input.metrics ?? []).map((metric) => ({
      label: metric.label,
      value: String(metric.value),
    })),
    notificationType: input.notificationType ?? null,
    recipients: input.recipients?.map((recipient) => recipient.trim().toLowerCase()).sort() ?? null,
    recipientMode: input.recipientMode ?? null,
    subject: input.subject,
    summary: input.summary,
    title: input.title,
    tone: input.tone ?? "neutral",
  };
}

function notificationDedupeKey(input: NotificationEmailInput) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(normalizeNotificationPayload(input)))
    .digest("hex");
}

function retryDelayMinutes(attemptNumber: number) {
  const delays = [5, 15, 60, 240];
  return delays[Math.min(Math.max(attemptNumber - 1, 0), delays.length - 1)];
}

function nextAttemptAtIso(attemptNumber: number) {
  const next = new Date();
  next.setMinutes(next.getMinutes() + retryDelayMinutes(attemptNumber));
  return next.toISOString();
}

async function sendNotificationEmailDirect(input: NotificationEmailInput): Promise<SendEmailResult> {
  if (!emailNotificationsEnabled()) {
    return { reason: "EMAIL_NOTIFICATIONS_ENABLED is not true.", skipped: true };
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFICATION_EMAIL_FROM;
  const delivery = await resolveNotificationDelivery(input);

  if (!apiKey) return { reason: "RESEND_API_KEY is missing.", skipped: true };
  if (!from) return { reason: "NOTIFICATION_EMAIL_FROM is missing.", skipped: true };
  if (delivery.skipped) return delivery;

  const requestId = notificationDedupeKey(input);
  const response = await fetch(resendEndpoint, {
    body: JSON.stringify({
      from,
      html: renderHtml(input),
      replyTo: process.env.NOTIFICATION_REPLY_TO || undefined,
      subject: input.subject,
      text: renderText(input),
      to: delivery.recipients,
    }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": requestId,
    },
    method: "POST",
  });

  const payload = (await response.json().catch(() => null)) as { error?: string; id?: string; message?: string } | null;

  if (!response.ok) {
    throw new Error(payload?.message ?? payload?.error ?? `Resend request failed with ${response.status}.`);
  }

  if (!payload?.id) {
    throw new Error("Resend accepted the request without returning a message id.");
  }

  return { id: payload.id, skipped: false };
}

export async function sendNotificationEmail(input: NotificationEmailInput): Promise<SendEmailResult> {
  return sendNotificationEmailDirect(input);
}

async function getNotificationOutboxRowByDedupeKey(dedupeKey: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(notificationOutboxTable)
    .select("*")
    .eq("dedupe_key", dedupeKey)
    .maybeSingle();

  if (error) throw error;
  return (data as NotificationOutboxRow | null) ?? null;
}

async function enqueueNotificationEmail(input: NotificationEmailInput) {
  const dedupeKey = notificationDedupeKey(input);
  const existing = await getNotificationOutboxRowByDedupeKey(dedupeKey);
  if (existing) return existing;

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from(notificationOutboxTable)
    .insert({
      attempts: 0,
      dedupe_key: dedupeKey,
      max_attempts: notificationOutboxMaxAttempts,
      next_attempt_at: now,
      payload: input,
      status: "pending",
      updated_at: now,
    })
    .select("*")
    .single();

  if (error) {
    const fallback = await getNotificationOutboxRowByDedupeKey(dedupeKey);
    if (fallback) return fallback;
    throw error;
  }

  return data as NotificationOutboxRow;
}

async function claimNotificationOutboxRow(id: string) {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from(notificationOutboxTable)
    .update({
      locked_at: now,
      status: "processing",
      updated_at: now,
    })
    .eq("id", id)
    .in("status", ["pending", "failed"])
    .select("*")
    .maybeSingle();

  if (error) throw error;
  return (data as NotificationOutboxRow | null) ?? null;
}

async function markNotificationOutboxSent(row: NotificationOutboxRow, providerMessageId?: string) {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  await supabase
    .from(notificationOutboxTable)
    .update({
      attempts: row.attempts + 1,
      last_error: null,
      locked_at: null,
      next_attempt_at: null,
      provider_message_id: providerMessageId ?? null,
      sent_at: now,
      status: "sent",
      updated_at: now,
    })
    .eq("id", row.id);
}

async function markNotificationOutboxFailed(row: NotificationOutboxRow, errorMessage: string) {
  const supabase = getSupabaseAdmin();
  const attempts = row.attempts + 1;
  const terminal = attempts >= row.max_attempts;
  const now = new Date().toISOString();
  await supabase
    .from(notificationOutboxTable)
    .update({
      attempts,
      last_error: errorMessage,
      locked_at: null,
      next_attempt_at: terminal ? null : nextAttemptAtIso(attempts),
      status: "failed",
      updated_at: now,
    })
    .eq("id", row.id);
}

async function loadDueNotificationOutboxRows(limit: number) {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from(notificationOutboxTable)
    .select("*")
    .in("status", ["pending", "failed"])
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${now}`)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw error;
  return ((data ?? []) as NotificationOutboxRow[]).filter((row) => row.attempts < row.max_attempts);
}

async function processNotificationOutboxRow(row: NotificationOutboxRow): Promise<SendEmailResult> {
  const claimed = await claimNotificationOutboxRow(row.id);
  if (!claimed) {
    return { reason: "Notification is already being processed.", skipped: true };
  }

  try {
    const result = await sendNotificationEmailDirect(claimed.payload);
    if (result.skipped) {
      await markNotificationOutboxFailed(claimed, result.reason);
      return result;
    }

    await markNotificationOutboxSent(claimed, result.id);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Email notification failed.";
    await markNotificationOutboxFailed(claimed, message);
    return { reason: message, skipped: true };
  }
}

export async function processNotificationOutbox(limit = notificationOutboxBatchSize): Promise<NotificationOutboxProcessResult> {
  const rows = await loadDueNotificationOutboxRows(limit);
  const processedIds: string[] = [];
  let attempted = 0;
  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    attempted += 1;
    const result = await processNotificationOutboxRow(row);
    processedIds.push(row.id);
    if (result.skipped) {
      failed += 1;
    } else {
      sent += 1;
    }
  }

  return { attempted, failed, processedIds, sent };
}

export async function safeSendNotificationEmail(input: NotificationEmailInput) {
  try {
    const delivery = await resolveNotificationDelivery(input);
    if (delivery.skipped) {
      return delivery;
    }

    const queued = await enqueueNotificationEmail(input);
    if (queued.status === "sent") {
      return { id: queued.provider_message_id ?? queued.id, skipped: false } satisfies SendEmailResult;
    }

    const result = await processNotificationOutboxRow(queued);
    if (result.skipped) {
      return {
        reason: `Queued for retry: ${result.reason}`,
        skipped: true,
      } satisfies SendEmailResult;
    }

    return result;
  } catch (error) {
    if (notificationSchemaMissing(error)) {
      return sendNotificationEmailDirect(input);
    }
    console.error("Email notification failed", error);
    return {
      reason: error instanceof Error ? error.message : "Email notification failed.",
      skipped: true,
    } satisfies SendEmailResult;
  }
}
