import crypto from "crypto";

import * as Sentry from "@sentry/nextjs";

import {
  renderGeneralNotificationEmailHtml,
  renderGeneralNotificationEmailText,
} from "@/emails/general-notification";
import {
  systemAuthEmailText,
  systemEmail,
  systemIdentity,
  systemNotificationEmailText,
} from "@/config/system-settings";
import { EMAIL_TEMPLATE_KEYS, normalizeEmailTemplateKey, sendTemplatedEmail } from "@/lib/email-templates/service";
import { RetryableEmailError, sendPhoenixEmail } from "@/lib/email/send-phoenix-email";
import { createUnsubscribeToken } from "@/lib/email/unsubscribe-token";
import { summarizeNotificationOutboxRows } from "@/lib/communication/metrics";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const emailNotificationTypes = [
  "probation",
  "contract_renewal",
  "birthday",
  "offer",
  "resignation",
  "password_reset",
  "user_created",
  "general",
] as const;

export const emailRecipientModes = [
  "hr_notifications",
  "employee",
  "direct_manager",
  "manager_manager",
  "manager_chain",
  "employee_and_direct_manager",
  "candidate",
  "same_line_selected_titles",
  "selected_titles_all_lines",
  "selected_titles_selected_lines",
] as const;

export type EmailNotificationType = (typeof emailNotificationTypes)[number];
export type EmailRecipientMode = (typeof emailRecipientModes)[number];
export type NotificationEmailIdentityGuard = "none" | "self" | "subject_required";
export type NotificationEmailIdentitySource =
  | "email.employeeHrId"
  | "metadata.employeeHrId"
  | "metadata.requestOwnerHrId"
  | "metadata.subjectHrId"
  | "metrics.Employee"
  | "recipient.self"
  | "subjectHrId";
export type NotificationEmailIdentityStatus = "failed" | "not_required" | "verified";

type NotificationMetric = {
  label: string;
  value: string | number;
};

export type NotificationEmailInput = {
  bcc?: string[];
  candidateEmail?: string | null;
  cc?: string[];
  ctaHref?: string;
  ctaLabel?: string;
  employeeHrId?: string | null;
  identityError?: string | null;
  identityGuard?: NotificationEmailIdentityGuard;
  identityStatus?: NotificationEmailIdentityStatus;
  metrics?: NotificationMetric[];
  /** Originating module (e.g. "weekly_plans") so module-scoped templates can be selected. */
  module?: string | null;
  /**
   * Explicit /admin/email-templates key for this send. Takes precedence over the
   * module/type mapping; invalid keys are ignored (the mapping then applies), so a
   * stale key can never silently drop an email.
   */
  templateKey?: string | null;
  notificationType?: EmailNotificationType;
  /** Pre-rendered HTML table of submitted plan rows for the {{planTable}} variable. */
  planTableHtml?: string;
  /** Plain-text projection of planTableHtml for the text part of the email. */
  planTableText?: string;
  /**
   * Name of the person actually RECEIVING this email (for "Dear {{recipientName}},").
   * Without it the hub falls back to the subject employee's name - wrong for emails
   * routed to a manager/CEO/HR about someone else's record.
   */
  recipientName?: string;
  recipientHrId?: string | null;
  recipients?: string[];
  recipientMode?: EmailRecipientMode;
  subjectHrIdSource?: NotificationEmailIdentitySource | null;
  includeHrInbox?: boolean;
  subject: string;
  summary: string;
  title: string;
  tone?: "success" | "warning" | "danger" | "neutral";
};

type EmailTemplateContent = {
  bodyText: string;
  closingText: string;
  greeting: string;
  previewText: string;
  subject: string;
  title: string;
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
  status: "pending" | "processing" | "sent" | "failed" | "skipped";
  updated_at: string;
};

type NotificationOutboxProcessResult = {
  attempted: number;
  failed: number;
  processedIds: string[];
  sent: number;
  skipped: number;
};

const emailNotificationPolicyTable = "email_notification_policies";
const notificationOutboxTable = "notification_outbox";
const notificationOutboxMaxAttempts = 5;
const notificationOutboxBatchSize = 10;

export type EmailNotificationPolicy = {
  description: string;
  enabled: boolean;
  includeHrInbox: boolean;
  label: string;
  recipientModes: EmailRecipientMode[];
  recipientMode: EmailRecipientMode;
  targetLines: string[];
  targetTitles: string[];
  template: EmailTemplateContent;
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
  recipient_modes?: EmailRecipientMode[] | null;
  target_lines?: string[] | null;
  target_titles?: string[] | null;
  template_body_text?: string | null;
  template_closing_text?: string | null;
  template_greeting?: string | null;
  template_preview_text?: string | null;
  template_subject?: string | null;
  template_title?: string | null;
};

