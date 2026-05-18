import crypto from "crypto";

import {
  renderEmailParagraphs,
  renderPhoenixEmailHtml,
  renderPhoenixEmailText,
} from "@/emails/phoenix-email-layout";
import { summarizeEmailTemplateReadiness } from "@/lib/communication/metrics";
import { sendPhoenixEmail, type SendPhoenixEmailResult } from "@/lib/email/send-phoenix-email";
import { getEmployeeDirectory, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const emailTemplateKeys = [
  "offer",
  "interview_invitation",
  "interview_feedback",
  "probation_workflow",
  "probation_reminder",
  "contract_renewal",
  "birthday",
  "resignation_workflow",
  "leave_request",
  "leave_approval",
  "leave_rejection",
  "password_setup",
  "password_reset",
  "user_created",
  "general",
] as const;

export const EMAIL_TEMPLATE_KEYS = {
  BIRTHDAY: "birthday",
  CONTRACT_RENEWAL: "contract_renewal",
  GENERAL: "general",
  INTERVIEW_FEEDBACK: "interview_feedback",
  INTERVIEW_INVITATION: "interview_invitation",
  JOB_OFFER: "offer",
  LEAVE_APPROVAL: "leave_approval",
  LEAVE_REJECTION: "leave_rejection",
  LEAVE_REQUEST: "leave_request",
  PASSWORD_SETUP: "password_setup",
  PASSWORD_RESET: "password_reset",
  PROBATION_REMINDER: "probation_reminder",
  PROBATION_WORKFLOW: "probation_workflow",
  RESIGNATION_WORKFLOW: "resignation_workflow",
  USER_CREATED: "user_created",
} as const satisfies Record<string, EmailTemplateKey>;

export const emailTemplateRecipientRoleOptions = [
  "employee",
  "candidate",
  "direct_manager",
  "manager_of_manager",
  "manager_chain",
  "hr",
  "hr_manager",
  "finance",
  "hiring_manager",
  "admin",
  "ceo",
  "recruiter",
  "district_manager",
  "regional_sales_manager",
  "national_sales_manager",
  "line_manager",
  "same_line_selected_titles",
  "all_lines_selected_titles",
  "selected_lines_selected_titles",
] as const;

export type EmailTemplateKey = (typeof emailTemplateKeys)[number];
export type EmailTemplateRecipientRole = (typeof emailTemplateRecipientRoleOptions)[number];

export type EmailTemplateContext = {
  area?: string | null;
  candidateName?: string | null;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  date?: string | null;
  endDate?: string | null;
  employeeHrId?: string | null;
  employeeName?: string | null;
  expiryText?: string | null;
  feedback?: string | null;
  interviewDate?: string | null;
  interviewLocation?: string | null;
  interviewerName?: string | null;
  interviewTime?: string | null;
  jobTitle?: string | null;
  line?: string | null;
  managerName?: string | null;
  meetingUrl?: string | null;
  nextStep?: string | null;
  recipientName?: string | null;
  startDate?: string | null;
  status?: string | null;
  subject?: string | null;
  summary?: string | null;
  vacationType?: string | null;
};

export type EmailTemplateDefinition = {
  bodyHtml: string;
  bodyText: string;
  closingText: string;
  description: string;
  greeting: string;
  isActive: boolean;
  previewText: string;
  subject: string;
  templateKey: EmailTemplateKey;
  templateName: string;
};

export type EmailTemplateRecipientRules = {
  bccRoles: EmailTemplateRecipientRole[];
  bccStaticEmails: string[];
  ccRoles: EmailTemplateRecipientRole[];
  ccStaticEmails: string[];
  targetLines: string[];
  targetTitles: string[];
  toRoles: EmailTemplateRecipientRole[];
  toStaticEmails: string[];
};

export type EmailTemplateRow = EmailTemplateDefinition & {
  createdAt: string;
  rules: EmailTemplateRecipientRules;
  updatedAt: string;
};

export type EmailTemplatePayload = Partial<Omit<EmailTemplateDefinition, "templateKey">> & {
  rules?: Partial<EmailTemplateRecipientRules>;
};

export type SendTemplatedEmailInput = {
  candidateEmail?: string | null;
  context?: Partial<EmailTemplateContext>;
  employeeHrId?: string | null;
  fallbackTo?: string[] | null;
  from?: string | null;
  overrides?: {
    bcc?: string[] | null;
    cc?: string[] | null;
    replaceRecipients?: boolean;
    to?: string[] | null;
  };
  templateKey: EmailTemplateKey | string;
};

export type EmailTemplateValidationIssue = {
  field: string;
  message: string;
  token?: string;
  type: "email" | "placeholder" | "required";
};

export class EmailTemplateValidationError extends Error {
  issues: EmailTemplateValidationIssue[];

  constructor(issues: EmailTemplateValidationIssue[]) {
    super("Email template validation failed.");
    this.name = "EmailTemplateValidationError";
    this.issues = issues;
  }
}

type TemplateTableRow = {
  body_html: string | null;
  body_text: string | null;
  closing_text: string | null;
  created_at: string | null;
  description: string | null;
  greeting: string | null;
  is_active: boolean | null;
  preview_text: string | null;
  subject: string | null;
  template_key: string;
  template_name: string | null;
  updated_at: string | null;
};

type RulesTableRow = {
  bcc_roles: string[] | null;
  cc_roles: string[] | null;
  static_bcc_emails: string[] | null;
  static_cc_emails: string[] | null;
  static_to_emails: string[] | null;
  target_lines: string[] | null;
  target_titles: string[] | null;
  template_key: string;
  to_roles: string[] | null;
};

type Recipient = {
  email: string;
  name?: string | null;
};

type Contact = {
  email: string;
  hrId: string | null;
  line: string | null;
  managerHrId: string | null;
  name: string | null;
  role: string | null;
  title: string | null;
};

const emailTemplatesTable = "email_templates";
const recipientRulesTable = "email_template_recipient_rules";
const placeholderHints = [
  "employeeName",
  "employeeHrId",
  "candidateName",
  "jobTitle",
  "managerName",
  "line",
  "area",
  "status",
  "date",
  "startDate",
  "endDate",
  "expiryText",
  "interviewDate",
  "interviewTime",
  "interviewLocation",
  "interviewerName",
  "meetingUrl",
  "feedback",
  "nextStep",
  "ctaUrl",
  "ctaLabel",
  "recipientName",
] as const;
const allowedPlaceholderSet = new Set<string>(placeholderHints);

const defaultRules: Record<EmailTemplateKey, EmailTemplateRecipientRules> = {
  birthday: emptyRules(["direct_manager"]),
  contract_renewal: emptyRules(["manager_chain"], ["hr"]),
  general: emptyRules(["admin"], ["hr"]),
  interview_feedback: emptyRules(["hr", "hiring_manager", "recruiter"]),
  interview_invitation: emptyRules(["candidate"]),
  leave_approval: emptyRules(["employee"], ["hr"]),
  leave_rejection: emptyRules(["employee"], ["hr"]),
  leave_request: emptyRules(["direct_manager"], ["manager_of_manager"]),
  offer: emptyRules(["candidate"]),
  password_setup: emptyRules(["candidate"]),
  password_reset: emptyRules(["candidate"]),
  probation_reminder: emptyRules(["direct_manager"], ["manager_of_manager", "hr"]),
  probation_workflow: emptyRules(["direct_manager"], ["hr"]),
  resignation_workflow: emptyRules(["manager_chain"], ["hr"]),
  user_created: emptyRules(["employee"]),
};

const templateDefaults: Record<EmailTemplateKey, EmailTemplateDefinition> = {
  birthday: {
    bodyHtml: "<p>A birthday reminder was triggered for {{employeeName}}.</p>",
    bodyText: "A birthday reminder was triggered for {{employeeName}}.",
    closingText: "Please prepare a thoughtful follow-up.",
    description: "Birthday reminders for people operations.",
    greeting: "Dear Team,",
    isActive: true,
    previewText: "Phoenix Workforce birthday reminder.",
    subject: "Birthday reminder: {{employeeName}}",
    templateKey: "birthday",
    templateName: "Birthday",
  },
  contract_renewal: {
    bodyHtml: "<p>{{summary}}</p><p>Employee: {{employeeName}} ({{employeeHrId}}).</p><p>Renewal date: {{endDate}}.</p><p>{{status}}</p>",
    bodyText: "{{summary}}\n\nEmployee: {{employeeName}} ({{employeeHrId}}).\nRenewal date: {{endDate}}.\n{{status}}",
    closingText: "Please review and process the renewal action.",
    description: "Contract renewal workflow updates.",
    greeting: "Dear Team,",
    isActive: true,
    previewText: "Phoenix Workforce contract renewal update.",
    subject: "{{subject}}",
    templateKey: "contract_renewal",
    templateName: "Contract Renewal",
  },
  general: {
    bodyHtml: "<p>{{summary}}</p><p>{{status}}</p>",
    bodyText: "{{summary}}\n\n{{status}}",
    closingText: "Please review and act accordingly.",
    description: "General HR communication used for standard updates.",
    greeting: "Dear Team,",
    isActive: true,
    previewText: "Phoenix Workforce HR notification.",
    subject: "{{subject}}",
    templateKey: "general",
    templateName: "General HR Notification",
  },
  interview_feedback: {
    bodyHtml: "<p>Interview feedback has been submitted for {{candidateName}}.</p><p>Role: {{jobTitle}}.</p><p>Status: {{status}}.</p><p>Feedback: {{feedback}}</p><p>Next step: {{nextStep}}</p>",
    bodyText: "Interview feedback has been submitted for {{candidateName}}.\n\nRole: {{jobTitle}}.\nStatus: {{status}}.\nFeedback: {{feedback}}\nNext step: {{nextStep}}",
    closingText: "Please review the feedback and complete the next recruiting step.",
    description: "Internal interview feedback follow-up for HR and hiring stakeholders.",
    greeting: "Dear Team,",
    isActive: true,
    previewText: "Phoenix Workforce interview feedback update.",
    subject: "Interview feedback: {{candidateName}} - {{jobTitle}}",
    templateKey: "interview_feedback",
    templateName: "Interview Feedback",
  },
  interview_invitation: {
    bodyHtml: "<p>You are invited to interview for {{jobTitle}}.</p><p>Date: {{interviewDate}} at {{interviewTime}}.</p><p>Location: {{interviewLocation}}</p><p>Interviewer: {{interviewerName}}</p><p>Meeting link: {{meetingUrl}}</p>",
    bodyText: "You are invited to interview for {{jobTitle}}.\n\nDate: {{interviewDate}} at {{interviewTime}}.\nLocation: {{interviewLocation}}\nInterviewer: {{interviewerName}}\nMeeting link: {{meetingUrl}}",
    closingText: "Please confirm your availability or contact HR if the time needs to change.",
    description: "Candidate interview invitation template.",
    greeting: "Dear {{candidateName}},",
    isActive: true,
    previewText: "Phoenix Workforce interview invitation for {{jobTitle}}.",
    subject: "Interview invitation: {{jobTitle}}",
    templateKey: "interview_invitation",
    templateName: "Interview Invitation",
  },
  leave_approval: {
    bodyHtml: "<p>Your leave request has been approved.</p><p>Employee: {{employeeName}} ({{employeeHrId}}).</p><p>Period: {{startDate}} - {{endDate}}.</p><p>{{status}}</p>",
    bodyText: "Your leave request has been approved. Employee: {{employeeName}} ({{employeeHrId}}). Period: {{startDate}} - {{endDate}}. {{status}}",
    closingText: "Please archive the request if no further action is required.",
    description: "Leave request approval confirmation.",
    greeting: "Dear {{recipientName}},",
    isActive: true,
    previewText: "Your leave request was approved.",
    subject: "Leave request approved: {{employeeName}}",
    templateKey: "leave_approval",
    templateName: "Leave Approval",
  },
  leave_rejection: {
    bodyHtml: "<p>Your leave request has been rejected.</p><p>Employee: {{employeeName}} ({{employeeHrId}}).</p><p>Period: {{startDate}} - {{endDate}}.</p><p>{{status}}</p>",
    bodyText: "Your leave request has been rejected. Employee: {{employeeName}} ({{employeeHrId}}). Period: {{startDate}} - {{endDate}}. {{status}}",
    closingText: "Please contact HR for clarification before submitting a revised request.",
    description: "Leave request rejection confirmation.",
    greeting: "Dear {{recipientName}},",
    isActive: true,
    previewText: "Your leave request was rejected.",
    subject: "Leave request rejected: {{employeeName}}",
    templateKey: "leave_rejection",
    templateName: "Leave Rejection",
  },
  leave_request: {
    bodyHtml: "<p>{{employeeName}} submitted a {{vacationType}} request.</p><p>Duration: {{startDate}} to {{endDate}}.</p><p>{{status}}</p>",
    bodyText: "{{employeeName}} submitted a {{vacationType}} request from {{startDate}} to {{endDate}}. {{status}}",
    closingText: "Please review and complete the manager decision workflow.",
    description: "Leave request submission and manager action.",
    greeting: "Dear Team,",
    isActive: true,
    previewText: "A leave request requires action in Phoenix Workforce.",
    subject: "Leave request from {{employeeName}}",
    templateKey: "leave_request",
    templateName: "Leave Request",
  },
  offer: {
    bodyHtml: "<p>We are pleased to share your offer details for {{jobTitle}}.</p><p>Reporting to {{managerName}} under {{line}} in {{area}}.</p><p>Planned start date: {{startDate}}.</p>",
    bodyText: "We are pleased to share your offer details for {{jobTitle}}. Reporting to {{managerName}} under {{line}} in {{area}}. Planned start date: {{startDate}}.",
    closingText: "Please respond through the action link at your convenience.",
    description: "Candidate job offer email with action links.",
    greeting: "Dear {{recipientName}},",
    isActive: true,
    previewText: "Phoenix Workforce job offer notification.",
    subject: "{{jobTitle}} Job Offer",
    templateKey: "offer",
    templateName: "Job Offer",
  },
  password_reset: {
    bodyHtml: "<p>{{summary}}</p><p>This secure link expires: {{expiryText}}.</p><p>Use the action button below to continue.</p>",
    bodyText: "{{summary}}\n\nThis secure link expires: {{expiryText}}.\nUse the action link to continue.",
    closingText: "If you did not request this, contact your administrator.",
    description: "Password reset communication.",
    greeting: "Dear {{recipientName}},",
    isActive: true,
    previewText: "Phoenix Workforce password reset link.",
    subject: "{{subject}}",
    templateKey: "password_reset",
    templateName: "Password Reset",
  },
  password_setup: {
    bodyHtml: "<p>{{summary}}</p><p>This secure link expires: {{expiryText}}.</p><p>Use the action button below to continue.</p>",
    bodyText: "{{summary}}\n\nThis secure link expires: {{expiryText}}.\nUse the action link to continue.",
    closingText: "Please complete setup before the link expires.",
    description: "Password setup communication for onboarding and first login.",
    greeting: "Dear {{recipientName}},",
    isActive: true,
    previewText: "Phoenix Workforce password setup link.",
    subject: "{{subject}}",
    templateKey: "password_setup",
    templateName: "Password Setup",
  },
  probation_reminder: {
    bodyHtml: "<p>{{summary}}</p><p>Employee: {{employeeName}} ({{employeeHrId}}).</p><p>Hire date: {{startDate}}.</p><p>{{status}}</p>",
    bodyText: "{{summary}}\n\nEmployee: {{employeeName}} ({{employeeHrId}}).\nHire date: {{startDate}}.\n{{status}}",
    closingText: "Please submit the required feedback before the probation checkpoint closes.",
    description: "Scheduled probation reminders for manager and HR follow-up.",
    greeting: "Dear Team,",
    isActive: true,
    previewText: "Phoenix Workforce probation reminder.",
    subject: "{{subject}}",
    templateKey: "probation_reminder",
    templateName: "Probation Reminder",
  },
  probation_workflow: {
    bodyHtml: "<p>{{summary}}</p><p>Employee: {{employeeName}} ({{employeeHrId}}).</p><p>{{status}}</p>",
    bodyText: "{{summary}}\n\nEmployee: {{employeeName}} ({{employeeHrId}}).\n{{status}}",
    closingText: "Please review and continue the required workflow.",
    description: "Probation tracker updates.",
    greeting: "Dear Team,",
    isActive: true,
    previewText: "Phoenix Workforce probation workflow update.",
    subject: "{{subject}}",
    templateKey: "probation_workflow",
    templateName: "Probation Tracker",
  },
  resignation_workflow: {
    bodyHtml: "<p>{{summary}}</p><p>Employee: {{employeeName}} ({{employeeHrId}}).</p><p>Effective date: {{date}}.</p><p>{{status}}</p>",
    bodyText: "{{summary}}\n\nEmployee: {{employeeName}} ({{employeeHrId}}).\nEffective date: {{date}}.\n{{status}}",
    closingText: "Please route this according to HR procedure.",
    description: "Resignation workflow updates.",
    greeting: "Dear Team,",
    isActive: true,
    previewText: "Phoenix Workforce resignation workflow update.",
    subject: "{{subject}}",
    templateKey: "resignation_workflow",
    templateName: "Resignation",
  },
  user_created: {
    bodyHtml: "<p>{{summary}}</p><p>This secure link expires: {{expiryText}}.</p><p>Use the action button below to complete account setup.</p>",
    bodyText: "{{summary}}\n\nThis secure link expires: {{expiryText}}.\nUse the action link to complete account setup.",
    closingText: "HR will assist if you need support.",
    description: "Welcome message for newly created users.",
    greeting: "Dear {{recipientName}},",
    isActive: true,
    previewText: "Phoenix Workforce account created.",
    subject: "{{subject}}",
    templateKey: "user_created",
    templateName: "User Created",
  },
};

const aliases: Record<string, EmailTemplateKey> = {
  job_offer: "offer",
  probation: "probation_workflow",
  probation_tracker: "probation_workflow",
  resignation: "resignation_workflow",
  user_creation: "user_created",
};

function emptyRules(toRoles: EmailTemplateRecipientRole[] = [], ccRoles: EmailTemplateRecipientRole[] = []): EmailTemplateRecipientRules {
  return {
    bccRoles: [],
    bccStaticEmails: [],
    ccRoles,
    ccStaticEmails: [],
    targetLines: [],
    targetTitles: [],
    toRoles,
    toStaticEmails: [],
  };
}

function normalizeTemplateKey(value: string | null | undefined): EmailTemplateKey | null {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((emailTemplateKeys as readonly string[]).includes(normalized)) return normalized as EmailTemplateKey;
  return aliases[normalized] ?? null;
}

function isTemplateRole(value: unknown): value is EmailTemplateRecipientRole {
  return typeof value === "string" && emailTemplateRecipientRoleOptions.includes(value as EmailTemplateRecipientRole);
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function cleanEmails(values: unknown) {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map(normalizeEmail).filter(validEmail)));
}

