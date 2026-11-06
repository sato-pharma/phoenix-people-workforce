// Read-only rollup across the 3 existing, independently-configured automated email systems —
// role-recipients (cron/HR digests), email-notification policies (core system emails), and
// email templates (~34 templated emails) — so the admin "Email Control Center" dashboard can
// show every automated email in one place. This is composition only: every value here is read
// straight from the same functions that already gate real production sends, so there is no
// separate "toggle state" to drift out of sync with reality.
import { getNotificationRolePolicies, type NotificationRoleKey, type NotificationRolePolicy } from "@/lib/notifications/role-recipients";
import { getEmailNotificationPolicies, type EmailNotificationPolicy, type EmailNotificationType } from "@/lib/notifications/email";
import { getEmailTemplateCatalog, type EmailTemplateRow } from "@/lib/email-templates/service";

export type EmailControlCenterSourceSystem = "role_recipients" | "email_notifications" | "email_templates";

export type EmailControlCenterRecipientSummary = {
  kind: "roles" | "recipient_mode" | "template_rules" | "not_role_configurable";
  roles?: string[];
  recipientMode?: string;
  recipientModes?: string[];
  targetTitles?: string[];
  targetLines?: string[];
  toRoles?: string[];
  ccRoles?: string[];
  bccRoles?: string[];
  countLabel: string;
};

export type EmailControlCenterItem = {
  id: string;
  sourceSystem: EmailControlCenterSourceSystem;
  key: string;
  label: string;
  description: string;
  module: string;
  enabled: boolean;
  recipientSummary: EmailControlCenterRecipientSummary;
  hybridNotice?: string | null;
  roleGatingCaveat?: string | null;
  deepLinkHref: string;
  lastSentAt?: string | null;
};

export type EmailControlCenterGroup = {
  module: string;
  items: EmailControlCenterItem[];
};

export type EmailControlCenterSnapshot = {
  groups: EmailControlCenterGroup[];
  totals: {
    total: number;
    enabled: number;
    disabled: number;
    bySystem: Record<EmailControlCenterSourceSystem, number>;
  };
};

const SYSTEM_HEALTH_MODULE = "System Health & Digests";

// (rather than imported from that client component) since this is a server-side read model.
const ROLE_RECIPIENTS_HYBRID_NOTICE: Partial<Record<NotificationRoleKey, string>> = {
  vacation_sla_hr_escalation: "The manager-stage recipient is always the specific request's manager-of-manager and isn't affected by this list.",
  probation_weekly_dv_digest: "The probationer's own manager, NSM chain, and line-matched PM/GPM are always included and aren't affected by this list.",
  marketing_invoice_overdue_alert: "The requester is always told about their own overdue invoice and isn't affected by this list — it is the finance-side audience only.",
};

const ROLE_RECIPIENTS_NOT_CONFIGURABLE: Partial<Record<NotificationRoleKey, string>> = {
  approval_whatsapp_reminder: "Recipients are whoever holds an approval for more than three days — not role-configurable. This is the on and off switch.",
  marketing_sla_reminder: "Recipients are always the specific request's assigned approver and requester — not role-configurable. This switch only turns the reminder on or off.",
};

const ROLE_RECIPIENTS_MODULE: Record<NotificationRoleKey, string> = {
  approval_whatsapp_reminder: "Approvals",
  holiday_confirmation_reminder: SYSTEM_HEALTH_MODULE,
  vacation_sla_hr_escalation: "Leave Management",
  telegram_daily_hr_digest: SYSTEM_HEALTH_MODULE,
  weekly_system_health_digest: SYSTEM_HEALTH_MODULE,
  probation_weekly_dv_digest: "Probation",
  field_workforce_compliance_digest: SYSTEM_HEALTH_MODULE,
  outstation_sla_reminder: "Outstation & Expenses",
  resignation_sla_reminder: "Resignations",
  weekly_plans_drift_alert: "Weekly & Monthly Plans",
  excuse_drift_alert: "Excuses",
  attendance_ingestion_alert: SYSTEM_HEALTH_MODULE,
  marketing_sla_reminder: "Marketing Requests",
  resignation_workflow_alert: "Resignations",
  employee_import_alert: "Employees",
  payroll_workflow_alert: "Payroll",
  marketing_invoice_overdue_alert: "Marketing Requests",
  distributor_upload_overdue_alert: "Source of Sales",
  retention_risk_alert: "Retention Risk",
  crm_account_setup_alert: "CRM",
  new_hire_mailbox_alert: "Employees",
  service_milestone_notice: "Milestones",
  // In-app + Telegram, never email (owner decision, 2026-09-26) — it is listed here
  // because this map is exhaustive over every role-recipients key, exactly as the
  // Telegram-only telegram_daily_hr_digest above is. Listing it is NOT a reason to
  // give it an email channel.
  activity_inactivity_digest: SYSTEM_HEALTH_MODULE,
  // In-app + push + Telegram, never email (owner decision, 2026-10-02) — listed here because this
  // map is exhaustive over every role-recipients key. Listing it is NOT a reason to email it.
  accepted_offer_alert: "Recruitment",
};

