import crypto from "crypto";


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
import { EMAIL_TEMPLATE_KEYS, normalizeEmailTemplateKey, sendTemplatedEmail, type EmailTemplateContext } from "@/lib/email-templates/service";
import { renderPhoenixMetadataTable, renderPhoenixMetadataTableText } from "@/emails/phoenix-email-layout";
import { EMPLOYEE_LINE_SELECT, resolveEmployeeLineName } from "@/lib/employees/employee-org-labels";
import { RetryableEmailError, sendPhoenixEmail } from "@/lib/email/send-phoenix-email";
import { createUnsubscribeToken } from "@/lib/email/unsubscribe-token";
import { readEmailPolicies } from "@/lib/notifications/email-policy-snapshot";
import { summarizeNotificationOutboxRows } from "@/lib/communication/metrics";
import { passwordResetCodeMetricLabel } from "@/lib/auth/password-reset-code";
import { ACTIVE_EMPLOYMENT_STATUSES_IN_LIST } from "@/lib/auth/session-lifecycle";
import { writeAuditLog } from "@/lib/admin/audit";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isPayslipEventType } from "@/lib/notifications/payslip-channel-guard";
import { emailKeepsLineBreaks } from "@/lib/notifications/attendance-digest-channels";

export const emailNotificationTypes = [
  "probation",
  // The Day 30/60/75 milestone emails ONLY (owner, 2026-09-29: To Yasmeena Elsafory, CC Omar
  // Gawish, BCC). Deliberately its OWN type rather than riding "probation": that policy is off by the
  // owner's 2026-07-19 decision and still governs the legacy per-manager probation reminders, so
  // turning the milestones on must not turn those back on with them. See
  // src/lib/probation/intelligence/milestone-emails.ts.
  "probation_milestone",
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
  /**
   * Which runtime enqueued this row — "production", "staging", "development".
   *
   * Stamped by enqueueNotificationEmail; never set by a caller. Present so a row written by a
   * LOCAL `pnpm run dev` (which talks to the production database, AGENTS.md §3) is distinguishable
   * from a real production one. Optional because rows enqueued before 2026-09-05 do not carry it.
   */
  originEnvironment?: string;
  ctaHref?: string;
  ctaLabel?: string;
  /**
   * A SECOND button beside the primary CTA, for an email that asks for one thing and offers
   * another alongside it. Added 2026-09-09 for the new-hire notice: the primary asks the SFE
   * Manager to record the CRM account, this one downloads the person's CV.
   *
   * Both halves must be set for it to render — a label with no href is a dead button, and an href
   * with no label is an unnamed one. `dashboardUrl` is applied to it exactly as to ctaHref, so a
   * relative app path becomes an absolute link in the delivered mail.
   */
  secondaryCtaHref?: string | null;
  secondaryCtaLabel?: string | null;
  /** The originating CreateSystemNotificationInput.eventType — threaded through purely so the
   * Notification Confidence Gate (send-phoenix-email.ts) can group its fan-out anomaly check
   * by (module, eventType) instead of just module. */
  eventType?: string | null;
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
   * Extra template tokens this send should fill (e.g. marketing financials, products table).
   * Merged into the resolved template context, so module-specific tokens stay editable in
   * /admin/email-templates while the value comes from the caller.
   */
  templateContext?: Partial<EmailTemplateContext>;
  /**
   * Name of the person actually RECEIVING this email (for "Dear {{recipientName}},").
   * Without it the hub falls back to the subject employee's name - wrong for emails
   * routed to a manager/CEO/HR about someone else's record.
   */
  recipientHonorific?: string | null;
  recipientName?: string;
  recipientHrId?: string | null;
  recipients?: string[];
  recipientMode?: EmailRecipientMode;
  /**
   * Set ONLY by buildChannelEmailInput (system.ts), and only when this email is addressed to
   * ONE specific person whose deliverable address could not be resolved.
   *
   * It exists because an empty `recipients` is indistinguishable from "this send is legitimately
   * policy-routed", and that ambiguity silently mailed 67 notifications to the shared HR inbox
   * while the intended person appeared nowhere in To, CC or BCC — recorded as a successful send
   * (production, 2026-07-25 → 2026-08-08). The address is missing, so nobody can be reached:
   * resolveNotificationDelivery must SKIP LOUDLY rather than let the inbox stand in for a person.
   */
  recipientAddressUnresolved?: boolean;
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

export type NotificationOutboxRow = {
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
export const notificationOutboxTable = "notification_outbox";
export const notificationOutboxMaxAttempts = 5;
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
  // No line_name: the column is being dropped, so nothing may declare it and quietly re-add it to
  // a select. The line comes from the embed below.
  lines?: { name: string | null } | Array<{ name: string | null }> | null;
  manager_hr_id?: string | null;
  work_email?: string | null;
};

type NotificationDelivery =
  | { policy: EmailNotificationPolicy; recipients: string[]; skipped: false }
  | { reason: string; skipped: true };

function payloadLooksLikePayslip(input: NotificationEmailInput): boolean {
  const haystack = [
    input.eventType,
    input.templateKey,
    input.subject,
    input.summary,
    input.title,
    input.ctaHref,
    input.ctaLabel,
    input.module,
    input.recipientName,
    input.recipientHonorific,
  ]
    .map((v) => String(v ?? "").trim().toLowerCase())
    .join(" | ");
  if (isPayslipEventType(input.eventType)) return true;
  return haystack.includes("payslip");
}

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
    description: "Probation Day 30 / 60 / 75 milestone emails — To Yasmeena Elsafory, BCC Omar Gawish.",
    enabled: true,
    // The recipients are fixed in code (owner, 2026-09-29), so the shared HR inbox is NOT added and
    // the mode is "candidate" — the mode that honours the caller's own explicit To address instead
    // of resolving a manager chain. Nothing here widens the recipient list.
    includeHrInbox: false,
    label: "Probation milestones",
    recipientModes: ["candidate"],
    recipientMode: "candidate",
    targetLines: [],
    targetTitles: [],
    template: {
      bodyText: "{summary}",
      closingText: "Open the live report to review this milestone.",
      greeting: systemNotificationEmailText.teamGreeting,
      previewText: "Probation milestone update from Phoenix Workforce.",
      subject: "{subject}",
      title: "{title}",
    },
    type: "probation_milestone",
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

/**
 * The delivery path's read: inside a drain run (`withEmailPolicySnapshot`) the table is read once and
 * shared by every email of that run; anywhere else it is a plain fresh read. `getEmailNotificationPolicies`
 * itself stays unwrapped — the admin screens and `saveEmailNotificationPolicy` must always see the table as it is.
 */
async function getEmailNotificationPolicy(type: EmailNotificationType) {
  const policies = await readEmailPolicies(getEmailNotificationPolicies);
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

  // A save compares against the table as it is NOW, never a run's snapshot.
  const before =
    (await getEmailNotificationPolicies()).find((policy) => policy.type === type) ?? fallback;

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

  await writeAuditLog({
    actorLoginId: actor ?? null,
    entityId: type,
    entityType: "notification",
    newValues: { enabled: policy.enabled, recipientModes: policy.recipientModes, targetLines: policy.targetLines, targetTitles: policy.targetTitles },
    oldValues: { enabled: before.enabled, recipientModes: before.recipientModes, targetLines: before.targetLines, targetTitles: before.targetTitles },
    summary: `${actor ?? "admin"} changed the "${policy.label}" email notification policy.`,
  });

  return policy;
}

async function loadEmployeeContact(hrId: string | null | undefined) {
  const cleanHrId = String(hrId ?? "").trim().toUpperCase();
  if (!cleanHrId) return null;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employees")
    .select(`hr_id,full_name,work_email,manager_hr_id,job_title,${EMPLOYEE_LINE_SELECT}`)
    .eq("hr_id", cleanHrId)
    .or(`employment_status.is.null,employment_status.in.${ACTIVE_EMPLOYMENT_STATUSES_IN_LIST}`)
    .maybeSingle();

  if (error) throw error;
  return (data as EmailContactRow | null) ?? null;
}

function normalizeCompare(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * The contact's line — now the shared resolver, and the ORDER changed with it. This read used to
 * prefer `contact.line_name` over the embedded `lines.name`. That is harmless only for as long as
 * the label stays empty (1 of 198 rows carry it) and backwards the moment one row carries a stale
 * one. The link is the truth; the label is the fallback. See employee-line.ts.
 */
function employeeLine(contact: EmailContactRow | null | undefined) {
  return resolveEmployeeLineName(contact);
}

async function loadEmployeesByTitlesAndLines(titles: string[], lines: string[]) {
  if (titles.length === 0) return [];

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employees")
    .select(`hr_id,full_name,work_email,manager_hr_id,job_title,${EMPLOYEE_LINE_SELECT}`)
    .not("work_email", "is", null)
    .or(`employment_status.is.null,employment_status.in.${ACTIVE_EMPLOYMENT_STATUSES_IN_LIST}`);

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

  const hasExplicitRecipients = cleanEmailList(input.recipients ?? []).length > 0;
  const requestedRecipientMode = input.recipientMode ?? (input.notificationType === "birthday" ? "employee" : undefined);
  const effectiveRequestedMode = hasExplicitRecipients
    ? requestedRecipientMode ?? "candidate"
    : requestedRecipientMode;
  const policy = {
    ...storedPolicy,
    includeHrInbox: hasExplicitRecipients ? false : (input.includeHrInbox ?? storedPolicy.includeHrInbox),
    recipientMode: effectiveRequestedMode ?? storedPolicy.recipientMode,
    recipientModes: effectiveRequestedMode ? [effectiveRequestedMode] : storedPolicy.recipientModes,
  };

  if (!policy.enabled) {
    return { reason: `Email skipped: ${policy.label} notifications are disabled.`, skipped: true };
  }

  const requestedModes = policy.recipientModes.length > 0 ? policy.recipientModes : [policy.recipientMode];
  // "hr_notifications" addresses a shared mailbox; every other mode resolves real people. Keeping
  // them apart is what lets GUARD 2 tell "nobody resolved" from "correctly routed to the inbox".
  const personModes = requestedModes.filter((mode) => mode !== "hr_notifications");
  const resolvedByMode = await Promise.all(
    requestedModes.map(async (mode) => ({ mode, recipients: await resolveRecipientsForMode(mode, input, policy) })),
  );
  const policyRecipients = cleanEmailList(resolvedByMode.flatMap((entry) => entry.recipients));
  const personRecipients = cleanEmailList(
    resolvedByMode.filter((entry) => entry.mode !== "hr_notifications").flatMap((entry) => entry.recipients),
  );
  const hrRecipients = policy.includeHrInbox ? recipientsFromEnv() : [];
  const explicitRecipients = cleanEmailList(input.recipients ?? []);

  // GUARD 1 — a named person with no address is a RESOLUTION FAILURE, never an inbox fallback.
  // Without this, buildChannelEmailInput's empty `recipients` fell through to the stored policy,
  // and the "general" policy is configured recipient_modes = ["hr_notifications"], so the mail
  // shipped to the shared inbox with the intended person absent from To, CC and BCC — and was
  // recorded `sent`. That is how PR #1872's phantom `employees.name_en` column (which nulled every
  // work_email lookup for ~13h) stayed invisible, and how PHX-1 — a Super Admin account with no
  // work_email at all — quietly redirected 43 direct-order and weekly-plan emails.
  //
  // `personRecipients.length === 0` is load-bearing, NOT redundant. The auth emails (password
  // setup/reset, user_created) address the account holder by `candidateEmail` and deliberately
  // leave `recipients` empty, so they arrive here with recipientAddressUnresolved = true — and a
  // brand-new account has no employees.work_email yet, which is the whole reason it is being sent.
  // Skipping on the flag alone would have blocked exactly the welcome and password-reset mail that
  // matters most. The "candidate" mode resolves that address here, so those sends continue.
  if (input.recipientAddressUnresolved && !hasExplicitRecipients && personRecipients.length === 0) {
    const target = String(input.recipientHrId ?? "").trim().toUpperCase() || "unknown recipient";
    const reason =
      `Email skipped: no deliverable address for ${target}. The notification was addressed to that ` +
      `person, so it must not be redirected to the HR inbox — set their employees.work_email.`;
    logError("Notification email has no deliverable address for its intended recipient", {
      labels: {
        event: "notification_email_recipient_address_missing",
        hr_id: target,
        module: input.module ?? "unknown",
        notificationType: input.notificationType,
      },
    });
    return { reason, skipped: true };
  }

  // GUARD 2 — the same masking one level up: when the policy asked for real people (manager chain,
  // direct manager, employee, selected titles) and every one of them resolved to nothing, the HR
  // inbox must not be the thing that makes the list non-empty. contract_renewal, leave, resignation
  // and probation all carry include_hr_inbox = true, so a broken manager chain would otherwise send
  // an "escalation" that reaches only the inbox and reports success.
  if (!hasExplicitRecipients && personModes.length > 0 && personRecipients.length === 0) {
    const reason =
      `Email skipped: ${policy.label} routing (${personModes.join(", ")}) resolved no recipient emails. ` +
      `Not falling back to the HR inbox — that would hide the failed lookup.`;
    logError("Notification email policy resolved no real recipients", {
      labels: {
        event: "notification_email_policy_recipients_missing",
        module: input.module ?? "unknown",
        notificationType: input.notificationType,
        recipientModes: personModes.join(","),
      },
    });
    return { reason, skipped: true };
  }

  const rawCombined = hasExplicitRecipients
    ? [...explicitRecipients]
    : [...policyRecipients, ...hrRecipients, ...explicitRecipients];
  const recipients = cleanEmailList(rawCombined);

  if (recipients.length === 0) {
    return { reason: `Email skipped: ${policy.label} routing resolved no recipient emails.`, skipped: true };
  }

  return { policy, recipients, skipped: false };
}

function dashboardUrl(path = "/") {
  const base = (process.env.NOTIFICATION_DASHBOARD_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "");
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

/**
 * Resolve the greeting for the non-templated (general/probation-alert) notification path.
 *
 * Bug (owner report, 2026-07-17): this path always fell back to the generic "Dear {Brand} Team,"
 * even when the system knew exactly who it was writing to (`input.recipientName` — set by
 * buildChannelEmailInput for every single-recipient send). The templated-email path already does
 * this fallback correctly (see the `recipientName` resolution near sendTemplatedEmail); this path
 * did not. Only fall back to the team greeting when a notification-type policy has an explicit,
 * genuinely custom greeting (e.g. birthday's "Dear {employee},") or the recipient's name is
 * unknown (a role-based/HR-inbox send with no single addressee).
 */
function resolveGreeting(input: NotificationEmailInput, template?: EmailNotificationPolicy["template"]) {
  const configured = template?.greeting;
  const isGenericDefault = !configured || configured === systemNotificationEmailText.teamGreeting;
  if (isGenericDefault && input.recipientName) {
    return `Dear ${input.recipientHonorific ?? ""}${input.recipientName},`;
  }
  return templateValue(input, configured || systemNotificationEmailText.teamGreeting);
}

function effectiveTemplate(input: NotificationEmailInput, policy?: EmailNotificationPolicy): EmailTemplateContent {
  const template = policy?.template ?? defaultPolicyForType(input.notificationType ?? "general")?.template;
  return {
    bodyText: templateValue(input, template?.bodyText || "{summary}"),
    closingText: templateValue(input, template?.closingText || "Please review this update."),
    greeting: resolveGreeting(input, template),
    previewText: templateValue(input, template?.previewText || input.summary),
    subject: templateValue(input, template?.subject || "{subject}"),
    title: templateValue(input, template?.title || "{title}"),
  };
}

/**
 * The optional second button. Returns undefined unless BOTH halves are present, so a partially
 * filled caller renders the email it always rendered rather than a button that goes nowhere.
 *
 * Tone "secondary" rather than "primary": the email still has exactly one thing it is asking for,
 * and two orange buttons would make the reader choose between them.
 */
function secondaryActionFor(input: NotificationEmailInput) {
  const href = String(input.secondaryCtaHref ?? "").trim();
  const label = String(input.secondaryCtaLabel ?? "").trim();
  if (!href || !label) return undefined;
  return { href: dashboardUrl(href), label, tone: "secondary" as const };
}

function renderText(input: NotificationEmailInput, policy?: EmailNotificationPolicy) {
  const template = effectiveTemplate(input, policy);
  return renderGeneralNotificationEmailText({
    action: input.ctaHref ? { href: dashboardUrl(input.ctaHref), label: input.ctaLabel ?? "Open dashboard" } : undefined,
    secondaryAction: secondaryActionFor(input),
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
    secondaryAction: secondaryActionFor(input),
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
      .select(`job_title,${EMPLOYEE_LINE_SELECT}`)
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
    probation_milestone: {
      ctaHref: "/probation",
      ctaLabel: "Open live report",
      employeeHrId: "B-001",
      metrics: [
        { label: "Employee", value: "Mariam Nabil (B-001)" },
        { label: "Milestone", value: "Day 60" },
        { label: "Days remaining", value: "30" },
      ],
      notificationType: "probation_milestone",
      recipientMode: "candidate",
      subject: "Probation Day 60 - Mariam Nabil (plan to Day 75)",
      summary: "Mariam Nabil reached Day 60 - completion planning.",
      title: "Probation Day 60 - Mariam Nabil",
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

    return { ...summary, terminalFailed, available: true as const };
  } catch (error) {
    if (notificationSchemaMissing(error)) {
      // Outbox table/schema is not deployed. Return a discriminated "unavailable"
      // result so callers can render "—"/"Unavailable" instead of a misleading 0
      // (which reads as "a healthy, empty outbox"). The zeroed numeric fields keep
      // count-only consumers working; UI surfaces should key off `available`.
      return {
        available: false as const,
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

/**
 * Exported so the reconciliation check that counts guard rejections matches on the guard's OWN
 * wording rather than a copy of it. A rejection is recorded as `notification_deliveries.last_error`
 * with this prefix and `status = 'skipped'` — a status nothing alarms on — which is how 159 refused
 * official workflow emails stayed invisible for 68 days.
 */
export const identityGuardFailurePrefix = "Email identity guard failed";

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

/**
 * Is this the SELF-SERVICE six-digit code, as opposed to the admin-minted reset LINK?
 *
 * Both arrive as notificationType "password_reset" and they need different templates: the code
 * rides in the metrics and reaches the employee only through {{detailsTable}}, while the link
 * template renders {{ctaUrl}} and no table at all.
 *
 * WHY THIS IS A SHAPE TEST AND NOT THE SENDER'S PIN. requestPasswordResetCode does pin
 * templateKey: PASSWORD_RESET_CODE, and that pin is DISCARDED a few lines below — the explicit
 * branch vetoes every auth key on purpose, so a wording override can never move an account-recovery
 * email onto another template's recipient expansion. Adding the code key to isAuthTemplateKey
 * (#5484, so the email carries no List-Unsubscribe) therefore ALSO silenced that PR's own pin: the
 * send fell through to PASSWORD_RESET, the link body, and the digits went nowhere a second time.
 * Reading the notification's own content keeps both properties — the veto stands, and the code
 * email cannot be routed onto the link template by anything a template editor can change.
 */
function isPasswordResetCodeNotification(input: NotificationEmailInput) {
  return input.notificationType === "password_reset" && (
    String(input.templateKey ?? "").trim().toLowerCase() === EMAIL_TEMPLATE_KEYS.PASSWORD_RESET_CODE ||
    Boolean(metricValue(input, passwordResetCodeMetricLabel))
  );
}

function isPasswordSetupNotification(input: NotificationEmailInput) {
  return input.notificationType === "user_created" && (
    input.ctaHref?.includes("/password-setup/") ||
    input.title.toLowerCase().includes("create your phoenix workforce password")
  );
}

// Exported for tests: #5484 pinned a template key, a guard inside this function dropped it, and
// every assertion in that PR passed anyway because they all read SOURCE TEXT. The routing is the
// behaviour, so the test executes this.
export function migratedTemplateKeyForNotification(input: NotificationEmailInput) {
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
    if (moduleLabel === "attendance") {
      // notifyDigestSent pins an explicit templateKey ("attendance_digest") and is handled
      // by the `explicit` branch above, before we ever reach this switch. Everything else in
      // the attendance module (review requests, auto-confirm, disputes, plan/punch
      // mismatches, missing-punch steps) is a workflow-status notice, not a digest table, so
      // it gets its own dedicated admin-editable template instead of falling to GENERAL.
      return EMAIL_TEMPLATE_KEYS.ATTENDANCE_WORKFLOW;
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
  if (input.notificationType === "password_reset") {
    return isPasswordResetCodeNotification(input)
      ? EMAIL_TEMPLATE_KEYS.PASSWORD_RESET_CODE
      : EMAIL_TEMPLATE_KEYS.PASSWORD_RESET;
  }
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
  // Offer STATUS notifications (accepted/rejected/hire-approved) use the dedicated Offer Status
  // template.
  //
  // This comment used to say the JOB_OFFER template "stays reserved for the candidate offer
  // LETTER, which goes through sendTemplatedEmail('offer') independently". That call does not
  // exist and never did — measured 2026-09-05, the string `sendTemplatedEmail('offer')` appeared
  // in this repository exactly once: in the comment itself. A reader checking whether the key was
  // wired would have found a sentence asserting it was.
  //
  // What actually sends a candidate their offer letter is the offers module — src/lib/offers/send.ts
  // renders its own block templates for both the PDF and the email body, because a letter needs a
  // letterhead, a compensation table and a signature block that this key/value template system has
  // no way to express. So EMAIL_TEMPLATE_KEYS.JOB_OFFER has no consumer and, in production, no
  // template row either. It is kept rather than deleted because the key set is data other rows
  // reference, and removing a key is a migration, not an edit.
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

function isAuthTemplateKey(templateKey: string) {
  return (
    templateKey === EMAIL_TEMPLATE_KEYS.PASSWORD_SETUP ||
    templateKey === EMAIL_TEMPLATE_KEYS.PASSWORD_RESET ||
    templateKey === EMAIL_TEMPLATE_KEYS.PASSWORD_RESET_CODE ||
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
  const directManager = managers[0];
  const districtManagers = managers.filter(isDistrictManagerContact);
  const cc = cleanEmailList([
    directManager?.work_email,
    ...districtManagers.map((manager) => manager.work_email),
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
 * (an approval/auth/lifecycle email) was silently dropped — worth flagging.
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
  | "no_deliverable_recipient"
  | "probation_audit_failed"
  | "payslip_email_blocked"
  | "held_for_review";

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
 * sets `sentryEscalate` because it means a real alert was dropped.
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
  // Payslip hard block. Never retries — owner rule means payslip emails never fire, period.
  if (r.includes("payslip emails are hard-blocked")) {
    return { terminal: true, sentryEscalate: false, code: "payslip_email_blocked" };
  }
  // HELD BY THE CONFIDENCE GATE — awaiting a Super Admin at /admin/notification-confidence.
  //
  // This is not a failure and retrying cannot change it: the gate re-evaluates to the same hold
  // every cycle, because what it is waiting for is a HUMAN, not a different moment. Left
  // unclassified it fell through to `{ terminal: false }`, so the drain called
  // markNotificationOutboxFailed five times and then marked the row permanently `failed`.
  //
  // It happened: 21 resignation emails on 2026-08-28, attempts 5/5, dead in the queue. Worse than
  // the wasted retries, the row then LIES — it reads as a delivery failure when the notification
  // was intact and simply waiting for review, so it pollutes the failure metrics the drain's
  // dead-man's-switch watches and hides what actually needs doing (a decision, not a fix).
  //
  // Terminal skip is the honest state: the outbox is done with it, and the review workspace is
  // where it lives now. Release from there sends it; discarding closes it. No Sentry escalation —
  // a hold is the gate working as designed, and the standing held-notification alert already
  // covers a backlog that nobody reviews.
  if (r.includes("held for super admin review")) {
    return { terminal: true, sentryEscalate: false, code: "held_for_review" };
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

async function enrichRecipientsWithManagerCc(
  input: NotificationEmailInput,
  toRecipients: string[],
): Promise<{ cc: string[]; enrichmentLog: Record<string, unknown> }> {
  const enrichmentLog: Record<string, unknown> = {
    employeeHrId: input.employeeHrId ?? null,
    originalToCount: toRecipients.length,
    originalCcCount: (input.cc ?? []).length,
  };

  if (!input.employeeHrId) {
    enrichmentLog.reason = "No employeeHrId - manager CC lookup skipped";
    return { cc: input.cc ?? [], enrichmentLog };
  }

  try {
    const [employee, managers] = await Promise.all([
      loadEmployeeContact(input.employeeHrId),
      loadManagerChain(input.employeeHrId, 1),
    ]);

    const employeeEmail = employee?.work_email?.trim().toLowerCase() ?? null;
    const directManager = managers[0];
    const directManagerEmail = directManager?.work_email?.trim().toLowerCase() ?? null;

    enrichmentLog.employeeEmail = employeeEmail;
    enrichmentLog.directManagerEmail = directManagerEmail;
    enrichmentLog.directManagerName = directManager?.full_name ?? null;
    enrichmentLog.directManagerHrId = directManager?.hr_id ?? null;

    if (!employeeEmail) {
      enrichmentLog.reason = "Employee has no work_email - manager CC skipped";
      return { cc: input.cc ?? [], enrichmentLog };
    }

    const toSet = new Set(toRecipients.map((e) => e.trim().toLowerCase()));
    const employeeIsPrimaryTo = toSet.has(employeeEmail);

    if (!employeeIsPrimaryTo) {
      enrichmentLog.reason = "Employee is not the primary To recipient - manager CC skipped";
      return { cc: input.cc ?? [], enrichmentLog };
    }

    const mergedCc = new Set<string>();
    for (const addr of (input.cc ?? [])) {
      const lc = addr.trim().toLowerCase();
      if (lc && validEmail(lc)) mergedCc.add(lc);
    }

    if (directManagerEmail && validEmail(directManagerEmail) && !toSet.has(directManagerEmail)) {
      if (!mergedCc.has(directManagerEmail)) {
        mergedCc.add(directManagerEmail);
        enrichmentLog.managerAddedToCc = true;
      } else {
        enrichmentLog.managerAlreadyInCc = true;
      }
    } else if (!directManagerEmail) {
      enrichmentLog.managerMissing = true;
    } else if (!validEmail(directManagerEmail)) {
      enrichmentLog.managerInvalidEmail = directManagerEmail;
    } else if (toSet.has(directManagerEmail)) {
      enrichmentLog.managerAlreadyInTo = true;
    }

    return { cc: Array.from(mergedCc), enrichmentLog };
  } catch (error) {
    enrichmentLog.reason = "Error during manager CC lookup";
    enrichmentLog.error = error instanceof Error ? error.message : String(error);
    console.log("Recipient enrichment (manager CC lookup) failed", {
      level: "warning",
      tags: { component: "email", enrichment: "manager_cc" },
      extra: enrichmentLog,
    });
    return { cc: input.cc ?? [], enrichmentLog };
  }
}

function validateAllRecipients(to: string[], cc: string[], bcc: string[]): {
  invalid: { to: string[]; cc: string[]; bcc: string[] };
  sanitized: { to: string[]; cc: string[]; bcc: string[] };
} {
  const invalid = { to: [] as string[], cc: [] as string[], bcc: [] as string[] };
  const sanitized = { to: [] as string[], cc: [] as string[], bcc: [] as string[] };

  const process = (list: string[], bucket: "to" | "cc" | "bcc") => {
    for (const raw of list) {
      const value = String(raw ?? "").trim().toLowerCase();
      if (!value) continue;
      if (validEmail(value)) sanitized[bucket].push(value);
      else invalid[bucket].push(raw);
    }
  };

  process(to, "to");
  process(cc, "cc");
  process(bcc, "bcc");

  const toSet = new Set(sanitized.to);
  sanitized.cc = sanitized.cc.filter((e) => {
    if (toSet.has(e)) return false;
    toSet.add(e);
    return true;
  });
  sanitized.bcc = sanitized.bcc.filter((e) => !toSet.has(e) ? (toSet.add(e), true) : false);

  return { invalid, sanitized };
}

async function sendNotificationEmailDirect(input: NotificationEmailInput): Promise<SendEmailResult> {
  if (!emailNotificationsEnabled()) {
    return { reason: "EMAIL_NOTIFICATIONS_ENABLED is not true.", skipped: true };
  }
  if (payloadLooksLikePayslip(input)) {
    const reason = "Payslip emails are hard-blocked per owner rule (payslip-channel-guard layer 5 — sendNotificationEmailDirect choke-point).";
    console.log("Payslip email BLOCKED at sendNotificationEmailDirect choke-point", {
      level: "error",
      tags: {
        component: "email",
        outboxSkipCode: "payslip_email_blocked",
        notificationType: input.notificationType ?? "unknown",
      },
      extra: {
        eventType: input.eventType ?? null,
        templateKey: input.templateKey ?? null,
        module: input.module ?? null,
        employeeHrId: input.employeeHrId ?? null,
        recipientHrId: input.recipientHrId ?? null,
        subject: input.subject?.slice(0, 140) ?? null,
        title: input.title?.slice(0, 140) ?? null,
      },
    });
    return { reason, skipped: true };
  }
  const identity = validateNotificationEmailIdentity(input);
  if (!identity.ok) {
    console.log("Email identity guard blocked notification", {
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

  const enriched = await enrichRecipientsWithManagerCc(input, delivery.recipients);
  const ccList = enriched.cc.filter((address) => !delivery.recipients.includes(address));

  const validation = validateAllRecipients(delivery.recipients, ccList, input.bcc ?? []);
  if (validation.invalid.to.length + validation.invalid.cc.length + validation.invalid.bcc.length > 0) {
    console.log("Email send had invalid recipient addresses filtered before dispatch", {
      level: "warning",
      tags: {
        component: "email",
        notificationType: input.notificationType ?? "unknown",
        invalidRecipients: "true",
      },
      extra: {
        managerEnrichment: enriched.enrichmentLog,
        invalid: validation.invalid,
        sanitizedCounts: {
          to: validation.sanitized.to.length,
          cc: validation.sanitized.cc.length,
          bcc: validation.sanitized.bcc.length,
        },
      },
    });
  }

  if (validation.sanitized.to.length === 0) {
    const reason = "No valid To recipients after format validation.";
    console.log("Email send skipped: no valid To recipients after format validation", {
      level: "error",
      tags: { component: "email", notificationType: input.notificationType ?? "unknown" },
      extra: { managerEnrichment: enriched.enrichmentLog, invalid: validation.invalid },
    });
    return { reason, skipped: true };
  }

  const cc = validation.sanitized.cc.length > 0 ? validation.sanitized.cc : undefined;
  const bcc = validation.sanitized.bcc.length > 0 ? validation.sanitized.bcc : undefined;
  const inputWithCc: NotificationEmailInput = { ...input, cc, bcc };

  const requestId = notificationDedupeKey(inputWithCc);
  const migratedTemplateKey = migratedTemplateKeyForNotification(input);
  const finalTo = validation.sanitized.to;
  const finalCc = cc;
  const finalBcc = bcc;

  const origin = {
    employeeHrId: input.employeeHrId ?? null,
    eventType: input.eventType ?? null,
    identityStatus: input.identityStatus ?? null,
    module: input.module ?? null,
    notificationType: input.notificationType ?? null,
    recipientHrId: input.recipientHrId ?? null,
    templateKey: input.templateKey ?? null,
  };

  if (migratedTemplateKey) {
    const baseOverrides = await migratedTemplateRecipientOverrides(migratedTemplateKey, inputWithCc, finalTo);
    const templateToClean = cleanEmailList(baseOverrides.to ?? []);
    const templateEnriched = await enrichRecipientsWithManagerCc(input, templateToClean);
    const templateCcBase = cleanEmailList([
      ...(baseOverrides.cc ?? []),
      ...templateEnriched.cc,
    ]);
    const templateCcFinal = templateCcBase.filter((e) => !templateToClean.includes(e));
    const templateValidation = validateAllRecipients(templateToClean, templateCcFinal, [
      ...(baseOverrides.bcc ?? []),
      ...(inputWithCc.bcc ?? []),
    ]);
    if (templateValidation.invalid.to.length + templateValidation.invalid.cc.length + templateValidation.invalid.bcc.length > 0) {
      console.log("Templated email send had invalid recipients filtered", {
        level: "warning",
        tags: {
          component: "email",
          notificationType: input.notificationType ?? "unknown",
          templateKey: migratedTemplateKey,
        },
        extra: {
          baseManagerEnrichment: enriched.enrichmentLog,
          templateManagerEnrichment: templateEnriched.enrichmentLog,
          templateInvalid: templateValidation.invalid,
          templateSanitized: templateValidation.sanitized,
        },
      });
    }
    const dispatchTo = templateValidation.sanitized.to.length > 0 ? templateValidation.sanitized.to : finalTo;
    const dispatchCc = templateValidation.sanitized.cc.length > 0 ? templateValidation.sanitized.cc : undefined;
    const dispatchBcc = templateValidation.sanitized.bcc.length > 0 ? templateValidation.sanitized.bcc : finalBcc;

    if (dispatchTo.length === 0) {
      return { reason: "No valid To recipients after format validation for templated email.", skipped: true };
    }

    const overrides = {
      bcc: dispatchBcc,
      cc: dispatchCc,
      replaceRecipients: true as const,
      to: dispatchTo,
    };
    // Every caller that passes `metrics` (the label/value pairs already shown in the in-app
    // notification and, historically, hand-rolled into each template's own inline HTML table)
    // gets a premium zebra-striped table for free via {{detailsTable}} - no per-template
    // sender changes needed. Callers with no metrics simply render an empty string.
    return sendTemplatedEmail({
      candidateEmail: input.candidateEmail,
      context: {
        ctaLabel: input.ctaLabel ?? systemNotificationEmailText.openInAppCtaLabel,
        ctaUrl: input.ctaHref ? dashboardUrl(input.ctaHref) : "",
        detailsTable: renderPhoenixMetadataTable(input.metrics),
        detailsTableText: renderPhoenixMetadataTableText(input.metrics),
        amount: metricValue(input, "Amount"),
        approvalFlow: metricValue(input, "Approval Flow"),
        candidateName: metricValue(input, "Candidate") || metricValue(input, "Candidate Name"),
        date: metricValue(input, "Birthday") || metricValue(input, "Effective date") || metricValue(input, "Date") || new Date().toISOString().slice(0, 10),
        area: metricValue(input, "Area"),
        destination: metricValue(input, "Destination"),
        duration: metricValue(input, "Duration") || metricValue(input, "Trip length"),
        endDate: metricValue(input, "Renewal date") || metricValue(input, "Trip end"),
        employeeHrId: input.employeeHrId || metricValue(input, "HR_ID") || metricValue(input, "Login ID"),
        employeeName: employeeNameFromNotification(input),
        expiryText: metricValue(input, "Expires"),
        // Offer/recruitment callers label the position metric "Role".
        jobTitle: metricValue(input, "Job Title") || metricValue(input, "Role"),
        line: metricValue(input, "Line"),
        managerName: metricValue(input, "Manager") || metricValue(input, "Manager Name"),
        planTable: input.planTableHtml,
        planTableText: input.planTableText,
        honorific: input.recipientHonorific ?? "",
        // Auth emails (password setup/reset, user-created) go to the account owner
        // themselves, so greet them by their real name when the caller supplied it
        // (sendPasswordSetupLink passes recipientName = the employee's name; see
        // system.ts buildChannelEmailInput). Fall back to the generic "Phoenix User"
        // only for login-only accounts with no name on file — never an HR_ID. The
        // honorific (line above) already flows, so this yields e.g. "Dear Dr. Omar …"
        // instead of "Dear Phoenix User".
        recipientName: isAuthTemplateKey(migratedTemplateKey)
          ? input.recipientName?.trim() || systemNotificationEmailText.userRecipientName
          : input.recipientName || employeeNameFromNotification(input) || systemNotificationEmailText.teamRecipientName,
        startDate: metricValue(input, "Hire date") || metricValue(input, "Trip start"),
        // The caller's own explicit "Status" metric (e.g. "Pending manager approval",
        // "Approved") — NOT a dump of every metric (see removed notificationMetricStatus).
        status: metricValue(input, "Status"),
        subject: input.subject,
        summary: input.summary,
        // Caller-supplied template fields (e.g. marketing financials, products table) — merged
        // last so module callers can populate their template-specific tokens.
        ...(input.templateContext ?? {}),
      },
      employeeHrId: input.employeeHrId,
      fallbackTo: dispatchTo,
      from,
      // The weekly attendance review's email keeps its paragraphs (owner, 2026-09-17); every other
      // module's body renders as before.
      lineBreaks: emailKeepsLineBreaks(input.module),
      origin,
      overrides,
      templateKey: migratedTemplateKey,
    });
  }

  const fanout = finalTo.length > 1;
  return sendPhoenixEmail({
    bcc: finalBcc,
    cc: finalCc,
    // A job candidate has no employee record, so their address is unknown to the Recipient
    // Assurance Guard by definition. Declare it, or every offer/recruitment email blocks.
    externalRecipients: input.candidateEmail ? [input.candidateEmail] : undefined,
    fanoutToBcc: true,
    from,
    // Per-address one-click token only for single-recipient sends; fan-outs go to internal
    // staff (manager chain / HR inbox) and use the mailto fallback.
    headers: listUnsubscribeHeaders(input.notificationType, fanout ? undefined : finalTo[0]),
    // Lets the send path tell a password reset from a newsletter, so a recipient's
    // unsubscribe cannot withhold their own account-recovery mail.
    notificationType: input.notificationType,
    html: renderHtml(input, delivery.policy),
    idempotencyKey: requestId,
    origin,
    subject: notificationSubject(input, delivery.policy),
    text: renderText(input, delivery.policy),
    to: finalTo,
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

/**
 * Which runtime enqueued this row: "production", "staging", "development"…
 *
 * `.env.local` points at PRODUCTION Supabase (AGENTS.md §3), so `pnpm run dev` writes real rows
 * into the real outbox. That local process has no `EMAIL_NOTIFICATIONS_ENABLED`, so every one of
 * those rows is immediately skipped with "EMAIL_NOTIFICATIONS_ENABLED is not true" — and until now
 * nothing on the row said where it came from. 63 such rows sit in production and are
 * indistinguishable from a genuine production email outage.
 *
 * That ambiguity is expensive: it is exactly what made "the system is not firing emails" look real
 * on 2026-09-05, and settling it needed clock forensics — 40 of those 63 rows have `updated_at`
 * EARLIER than `created_at`, because the two timestamps come from different machines, against 2 of
 * 2,231 everywhere else. Stamping the origin turns an afternoon of archaeology into one glance.
 *
 * Same expression as the error monitor's own label, deliberately: one definition of "which
 * environment am I", so the two never disagree about the same run.
 */
function enqueueOriginEnvironment(): string {
  return process.env.APP_ENV || process.env.NODE_ENV || "development";
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
      // Stamped into the payload rather than a new column: no migration, and it travels with the
      // row wherever the payload is read.
      payload: { ...input, originEnvironment: enqueueOriginEnvironment() },
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
  const { error } = await supabase
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
  // The email already went out at the provider. If we fail to flip the row to "sent",
  // the next drain cycle will re-send it (duplicate). Surface the failure so the
  // misconfiguration/transient DB error is visible instead of silently duplicating mail.
  if (error) {
    logError("Notification outbox row failed to mark sent (risk of duplicate send)", {
      labels: { event: "outbox_mark_sent_failed", outbox_id: row.id },
      error,
    });
  }
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
    console.log("Email outbox row terminally failed", {
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

// A row that has used up its attempts never leaves the ('pending','failed') window - nothing marks
// it terminal - and the eligibility test cannot run in SQL, because PostgREST has no
// column-to-column comparison for `attempts < max_attempts`. So a plain `.limit(limit)` caps the
// batch BEFORE the dead rows are discarded rather than after, and one full batch of exhausted rows
// starves every retryable row behind them, permanently.
//
// That is not hypothetical. On 2026-08-27 production held exactly 50 exhausted rows against this
// job's limit of 50 (`/api/notifications/process?limit=50`): every run fetched those 50, filtered
// all 50 away, and returned nothing. It had done so every 5 minutes since 2026-08-14 - the day the
// exhausted count reached 50 - while 49 genuinely retryable rows waited behind them. The cron was
// green, HTTP 200, `attempted: 0`, so nothing ever alerted and retries were silently dead for 13
// days.
//
// Page past the dead rows instead of letting one batch of them cap the scan.
const outboxScanPageSize = 100;
const outboxMaxScanPages = 10;

type DueOutboxPageFetcher = (from: number, to: number) => Promise<NotificationOutboxRow[]>;

async function fetchDueNotificationOutboxPage(from: number, to: number): Promise<NotificationOutboxRow[]> {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from(notificationOutboxTable)
    .select("*")
    .in("status", ["pending", "failed"])
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${now}`)
    // Keep the dead rows OUT of the window rather than only surviving them. The comment above is
    // right that `attempts < max_attempts` is not expressible in PostgREST - but comparing the
    // column to the CONSTANT is, and `max_attempts` is `NOT NULL DEFAULT 5` here and is written
    // only from `notificationOutboxMaxAttempts` (the insert above), so for every row this app
    // creates the two tests are the same test. Measured 2026-08-27: 5 on all 1,964 rows.
    //
    // This is what turns the paging above from a bigger fuse into a fix. Paging alone still has a
    // ceiling - `outboxScanPageSize * outboxMaxScanPages` = 1,000 rows - and exhausted rows still
    // accumulate forever, so the same freeze returns once 1,000 of them sit at the head. With this
    // filter they never enter the scan at all and there is nothing to page past.
    //
    // The JS `attempts < max_attempts` check in the loader STAYS and remains the authority: if a
    // row ever carries a different `max_attempts`, this filter is merely an imperfect prefilter and
    // that check is what keeps the result correct.
    .lt("attempts", notificationOutboxMaxAttempts)
    .order("created_at", { ascending: true })
    // `created_at` ties (7 rows share one in production, in pairs) leave the order undefined
    // BETWEEN the separate `.range()` calls above, which silently skips or double-returns a row at
    // a page boundary. `id` is the primary key, so it makes the sort total and the paging stable.
    .order("id", { ascending: true })
    .range(from, to);

  if (error) throw error;
  return (data ?? []) as NotificationOutboxRow[];
}

// `fetchPage` is injectable so the starvation case can be tested without a database.
export async function loadDueNotificationOutboxRows(
  limit: number,
  fetchPage: DueOutboxPageFetcher = fetchDueNotificationOutboxPage,
) {
  const eligible: NotificationOutboxRow[] = [];
  let skippedExhausted = 0;
  let pagesRead = 0;
  let scanCappedAtPageLimit = false;

  for (let page = 0; page < outboxMaxScanPages && eligible.length < limit; page += 1) {
    const from = page * outboxScanPageSize;
    const rows = await fetchPage(from, from + outboxScanPageSize - 1);
    pagesRead += 1;
    if (rows.length === 0) break;
    const live = rows.filter((row) => row.attempts < row.max_attempts);
    skippedExhausted += rows.length - live.length;
    eligible.push(...live);
    if (rows.length < outboxScanPageSize) break;
    // The loop ran out of pages while the queue kept going and the batch is still not full:
    // exactly the shape that froze the drain, only now it costs a delay instead of a freeze.
    if (page === outboxMaxScanPages - 1 && eligible.length < limit) scanCappedAtPageLimit = true;
  }

  // The original failure was silent for thirteen days: HTTP 200, `attempted: 0`, indistinguishable
  // from an empty queue. Paging past the dead rows fixes the starvation but says nothing, so the
  // early warning would still be missing. This line is that warning — if exhausted rows are being
  // walked past on every tick, the count climbs here long before the batch is capped again.
  if (skippedExhausted > 0) {
    console.log("Outbox batch walked past exhausted rows", {
      level: scanCappedAtPageLimit ? "error" : "warning",
      tags: { component: "email", cron: "outbox-processing" },
      extra: {
        limit,
        pagesRead,
        returned: Math.min(eligible.length, limit),
        // A true here means the scan hit its ceiling with the batch still unfilled — the drain is
        // degraded now and starves outright once the dead rows outgrow the whole scan window.
        scanCappedAtPageLimit,
        scanWindow: outboxScanPageSize * outboxMaxScanPages,
        skippedExhausted,
      },
    });
  }

  return eligible.slice(0, limit);
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
  } catch (error) {
    if (!notificationSchemaMissing(error)) {
      logError("Failed to reap stale processing notification outbox rows", {
        labels: { event: "outbox_reap_stale_failed" },
        error,
      });
    }
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
      logError("Notification outbox retention cleanup failed", {
        labels: { event: "outbox_retention_cleanup_failed" },
        error: outboxError,
      });
    }
    outboxDeleted = outboxData?.length ?? 0;
  } catch (error) {
    if (!notificationSchemaMissing(error)) {
      logError("Unexpected error during notification outbox retention cleanup", {
        labels: { event: "outbox_retention_cleanup_unexpected_error" },
        error,
      });
    }
  }

  try {
    const supabase = getSupabaseAdmin();

    // Terminal failed/skipped rows still hold their PII-bearing payload (HR_IDs, names,
    // candidate emails). At 90 days these are unquestionably terminal — purge them too,
    // so retention is not limited to successfully-sent rows.
    const { data: terminalData, error: terminalError } = await supabase
      .from(notificationOutboxTable)
      .delete()
      .in("status", ["failed", "skipped"])
      .not("updated_at", "is", null)
      .lt("updated_at", thresholdIso)
      .select("id");

    if (terminalError && !notificationSchemaMissing(terminalError)) {
      logError("Notification outbox terminal-row retention cleanup failed", {
        labels: { event: "outbox_terminal_retention_cleanup_failed" },
        error: terminalError,
      });
    }
    outboxTerminalDeleted = terminalData?.length ?? 0;
  } catch (error) {
    if (!notificationSchemaMissing(error)) {
      logError("Unexpected error during notification outbox terminal-row retention cleanup", {
        labels: { event: "outbox_terminal_retention_cleanup_unexpected_error" },
        error,
      });
    }
  }

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
      logError("Email delivery events retention cleanup failed", {
        labels: { event: "delivery_events_retention_cleanup_failed" },
        error: eventsError,
      });
    }
    eventsRedacted = eventsData?.length ?? 0;
  } catch (error) {
    if (!notificationSchemaMissing(error)) {
      logError("Unexpected error during email delivery events redaction", {
        labels: { event: "delivery_events_redaction_unexpected_error" },
        error,
      });
    }
  }

  return { eventsRedacted, outboxDeleted, outboxTerminalDeleted };
}

/**
 * MOD-4 (2026-07-17): a pre-send correctness audit for probation emails. Before a probation email
 * is dispatched from the outbox, confirm it is not broken — no unresolved {{token}} leaked into any
 * user-facing value, a non-empty subject/title, and the employee shown by NAME (never a bare
 * HR_ID). This is the runtime backstop to the build-time render-core harness: a broken probation
 * email (like the 2026-07-14 blank-token incident) is BLOCKED from reaching an inbox and surfaced
 * as a terminal skip instead of silently going out wrong.
 */
export function auditProbationOutboundEmail(payload: NotificationEmailInput): { ok: true } | { ok: false; reason: string } {
  const strings: string[] = [];
  const push = (v: unknown) => { if (typeof v === "string" && v.trim()) strings.push(v); };
  push(payload.subject); push(payload.title); push(payload.summary); push(payload.ctaLabel);
  for (const m of payload.metrics ?? []) push(String(m.value));
  for (const v of Object.values(payload.templateContext ?? {})) push(typeof v === "string" ? v : "");

  const unresolved = strings.find((s) => /\{\{\s*[a-zA-Z0-9_]+\s*\}\}/.test(s));
  if (unresolved) return { ok: false, reason: `probation email carries an unresolved template token: "${unresolved.slice(0, 80)}"` };

  if (!String(payload.subject ?? "").trim() && !String(payload.title ?? "").trim()) {
    return { ok: false, reason: "probation email has no subject/title" };
  }

  const employeeHrId = String(payload.employeeHrId ?? "").trim().toUpperCase();
  const nameCarriers = [
    payload.templateContext?.employeeName,
    payload.metrics?.find((m) => m.label.trim().toLowerCase() === "employee")?.value,
  ].map((v) => String(v ?? "").trim()).filter(Boolean);
  if (employeeHrId && nameCarriers.length > 0 && nameCarriers.some((n) => n.toUpperCase() === employeeHrId)) {
    return { ok: false, reason: `probation email shows the raw HR_ID (${employeeHrId}) instead of the employee name` };
  }
  return { ok: true };
}

async function processNotificationOutboxRow(row: NotificationOutboxRow): Promise<SendEmailResult> {
  const isRetry = row.attempts > 0;
  const claimed = await claimNotificationOutboxRow(row.id);
  if (!claimed) {
    return { reason: "Notification is already being processed.", skipped: true };
  }

  try {
    const identity = validateNotificationEmailIdentity(claimed.payload);
    if (!identity.ok) {
      await markNotificationOutboxSkipped(claimed, identity.reason, "unsafe_identity");
      console.log("Email outbox row blocked by identity guard", {
        level: "error",
        tags: {
          component: "email",
          cron: "outbox-processing",
          notificationType: claimed.payload.notificationType ?? "unknown",
          outboxSkipCode: "unsafe_identity",
        },
        extra: { id: claimed.id, isRetry, ...identity.metadata },
      });
      return { reason: identity.reason, skipped: true };
    }

    // MOD-4 pre-send audit — a probation email must pass a correctness check before it fires.
    if (claimed.payload.notificationType === "probation") {
      const audit = auditProbationOutboundEmail(claimed.payload);
      if (!audit.ok) {
        await markNotificationOutboxSkipped(claimed, audit.reason, "probation_audit_failed");
        console.log("Probation email blocked by pre-send audit", {
          level: "error",
          tags: { component: "email", cron: "outbox-processing", notificationType: "probation", outboxSkipCode: "probation_audit_failed" },
          extra: { id: claimed.id, isRetry, reason: audit.reason },
        });
        return { reason: audit.reason, skipped: true };
      }
    }

    const payloadSummary = {
      id: claimed.id,
      attempts: row.attempts,
      isRetry,
      lastError: row.last_error ?? null,
      notificationType: claimed.payload.notificationType ?? "unknown",
      employeeHrId: claimed.payload.employeeHrId ?? null,
      module: claimed.payload.module ?? null,
      eventType: claimed.payload.eventType ?? null,
      originalCcCount: (claimed.payload.cc ?? []).length,
      originalToCount: (
        cleanEmailList(claimed.payload.recipients ?? []).length ||
        cleanEmailList([claimed.payload.candidateEmail]).length
      ),
      subject: claimed.payload.subject?.slice(0, 120) ?? null,
    };
    if (isRetry) {
      console.log("Retrying failed outbox email", {
        level: "info",
        tags: {
          component: "email",
          cron: "outbox-processing",
          isRetry: "true",
          notificationType: claimed.payload.notificationType ?? "unknown",
        },
        extra: payloadSummary,
      });
    } else {
      console.log("Processing new outbox email", {
        level: "info",
        tags: { component: "email", cron: "outbox-processing" },
        extra: payloadSummary,
      });
    }

    // Payslip hard block (layer 4 outbox dispatch guard). Runs even if all upstream layers
    // somehow got bypassed — catches payslip-named content in eventType, templateKey, subject,
    // summary, title, ctaHref, module, or recipient fields.
    if (payloadLooksLikePayslip(claimed.payload)) {
      const skipReason = "Payslip emails are hard-blocked per owner rule (payslip-channel-guard layer 4 — outbox dispatch guard).";
      await markNotificationOutboxSkipped(claimed, skipReason, "payslip_email_blocked");
      console.log("Payslip email BLOCKED at outbox dispatch guard", {
        level: "error",
        tags: {
          component: "email",
          cron: "outbox-processing",
          outboxSkipCode: "payslip_email_blocked",
          notificationType: claimed.payload.notificationType ?? "unknown",
        },
        extra: {
          id: claimed.id,
          attempts: claimed.attempts,
          eventType: claimed.payload.eventType ?? null,
          templateKey: claimed.payload.templateKey ?? null,
          module: claimed.payload.module ?? null,
          employeeHrId: claimed.payload.employeeHrId ?? null,
          recipientHrId: claimed.payload.recipientHrId ?? null,
          subject: claimed.payload.subject?.slice(0, 140) ?? null,
          title: claimed.payload.title?.slice(0, 140) ?? null,
        },
      });
      return { reason: skipReason, skipped: true };
    }

    const result = await sendNotificationEmailDirect(claimed.payload);
    if (result.skipped) {
      const classification = classifyOutboxSkip(result.reason, claimed.payload.notificationType);
      if (classification.terminal) {
        await markNotificationOutboxSkipped(claimed, result.reason, classification.code);
        if (classification.sentryEscalate) {
          console.log("High-priority notification dropped: no recipients resolved", {
            level: "warning",
            tags: {
              component: "email",
              cron: "outbox-processing",
              outboxSkipCode: classification.code,
              notificationType: claimed.payload.notificationType ?? "unknown",
            },
            extra: { id: claimed.id, isRetry, reason: result.reason },
          });
        }
        if (isRetry) {
          console.log("Retried email terminally skipped", {
            level: "warning",
            tags: {
              component: "email",
              cron: "outbox-processing",
              isRetry: "true",
              outboxSkipCode: classification.code,
            },
            extra: { ...payloadSummary, skipReason: result.reason },
          });
        }
        return result;
      }
      // Transient skip (e.g. template temporarily unavailable) → retry within budget.
      if (isRetry) {
        console.log("Retried email marked transient failed — will re-attempt later", {
          level: "warning",
          tags: { component: "email", cron: "outbox-processing", isRetry: "true" },
          extra: { ...payloadSummary, skipReason: result.reason },
        });
      }
      await markNotificationOutboxFailed(claimed, result.reason);
      return result;
    }

    if (isRetry) {
      console.log("Retried outbox email sent successfully", {
        level: "info",
        tags: {
          component: "email",
          cron: "outbox-processing",
          isRetry: "true",
          notificationType: claimed.payload.notificationType ?? "unknown",
        },
        extra: { ...payloadSummary, providerMessageId: result.id ?? null },
      });
    }

    await markNotificationOutboxSent(claimed, result.id);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Email notification failed.";
    const retryAfterMs = error instanceof RetryableEmailError ? error.retryAfterMs : undefined;
    if (isRetry) {
      console.log("Retried outbox email threw exception — scheduling retry", {
        level: "error",
        tags: {
          component: "email",
          cron: "outbox-processing",
          errorClass: error instanceof RetryableEmailError ? "retryable" : "terminal",
          isRetry: "true",
          notificationType: claimed.payload.notificationType ?? "unknown",
        },
        extra: {
          attempts: row.attempts,
          errorMessage: message,
          id: claimed.id,
          lastError: row.last_error ?? null,
          retryAfterMs: retryAfterMs ?? null,
        },
      });
    }
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
    console.log("Email outbox processing had failures", {
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
      console.log("Email identity guard blocked enqueue", {
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
      // A terminal skip (e.g. the payslip hard block, an identity-guard block) already marked
      // the outbox row "skipped" for good — nothing will ever retry it. Blindly prefixing every
      // skip reason with "Queued for retry:" made system.ts's callers (which branch on that
      // exact prefix) treat a permanently-blocked email as a successful handoff and record the
      // delivery as "sent" with no error. Bug found 2026-08-08: a Part 2 payroll milestone email
      // whose own body text mentioned "payslips" tripped the payslip guard and silently vanished
      // behind a healthy-looking notification_deliveries row. Classify first, exactly like
      // processNotificationOutboxRow itself already does to choose between
      // markNotificationOutboxSkipped and markNotificationOutboxFailed.
      const classification = classifyOutboxSkip(result.reason, input.notificationType);
      const reason = classification.terminal ? result.reason : `Queued for retry: ${result.reason}`;
      return { reason, skipped: true } satisfies SendEmailResult;
    }

    return result;
  } catch (error) {
    if (notificationSchemaMissing(error)) {
      return sendNotificationEmailDirect(input);
    }
    logError("Notification email send failed", {
      labels: { event: "notification_email_send_failed", notification_type: input.notificationType ?? "unknown" },
      error,
    });
    logError("Email notification failed", {
      labels: { event: "notification_email_failed" },
      error,
    });
    return {
      reason: error instanceof Error ? error.message : "Email notification failed.",
      skipped: true,
    } satisfies SendEmailResult;
  }
}