function invalidEmails(values: unknown) {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map(text).filter((value) => value && !validEmail(normalizeEmail(value)))));
}

function cleanRoles(values: unknown): EmailTemplateRecipientRole[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.filter(isTemplateRole)));
}

function cleanTextArray(values: unknown) {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map(text).filter(Boolean)));
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizeHtml(value: string) {
  return value
    .replace(/<\s*script\b[^>]*>[\s\S]*?<\s*\/\s*script>/gi, "")
    .replace(/<\s*iframe\b[^>]*>[\s\S]*?<\s*\/\s*iframe>/gi, "")
    .replace(/\son\w+\s*=\s*(["']).*?\1/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "")
    .replace(/javascript:/gi, "");
}

function interpolate(template: string, variables: Record<string, string>, escapeValues: boolean) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = variables[key] ?? "";
    return escapeValues ? escapeHtml(value) : value;
  });
}

function extractPlaceholders(value: unknown) {
  const source = String(value ?? "");
  const tokens = Array.from(source.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)).map((match) => match[1]);
  const malformed = (source.match(/\{\{/g) ?? []).length !== (source.match(/\}\}/g) ?? []).length;
  return { malformed, tokens };
}

export function validateEmailTemplatePayload(payload: EmailTemplatePayload) {
  const issues: EmailTemplateValidationIssue[] = [];
  const warnings: EmailTemplateValidationIssue[] = [];
  const fields: Array<[keyof EmailTemplatePayload, string]> = [
    ["subject", "Subject"],
    ["greeting", "Greeting"],
    ["previewText", "Preview text"],
    ["bodyHtml", "Body HTML"],
    ["bodyText", "Body text"],
    ["closingText", "Closing"],
  ];

  if (!text(payload.subject)) {
    warnings.push({
      field: "subject",
      message: "Subject is empty. Drafts can be saved, but published emails should have a clear subject.",
      type: "required",
    });
  }

  for (const [field, label] of fields) {
    const { malformed, tokens } = extractPlaceholders(payload[field]);
    if (malformed) {
      issues.push({
        field,
        message: `${label} contains an incomplete placeholder. Use the format {{employeeName}}.`,
        type: "placeholder",
      });
    }
    for (const token of tokens) {
      if (!allowedPlaceholderSet.has(token)) {
        issues.push({
          field,
          message: `Unknown variable {{${token}}}. Choose one from Available Variables.`,
          token,
          type: "placeholder",
        });
      }
    }
  }

  const ruleChecks: Array<[keyof EmailTemplateRecipientRules, string]> = [
    ["toStaticEmails", "Static TO emails"],
    ["ccStaticEmails", "Static CC emails"],
    ["bccStaticEmails", "Static BCC emails"],
  ];
  for (const [field, label] of ruleChecks) {
    for (const email of invalidEmails(payload.rules?.[field])) {
      issues.push({
        field: `rules.${field}`,
        message: `${label} contains an invalid email address: ${email}.`,
        type: "email",
      });
    }
  }

  return {
    isValid: issues.length === 0,
    issues,
    warnings,
  };
}