type EmailContactRow = {
  full_name?: string | null;
  hr_id?: string;
  job_title?: string | null;
  line_name?: string | null;
  lines?: { name: string | null } | Array<{ name: string | null }> | null;
  manager_hr_id?: string | null;
  work_email?: string | null;
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
    recipientModes: ["direct_manager"],
    recipientMode: "direct_manager",
    targetLines: [],
    targetTitles: [],
    template: {
      bodyText: "{summary}",
      closingText: "Please review and take the required action.",
      greeting: systemNotificationEmailText.teamGreeting,
      previewText: "Probation review update from Phoenix Workforce.",
      subject: "{subject}",
      title: "{title}",
    },
    type: "probation",
  },
  {
    description: "Contract renewal workflow alerts routed to the manager chain.",
    enabled: true,
    includeHrInbox: true,
    label: "Contract renewal",
    recipientModes: ["manager_chain"],
    recipientMode: "manager_chain",
    targetLines: [],
    targetTitles: [],
    template: {
      bodyText: "{summary}",
      closingText: "Please review the renewal status and proceed with the required action.",
      greeting: systemNotificationEmailText.teamGreeting,
      previewText: "Contract renewal workflow update from Phoenix Workforce.",
      subject: "{subject}",
      title: "{title}",
    },
    type: "contract_renewal",
  },
  {
    description: "Birthday wishes routed to the employee.",
    enabled: true,
    includeHrInbox: false,
    label: "Birthdays",
    recipientModes: ["employee"],
    recipientMode: "employee",
    targetLines: [],
    targetTitles: [],
    template: {
      bodyText: "On behalf of Sato Pharma Family and Phoenix HR team, we wish you a very happy birthday.",
      closingText: "Wishing you a wonderful birthday and a year ahead full of success.",
      greeting: "Dear {employee},",
      previewText: "Happy birthday wishes from Phoenix HR.",
      subject: "{subject}",
      title: "Happy Birthday",
    },
    type: "birthday",
  },
  {
    description: "Offer communication for candidates and HR follow-up.",
    enabled: true,
    includeHrInbox: false,
    label: "Offers",
    recipientModes: ["candidate"],
    recipientMode: "candidate",
    targetLines: [],
    targetTitles: [],
    template: {
      bodyText: "{summary}",
      closingText: "Phoenix HR will continue the next steps according to the offer workflow.",
      greeting: systemNotificationEmailText.teamGreeting,
      previewText: "Offer update from Phoenix Workforce.",
      subject: "{subject}",
      title: "{title}",
    },
    type: "offer",
  },
  {
    description: "Resignation workflow alerts routed to the reporting chain.",
    enabled: true,
    includeHrInbox: true,
    label: "Resignations",
    recipientModes: ["manager_chain"],
    recipientMode: "manager_chain",
    targetLines: [],
    targetTitles: [],
    template: {
      bodyText: "{summary}",
      closingText: "Please review the resignation workflow and complete the required action.",
      greeting: systemNotificationEmailText.teamGreeting,
      previewText: "Resignation workflow update from Phoenix Workforce.",
      subject: "{subject}",
      title: "{title}",
    },
    type: "resignation",
  },
  {
    description: "Password reset links routed directly to the target account email.",
    enabled: true,
    includeHrInbox: false,
    label: "Password reset",
    recipientModes: ["candidate"],
    recipientMode: "candidate",
    targetLines: [],
    targetTitles: [],
    template: {
      bodyText: "{summary}",
      closingText: "If you did not request this action, please contact HR immediately.",
      greeting: systemNotificationEmailText.userGreeting,
      previewText: `${systemIdentity.appName} password reset link.`,
      subject: "{subject}",
      title: "{title}",
    },
    type: "password_reset",
  },
  {
    description: "New account setup links routed directly to the target account email.",
    enabled: true,
    includeHrInbox: false,
    label: "User created",
    recipientModes: ["candidate"],
    recipientMode: "candidate",
    targetLines: [],
    targetTitles: [],
    template: {
      bodyText: "{summary}",
      closingText: "Please complete setup before the link expires.",
      greeting: systemNotificationEmailText.userGreeting,
      previewText: `${systemIdentity.appName} account setup link.`,
      subject: "{subject}",
      title: "{title}",
    },
    type: "user_created",
  },
  {
    description: systemNotificationEmailText.generalDescription,
    enabled: true,
    includeHrInbox: false,
    label: "General",
    recipientModes: ["hr_notifications"],
    recipientMode: "hr_notifications",
    targetLines: [],
    targetTitles: [],
    template: {
      bodyText: "{summary}",
      closingText: "Please review this update when available.",
      greeting: systemNotificationEmailText.teamGreeting,
      previewText: systemNotificationEmailText.generalPreviewText,
      subject: "{subject}",
      title: "{title}",
    },
    type: "general",
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

function cleanRecipientModes(value: unknown, fallback: EmailRecipientMode): EmailRecipientMode[] {
  const values = Array.isArray(value) ? value : [];
  const modes = values.filter(isEmailRecipientMode);
  if (modes.length > 0) return Array.from(new Set(modes));
  return [fallback];
}

function cleanTextArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean)));
}

function templateWithFallback(row: EmailNotificationPolicyRow, fallback: EmailNotificationPolicy): EmailTemplateContent {
  return {
    bodyText: row.template_body_text?.trim() || fallback.template.bodyText,
    closingText: row.template_closing_text?.trim() || fallback.template.closingText,
    greeting: row.template_greeting?.trim() || fallback.template.greeting,
    previewText: row.template_preview_text?.trim() || fallback.template.previewText,
    subject: row.template_subject?.trim() || fallback.template.subject,
    title: row.template_title?.trim() || fallback.template.title,
  };
}

function mapPolicyRow(row: EmailNotificationPolicyRow): EmailNotificationPolicy {
  const fallback = defaultPolicyForType(row.notification_type);
  const fallbackMode = fallback?.recipientMode ?? "hr_notifications";

  return {
    description: row.description ?? fallback?.description ?? "",
    enabled: row.enabled ?? fallback?.enabled ?? true,
    includeHrInbox: row.include_hr_inbox ?? row.include_hr_notifications ?? fallback?.includeHrInbox ?? false,
    label: row.label ?? fallback?.label ?? row.notification_type.replace(/_/g, " "),
    recipientMode: isEmailRecipientMode(row.recipient_mode) ? row.recipient_mode : fallbackMode,
    recipientModes: cleanRecipientModes(row.recipient_modes, fallbackMode),
    targetLines: cleanTextArray(row.target_lines),
    targetTitles: cleanTextArray(row.target_titles),
    template: fallback ? templateWithFallback(row, fallback) : {
      bodyText: "{summary}",
      closingText: "Please review this Phoenix Workforce update.",
      greeting: "Dear Phoenix Team,",
      previewText: "Phoenix Workforce notification.",
      subject: "{subject}",
      title: "{title}",
    },
    type: row.notification_type,
  };
}