const EMAIL_NOTIFICATIONS_MODULE: Record<EmailNotificationType, string> = {
  probation: "Probation",
  probation_milestone: "Probation",
  contract_renewal: "Contracts",
  birthday: "Birthdays",
  offer: "Recruitment",
  resignation: "Resignations",
  password_reset: "Account Access",
  user_created: "Account Access",
  general: "General",
};

function roleRecipientsItem(policy: NotificationRolePolicy): EmailControlCenterItem {
  const notConfigurable = ROLE_RECIPIENTS_NOT_CONFIGURABLE[policy.key];
  const recipientSummary: EmailControlCenterRecipientSummary = notConfigurable
    ? { kind: "not_role_configurable", countLabel: "Not role-configurable" }
    : {
        kind: "roles",
        roles: policy.roles,
        countLabel: policy.roles.length === 0 ? "No roles selected" : `${policy.roles.length} role${policy.roles.length === 1 ? "" : "s"} selected`,
      };

  return {
    id: `role_recipients:${policy.key}`,
    sourceSystem: "role_recipients",
    key: policy.key,
    label: policy.label,
    description: policy.description,
    module: ROLE_RECIPIENTS_MODULE[policy.key],
    enabled: policy.enabled,
    recipientSummary,
    hybridNotice: ROLE_RECIPIENTS_HYBRID_NOTICE[policy.key] ?? null,
    roleGatingCaveat: notConfigurable ?? null,
    deepLinkHref: "/admin/notification-recipients",
  };
}

function recipientModeLabel(mode: string) {
  return mode
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function emailNotificationItem(policy: EmailNotificationPolicy): EmailControlCenterItem {
  const modes = policy.recipientModes.length > 0 ? policy.recipientModes : [policy.recipientMode];
  const modeLabel = modes.map(recipientModeLabel).join(", ");
  const titleSuffix = policy.targetTitles.length > 0 ? ` · ${policy.targetTitles.length} job title${policy.targetTitles.length === 1 ? "" : "s"}` : "";

  return {
    id: `email_notifications:${policy.type}`,
    sourceSystem: "email_notifications",
    key: policy.type,
    label: policy.label,
    description: policy.description,
    module: EMAIL_NOTIFICATIONS_MODULE[policy.type],
    enabled: policy.enabled,
    recipientSummary: {
      kind: "recipient_mode",
      recipientMode: policy.recipientMode,
      recipientModes: policy.recipientModes,
      targetTitles: policy.targetTitles,
      targetLines: policy.targetLines,
      countLabel: `${modeLabel}${titleSuffix}`,
    },
    deepLinkHref: "/admin/email-notifications",
  };
}

function emailTemplateItem(template: EmailTemplateRow): EmailControlCenterItem {
  const roleCount = template.rules.toRoles.length + template.rules.ccRoles.length + template.rules.bccRoles.length;

  return {
    id: `email_templates:${template.templateKey}`,
    sourceSystem: "email_templates",
    key: template.templateKey,
    label: template.templateName,
    description: template.description,
    module: template.category,
    // publishedIsActive, never the draft-overlaid isActive — sendTemplatedEmail's real gate
    // reads the published row only, so the dashboard must reflect exactly that, not a pending draft.
    enabled: template.publishedIsActive,
    recipientSummary: {
      kind: "template_rules",
      toRoles: template.rules.toRoles,
      ccRoles: template.rules.ccRoles,
      bccRoles: template.rules.bccRoles,
      targetTitles: template.rules.targetTitles,
      targetLines: template.rules.targetLines,
      countLabel: roleCount === 0 ? "No roles selected" : `${roleCount} role${roleCount === 1 ? "" : "s"} selected`,
    },
    deepLinkHref: `/admin/email-templates?template=${encodeURIComponent(template.templateKey)}`,
    lastSentAt: template.lastSentAt,
  };
}

export async function getEmailControlCenterSnapshot(): Promise<EmailControlCenterSnapshot> {
  const [rolePolicies, emailPolicies, templates] = await Promise.all([
    getNotificationRolePolicies(),
    getEmailNotificationPolicies(),
    // Deliberately the published-only view (no includeDrafts) — an unpublished draft must never
    // make this dashboard claim a template is on/off differently than what actually sends.
    getEmailTemplateCatalog(),
  ]);

  const items: EmailControlCenterItem[] = [
    ...rolePolicies.map(roleRecipientsItem),
    ...emailPolicies.map(emailNotificationItem),
    ...templates.map(emailTemplateItem),
  ];

  const groupsByModule = new Map<string, EmailControlCenterItem[]>();
  for (const item of items) {
    const list = groupsByModule.get(item.module) ?? [];
    list.push(item);
    groupsByModule.set(item.module, list);
  }
  const groups = Array.from(groupsByModule.entries())
    .map(([module, groupItems]) => ({ module, items: groupItems }))
    .sort((a, b) => a.module.localeCompare(b.module));

  const bySystem: Record<EmailControlCenterSourceSystem, number> = {
    role_recipients: rolePolicies.length,
    email_notifications: emailPolicies.length,
    email_templates: templates.length,
  };
  const enabledCount = items.filter((item) => item.enabled).length;

  return {
    groups,
    totals: {
      total: items.length,
      enabled: enabledCount,
      disabled: items.length - enabledCount,
      bySystem,
    },
  };
}