function tableMissing(error: unknown) {
  const message = (
    error instanceof Error
      ? error.message
      : typeof error === "object" && error && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : String(error)
  ).toLowerCase();
  const code = typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code ?? "").toLowerCase()
    : "";
  return (
    code === "42703" ||
    code === "42p01" ||
    message.includes("email_templates") ||
    message.includes("email_template_recipient_rules") ||
    message.includes("does not exist") ||
    message.includes("schema cache")
  );
}

function mapTemplate(row: TemplateTableRow | null | undefined, key: EmailTemplateKey): EmailTemplateDefinition {
  const fallback = templateDefaults[key];
  return {
    bodyHtml: row?.body_html ?? fallback.bodyHtml,
    bodyText: row?.body_text ?? fallback.bodyText,
    closingText: row?.closing_text ?? fallback.closingText,
    description: row?.description ?? fallback.description,
    greeting: row?.greeting ?? fallback.greeting,
    isActive: row?.is_active ?? fallback.isActive,
    previewText: row?.preview_text ?? fallback.previewText,
    subject: row?.subject ?? fallback.subject,
    templateKey: key,
    templateName: row?.template_name ?? fallback.templateName,
  };
}

function mapRules(row: RulesTableRow | null | undefined, key: EmailTemplateKey): EmailTemplateRecipientRules {
  const fallback = defaultRules[key];
  return {
    bccRoles: cleanRoles(row?.bcc_roles ?? fallback.bccRoles),
    bccStaticEmails: cleanEmails(row?.static_bcc_emails ?? fallback.bccStaticEmails),
    ccRoles: cleanRoles(row?.cc_roles ?? fallback.ccRoles),
    ccStaticEmails: cleanEmails(row?.static_cc_emails ?? fallback.ccStaticEmails),
    targetLines: cleanTextArray(row?.target_lines ?? fallback.targetLines),
    targetTitles: cleanTextArray(row?.target_titles ?? fallback.targetTitles),
    toRoles: cleanRoles(row?.to_roles ?? fallback.toRoles),
    toStaticEmails: cleanEmails(row?.static_to_emails ?? fallback.toStaticEmails),
  };
}