function notificationPolicySchemaMissing(error: unknown) {
  const message = (
    error instanceof Error ? error.message : `${String(error)} ${JSON.stringify(error)}`
  ).toLowerCase();
  return (
    message.includes(emailNotificationPolicyTable) ||
    message.includes("could not find the table") ||
    message.includes("column") && message.includes("does not exist") ||
    message.includes("42703") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

export async function getEmailNotificationPolicies(): Promise<EmailNotificationPolicy[]> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from(emailNotificationPolicyTable)
      .select("notification_type,label,description,enabled,recipient_mode,recipient_modes,target_titles,target_lines,template_subject,template_title,template_greeting,template_body_text,template_closing_text,template_preview_text,include_hr_inbox")
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
    recipientMode?: EmailRecipientMode;
    recipientModes?: EmailRecipientMode[];
    targetLines?: string[];
    targetTitles?: string[];
    template?: Partial<EmailTemplateContent>;
  },
  actor?: string | null,
) {
  const fallback = defaultPolicyForType(type);
  if (!fallback) throw new Error("Unsupported email notification type.");

  const policy: EmailNotificationPolicy = {
    ...fallback,
    enabled: input.enabled,
    includeHrInbox: input.includeHrInbox,
    recipientMode: input.recipientMode ?? input.recipientModes?.[0] ?? fallback.recipientMode,
    recipientModes: input.recipientModes?.length ? input.recipientModes : [input.recipientMode ?? fallback.recipientMode],
    targetLines: input.targetLines ?? fallback.targetLines,
    targetTitles: input.targetTitles ?? fallback.targetTitles,
    template: {
      ...fallback.template,
      ...(input.template ?? {}),
    },
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
        recipient_modes: policy.recipientModes,
        target_lines: policy.targetLines,
        target_titles: policy.targetTitles,
        template_body_text: policy.template.bodyText,
        template_closing_text: policy.template.closingText,
        template_greeting: policy.template.greeting,
        template_preview_text: policy.template.previewText,
        template_subject: policy.template.subject,
        template_title: policy.template.title,
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
    .select("hr_id,full_name,work_email,manager_hr_id,job_title,line_name,lines(name)")
    .eq("hr_id", cleanHrId)
    .not("employment_status", "in", "(resigned,terminated,inactive)")
    .maybeSingle();

  if (error) throw error;
  return (data as EmailContactRow | null) ?? null;
}

function normalizeCompare(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function employeeLine(contact: EmailContactRow | null | undefined) {
  const relation = Array.isArray(contact?.lines) ? contact?.lines[0] : contact?.lines;
  return contact?.line_name || relation?.name || null;
}

async function loadEmployeesByTitlesAndLines(titles: string[], lines: string[]) {
  if (titles.length === 0) return [];

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employees")
    .select("hr_id,full_name,work_email,manager_hr_id,job_title,line_name,lines(name)")
    .not("work_email", "is", null)
    .not("employment_status", "in", "(resigned,terminated,inactive)");

  if (error) throw error;

  const titleSet = new Set(titles.map(normalizeCompare));
  const lineSet = new Set(lines.map(normalizeCompare));

  return ((data ?? []) as EmailContactRow[]).filter((contact) => {
    const titleMatches = titleSet.has(normalizeCompare(contact.job_title));
    const lineMatches = lineSet.size === 0 || lineSet.has(normalizeCompare(employeeLine(contact)));
    return titleMatches && lineMatches;
  });
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

async function resolveRecipientsForMode(mode: EmailRecipientMode, input: NotificationEmailInput, policy?: EmailNotificationPolicy) {
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
  if (mode === "same_line_selected_titles") {
    const line = employeeLine(employee);
    if (!line) return [];
    const recipients = await loadEmployeesByTitlesAndLines(policy?.targetTitles ?? [], [line]);
    return cleanEmailList(recipients.map((recipient) => recipient.work_email));
  }
  if (mode === "selected_titles_all_lines") {
    const recipients = await loadEmployeesByTitlesAndLines(policy?.targetTitles ?? [], []);
    return cleanEmailList(recipients.map((recipient) => recipient.work_email));
  }
  if (mode === "selected_titles_selected_lines") {
    const recipients = await loadEmployeesByTitlesAndLines(policy?.targetTitles ?? [], policy?.targetLines ?? []);
    return cleanEmailList(recipients.map((recipient) => recipient.work_email));
  }

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

  const requestedRecipientMode = input.recipientMode ?? (input.notificationType === "birthday" ? "employee" : undefined);
  const policy = {
    ...storedPolicy,
    includeHrInbox: input.includeHrInbox ?? storedPolicy.includeHrInbox,
    recipientMode: requestedRecipientMode ?? storedPolicy.recipientMode,
    recipientModes: requestedRecipientMode ? [requestedRecipientMode] : storedPolicy.recipientModes,
  };

  if (!policy.enabled) {
    return { reason: `Email skipped: ${policy.label} notifications are disabled.`, skipped: true };
  }

  const allPolicyRecipients = await Promise.all(
    (policy.recipientModes.length > 0 ? policy.recipientModes : [policy.recipientMode]).map((mode) =>
      resolveRecipientsForMode(mode, input, policy),
    ),
  );
  const policyRecipients = cleanEmailList(allPolicyRecipients.flat());
  const hrRecipients = policy.includeHrInbox ? recipientsFromEnv() : [];
  const explicitRecipients = cleanEmailList(input.recipients ?? []);
  const recipients = cleanEmailList([...policyRecipients, ...hrRecipients, ...explicitRecipients]);

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

function templateToken(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function templateValue(input: NotificationEmailInput, value: string) {
  const metrics = Object.fromEntries(
    (input.metrics ?? []).map((metric) => [templateToken(metric.label), String(metric.value)]),
  );
  const variables: Record<string, string> = {
    candidateemail: input.candidateEmail ?? "",
    ctalabel: input.ctaLabel ?? "Open dashboard",
    ctaurl: input.ctaHref ? dashboardUrl(input.ctaHref) : "",
    date: metrics.date ?? metrics.birthday ?? metrics.renewaldate ?? metrics.effectivedate ?? "",
    employee: metrics.employee ?? input.employeeHrId ?? "",
    employeehrid: input.employeeHrId ?? "",
    status: metrics.status ?? "",
    subject: input.subject,
    summary: input.summary,
    title: input.title,
    ...metrics,
  };

  return value.replace(/\{([^}]+)\}/g, (_match, key: string) => variables[templateToken(key)] ?? "");
}

function effectiveTemplate(input: NotificationEmailInput, policy?: EmailNotificationPolicy): EmailTemplateContent {
  const template = policy?.template ?? defaultPolicyForType(input.notificationType ?? "general")?.template;
  return {
    bodyText: templateValue(input, template?.bodyText || "{summary}"),
    closingText: templateValue(input, template?.closingText || "Please review this update."),
    greeting: templateValue(input, template?.greeting || systemNotificationEmailText.teamGreeting),
    previewText: templateValue(input, template?.previewText || input.summary),
    subject: templateValue(input, template?.subject || "{subject}"),
    title: templateValue(input, template?.title || "{title}"),
  };
}

function renderText(input: NotificationEmailInput, policy?: EmailNotificationPolicy) {
  const template = effectiveTemplate(input, policy);
  return renderGeneralNotificationEmailText({
    action: input.ctaHref ? { href: dashboardUrl(input.ctaHref), label: input.ctaLabel ?? "Open dashboard" } : undefined,
    bodyText: template.bodyText,
    closingText: template.closingText,
    greeting: template.greeting,
    signatureName: systemIdentity.hrSignatureName,
    metadataRows: input.metrics,
    subject: template.subject,
    summary: template.bodyText,
    title: template.title,
  });
}

function renderHtml(input: NotificationEmailInput, policy?: EmailNotificationPolicy) {
  const template = effectiveTemplate(input, policy);
  return renderGeneralNotificationEmailHtml({
    action: input.ctaHref ? { href: dashboardUrl(input.ctaHref), label: input.ctaLabel ?? "Open dashboard" } : undefined,
    bodyText: template.bodyText,
    closingText: template.closingText,
    greeting: template.greeting,
    metadataRows: input.metrics,
    previewText: template.previewText,
    signatureName: systemIdentity.hrSignatureName,
    subject: template.subject,
    summary: template.bodyText,
    title: template.title,
  });
}

function notificationSubject(input: NotificationEmailInput, policy?: EmailNotificationPolicy) {
  return effectiveTemplate(input, policy).subject;
}

export async function getEmailRoutingOptions() {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("employees")
      .select("job_title,line_name,lines(name)")
      .not("work_email", "is", null);

    if (error) throw error;

    const rows = (data ?? []) as EmailContactRow[];
    return {
      lines: Array.from(new Set(rows.map((row) => employeeLine(row)).filter(Boolean) as string[])).sort(),
      titles: Array.from(new Set(rows.map((row) => row.job_title).filter(Boolean) as string[])).sort(),
    };
  } catch {
    return { lines: [], titles: [] };
  }
}

export function buildEmailNotificationPreview(type: EmailNotificationType, policy?: EmailNotificationPolicy) {
  const samples: Record<EmailNotificationType, NotificationEmailInput> = {
    birthday: {
      employeeHrId: "B-001",
      metrics: [
        { label: "Employee", value: "Mariam Nabil" },
        { label: "Birthday", value: "Today" },
        { label: "Routing", value: "Employee" },
      ],
      notificationType: "birthday",
      recipientMode: "employee",
      subject: "Happy Birthday, Mariam Nabil",
      summary: "Happy birthday wishes for Mariam Nabil.",
      title: "Happy Birthday",
      tone: "neutral",
    },
    contract_renewal: {
      employeeHrId: "B-001",
      metrics: [
        { label: "Employee", value: "Mariam Nabil (B-001)" },
        { label: "Status", value: "Pending Manager Recommendation" },
        { label: "Renewal date", value: "2026-06-15" },
      ],
      notificationType: "contract_renewal",
      subject: "Contract Renewal Reminder - Mariam Nabil",
      summary: "Contract renewal for Mariam Nabil is pending manager recommendation.",
      title: "Contract Renewal Reminder - Pending Manager Recommendation",
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
      subject: "Phoenix Offer Updated - Youssef Ahmed",
      summary: "Offer workflow for Youssef Ahmed requires HR follow-up.",
      title: "Offer Updated",
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
      subject: "Phoenix Probation Review Updated - Mariam Nabil",
      summary: "Probation review for Mariam Nabil is now manager feedback.",
      title: "Probation Review Updated",
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
    password_reset: {
      candidateEmail: "employee@example.com",
      ctaHref: "/password-setup/example",
      ctaLabel: "Reset password",
      metrics: [
        { label: "Login ID", value: "B-001" },
        { label: "Expires", value: "15 minutes" },
      ],
      notificationType: "password_reset",
      recipientMode: "candidate",
      subject: systemAuthEmailText.passwordResetSubject,
      summary: systemAuthEmailText.passwordResetSummary,
      title: systemAuthEmailText.passwordResetTitle,
      tone: "warning",
    },
    user_created: {
      candidateEmail: "employee@example.com",
      ctaHref: "/password-setup/example",
      ctaLabel: "Set password",
      metrics: [
        { label: "Login ID", value: "B-001" },
        { label: "Expires", value: "15 minutes" },
      ],
      notificationType: "user_created",
      recipientMode: "candidate",
      subject: systemAuthEmailText.accountSetupSubject,
      summary: systemAuthEmailText.accountSetupSummary,
      title: systemAuthEmailText.accountSetupTitle,
      tone: "warning",
    },
    general: {
      ctaHref: "/overview",
      ctaLabel: systemNotificationEmailText.openAppCtaLabel,
      metrics: [{ label: "Source", value: systemNotificationEmailText.sourceMetricValue }],
      notificationType: "general",
      subject: systemNotificationEmailText.generalSubject,
      summary: systemNotificationEmailText.generalSummary,
      title: systemNotificationEmailText.generalTitle,
      tone: "neutral",
    },
  };
  const input = samples[type];

  return {
    html: renderHtml(input, policy),
    plainText: renderText(input, policy),
    subject: notificationSubject(input, policy),
  };
}

export async function getEmailNotificationOutboxStats() {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from(notificationOutboxTable)
      .select("status,payload,created_at,attempts,max_attempts")
      .order("created_at", { ascending: false })
      .limit(500);

    if (error) throw error;

    const rows = (data ?? []) as Array<{
      attempts: number;
      created_at: string;
      max_attempts: number;
      payload: Partial<NotificationEmailInput> | null;
      status: NotificationOutboxRow["status"];
    }>;
    const allowed = new Set<EmailNotificationType>(emailNotificationTypes);

    const summary = summarizeNotificationOutboxRows(
      rows.map((row) => ({
        createdAt: row.created_at,
        payload: row.payload,
        status: row.status,
      })),
      Array.from(allowed),
    );

    const terminalFailed = rows.filter(
      (row) => row.status === "failed" && row.attempts >= row.max_attempts,
    ).length;

    return { ...summary, terminalFailed };
  } catch (error) {
    if (notificationSchemaMissing(error)) {
      return {
        failed: 0,
        lastSentAt: null,
        pending: 0,
        recentAllowed: 0,
        recentTotal: 0,
        sent: 0,
        terminalFailed: 0,
      };
    }
    throw error;
  }
}

export function emailNotificationsEnabled() {
  return envFlag(process.env.EMAIL_NOTIFICATIONS_ENABLED);
}

function notificationSchemaMissing(error: unknown) {
  const message = (
    error instanceof Error ? error.message : `${String(error)} ${JSON.stringify(error)}`
  ).toLowerCase();
  return (
    message.includes(notificationOutboxTable) ||
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

const identityGuardFailurePrefix = "Email identity guard failed";

function normalizeIdentityHrId(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

function employeeMetricHrId(input: NotificationEmailInput) {
  const employee = metricValue(input, "Employee");
  const match = employee.match(/\(([^)]+)\)\s*$/);
  return normalizeIdentityHrId(match?.[1]);
}

export type NotificationEmailIdentityValidation =
  | {
      ok: true;
      metadata: {
        employeeHrId: string | null;
        guard: NotificationEmailIdentityGuard;
        recipientHrId: string | null;
        source: NotificationEmailIdentitySource | null;
        status: Exclude<NotificationEmailIdentityStatus, "failed">;
      };
    }
  | {
      ok: false;
      metadata: {
        employeeHrId: string | null;
        guard: NotificationEmailIdentityGuard;
        recipientHrId: string | null;
        source: NotificationEmailIdentitySource | null;
        status: "failed";
      };
      reason: string;
    };

export function validateNotificationEmailIdentity(input: NotificationEmailInput): NotificationEmailIdentityValidation {
  const guard = input.identityGuard ?? "none";
  const employeeHrId = normalizeIdentityHrId(input.employeeHrId) || null;
  const recipientHrId = normalizeIdentityHrId(input.recipientHrId) || null;
  const source = input.subjectHrIdSource ?? null;
  const baseMetadata = {
    employeeHrId,
    guard,
    recipientHrId,
    source,
  };

  if (input.identityError) {
    return {
      metadata: { ...baseMetadata, status: "failed" },
      ok: false,
      reason: `${identityGuardFailurePrefix}: ${input.identityError}`,
    };
  }

  const metricHrId = employeeMetricHrId(input);
  if (employeeHrId && metricHrId && employeeHrId !== metricHrId) {
    return {
      metadata: { ...baseMetadata, status: "failed" },
      ok: false,
      reason: `${identityGuardFailurePrefix}: employee HR ID ${employeeHrId} conflicts with Employee metric HR ID ${metricHrId}.`,
    };
  }

  if (guard === "subject_required") {
    if (!employeeHrId) {
      return {
        metadata: { ...baseMetadata, status: "failed" },
        ok: false,
        reason: `${identityGuardFailurePrefix}: subject employee HR ID is required for this official workflow email.`,
      };
    }
    if (source === "recipient.self") {
      return {
        metadata: { ...baseMetadata, status: "failed" },
        ok: false,
        reason: `${identityGuardFailurePrefix}: official workflow email cannot use the recipient HR ID as the subject employee HR ID.`,
      };
    }
  }

  return {
    metadata: {
      ...baseMetadata,
      status: employeeHrId ? "verified" : "not_required",
    },
    ok: true,
  };
}

function normalizeNotificationPayload(input: NotificationEmailInput) {
  return {
    bcc: input.bcc?.map((recipient) => recipient.trim().toLowerCase()).filter(Boolean).sort() ?? null,
    candidateEmail: input.candidateEmail?.trim().toLowerCase() ?? null,
    cc: input.cc?.map((recipient) => recipient.trim().toLowerCase()).filter(Boolean).sort() ?? null,
    ctaHref: input.ctaHref ?? null,
    ctaLabel: input.ctaLabel ?? null,
    employeeHrId: input.employeeHrId?.trim().toUpperCase() ?? null,
    includeHrInbox: input.includeHrInbox ?? null,
    identityGuard: input.identityGuard ?? null,
    identityStatus: input.identityStatus ?? null,
    metrics: (input.metrics ?? []).map((metric) => ({
      label: metric.label,
      value: String(metric.value),
    })),
    notificationType: input.notificationType ?? null,
    recipientHrId: input.recipientHrId?.trim().toUpperCase() ?? null,
    recipients: input.recipients?.map((recipient) => recipient.trim().toLowerCase()).sort() ?? null,
    recipientMode: input.recipientMode ?? null,
    subjectHrIdSource: input.subjectHrIdSource ?? null,
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

function isProbationReminderNotification(input: NotificationEmailInput) {
  return input.notificationType === "probation" && (
    Boolean(metricValue(input, "Days remaining")) ||
    Boolean(metricValue(input, "Hire date")) ||
    input.ctaHref?.includes("/employee-portals/probation")
  );
}

function isPasswordSetupNotification(input: NotificationEmailInput) {
  return input.notificationType === "user_created" && (
    input.ctaHref?.includes("/password-setup/") ||
    input.title.toLowerCase().includes("create your phoenix workforce password")
  );
}

function migratedTemplateKeyForNotification(input: NotificationEmailInput) {
  // A domain can pin its admin-editable template explicitly (the strongest form of the
  // one-source-of-truth contract): /admin/email-templates governs the wording, the
  // domain only declares WHICH template frames the event. Unknown keys are ignored so a
  // typo can never silently kill an email. Auth and birthday keys cannot be pinned -
  // those keys also switch recipient expansion and List-Unsubscribe behavior, which a
  // wording override must never do.
  const explicit = normalizeEmailTemplateKey(input.templateKey);
  if (explicit && !isAuthTemplateKey(explicit) && explicit !== EMAIL_TEMPLATE_KEYS.BIRTHDAY) {
    return explicit;
  }
  if (input.notificationType === "birthday") return EMAIL_TEMPLATE_KEYS.BIRTHDAY;
  if (input.notificationType === "contract_renewal") return EMAIL_TEMPLATE_KEYS.CONTRACT_RENEWAL;
  if (input.notificationType === "general") {
    // Module-scoped notifications arrive as "general"; the originating module rides along
    // (createSystemNotification → buildEmailInput). Every business module routes to its
    // own editable template so /admin/email-templates is the single source of truth;
    // GENERAL is reserved for genuinely generic system notices (internal messages,
    // employee import, telegram/attendance alerts).
    const moduleLabel = String(input.module ?? "").trim().toLowerCase().replace(/_/g, " ");
    if (moduleLabel === "weekly plans" || moduleLabel === "monthly plans" || moduleLabel === "weekly planning") {
      return EMAIL_TEMPLATE_KEYS.WEEKLY_PLANS;
    }
    if (moduleLabel === "outstation" || moduleLabel === "expenses" || moduleLabel === "expense") {
      return EMAIL_TEMPLATE_KEYS.OUTSTATION;
    }
    if (moduleLabel === "marketing requests" || moduleLabel === "marketing request") {
      return EMAIL_TEMPLATE_KEYS.MARKETING_REQUEST;
    }
    if (moduleLabel === "excuse" || moduleLabel === "excuses") {
      return EMAIL_TEMPLATE_KEYS.EXCUSE_REQUEST;
    }
    if (moduleLabel === "coaching") {
      return EMAIL_TEMPLATE_KEYS.COACHING_REPORT;
    }
    if (moduleLabel === "payroll") {
      return EMAIL_TEMPLATE_KEYS.PAYROLL_UPDATE;
    }
    if (moduleLabel === "recruitment") {
      // External candidates (interview cancellation notices) have no Phoenix login -
      // keep candidate-addressed sends on the audience-neutral GENERAL template; the
      // Recruitment Update template frames internal staff notices.
      return String(input.candidateEmail ?? "").trim()
        ? EMAIL_TEMPLATE_KEYS.GENERAL
        : EMAIL_TEMPLATE_KEYS.RECRUITMENT_UPDATE;
    }
    return EMAIL_TEMPLATE_KEYS.GENERAL;
  }
  if (input.notificationType === "password_reset") return EMAIL_TEMPLATE_KEYS.PASSWORD_RESET;
  if (input.notificationType === "probation") {
    return isProbationReminderNotification(input)
      ? EMAIL_TEMPLATE_KEYS.PROBATION_REMINDER
      : EMAIL_TEMPLATE_KEYS.PROBATION_WORKFLOW;
  }
  if (input.notificationType === "user_created") {
    return isPasswordSetupNotification(input)
      ? EMAIL_TEMPLATE_KEYS.PASSWORD_SETUP
      : EMAIL_TEMPLATE_KEYS.USER_CREATED;
  }
  if (input.notificationType === "resignation") return EMAIL_TEMPLATE_KEYS.RESIGNATION_WORKFLOW;
  // Offer STATUS notifications (accepted/rejected/hire-approved) use the dedicated
  // Offer Status template — the JOB_OFFER template stays reserved for the candidate
  // offer LETTER, which goes through sendTemplatedEmail('offer') independently.
  // Candidate-addressed confirmations stay on the audience-neutral GENERAL template
  // (candidates have no Phoenix login; Offer Status frames internal HR alerts).
  if (input.notificationType === "offer") {
    return String(input.candidateEmail ?? "").trim()
      ? EMAIL_TEMPLATE_KEYS.GENERAL
      : EMAIL_TEMPLATE_KEYS.OFFER_STATUS;
  }
  return null;
}

function metricValue(input: NotificationEmailInput, label: string) {
  const expected = label.trim().toLowerCase();
  return String(
    input.metrics?.find((metric) => metric.label.trim().toLowerCase() === expected)?.value ?? "",
  ).trim();
}

function employeeNameFromNotification(input: NotificationEmailInput) {
  const employee = metricValue(input, "Employee");
  return employee.replace(/\s+\([^)]*\)\s*$/, "").trim() || metricValue(input, "Login ID") || input.employeeHrId || "";
}

function notificationMetricStatus(input: NotificationEmailInput) {
  return (input.metrics ?? [])
    .map((metric) => `${metric.label}: ${metric.value}`)
    .join(" | ");
}

function isAuthTemplateKey(templateKey: string) {
  return (
    templateKey === EMAIL_TEMPLATE_KEYS.PASSWORD_SETUP ||
    templateKey === EMAIL_TEMPLATE_KEYS.PASSWORD_RESET ||
    templateKey === EMAIL_TEMPLATE_KEYS.USER_CREATED
  );
}

function isDistrictManagerContact(contact: EmailContactRow | null | undefined) {
  const value = normalizeCompare(`${contact?.job_title ?? ""}`);
  return value.includes("district manager") || value.includes("district sales manager");
}

async function migratedTemplateRecipientOverrides(
  templateKey: string,
  input: NotificationEmailInput,
  deliveryRecipients: string[],
) {
  if (templateKey !== EMAIL_TEMPLATE_KEYS.BIRTHDAY) {
    return {
      bcc: input.bcc,
      cc: input.cc,
      replaceRecipients: true,
      to: deliveryRecipients,
    };
  }

  const [employee, managers] = await Promise.all([
    loadEmployeeContact(input.employeeHrId),
    loadManagerChain(input.employeeHrId),
  ]);
  const to = cleanEmailList([employee?.work_email, ...deliveryRecipients]);
  const cc = cleanEmailList([
    ...managers
      .filter(isDistrictManagerContact)
      .map((manager) => manager.work_email),
    ...(input.cc ?? []),
  ]);

  return {
    bcc: input.bcc,
    cc,
    replaceRecipients: true,
    to,
  };
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

/**
 * Notification types where a "no recipients resolved" outcome means a real escalation
 * (an approval/auth/lifecycle email) was silently dropped — worth a Sentry warning.
 */
const highPriorityNotificationTypes = new Set<EmailNotificationType>([
  "password_reset",
  "user_created",
  "offer",
  "resignation",
  "probation",
  "contract_renewal",
]);

export type OutboxSkipCode =
  | "email_disabled_globally"
  | "from_missing"
  | "unsafe_identity"
  | "type_not_approved"
  | "type_unsupported"
  | "policy_disabled"
  | "no_recipients"
  | "recipient_suppressed"
  | "no_deliverable_recipient";

export type OutboxSkipClass =
  | { terminal: true; sentryEscalate: boolean; code: OutboxSkipCode }
  | { terminal: false };

/**
 * Classify a `skipped` send result as a DETERMINISTIC skip (a configuration/routing
 * outcome that will not change on retry) vs a transient failure (worth retrying).
 *
 * Deterministic skips were previously routed through markNotificationOutboxFailed,
 * burning all 5 retries and polluting the failure/terminalFailed metrics. They now go
 * to a terminal `skipped` state. A `no_recipients` skip on a high-priority type ALSO
 * escalates to Sentry because it means a real alert was dropped.
 */
export function classifyOutboxSkip(
  reason: string,
  notificationType?: EmailNotificationType | null,
): OutboxSkipClass {
  const r = reason.toLowerCase();
  const high = !!notificationType && highPriorityNotificationTypes.has(notificationType);
  if (r.includes("email_notifications_enabled")) {
    return { terminal: true, sentryEscalate: false, code: "email_disabled_globally" };
  }
  if (r.includes("notification_email_from")) {
    return { terminal: true, sentryEscalate: false, code: "from_missing" };
  }
  if (r.includes(identityGuardFailurePrefix.toLowerCase())) {
    return { terminal: true, sentryEscalate: true, code: "unsafe_identity" };
  }
  if (r.includes("not approved for automatic")) {
    return { terminal: true, sentryEscalate: false, code: "type_not_approved" };
  }
  if (r.includes("unsupported notification type")) {
    return { terminal: true, sentryEscalate: false, code: "type_unsupported" };
  }
  if (r.includes("notifications are disabled")) {
    return { terminal: true, sentryEscalate: false, code: "policy_disabled" };
  }
  if (r.includes("resolved no recipient")) {
    return { terminal: true, sentryEscalate: high, code: "no_recipients" };
  }
  // Bounce/complaint suppression is deterministic — retrying re-sends to the same dead
  // address. Terminal skip (not a failure); do not escalate (suppression is by-design).
  if (r.includes("suppressed")) {
    return { terminal: true, sentryEscalate: false, code: "recipient_suppressed" };
  }
  // Every recipient was a synthetic/non-routable address (no real mailbox on file). Won't
  // change on retry. Terminal skip; escalate only for high-priority types (a real alert that
  // could not be emailed — the in-app copy still delivers).
  if (r.includes("no deliverable recipient")) {
    return { terminal: true, sentryEscalate: high, code: "no_deliverable_recipient" };
  }
  // Unknown reason (e.g. a missing/inactive template that may be republished, or
  // "already being processed") → transient: keep retrying within the attempt budget.
  return { terminal: false };
}

const transactionalEmailTypes = new Set<EmailNotificationType>(["password_reset", "user_created"]);

function listUnsubscribeHeaders(
  notificationType: EmailNotificationType | undefined,
  primaryRecipient?: string,
): Record<string, string> | undefined {
  if (!notificationType || transactionalEmailTypes.has(notificationType)) return undefined;
  const replyTo = process.env.NOTIFICATION_REPLY_TO || systemEmail.defaultReplyTo;
  const mailto = `<mailto:${replyTo}?subject=unsubscribe>`;
  const base = String(process.env.NOTIFICATION_DASHBOARD_URL ?? "").replace(/\/+$/, "");
  // RFC 8058 one-click requires an HTTPS endpoint. Emit it (alongside mailto) only when we
  // have an app URL AND a single resolved recipient to mint a per-address token for.
  if (!base || !primaryRecipient) {
    return { "List-Unsubscribe": mailto };
  }
  const token = createUnsubscribeToken(primaryRecipient, notificationType);
  return {
    "List-Unsubscribe": `<${base}/api/email/unsubscribe/${token}>, ${mailto}`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

async function sendNotificationEmailDirect(input: NotificationEmailInput): Promise<SendEmailResult> {
  if (!emailNotificationsEnabled()) {
    return { reason: "EMAIL_NOTIFICATIONS_ENABLED is not true.", skipped: true };
  }
  const identity = validateNotificationEmailIdentity(input);
  if (!identity.ok) {
    Sentry.captureMessage("Email identity guard blocked notification", {
      level: "error",
      tags: { component: "email", notificationType: input.notificationType ?? "unknown" },
      extra: identity.metadata,
    });
    return { reason: identity.reason, skipped: true };
  }

  const from = process.env.NOTIFICATION_EMAIL_FROM;
  const delivery = await resolveNotificationDelivery(input);

  if (!from) return { reason: "NOTIFICATION_EMAIL_FROM is missing.", skipped: true };
  if (delivery.skipped) return delivery;

  const requestId = notificationDedupeKey(input);
  const migratedTemplateKey = migratedTemplateKeyForNotification(input);

  if (migratedTemplateKey) {
    const overrides = await migratedTemplateRecipientOverrides(migratedTemplateKey, input, delivery.recipients);
    return sendTemplatedEmail({
      candidateEmail: input.candidateEmail,
      context: {
        ctaLabel: input.ctaLabel ?? systemNotificationEmailText.openInAppCtaLabel,
        ctaUrl: input.ctaHref ? dashboardUrl(input.ctaHref) : "",
        amount: metricValue(input, "Amount"),
        candidateName: metricValue(input, "Candidate") || metricValue(input, "Candidate Name"),
        date: metricValue(input, "Birthday") || metricValue(input, "Effective date") || metricValue(input, "Date") || new Date().toISOString().slice(0, 10),
        area: metricValue(input, "Area"),
        destination: metricValue(input, "Destination"),
        endDate: metricValue(input, "Renewal date") || metricValue(input, "Trip end"),
        employeeHrId: input.employeeHrId || metricValue(input, "HR_ID") || metricValue(input, "Login ID"),
        employeeName: employeeNameFromNotification(input),
        expiryText: metricValue(input, "Expires"),
        // Offer/recruitment callers label the position metric "Role".
        jobTitle: metricValue(input, "Job Title") || metricValue(input, "Role"),
        line: metricValue(input, "Line"),
        planTable: input.planTableHtml,
        planTableText: input.planTableText,
        recipientName: isAuthTemplateKey(migratedTemplateKey)
          ? systemNotificationEmailText.userRecipientName
          : input.recipientName || employeeNameFromNotification(input) || systemNotificationEmailText.teamRecipientName,
        startDate: metricValue(input, "Hire date") || metricValue(input, "Trip start"),
        status: notificationMetricStatus(input),
        subject: input.subject,
        summary: input.summary,
      },
      employeeHrId: input.employeeHrId,
      fallbackTo: delivery.recipients,
      from,
      overrides,
      templateKey: migratedTemplateKey,
    });
  }

  const fanout = delivery.recipients.length > 1;
  return sendPhoenixEmail({
    bcc: input.bcc,
    cc: input.cc,
    fanoutToBcc: true,
    from,
    // Per-address one-click token only for single-recipient sends; fan-outs go to internal
    // staff (manager chain / HR inbox) and use the mailto fallback.
    headers: listUnsubscribeHeaders(input.notificationType, fanout ? undefined : delivery.recipients[0]),
    html: renderHtml(input, delivery.policy),
    idempotencyKey: requestId,
    subject: notificationSubject(input, delivery.policy),
    text: renderText(input, delivery.policy),
    to: delivery.recipients,
  });
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

async function markNotificationOutboxFailed(row: NotificationOutboxRow, errorMessage: string, retryAfterMs?: number) {
  const supabase = getSupabaseAdmin();
  const attempts = row.attempts + 1;
  const terminal = attempts >= row.max_attempts;
  const now = new Date().toISOString();
  // Honour a provider Retry-After (e.g. a 429): wait at least that long, but never less
  // than the normal backoff schedule.
  const baseNext = nextAttemptAtIso(attempts);
  const nextAttempt = terminal
    ? null
    : retryAfterMs != null
      ? new Date(Math.max(Date.parse(baseNext), Date.now() + retryAfterMs)).toISOString()
      : baseNext;
  await supabase
    .from(notificationOutboxTable)
    .update({
      attempts,
      last_error: errorMessage,
      locked_at: null,
      next_attempt_at: nextAttempt,
      status: "failed",
      updated_at: now,
    })
    .eq("id", row.id);

  // A row that has exhausted every retry is a notification that was never delivered.
  // Surface it individually (the batch-level warning only says "something failed").
  if (terminal) {
    Sentry.captureMessage("Email outbox row terminally failed", {
      level: "error",
      tags: { component: "email", cron: "outbox-processing", notificationType: row.payload.notificationType ?? "unknown" },
      extra: { id: row.id, attempts, last_error: errorMessage },
    });
  }
}

/**
 * Terminal `skipped` state for DETERMINISTIC non-sends (disabled policy, unsupported
 * type, missing global config, no recipients). Unlike a failure, this does not consume
 * the retry budget or inflate the failure metric — the send will never succeed on retry.
 */
async function markNotificationOutboxSkipped(row: NotificationOutboxRow, reason: string, code: OutboxSkipCode) {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from(notificationOutboxTable)
    .update({
      attempts: row.attempts + 1,
      last_error: `[${code}] ${reason}`,
      locked_at: null,
      next_attempt_at: null,
      status: "skipped",
      updated_at: now,
    })
    .eq("id", row.id);

  // The 'skipped' status requires the widening migration. If it is not applied yet, the
  // CHECK constraint rejects the update — fall back to the failure path so the row still
  // progresses toward terminal instead of being re-claimed forever.
  if (error) {
    await markNotificationOutboxFailed(row, `[${code}] ${reason}`);
  }
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

const staleProcessingThresholdMinutes = 10;
const retentionDays = 90;

export async function reapStaleProcessingOutboxRows(): Promise<number> {
  try {
    const supabase = getSupabaseAdmin();
    const threshold = new Date();
    threshold.setMinutes(threshold.getMinutes() - staleProcessingThresholdMinutes);

    const { data, error } = await supabase
      .from(notificationOutboxTable)
      .update({ locked_at: null, status: "pending", updated_at: new Date().toISOString() })
      .eq("status", "processing")
      .lt("locked_at", threshold.toISOString())
      .select("id");

    if (error) {
      if (notificationSchemaMissing(error)) return 0;
      throw error;
    }
    return data?.length ?? 0;
  } catch {
    return 0;
  }
}

export async function cleanupOldNotificationData(): Promise<{
  outboxDeleted: number;
  outboxTerminalDeleted: number;
  eventsRedacted: number;
}> {
  const threshold = new Date();
  threshold.setDate(threshold.getDate() - retentionDays);
  const thresholdIso = threshold.toISOString();
  let outboxDeleted = 0;
  let outboxTerminalDeleted = 0;
  let eventsRedacted = 0;

  try {
    const supabase = getSupabaseAdmin();

    const { data: outboxData, error: outboxError } = await supabase
      .from(notificationOutboxTable)
      .delete()
      .eq("status", "sent")
      .lt("sent_at", thresholdIso)
      .select("id");

    if (outboxError && !notificationSchemaMissing(outboxError)) {
      console.error("Outbox retention cleanup failed", outboxError);
    }
    outboxDeleted = outboxData?.length ?? 0;
  } catch { /* schema missing */ }

  try {
    const supabase = getSupabaseAdmin();

    // Terminal failed/skipped rows still hold their PII-bearing payload (HR_IDs, names,
    // candidate emails). At 90 days these are unquestionably terminal — purge them too,
    // so retention is not limited to successfully-sent rows.
    const { data: terminalData, error: terminalError } = await supabase
      .from(notificationOutboxTable)
      .delete()
      .in("status", ["failed", "skipped"])
      .lt("updated_at", thresholdIso)
      .select("id");

    if (terminalError && !notificationSchemaMissing(terminalError)) {
      console.error("Outbox terminal-row retention cleanup failed", terminalError);
    }
    outboxTerminalDeleted = terminalData?.length ?? 0;
  } catch { /* schema missing */ }

  try {
    const supabase = getSupabaseAdmin();

    // Redact the PII-bearing payload AND the recipient addresses on aged delivery
    // events (previously only raw_event was cleared, leaving recipients intact).
    const { data: eventsData, error: eventsError } = await supabase
      .from("email_delivery_events")
      .update({ raw_event: {}, recipients: [] })
      .lt("occurred_at", thresholdIso)
      .neq("raw_event", "{}")
      .select("id");

    if (eventsError) {
      console.error("Delivery events retention cleanup failed", eventsError);
    }
    eventsRedacted = eventsData?.length ?? 0;
  } catch { /* table missing */ }

  return { eventsRedacted, outboxDeleted, outboxTerminalDeleted };
}

async function processNotificationOutboxRow(row: NotificationOutboxRow): Promise<SendEmailResult> {
  const claimed = await claimNotificationOutboxRow(row.id);
  if (!claimed) {
    return { reason: "Notification is already being processed.", skipped: true };
  }

  try {
    const identity = validateNotificationEmailIdentity(claimed.payload);
    if (!identity.ok) {
      await markNotificationOutboxSkipped(claimed, identity.reason, "unsafe_identity");
      Sentry.captureMessage("Email outbox row blocked by identity guard", {
        level: "error",
        tags: {
          component: "email",
          cron: "outbox-processing",
          notificationType: claimed.payload.notificationType ?? "unknown",
          outboxSkipCode: "unsafe_identity",
        },
        extra: { id: claimed.id, ...identity.metadata },
      });
      return { reason: identity.reason, skipped: true };
    }

    const result = await sendNotificationEmailDirect(claimed.payload);
    if (result.skipped) {
      const classification = classifyOutboxSkip(result.reason, claimed.payload.notificationType);
      if (classification.terminal) {
        await markNotificationOutboxSkipped(claimed, result.reason, classification.code);
        if (classification.sentryEscalate) {
          Sentry.captureMessage("High-priority notification dropped: no recipients resolved", {
            level: "warning",
            tags: {
              component: "email",
              cron: "outbox-processing",
              outboxSkipCode: classification.code,
              notificationType: claimed.payload.notificationType ?? "unknown",
            },
            extra: { id: claimed.id, reason: result.reason },
          });
        }
        return result;
      }
      // Transient skip (e.g. template temporarily unavailable) → retry within budget.
      await markNotificationOutboxFailed(claimed, result.reason);
      return result;
    }

    await markNotificationOutboxSent(claimed, result.id);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Email notification failed.";
    const retryAfterMs = error instanceof RetryableEmailError ? error.retryAfterMs : undefined;
    await markNotificationOutboxFailed(claimed, message, retryAfterMs);
    return { reason: message, skipped: true };
  }
}

export async function processNotificationOutbox(limit = notificationOutboxBatchSize): Promise<NotificationOutboxProcessResult> {
  const rows = await loadDueNotificationOutboxRows(limit);
  const processedIds: string[] = [];
  let attempted = 0;
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows) {
    attempted += 1;
    const result = await processNotificationOutboxRow(row);
    processedIds.push(row.id);
    if (!result.skipped) {
      sent += 1;
      continue;
    }
    // A row claimed by a concurrent run is neither sent nor failed here.
    if (result.reason.toLowerCase().includes("already being processed")) {
      skipped += 1;
      continue;
    }
    // Deterministic skips (disabled policy, no recipients, …) are terminal config
    // outcomes — count them as skipped, not failed, so they never trip the alarm.
    const classification = classifyOutboxSkip(result.reason, row.payload.notificationType);
    if (classification.terminal) skipped += 1;
    else failed += 1;
  }

  if (failed > 0) {
    Sentry.captureMessage("Email outbox processing had failures", {
      level: "warning",
      tags: { component: "email", cron: "outbox-processing" },
      extra: { attempted, failed, sent, skipped },
    });
  }

  return { attempted, failed, processedIds, sent, skipped };
}

export async function safeSendNotificationEmail(input: NotificationEmailInput) {
  try {
    const identity = validateNotificationEmailIdentity(input);
    if (!identity.ok) {
      Sentry.captureMessage("Email identity guard blocked enqueue", {
        level: "error",
        tags: { component: "email", notificationType: input.notificationType ?? "unknown" },
        extra: identity.metadata,
      });
      return { reason: identity.reason, skipped: true } satisfies SendEmailResult;
    }

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
    Sentry.captureException(error, {
      tags: { component: "email", notificationType: input.notificationType ?? "unknown" },
    });
    console.error("Email notification failed", error);
    return {
      reason: error instanceof Error ? error.message : "Email notification failed.",
      skipped: true,
    } satisfies SendEmailResult;
  }
}
