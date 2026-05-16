import { getSupabaseAdmin } from "@/lib/supabase/server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const EMAIL_TEMPLATE_KEYS = [
  "job_offer",
  "probation",
  "contract_renewal",
  "leave_request",
  "leave_approval",
  "leave_rejection",
  "password_setup",
  "user_created",
  "general_hr",
  "birthday",
  "resignation",
] as const;

export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];

export const EMAIL_TEMPLATE_LABELS: Record<EmailTemplateKey, string> = {
  job_offer: "Job Offer",
  probation: "Probation Tracker",
  contract_renewal: "Contract Renewal",
  leave_request: "Leave Request",
  leave_approval: "Leave Approval",
  leave_rejection: "Leave Rejection",
  password_setup: "Password Setup",
  user_created: "User Created",
  general_hr: "General HR Notification",
  birthday: "Birthday Reminder",
  resignation: "Resignation Notice",
};

export const EMAIL_RECIPIENT_ROLES = [
  "employee",
  "candidate",
  "direct_manager",
  "manager_manager",
  "manager_chain",
  "hr",
  "hr_manager",
  "finance",
  "admin",
  "ceo",
  "district_manager",
  "regional_sales_manager",
  "national_sales_manager",
  "line_manager",
  "same_line_selected_titles",
  "all_lines_selected_titles",
  "selected_lines_selected_titles",
] as const;

export type EmailRecipientRole = (typeof EMAIL_RECIPIENT_ROLES)[number];

export const EMAIL_RECIPIENT_ROLE_LABELS: Record<EmailRecipientRole, string> = {
  employee: "Employee",
  candidate: "Candidate",
  direct_manager: "Direct Manager",
  manager_manager: "Manager of Manager",
  manager_chain: "Full Manager Chain",
  hr: "HR",
  hr_manager: "HR Manager",
  finance: "Finance",
  admin: "Admin",
  ceo: "CEO",
  district_manager: "District Manager",
  regional_sales_manager: "Regional Sales Manager",
  national_sales_manager: "National Sales Manager",
  line_manager: "Line Manager",
  same_line_selected_titles: "Same Line — Selected Titles",
  all_lines_selected_titles: "All Lines — Selected Titles",
  selected_lines_selected_titles: "Selected Lines + Selected Titles",
};

export type EmailTemplate = {
  id: string;
  templateKey: EmailTemplateKey;
  templateName: string;
  description: string;
  subject: string;
  greeting: string;
  bodyHtml: string;
  bodyText: string;
  closing: string;
  previewText: string;
  isActive: boolean;
  smartGreeting: boolean;
  toRoles: EmailRecipientRole[];
  ccRoles: EmailRecipientRole[];
  bccRoles: EmailRecipientRole[];
  targetTitles: string[];
  targetLines: string[];
  staticToEmails: string[];
  staticCcEmails: string[];
  staticBccEmails: string[];
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
};

export type EmailTemplateUpdate = Partial<
  Omit<EmailTemplate, "id" | "templateKey" | "createdAt" | "updatedAt">
> & {
  updatedBy?: string;
};

export type RenderedEmailTemplate = {
  subject: string;
  greeting: string;
  bodyHtml: string;
  bodyText: string;
  closing: string;
  previewText: string;
};

// ---------------------------------------------------------------------------
// DB row mapper
// ---------------------------------------------------------------------------

type EmailTemplateRow = {
  id: string;
  template_key: string;
  template_name: string;
  description: string;
  subject: string;
  greeting: string;
  body_html: string;
  body_text: string;
  closing: string;
  preview_text: string;
  is_active: boolean;
  smart_greeting: boolean;
  to_roles: string[];
  cc_roles: string[];
  bcc_roles: string[];
  target_titles: string[];
  target_lines: string[];
  static_to_emails: string[];
  static_cc_emails: string[];
  static_bcc_emails: string[];
  created_at: string;
  updated_at: string;
  updated_by: string | null;
};