function toTemplateRow(template: EmailTemplateDefinition, row?: TemplateTableRow | null, rules?: RulesTableRow | null): EmailTemplateRow {
  return {
    ...template,
    createdAt: row?.created_at ?? new Date().toISOString(),
    rules: mapRules(rules, template.templateKey),
    updatedAt: row?.updated_at ?? new Date().toISOString(),
  };
}

async function readTemplateTables() {
  const supabase = getSupabaseAdmin();
  const [templates, rules] = await Promise.all([
    supabase
      .from(emailTemplatesTable)
      .select("template_key,template_name,description,is_active,subject,greeting,body_html,body_text,closing_text,preview_text,created_at,updated_at"),
    supabase
      .from(recipientRulesTable)
      .select("template_key,to_roles,cc_roles,bcc_roles,target_titles,target_lines,static_to_emails,static_cc_emails,static_bcc_emails"),
  ]);

  if (templates.error) throw templates.error;
  if (rules.error) throw rules.error;

  return {
    rules: (rules.data ?? []) as RulesTableRow[],
    templates: (templates.data ?? []) as TemplateTableRow[],
  };
}

export async function getEmailTemplateCatalog(): Promise<EmailTemplateRow[]> {
  try {
    const { templates, rules } = await readTemplateTables();
    return emailTemplateKeys
      .map((key) => {
        const templateRow = templates.find((row) => normalizeTemplateKey(row.template_key) === key) ?? null;
        const rulesRow = rules.find((row) => normalizeTemplateKey(row.template_key) === key) ?? null;
        return toTemplateRow(mapTemplate(templateRow, key), templateRow, rulesRow);
      })
      .sort((left, right) => left.templateName.localeCompare(right.templateName));
  } catch (error) {
    if (!tableMissing(error)) throw error;
    return emailTemplateKeys
      .map((key) => toTemplateRow(templateDefaults[key], null, null))
      .sort((left, right) => left.templateName.localeCompare(right.templateName));
  }
}

export async function getEmailTemplateReadinessMetrics() {
  const templates = await getEmailTemplateCatalog();
  return summarizeEmailTemplateReadiness(templates.map((template) => ({
    bodyHtml: template.bodyHtml,
    bodyText: template.bodyText,
    isActive: template.isActive,
    rules: template.rules,
    subject: template.subject,
    templateKey: template.templateKey,
  })));
}

export async function getEmailTemplate(templateKey: string): Promise<EmailTemplateRow | null> {
  const key = normalizeTemplateKey(templateKey);
  if (!key) return null;

  try {
    const { templates, rules } = await readTemplateTables();
    const templateRow = templates.find((row) => normalizeTemplateKey(row.template_key) === key) ?? null;
    const rulesRow = rules.find((row) => normalizeTemplateKey(row.template_key) === key) ?? null;
    return toTemplateRow(mapTemplate(templateRow, key), templateRow, rulesRow);
  } catch (error) {
    if (!tableMissing(error)) throw error;
    return toTemplateRow(templateDefaults[key], null, null);
  }
}

function normalizeRules(input: Partial<EmailTemplateRecipientRules> | undefined, key: EmailTemplateKey): EmailTemplateRecipientRules {
  const fallback = defaultRules[key];
  return {
    bccRoles: cleanRoles(input?.bccRoles ?? fallback.bccRoles),
    bccStaticEmails: cleanEmails(input?.bccStaticEmails ?? fallback.bccStaticEmails),
    ccRoles: cleanRoles(input?.ccRoles ?? fallback.ccRoles),
    ccStaticEmails: cleanEmails(input?.ccStaticEmails ?? fallback.ccStaticEmails),
    targetLines: cleanTextArray(input?.targetLines ?? fallback.targetLines),
    targetTitles: cleanTextArray(input?.targetTitles ?? fallback.targetTitles),
    toRoles: cleanRoles(input?.toRoles ?? fallback.toRoles),
    toStaticEmails: cleanEmails(input?.toStaticEmails ?? fallback.toStaticEmails),
  };
}

export async function saveEmailTemplate(templateKey: string, payload: EmailTemplatePayload, actor?: string | null) {
  const key = normalizeTemplateKey(templateKey);
  if (!key) throw new Error("Unsupported email template.");
  const validation = validateEmailTemplatePayload(payload);
  if (!validation.isValid) throw new EmailTemplateValidationError(validation.issues);

  const current = await getEmailTemplate(key);
  const fallback = current ?? toTemplateRow(templateDefaults[key], null, null);
  const now = new Date().toISOString();
  const template = {
    body_html: sanitizeHtml(text(payload.bodyHtml ?? fallback.bodyHtml)),
    body_text: text(payload.bodyText ?? fallback.bodyText),
    closing_text: text(payload.closingText ?? fallback.closingText),
    description: text(payload.description ?? fallback.description),
    greeting: text(payload.greeting ?? fallback.greeting),
    is_active: Boolean(payload.isActive ?? fallback.isActive),
    preview_text: text(payload.previewText ?? fallback.previewText),
    subject: text(payload.subject ?? fallback.subject),
    template_key: key,
    template_name: text(payload.templateName ?? fallback.templateName),
    updated_at: now,
    updated_by: actor ?? null,
  };
  const rules = normalizeRules(payload.rules, key);

  const supabase = getSupabaseAdmin();
  const templateResult = await supabase.from(emailTemplatesTable).upsert(template, { onConflict: "template_key" });
  if (templateResult.error) throw templateResult.error;

  const ruleResult = await supabase.from(recipientRulesTable).upsert(
    {
      bcc_roles: rules.bccRoles,
      static_bcc_emails: rules.bccStaticEmails,
      cc_roles: rules.ccRoles,
      static_cc_emails: rules.ccStaticEmails,
      static_to_emails: rules.toStaticEmails,
      target_lines: rules.targetLines,
      target_titles: rules.targetTitles,
      template_key: key,
      to_roles: rules.toRoles,
      updated_at: now,
      updated_by: actor ?? null,
    },
    { onConflict: "template_key" },
  );
  if (ruleResult.error) throw ruleResult.error;

  return getEmailTemplate(key);
}