function rowToTemplate(row: EmailTemplateRow): EmailTemplate {
  return {
    id: row.id,
    templateKey: row.template_key as EmailTemplateKey,
    templateName: row.template_name,
    description: row.description ?? "",
    subject: row.subject ?? "",
    greeting: row.greeting ?? "",
    bodyHtml: row.body_html ?? "",
    bodyText: row.body_text ?? "",
    closing: row.closing ?? "",
    previewText: row.preview_text ?? "",
    isActive: row.is_active ?? true,
    smartGreeting: row.smart_greeting ?? true,
    toRoles: (row.to_roles ?? []) as EmailRecipientRole[],
    ccRoles: (row.cc_roles ?? []) as EmailRecipientRole[],
    bccRoles: (row.bcc_roles ?? []) as EmailRecipientRole[],
    targetTitles: row.target_titles ?? [],
    targetLines: row.target_lines ?? [],
    staticToEmails: row.static_to_emails ?? [],
    staticCcEmails: row.static_cc_emails ?? [],
    staticBccEmails: row.static_bcc_emails ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

// ---------------------------------------------------------------------------
// Fallback defaults (shown if DB row is missing)
// ---------------------------------------------------------------------------

function buildFallback(key: EmailTemplateKey): EmailTemplate {
  const now = new Date().toISOString();
  return {
    id: "",
    templateKey: key,
    templateName: EMAIL_TEMPLATE_LABELS[key],
    description: "",
    subject: "",
    greeting: "Dear Team,",
    bodyHtml: "<p>{{summary}}</p>",
    bodyText: "{{summary}}",
    closing: "Please review and take the required action.",
    previewText: `Phoenix Workforce — ${EMAIL_TEMPLATE_LABELS[key]}`,
    isActive: true,
    smartGreeting: true,
    toRoles: [],
    ccRoles: [],
    bccRoles: [],
    targetTitles: [],
    targetLines: [],
    staticToEmails: [],
    staticCcEmails: [],
    staticBccEmails: [],
    createdAt: now,
    updatedAt: now,
    updatedBy: null,
  };
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/** Return all templates. Keys missing from DB get fallback defaults. */
export async function listEmailTemplates(): Promise<EmailTemplate[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("email_templates")
    .select("*")
    .order("template_key");

  if (error) {
    console.error("[email-templates] listEmailTemplates error:", error.message);
  }

  const byKey = new Map<string, EmailTemplate>(
    (data ?? []).map((row) => [row.template_key, rowToTemplate(row as EmailTemplateRow)])
  );

  return EMAIL_TEMPLATE_KEYS.map((key) => byKey.get(key) ?? buildFallback(key));
}

/** Return a single template by key. Falls back to default if missing. */
export async function getEmailTemplate(key: EmailTemplateKey): Promise<EmailTemplate> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("email_templates")
    .select("*")
    .eq("template_key", key)
    .maybeSingle();

  if (error) {
    console.error("[email-templates] getEmailTemplate error:", error.message);
  }

  if (!data) return buildFallback(key);
  return rowToTemplate(data as EmailTemplateRow);
}

/** Upsert a template. Creates the row if it doesn't exist yet. */
export async function updateEmailTemplate(
  key: EmailTemplateKey,
  update: EmailTemplateUpdate
): Promise<EmailTemplate> {
  const supabase = getSupabaseAdmin();

  const upsertData = {
    template_key: key,
    template_name: update.templateName,
    description: update.description,
    subject: update.subject,
    greeting: update.greeting,
    body_html: update.bodyHtml,
    body_text: update.bodyText,
    closing: update.closing,
    preview_text: update.previewText,
    is_active: update.isActive,
    smart_greeting: update.smartGreeting,
    to_roles: update.toRoles,
    cc_roles: update.ccRoles,
    bcc_roles: update.bccRoles,
    target_titles: update.targetTitles,
    target_lines: update.targetLines,
    static_to_emails: update.staticToEmails,
    static_cc_emails: update.staticCcEmails,
    static_bcc_emails: update.staticBccEmails,
    updated_by: update.updatedBy ?? null,
  };

  // Remove undefined keys so Supabase doesn't overwrite with null
  const cleanData = Object.fromEntries(
    Object.entries(upsertData).filter(([, v]) => v !== undefined)
  );

  const { data, error } = await supabase
    .from("email_templates")
    .upsert({ ...cleanData }, { onConflict: "template_key" })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to save template "${key}": ${error.message}`);
  }

  return rowToTemplate(data as EmailTemplateRow);
}

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

/** Safely substitute {{variable}} placeholders. No JS execution. */
export function renderTemplateString(
  template: string,
  context: Record<string, string>,
  escapeForHtml = false
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = context[key];
    if (value === undefined) return `{{${key}}}`;
    return escapeForHtml ? escapeHtml(value) : value;
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render a full template with context variables. */
export function renderEmailTemplate(
  template: EmailTemplate,
  context: Record<string, string>
): RenderedEmailTemplate {
  return {
    subject: renderTemplateString(template.subject, context),
    greeting: resolveGreeting(template, context),
    bodyHtml: renderTemplateString(template.bodyHtml, context, true),
    bodyText: renderTemplateString(template.bodyText, context),
    closing: renderTemplateString(template.closing, context),
    previewText: renderTemplateString(template.previewText, context),
  };
}

function resolveGreeting(
  template: EmailTemplate,
  context: Record<string, string>
): string {
  if (!template.smartGreeting) {
    return renderTemplateString(template.greeting, context);
  }

  // Smart greeting: use recipient name if single known recipient
  const recipientName = context.recipientName ?? context.employeeName ?? context.candidateName;
  if (recipientName) {
    return `Dear ${escapeHtml(recipientName)},`;
  }

  // Fallback to template greeting
  return renderTemplateString(template.greeting, context);
}

// ---------------------------------------------------------------------------
// Available template variables (for UI hints)
// ---------------------------------------------------------------------------

export const TEMPLATE_VARIABLES = [
  { key: "employeeName", label: "Employee Name" },
  { key: "employeeHrId", label: "Employee HR ID" },
  { key: "candidateName", label: "Candidate Name" },
  { key: "jobTitle", label: "Job Title" },
  { key: "managerName", label: "Manager Name" },
  { key: "line", label: "Line" },
  { key: "area", label: "Area" },
  { key: "status", label: "Status" },
  { key: "date", label: "Date" },
  { key: "startDate", label: "Start Date" },
  { key: "endDate", label: "End Date" },
  { key: "ctaUrl", label: "CTA URL" },
  { key: "ctaLabel", label: "CTA Label" },
  { key: "recipientName", label: "Recipient Name" },
  { key: "subject", label: "Subject" },
  { key: "body", label: "Body" },
  { key: "summary", label: "Summary" },
] as const;