async function loadContacts(): Promise<Contact[]> {
  const directory = await getEmployeeDirectory().catch(() => ({ employees: [] as EmployeeDirectoryRow[] }));
  const authRoles = new Map<string, string>();

  try {
    const { data } = await getSupabaseAdmin()
      .from("app_auth_users")
      .select("hr_id,role,is_active")
      .eq("is_active", true);
    for (const row of (data ?? []) as Array<{ hr_id: string | null; role: string | null }>) {
      if (row.hr_id) authRoles.set(row.hr_id.toLowerCase(), row.role ?? "");
    }
  } catch {
    // Employee role routing should still work from titles when auth roles are unavailable.
  }

  return directory.employees
    .map((employee) => ({
      email: normalizeEmail(employee.workEmail),
      hrId: employee.hrId,
      line: employee.lineName,
      managerHrId: employee.managerHrId,
      name: employee.fullName,
      role: authRoles.get(employee.hrId.toLowerCase()) ?? employee.jobTitle ?? employee.positionTitle ?? null,
      title: employee.positionTitle ?? employee.jobTitle,
    }))
    .filter((contact) => validEmail(contact.email));
}

function hrIdMatches(left: string | null | undefined, right: string | null | undefined) {
  return Boolean(left && right && left.trim().toLowerCase() === right.trim().toLowerCase());
}

function textMatches(value: string | null | undefined, options: string[]) {
  if (options.length === 0) return true;
  const normalized = text(value).toLowerCase();
  return options.some((option) => normalized.includes(option.toLowerCase()));
}

function lineMatches(value: string | null | undefined, options: string[]) {
  if (options.length === 0) return true;
  const normalized = text(value).toLowerCase();
  return options.some((option) => normalized === option.toLowerCase());
}

function roleMatches(contact: Contact, role: EmailTemplateRecipientRole, employee: Contact | null, rules: EmailTemplateRecipientRules) {
  const value = `${contact.role ?? ""} ${contact.title ?? ""}`.toLowerCase();
  switch (role) {
    case "hr":
    case "hr_manager":
      return value.includes("hr");
    case "finance":
      return value.includes("finance");
    case "hiring_manager":
      return value.includes("hiring manager") || value.includes("recruiting manager");
    case "admin":
      return value.includes("admin") || value.includes("super admin");
    case "ceo":
      return value.includes("ceo");
    case "recruiter":
      return value.includes("recruiter") || value.includes("talent acquisition");
    case "district_manager":
      return value.includes("district manager") || value.includes("district sales manager");
    case "regional_sales_manager":
      return value.includes("regional manager") || value.includes("regional sales manager");
    case "national_sales_manager":
      return value.includes("national sales manager");
    case "line_manager":
      return value.includes("manager") && (!employee?.line || contact.line === employee.line);
    case "same_line_selected_titles":
      return Boolean(employee?.line && contact.line === employee.line && textMatches(contact.title, rules.targetTitles));
    case "all_lines_selected_titles":
      return textMatches(contact.title, rules.targetTitles);
    case "selected_lines_selected_titles":
      return lineMatches(contact.line, rules.targetLines) && textMatches(contact.title, rules.targetTitles);
    default:
      return false;
  }
}

function managerChain(contacts: Contact[], employee: Contact | null) {
  const output: Contact[] = [];
  let current = employee;
  const visited = new Set<string>();

  while (current?.managerHrId) {
    const manager = contacts.find((contact) => hrIdMatches(contact.hrId, current?.managerHrId));
    if (!manager?.hrId || visited.has(manager.hrId.toLowerCase())) break;
    output.push(manager);
    visited.add(manager.hrId.toLowerCase());
    current = manager;
  }

  return output;
}

function dedupe(recipients: Recipient[]) {
  const seen = new Set<string>();
  return recipients.filter((recipient) => {
    const email = normalizeEmail(recipient.email);
    if (!validEmail(email) || seen.has(email)) return false;
    seen.add(email);
    recipient.email = email;
    return true;
  });
}

function removeEmails(recipients: Recipient[], blocked: Recipient[]) {
  const emails = new Set(blocked.map((recipient) => normalizeEmail(recipient.email)));
  return recipients.filter((recipient) => !emails.has(normalizeEmail(recipient.email)));
}

function resolveRoleRecipients(
  role: EmailTemplateRecipientRole,
  contacts: Contact[],
  employee: Contact | null,
  candidateEmail: string | null | undefined,
  rules: EmailTemplateRecipientRules,
) {
  if (role === "candidate") return candidateEmail ? [{ email: candidateEmail, name: "Candidate" }] : [];
  if (role === "employee") return employee ? [{ email: employee.email, name: employee.name }] : [];
  if (role === "direct_manager") {
    const manager = managerChain(contacts, employee)[0];
    return manager ? [{ email: manager.email, name: manager.name }] : [];
  }
  if (role === "manager_of_manager") {
    const manager = managerChain(contacts, employee)[1];
    return manager ? [{ email: manager.email, name: manager.name }] : [];
  }
  if (role === "manager_chain") return managerChain(contacts, employee).map((manager) => ({ email: manager.email, name: manager.name }));
  return contacts.filter((contact) => roleMatches(contact, role, employee, rules)).map((contact) => ({ email: contact.email, name: contact.name }));
}

export async function resolveTemplateRecipients(input: {
  candidateEmail?: string | null;
  context?: Partial<EmailTemplateContext>;
  fallbackTo?: string[] | null;
  templateKey: string;
}) {
  const key = normalizeTemplateKey(input.templateKey);
  if (!key) throw new Error("Unsupported email template.");

  const [template, contacts] = await Promise.all([getEmailTemplate(key), loadContacts()]);
  const rules = template?.rules ?? defaultRules[key];
  const employeeHrId = input.context?.employeeHrId;
  const employee = contacts.find((contact) => hrIdMatches(contact.hrId, employeeHrId)) ?? null;

  const build = (roles: EmailTemplateRecipientRole[], staticEmails: string[]) => dedupe([
    ...roles.flatMap((role) => resolveRoleRecipients(role, contacts, employee, input.candidateEmail, rules)),
    ...staticEmails.map((email) => ({ email, name: "Static recipient" })),
  ]);

  let to = build(rules.toRoles, rules.toStaticEmails);
  if (to.length === 0) {
    to = cleanEmails(input.fallbackTo ?? []).map((email) => ({ email, name: "Fallback recipient" }));
  }
  const cc = removeEmails(build(rules.ccRoles, rules.ccStaticEmails), to);
  const bcc = removeEmails(build(rules.bccRoles, rules.bccStaticEmails), [...to, ...cc]);

  return { bcc, cc, to };
}

function contextVariables(input: Partial<EmailTemplateContext>, recipientName: string) {
  return {
    area: text(input.area),
    candidateName: text(input.candidateName),
    ctaLabel: text(input.ctaLabel || "Open in Phoenix Workforce"),
    ctaUrl: text(input.ctaUrl),
    date: text(input.date || new Date().toISOString().slice(0, 10)),
    endDate: text(input.endDate),
    employeeHrId: text(input.employeeHrId),
    employeeName: text(input.employeeName),
    expiryText: text(input.expiryText),
    feedback: text(input.feedback),
    interviewDate: text(input.interviewDate),
    interviewLocation: text(input.interviewLocation),
    interviewerName: text(input.interviewerName),
    interviewTime: text(input.interviewTime),
    jobTitle: text(input.jobTitle),
    line: text(input.line),
    managerName: text(input.managerName),
    meetingUrl: text(input.meetingUrl),
    nextStep: text(input.nextStep),
    recipientName,
    startDate: text(input.startDate),
    status: text(input.status),
    subject: text(input.subject),
    summary: text(input.summary),
    vacationType: text(input.vacationType),
  };
}

function recipientNameForGreeting(recipients: Recipient[], context: Partial<EmailTemplateContext>) {
  if (context.recipientName) return text(context.recipientName);
  if (recipients.length === 1 && recipients[0]?.name) return text(recipients[0].name);
  return "Team";
}

export function renderEmailTemplate(
  template: EmailTemplateDefinition,
  context: Partial<EmailTemplateContext> = {},
  recipients: Recipient[] = [],
) {
  const variables = contextVariables(context, recipientNameForGreeting(recipients, context));
  const subject = interpolate(template.subject, variables, false) || template.templateName;
  const greeting = interpolate(template.greeting, variables, false);
  const bodyHtml = sanitizeHtml(interpolate(template.bodyHtml, variables, true));
  const bodyText = interpolate(template.bodyText, variables, false);
  const closingText = interpolate(template.closingText, variables, false);
  const previewText = interpolate(template.previewText, variables, false) || subject;
  const action = variables.ctaUrl
    ? { href: variables.ctaUrl, label: variables.ctaLabel || "Open in Phoenix Workforce" }
    : undefined;

  return {
    html: renderPhoenixEmailHtml({
      action,
      bodyHtml: bodyHtml.trim() ? bodyHtml : renderEmailParagraphs(bodyText),
      closingText,
      greeting,
      previewText,
      subject,
      subtitle: "Official HR communication prepared through Phoenix Workforce.",
      title: subject,
    }),
    previewText,
    subject,
    text: renderPhoenixEmailText({
      action,
      bodyText,
      closingText,
      greeting,
      title: subject,
    }),
  };
}

export async function previewTemplate(templateKey: string, input: {
  context?: Partial<EmailTemplateContext>;
  template?: EmailTemplatePayload;
}) {
  const current = await getEmailTemplate(templateKey);
  if (!current) throw new Error("Unsupported email template.");
  const draft: EmailTemplateDefinition = {
    ...current,
    bodyHtml: text(input.template?.bodyHtml ?? current.bodyHtml),
    bodyText: text(input.template?.bodyText ?? current.bodyText),
    closingText: text(input.template?.closingText ?? current.closingText),
    description: text(input.template?.description ?? current.description),
    greeting: text(input.template?.greeting ?? current.greeting),
    isActive: Boolean(input.template?.isActive ?? current.isActive),
    previewText: text(input.template?.previewText ?? current.previewText),
    subject: text(input.template?.subject ?? current.subject),
    templateName: text(input.template?.templateName ?? current.templateName),
  };
  const recipients = [{ email: "preview@phoenix.local", name: input.context?.recipientName ?? "Team" }];
  const rendered = renderEmailTemplate(draft, input.context, recipients);
  return {
    html: rendered.html,
    previewText: rendered.previewText,
    recipients: { bcc: [], cc: [], to: recipients },
    subject: rendered.subject,
    text: rendered.text,
  };
}

export async function getEmailTemplateRoutingOptions() {
  const contacts = await loadContacts();
  const lines = contacts.map((contact) => contact.line).filter((value): value is string => Boolean(value));
  const titles = contacts.map((contact) => contact.title).filter((value): value is string => Boolean(value));
  return {
    lines: Array.from(new Set(lines)).sort(),
    recipientRoles: emailTemplateRecipientRoleOptions.map((value) => ({
      label: value.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" "),
      value,
    })),
    titles: Array.from(new Set(titles)).sort(),
  };
}

export async function sendTemplatedEmail(input: SendTemplatedEmailInput): Promise<SendPhoenixEmailResult> {
  const key = normalizeTemplateKey(input.templateKey);
  if (!key) return { reason: "Unsupported email template.", skipped: true };

  const template = await getEmailTemplate(key);
  if (!template) return { reason: "Email template not found.", skipped: true };
  if (!template.isActive) return { reason: `Email template ${key} is inactive.`, skipped: true };

  const context = {
    ...(input.context ?? {}),
    employeeHrId: input.employeeHrId ?? input.context?.employeeHrId ?? null,
  };
  const resolved = await resolveTemplateRecipients({
    candidateEmail: input.candidateEmail,
    context,
    fallbackTo: input.fallbackTo,
    templateKey: key,
  });
  const baseRecipients = input.overrides?.replaceRecipients
    ? { bcc: [] as Recipient[], cc: [] as Recipient[], to: [] as Recipient[] }
    : resolved;

  const to = dedupe([
    ...baseRecipients.to,
    ...cleanEmails(input.overrides?.to ?? []).map((email) => ({ email, name: "Override recipient" })),
  ]);
  const cc = removeEmails(dedupe([
    ...baseRecipients.cc,
    ...cleanEmails(input.overrides?.cc ?? []).map((email) => ({ email, name: "Override recipient" })),
  ]), to);
  const bcc = removeEmails(dedupe([
    ...baseRecipients.bcc,
    ...cleanEmails(input.overrides?.bcc ?? []).map((email) => ({ email, name: "Override recipient" })),
  ]), [...to, ...cc]);

  if (to.length === 0) return { reason: "No TO recipients resolved for email template.", skipped: true };

  const rendered = renderEmailTemplate(template, context, to);
  const requestId = crypto
    .createHash("sha256")
    .update(JSON.stringify({ key, subject: rendered.subject, to: to.map((recipient) => recipient.email), context }))
    .digest("hex");

  return sendPhoenixEmail({
    bcc: bcc.map((recipient) => recipient.email),
    cc: cc.map((recipient) => recipient.email),
    from: input.from ?? undefined,
    html: rendered.html,
    idempotencyKey: `template-${key}-${requestId}`,
    subject: rendered.subject,
    text: rendered.text,
    to: to.map((recipient) => recipient.email),
  });
}

export async function sendTemplateTestEmail(input: {
  context?: Partial<EmailTemplateContext>;
  template?: EmailTemplatePayload;
  templateKey: string;
  to: string;
}) {
  const key = normalizeTemplateKey(input.templateKey);
  if (!key) return { reason: "Unsupported email template.", skipped: true } satisfies SendPhoenixEmailResult;

  const to = normalizeEmail(input.to);
  if (!validEmail(to)) {
    throw new EmailTemplateValidationError([{
      field: "testEmail",
      message: "Enter a valid test email address.",
      type: "email",
    }]);
  }

  const validation = validateEmailTemplatePayload(input.template ?? {});
  if (!validation.isValid) throw new EmailTemplateValidationError(validation.issues);

  const current = await getEmailTemplate(key);
  if (!current) return { reason: "Email template not found.", skipped: true } satisfies SendPhoenixEmailResult;

  const draft: EmailTemplateDefinition = {
    ...current,
    bodyHtml: text(input.template?.bodyHtml ?? current.bodyHtml),
    bodyText: text(input.template?.bodyText ?? current.bodyText),
    closingText: text(input.template?.closingText ?? current.closingText),
    description: text(input.template?.description ?? current.description),
    greeting: text(input.template?.greeting ?? current.greeting),
    isActive: Boolean(input.template?.isActive ?? current.isActive),
    previewText: text(input.template?.previewText ?? current.previewText),
    subject: text(input.template?.subject ?? current.subject),
    templateName: text(input.template?.templateName ?? current.templateName),
  };
  const context = {
    area: "Cairo",
    candidateName: "Ahmed Hassan",
    ctaLabel: "Open in Phoenix Workforce",
    ctaUrl: "https://phoenix.example.com/action",
    employeeHrId: "PHX-1024",
    employeeName: "Mariam Adel",
    endDate: "2026-06-05",
    feedback: "Strong technical discussion and positive role alignment.",
    interviewDate: "2026-06-10",
    interviewLocation: "Phoenix Workforce Cairo Office",
    interviewerName: "Nour Samir",
    interviewTime: "10:30 AM",
    jobTitle: "Medical Rep",
    line: "Cardio Line",
    managerName: "Omar Nabil",
    meetingUrl: "https://meet.example.com/phoenix-interview",
    nextStep: "Share final feedback with HR and confirm the next interview round.",
    recipientName: "Test Recipient",
    startDate: "2026-06-01",
    status: "Sample status",
    subject: "Phoenix Workforce test email",
    summary: "This is a test email rendered from the current template draft.",
    vacationType: "Annual Leave",
    ...(input.context ?? {}),
  };
  const rendered = renderEmailTemplate(draft, context, [{ email: to, name: context.recipientName }]);
  const requestId = crypto
    .createHash("sha256")
    .update(JSON.stringify({ key, subject: rendered.subject, testTo: to, at: Date.now() }))
    .digest("hex");

  return sendPhoenixEmail({
    html: rendered.html,
    idempotencyKey: `template-test-${key}-${requestId}`,
    subject: `[Test] ${rendered.subject}`,
    text: rendered.text,
    to: [to],
  });
}

export function getTemplatePlaceholderHints() {
  return [...placeholderHints];
}
