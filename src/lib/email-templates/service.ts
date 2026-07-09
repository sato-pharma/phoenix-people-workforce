import crypto from "crypto";


import {
  renderEmailParagraphs,
  renderPhoenixEmailHtml,
  renderPhoenixEmailText,
} from "@/emails/phoenix-email-layout";
import { systemEmail } from "@/config/system-settings";
import { summarizeEmailTemplateReadiness } from "@/lib/communication/metrics";
import { sanitizeEmailTemplateHtml } from "@/lib/email/email-safety";
import { sendPhoenixEmail, type SendPhoenixEmailResult } from "@/lib/email/send-phoenix-email";
import { createUnsubscribeToken } from "@/lib/email/unsubscribe-token";
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
  "leave_submission_confirmation",
  "leave_resubmit_confirmation",
  "leave_returned",
  "leave_manager_step_decision",
  "vacation_balance_settlement",
  "password_setup",
  "password_reset",
  "user_created",
  "weekly_plans",
  "outstation",
  "marketing_request",
  "excuse_request",
  "excuse_decision",
  "offer_status",
  "recruitment_update",
  "coaching_report",
  "payroll_update",
  "attendance_digest",
  "general",
] as const;

export const EMAIL_TEMPLATE_KEYS = {
  ATTENDANCE_DIGEST: "attendance_digest",
  BIRTHDAY: "birthday",
  COACHING_REPORT: "coaching_report",
  EXCUSE_DECISION: "excuse_decision",
  EXCUSE_REQUEST: "excuse_request",
  CONTRACT_RENEWAL: "contract_renewal",
  GENERAL: "general",
  INTERVIEW_FEEDBACK: "interview_feedback",
  INTERVIEW_INVITATION: "interview_invitation",
  JOB_OFFER: "offer",
  LEAVE_APPROVAL: "leave_approval",
  LEAVE_MANAGER_STEP_DECISION: "leave_manager_step_decision",
  LEAVE_REJECTION: "leave_rejection",
  LEAVE_REQUEST: "leave_request",
  LEAVE_RESUBMIT_CONFIRMATION: "leave_resubmit_confirmation",
  LEAVE_RETURNED: "leave_returned",
  LEAVE_SUBMISSION_CONFIRMATION: "leave_submission_confirmation",
  VACATION_BALANCE_SETTLEMENT: "vacation_balance_settlement",
  MARKETING_REQUEST: "marketing_request",
  OFFER_STATUS: "offer_status",
  OUTSTATION: "outstation",
  PASSWORD_SETUP: "password_setup",
  PASSWORD_RESET: "password_reset",
  PROBATION_REMINDER: "probation_reminder",
  PROBATION_WORKFLOW: "probation_workflow",
  PAYROLL_UPDATE: "payroll_update",
  RECRUITMENT_UPDATE: "recruitment_update",
  RESIGNATION_WORKFLOW: "resignation_workflow",
  USER_CREATED: "user_created",
  WEEKLY_PLANS: "weekly_plans",
} as const satisfies Record<string, EmailTemplateKey>;

export const emailTemplateRecipientRoleOptions = [
  "employee",
  "candidate",
  "direct_manager",
  "manager_of_manager",
  "manager_chain",
  "employee_team",
  "direct_reports",
  "employee_line",
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
  amount?: string | null;
  area?: string | null;
  /** Pre-rendered HTML deduction table (day/date, value, quantity, reason) for the attendance_digest template. */
  digestTable?: string | null;
  digestTableText?: string | null;
  /** Formatted date range for the settlement week, e.g. "2026-06-24 to 2026-06-30". */
  weekLabel?: string | null;
  candidateName?: string | null;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  date?: string | null;
  destination?: string | null;
  approvalFlow?: string | null;
  duration?: string | null;
  /** Friendly excuse type label (e.g. "Morning excuse") for the excuse_decision template. */
  excuseType?: string | null;
  /** Excuse date (YYYY-MM-DD) for the excuse_decision template. */
  excuseDate?: string | null;
  endDate?: string | null;
  employeeHrId?: string | null;
  employeeName?: string | null;
  expiryText?: string | null;
  feedback?: string | null;
  hireDate?: string | null;
  /** "Dr. " for manager roles, "" for non-managers; rendered by {{honorific}} in greeting. */
  honorific?: string | null;
  interviewDate?: string | null;
  interviewLocation?: string | null;
  interviewerName?: string | null;
  interviewTime?: string | null;
  jobTitle?: string | null;
  line?: string | null;
  managerName?: string | null;
  meetingUrl?: string | null;
  nextStep?: string | null;
  /** Pre-rendered HTML table (e.g. submitted plan rows); sanitized, not escaped, in bodyHtml. */
  planTable?: string | null;
  /** Plain-text projection used wherever {{planTable}} appears in text fields. */
  planTableText?: string | null;
  /** Pre-rendered HTML score table for coaching report metrics; sanitized, not escaped, in bodyHtml. */
  scoreTable?: string | null;
  /** Plain-text projection used wherever {{scoreTable}} appears in text fields. */
  scoreTableText?: string | null;
  recipientName?: string | null;
  startDate?: string | null;
  status?: string | null;
  subject?: string | null;
  summary?: string | null;
  vacationBalance?: string | null;
  vacationType?: string | null;
  // ── Marketing-request fields (editable tokens for the marketing_request template) ──
  currentStep?: string | null;
  customerName?: string | null;
  estimatedCost?: string | null;
  payDate?: string | null;
  /** Pre-rendered HTML product rows for marketing emails; sanitized, not escaped, in bodyHtml. */
  productsTable?: string | null;
  productsTableText?: string | null;
  requestCode?: string | null;
  requesterName?: string | null;
  requiredRoi?: string | null;
  /** Pre-rendered HTML return-reason callout (empty unless returned/rejected); raw in bodyHtml. */
  returnCallout?: string | null;
  returnCalloutText?: string | null;
  roiWindow?: string | null;
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
  category: EmailTemplateCategory;
  createdAt: string;
  draftEditedAt: string | null;
  draftEditedBy: string | null;
  hasDraftChanges: boolean;
  health: EmailTemplateHealth;
  publicationState: EmailTemplatePublicationState;
  publishedIsActive: boolean;
  publishedUpdatedAt: string;
  rules: EmailTemplateRecipientRules;
  updatedAt: string;
};

export type EmailTemplatePayload = Partial<Omit<EmailTemplateDefinition, "templateKey">> & {
  changeReason?: string;
  rules?: Partial<EmailTemplateRecipientRules>;
};

export type EmailTemplateHistoryAction = "draft" | "publish" | "rollback" | "save";

export type EmailTemplateHistoryEntry = {
  action: EmailTemplateHistoryAction;
  changedAt: string;
  changedBy: string | null;
  id: string;
  reason: string | null;
  rollbackSourceVersion: number | null;
  rulesSnapshot: EmailTemplateRecipientRules;
  templateKey: EmailTemplateKey;
  templateSnapshot: EmailTemplateDefinition;
  versionNumber: number;
};

export type EmailTemplateCategory =
  | "Account Access"
  | "Employee Lifecycle"
  | "General"
  | "Leave Management"
  | "Recruitment";

export type EmailTemplatePublicationState = "draft_changes" | "draft_unpublished" | "inactive" | "published";

export type EmailTemplateHealth = {
  issues: Array<{ message: string; severity: "error" | "warning" }>;
  label: "Good" | "Needs Attention" | "Broken";
  score: number;
  status: "broken" | "good" | "needs_attention";
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

type HistoryTableRow = {
  action: string | null;
  changed_at: string | null;
  changed_by: string | null;
  id: string;
  reason: string | null;
  rollback_source_version: number | null;
  rules_snapshot: EmailTemplateRecipientRules | null;
  template_key: string;
  template_snapshot: EmailTemplateDefinition | null;
  version_number: number | null;
};

type DraftTableRow = {
  edited_at: string | null;
  edited_by: string | null;
  reason: string | null;
  rules_snapshot: EmailTemplateRecipientRules | null;
  template_key: string;
  template_snapshot: EmailTemplateDefinition | null;
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
const emailTemplateDraftsTable = "email_template_drafts";
const emailTemplateHistoryTable = "email_template_history";
const recipientRulesTable = "email_template_recipient_rules";
const placeholderHints = [
  "employeeName",
  "employeeHrId",
  "candidateName",
  "jobTitle",
  "managerName",
  "line",
  "area",
  "amount",
  "destination",
  "approvalFlow",
  "status",
  "date",
  "duration",
  // Excuse-decision tokens (employee-facing approval/rejection notice).
  "excuseType",
  "excuseDate",
  "startDate",
  "endDate",
  "hireDate",
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
  // "Dr. " for manager roles, "" for others — pair with {{recipientName}} in greeting fields.
  "honorific",
  "vacationBalance",
  // These three were always offered as designer chips and filled by contextVariables, but
  // missing here - so templates using them (general, weekly_plans, leave_*) failed
  // validation and showed "Broken" health even with their shipped defaults.
  "subject",
  "summary",
  "vacationType",
  // Pre-rendered HTML table of submitted weekly/monthly plan rows (weekly_plans only).
  "planTable",
  // Pre-rendered HTML deduction table + week date range (attendance_digest only).
  "digestTable",
  "weekLabel",
  // Coaching score table for the coaching_report template.
  "scoreTable",
  // Marketing-request editable tokens. Scalars fill per request; productsTable + returnCallout
  // are pre-rendered HTML blocks (raw in bodyHtml, empty/text projection elsewhere).
  "estimatedCost",
  "requiredRoi",
  "roiWindow",
  "payDate",
  "customerName",
  "currentStep",
  "requestCode",
  "requesterName",
  "productsTable",
  "returnCallout",
] as const;
const allowedPlaceholderSet = new Set<string>(placeholderHints);

const defaultRules: Record<EmailTemplateKey, EmailTemplateRecipientRules> = {
  birthday: emptyRules(["employee"], ["district_manager"]),
  contract_renewal: emptyRules(["manager_chain"], ["hr"]),
  general: emptyRules(["admin"], ["hr"]),
  marketing_request: emptyRules(["admin"], ["hr"]),
  excuse_request: emptyRules(["direct_manager"], ["hr"]),
  excuse_decision: emptyRules(["employee"]),
  offer_status: emptyRules(["hr"], []),
  recruitment_update: emptyRules(["hr", "recruiter"], []),
  coaching_report: emptyRules(["employee"], ["direct_manager"]),
  payroll_update: emptyRules(["admin"], ["finance"]),
  attendance_digest: emptyRules(["employee"]),
  weekly_plans: emptyRules(["employee"], ["direct_manager"]),
  outstation: emptyRules(["direct_manager"], ["hr_manager", "finance"]),
  interview_feedback: emptyRules(["hr", "hiring_manager", "recruiter"]),
  interview_invitation: emptyRules(["candidate"]),
  leave_approval: emptyRules(["employee"], ["hr"]),
  leave_manager_step_decision: emptyRules(["employee"], ["hr"]),
  leave_rejection: emptyRules(["employee"], ["hr"]),
  leave_request: emptyRules(["direct_manager"], ["manager_of_manager", "hr"]),
  leave_resubmit_confirmation: emptyRules(["employee"]),
  leave_returned: emptyRules(["employee"], ["hr"]),
  leave_submission_confirmation: emptyRules(["employee"]),
  vacation_balance_settlement: emptyRules(["employee", "direct_manager"], ["hr"]),
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
    bodyHtml:
      "<p>On behalf of Sato Pharma Family and Phoenix HR team we wish you a very happy birthday.</p><p>May this bring you more success, happiness, achievements that you have ever dreamt of.</p><p>We are proud to have you as part of our team and we wish you a wonderful year ahead.</p>",
    bodyText:
      "On behalf of Sato Pharma Family and Phoenix HR team we wish you a very happy birthday. May this bring you more success, happiness, achievements that you have ever dreamt of. We are proud to have you as part of our team and we wish you a wonderful year ahead.",
    closingText: "Wishing you a wonderful birthday and a year ahead full of success.",
    description: "Birthday wishes routed to the employee.",
    greeting: "Dear {{honorific}}{{recipientName}},",
    isActive: true,
    previewText: "happy birthday wishes from Sato Pharma Family and Phoenix HR team",
    subject: "Happy Birthday, {{recipientName}}",
    templateKey: "birthday",
    templateName: "Birthday Wishes",
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
  marketing_request: {
    bodyHtml:
      "<p>{{summary}}</p>" +
      "{{returnCallout}}" +
      '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%">' +
      '<tr><td width="50%" style="background-color:#f8fafc;border:1px solid #e2e8f0;padding:12px 14px;width:50%"><span style="color:#64748b;font-size:11px">Estimated cost</span><br /><span style="color:#0f172a;font-size:18px;font-weight:600">{{estimatedCost}}</span></td>' +
      '<td width="50%" style="background-color:#fff7ed;border:1px solid #fed7aa;padding:12px 14px;width:50%"><span style="color:#9a3412;font-size:11px">Required ROI</span><br /><span style="color:#9a3412;font-size:18px;font-weight:600">{{requiredRoi}}</span></td></tr>' +
      '<tr><td style="background-color:#f8fafc;border:1px solid #e2e8f0;padding:12px 14px"><span style="color:#64748b;font-size:11px">Customer</span><br /><span style="color:#0f172a;font-size:14px;font-weight:600">{{customerName}}</span></td>' +
      '<td style="background-color:#f8fafc;border:1px solid #e2e8f0;padding:12px 14px"><span style="color:#64748b;font-size:11px">Pay date</span><br /><span style="color:#0f172a;font-size:14px;font-weight:600">{{payDate}}</span></td></tr>' +
      "</table>" +
      "{{productsTable}}" +
      '<p style="font-size:13px;color:#475569">Currently with: <strong style="color:#0f172a">{{currentStep}}</strong> · ROI window {{roiWindow}}</p>',
    bodyText:
      "{{summary}}\n\n{{returnCallout}}Estimated cost: {{estimatedCost}}\nRequired ROI: {{requiredRoi}}\nCustomer: {{customerName}} · Pay date: {{payDate}}\n\n{{productsTable}}\n\nCurrently with: {{currentStep}} · ROI window {{roiWindow}}",
    closingText: "Open Phoenix Workforce to review the marketing request and take the next action.",
    description: "Marketing request workflow updates: submission, assignment, approvals, returns, completion, and SLA reminders.",
    greeting: "Dear {{honorific}}{{recipientName}},",
    isActive: true,
    previewText: "A marketing request needs your attention.",
    subject: "{{subject}}",
    templateKey: "marketing_request",
    templateName: "Marketing Request",
  },
  excuse_request: {
    bodyHtml: "<p>{{summary}}</p><p><strong>Date:</strong> {{date}}</p><p>{{status}}</p>",
    bodyText: "{{summary}}\n\nDate: {{date}}\n\n{{status}}",
    closingText: "Open Phoenix Workforce to review the excuse request.",
    description: "Excuse (late arrival / early leave) updates: submission to the manager and the decision back to the employee.",
    greeting: "Dear {{honorific}}{{recipientName}},",
    isActive: true,
    previewText: "An excuse request update needs your attention.",
    subject: "{{subject}}",
    templateKey: "excuse_request",
    templateName: "Excuse Request",
  },
  excuse_decision: {
    bodyHtml:
      "<p>{{summary}}</p>" +
      "<p><strong>Excuse type:</strong> {{excuseType}}</p>" +
      "<p><strong>Date:</strong> {{excuseDate}}</p>" +
      "<p><strong>Duration:</strong> {{duration}}</p>" +
      "<p><strong>Decision:</strong> {{status}}</p>",
    bodyText:
      "{{summary}}\n\nExcuse type: {{excuseType}}\nDate: {{excuseDate}}\nDuration: {{duration}}\nDecision: {{status}}",
    closingText: "Open Phoenix Workforce to review your excuse history.",
    description:
      "Excuse decision result sent to the employee after their manager approves or rejects an excuse (late arrival / early leave) request.",
    greeting: "Dear {{honorific}}{{recipientName}},",
    isActive: true,
    previewText: "An update on your excuse request.",
    subject: "Your excuse request was {{status}}",
    templateKey: "excuse_decision",
    templateName: "Excuse Decision",
  },
  offer_status: {
    bodyHtml: "<p>{{summary}}</p><p>{{status}}</p>",
    bodyText: "{{summary}}\n\n{{status}}",
    closingText: "Open Phoenix Workforce to review the offer and continue the hiring workflow.",
    description: "Offer status updates: candidate accepted/rejected confirmations and HR hiring alerts (the offer letter itself uses the Job Offer template).",
    greeting: "Dear {{honorific}}{{recipientName}},",
    isActive: true,
    previewText: "A job offer status update needs your attention.",
    subject: "{{subject}}",
    templateKey: "offer_status",
    templateName: "Offer Status",
  },
  recruitment_update: {
    bodyHtml: "<p>{{summary}}</p><p>{{status}}</p>",
    bodyText: "{{summary}}\n\n{{status}}",
    closingText: "Open Phoenix Workforce to review the recruitment pipeline.",
    description: "Recruitment notices: interview cancellations, interviewer notifications, and day-before reminders (invitations and feedback use their own templates).",
    greeting: "Dear {{honorific}}{{recipientName}},",
    isActive: true,
    previewText: "A recruitment update needs your attention.",
    subject: "{{subject}}",
    templateKey: "recruitment_update",
    templateName: "Recruitment Update",
  },
  coaching_report: {
    bodyHtml:
      "<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"border-collapse:separate;width:100%;border:1px solid #CBD5E1\">" +
      "<tr><td style=\"background-color:#FFFFFF;padding:16px\">" +
      "<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"border-collapse:collapse;width:100%;border:1px solid #E2E8F0\">" +
      "<tr><td style=\"background-color:#F8FAFC;border:1px solid #E2E8F0;padding:10px 12px;color:#64748B;font-size:12px;line-height:1.4;font-weight:700;text-align:left\">Status</td>" +
      "<td style=\"border:1px solid #E2E8F0;padding:10px 12px;color:#0F172A;font-size:13px;line-height:1.4;font-weight:700;text-align:right\">{{status}}</td></tr>" +
      "</table>" +
      "<p style=\"color:#0F172A;font-size:16px;line-height:1.4;font-weight:900\">Metric Scorecard</p>" +
      "{{scoreTable}}" +
      "<p style=\"color:#64748B;font-size:12px;line-height:1.55\">Please review the submitted coaching scores and acknowledge the report in Phoenix Workforce.</p>" +
      "</td></tr>" +
      "</table>",
    bodyText:
      "Status: {{status}}\n\nMetric Scorecard\n{{scoreTable}}\n\nPlease review the submitted coaching scores and acknowledge the report in Phoenix Workforce.",
    closingText: "Open Phoenix Workforce to review and acknowledge the coaching report.",
    description: "Coaching report notifications: a submitted report awaiting the employee's review and acknowledgement.",
    greeting: "Dear {{honorific}}{{recipientName}},",
    isActive: true,
    previewText: "A coaching report is ready for your review.",
    subject: "{{subject}}",
    templateKey: "coaching_report",
    templateName: "Coaching Report",
  },
  payroll_update: {
    bodyHtml: "<p>{{summary}}</p><p>{{status}}</p>",
    bodyText: "{{summary}}\n\n{{status}}",
    closingText: "Open Phoenix Workforce to review the payroll batch.",
    description: "Payroll operations notices to payroll staff: salary uploads and batch workflow actions.",
    greeting: "Dear {{honorific}}{{recipientName}},",
    isActive: true,
    previewText: "A payroll update needs your attention.",
    subject: "{{subject}}",
    templateKey: "payroll_update",
    templateName: "Payroll Update",
  },
  attendance_digest: {
    bodyHtml: "<p>{{summary}}</p>{{digestTable}}<p>{{status}}</p>",
    bodyText: "{{summary}}\n\n{{digestTable}}\n\n{{status}}",
    closingText: "Open Phoenix Workforce to confirm or dispute.",
    description: "Weekly attendance digest sent to an employee after admin review, showing any deductible days.",
    greeting: "Dear {{honorific}}{{recipientName}},",
    isActive: true,
    previewText: "Your weekly attendance digest is ready.",
    subject: "Weekly attendance digest — {{weekLabel}}",
    templateKey: "attendance_digest",
    templateName: "Weekly Attendance Digest",
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
  weekly_plans: {
    bodyHtml: "<p>{{summary}}</p>{{planTable}}<p>{{status}}</p>",
    bodyText: "{{summary}}\n\n{{planTable}}\n\n{{status}}",
    closingText: "Please open Phoenix Workforce to review the plan details.",
    description: "Weekly and monthly plan updates: submissions, approvals, and rejections.",
    greeting: "Dear {{honorific}}{{recipientName}},",
    isActive: true,
    previewText: "A weekly/monthly plan update needs your attention.",
    subject: "{{subject}}",
    templateKey: "weekly_plans",
    templateName: "Weekly / Monthly Plans",
  },
  outstation: {
    bodyHtml:
      "<p>{{summary}}</p><p><strong>Employee:</strong> {{employeeName}}</p><p><strong>Amount:</strong> {{amount}}</p><p><strong>Destination:</strong> {{destination}}</p><p><strong>Trip dates:</strong> {{startDate}} to {{endDate}}</p>",
    bodyText:
      "{{summary}}\n\nEmployee: {{employeeName}}\nAmount: {{amount}}\nDestination: {{destination}}\nTrip dates: {{startDate}} to {{endDate}}",
    closingText: "Open Phoenix Workforce to review the full request and supporting evidence.",
    description: "Outstation and expense updates: submission (to the approver), approval, and rejection (to the employee).",
    greeting: "Dear {{honorific}}{{recipientName}},",
    isActive: true,
    previewText: "An outstation / expense request needs your attention.",
    subject: "{{subject}}",
    templateKey: "outstation",
    templateName: "Outstation / Expense",
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
    greeting: "Dear {{honorific}}{{recipientName}},",
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
    greeting: "Dear {{honorific}}{{recipientName}},",
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
  leave_submission_confirmation: {
    bodyHtml: "<p>Your {{vacationType}} request has been submitted and is now pending manager review.</p><p><strong>Period:</strong> {{startDate}} to {{endDate}}</p><p><strong>Duration:</strong> {{duration}}</p><p><strong>Status:</strong> Pending manager review</p>",
    bodyText: "Your {{vacationType}} request has been submitted and is now pending manager review.\n\nPeriod: {{startDate}} to {{endDate}}\nDuration: {{duration}}\nStatus: Pending manager review",
    closingText: "You will be notified once your manager reviews the request.",
    description: "Confirmation sent to the employee immediately after they submit a leave request.",
    greeting: "Dear {{honorific}}{{recipientName}},",
    isActive: true,
    previewText: "Your leave request has been submitted and is pending manager review.",
    subject: "Your vacation request has been submitted",
    templateKey: "leave_submission_confirmation",
    templateName: "Leave Submission Confirmation",
  },
  leave_resubmit_confirmation: {
    bodyHtml: "<p>Your {{vacationType}} request has been resubmitted and is now pending manager review.</p><p><strong>Period:</strong> {{startDate}} to {{endDate}}</p><p><strong>Duration:</strong> {{duration}}</p><p><strong>Status:</strong> Pending manager review</p>",
    bodyText: "Your {{vacationType}} request has been resubmitted and is now pending manager review.\n\nPeriod: {{startDate}} to {{endDate}}\nDuration: {{duration}}\nStatus: Pending manager review",
    closingText: "You will be notified once your manager reviews the updated request.",
    description: "Confirmation sent to the employee after they resubmit a returned leave request.",
    greeting: "Dear {{honorific}}{{recipientName}},",
    isActive: true,
    previewText: "Your leave request has been resubmitted and is pending manager review.",
    subject: "Your vacation request has been resubmitted",
    templateKey: "leave_resubmit_confirmation",
    templateName: "Leave Resubmit Confirmation",
  },
  leave_returned: {
    bodyHtml: "<p>{{managerName}} returned your {{vacationType}} request for revision.</p><p><strong>Period:</strong> {{startDate}} to {{endDate}}</p><p><strong>Returned by:</strong> {{managerName}}</p><p><strong>Reason:</strong> {{summary}}</p><p>Please review the reason and resubmit your request through Phoenix Workforce.</p>",
    bodyText: "{{managerName}} returned your {{vacationType}} request for revision.\n\nPeriod: {{startDate}} to {{endDate}}\nReturned by: {{managerName}}\nReason: {{summary}}\n\nPlease review the reason and resubmit your request.",
    closingText: "Log in to Phoenix Workforce, review the feedback, update your request, and resubmit.",
    description: "Notifies the employee (CC: HR) when a manager returns their leave request for revision.",
    greeting: "Dear {{honorific}}{{recipientName}},",
    isActive: true,
    previewText: "Your leave request was returned for revision.",
    subject: "Vacation request returned for revision",
    templateKey: "leave_returned",
    templateName: "Leave Returned for Revision",
  },
  leave_manager_step_decision: {
    bodyHtml: "<p>{{summary}}</p><p><strong>Type:</strong> {{vacationType}}</p><p><strong>Period:</strong> {{startDate}} to {{endDate}}</p><p><strong>Manager:</strong> {{managerName}}</p><p><strong>Decision:</strong> {{status}}</p><p>{{nextStep}}</p>",
    bodyText: "{{summary}}\n\nType: {{vacationType}}\nPeriod: {{startDate}} to {{endDate}}\nManager: {{managerName}}\nDecision: {{status}}\n\n{{nextStep}}",
    closingText: "Open Phoenix Workforce to track the status of your leave request.",
    description: "Notifies the employee (CC: HR) after an intermediate manager approves or rejects their leave request, before the final HR step.",
    greeting: "Dear {{honorific}}{{recipientName}},",
    isActive: true,
    previewText: "An update on your leave request from your manager.",
    subject: "{{subject}}",
    templateKey: "leave_manager_step_decision",
    templateName: "Leave Manager Step Decision",
  },
  vacation_balance_settlement: {
    bodyHtml: "<p>Based on {{employeeName}}'s {{vacationType}} leave ({{startDate}} to {{endDate}}, {{duration}}), a deduction of {{amount}} would normally apply to this month's payroll for the unpaid portion.</p><p>The system administrator has approved settling this against the vacation balance instead — no salary deduction will occur.</p>",
    bodyText: "Based on {{employeeName}}'s {{vacationType}} leave ({{startDate}} to {{endDate}}, {{duration}}), a deduction of {{amount}} would normally apply to this month's payroll for the unpaid portion.\n\nThe system administrator has approved settling this against the vacation balance instead — no salary deduction will occur.",
    closingText: "Open Phoenix Workforce to review your vacation balance.",
    description: "Notifies the employee and their manager (CC: HR) when the CEO settles an unpaid-leave request against vacation balance instead of deducting it from payroll.",
    greeting: "Dear {{honorific}}{{recipientName}},",
    isActive: true,
    previewText: "An unpaid leave deduction has been settled against your vacation balance.",
    subject: "Vacation balance settlement — {{employeeName}}",
    templateKey: "vacation_balance_settlement",
    templateName: "Vacation Balance Settlement",
  },
  offer: {
    bodyHtml: "<p>We are pleased to share your offer details for {{jobTitle}}.</p><p>Reporting to {{managerName}} under {{line}} in {{area}}.</p><p>Planned start date: {{startDate}}.</p>",
    bodyText: "We are pleased to share your offer details for {{jobTitle}}. Reporting to {{managerName}} under {{line}} in {{area}}. Planned start date: {{startDate}}.",
    closingText: "Please respond through the action link at your convenience.",
    description: "Candidate job offer email with action links.",
    greeting: "Dear {{honorific}}{{recipientName}},",
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
    greeting: "Dear {{honorific}}{{recipientName}},",
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
    greeting: "Dear {{honorific}}{{recipientName}},",
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
    greeting: "Dear {{honorific}}{{recipientName}},",
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

const templateCategories: Record<EmailTemplateKey, EmailTemplateCategory> = {
  birthday: "Employee Lifecycle",
  contract_renewal: "Employee Lifecycle",
  general: "General",
  marketing_request: "General",
  excuse_request: "Leave Management",
  excuse_decision: "Leave Management",
  offer_status: "Recruitment",
  recruitment_update: "Recruitment",
  coaching_report: "Employee Lifecycle",
  payroll_update: "General",
  attendance_digest: "General",
  weekly_plans: "General",
  outstation: "General",
  interview_feedback: "Recruitment",
  interview_invitation: "Recruitment",
  leave_approval: "Leave Management",
  leave_manager_step_decision: "Leave Management",
  leave_rejection: "Leave Management",
  leave_request: "Leave Management",
  leave_resubmit_confirmation: "Leave Management",
  leave_returned: "Leave Management",
  leave_submission_confirmation: "Leave Management",
  vacation_balance_settlement: "Leave Management",
  offer: "Recruitment",
  password_reset: "Account Access",
  password_setup: "Account Access",
  probation_reminder: "Employee Lifecycle",
  probation_workflow: "Employee Lifecycle",
  resignation_workflow: "Employee Lifecycle",
  user_created: "Account Access",
};

export const emailTemplateCategories = [
  "All",
  "Recruitment",
  "Employee Lifecycle",
  "Leave Management",
  "Account Access",
  "General",
] as const;

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

/** Public alias of the internal key normalizer (lowercase, space/hyphen folding, aliases). */
export function normalizeEmailTemplateKey(value: string | null | undefined): EmailTemplateKey | null {
  return normalizeTemplateKey(value);
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

/**
 * Tokens whose values are trusted pre-rendered HTML blocks (system-built, e.g. the
 * submitted-plan table). They bypass per-value escaping in bodyHtml; the WHOLE
 * interpolated body still goes through sanitizeEmailTemplateHtml afterwards, which stays
 * the security authority. In text fields these tokens resolve to their text projection.
 */
const htmlBlockTokens: ReadonlySet<string> = new Set(["planTable", "productsTable", "returnCallout", "scoreTable", "digestTable"]);

function interpolate(
  template: string,
  variables: Record<string, string>,
  escapeValues: boolean,
  rawHtmlTokens?: ReadonlySet<string>,
) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = variables[key] ?? "";
    return escapeValues && !rawHtmlTokens?.has(key) ? escapeHtml(value) : value;
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
      // HTML-block tokens render multi-line tables - they only make sense in the body.
      // Single-line fields resolve them to "" at render time; flag at save time too.
      if (htmlBlockTokens.has(token) && field !== "bodyHtml" && field !== "bodyText") {
        issues.push({
          field,
          message: `{{${token}}} is only available in the email body.`,
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
    message.includes("email_template_history") ||
    message.includes("email_template_drafts") ||
    message.includes("email_templates") ||
    message.includes("email_template_recipient_rules") ||
    message.includes("does not exist") ||
    message.includes("schema cache")
  );
}

function hasAnyRecipientRule(rules: EmailTemplateRecipientRules) {
  return [
    rules.bccRoles,
    rules.bccStaticEmails,
    rules.ccRoles,
    rules.ccStaticEmails,
    rules.toRoles,
    rules.toStaticEmails,
  ].some((values) => values.length > 0);
}

export function getEmailTemplateHealth(template: EmailTemplateDefinition, rules: EmailTemplateRecipientRules): EmailTemplateHealth {
  const validation = validateEmailTemplatePayload({ ...template, rules });
  const issues: EmailTemplateHealth["issues"] = [];
  let score = 100;

  if (!text(template.subject)) {
    issues.push({ message: "Subject is missing.", severity: "error" });
    score -= 25;
  }
  if (!text(template.bodyHtml) && !text(template.bodyText)) {
    issues.push({ message: "Email body is missing.", severity: "error" });
    score -= 30;
  }
  if (!hasAnyRecipientRule(rules)) {
    issues.push({ message: "No recipients are configured.", severity: "error" });
    score -= 30;
  }
  if (!template.isActive) {
    issues.push({ message: "Template is inactive.", severity: "warning" });
    score -= 10;
  }
  for (const issue of validation.issues) {
    issues.push({ message: issue.message, severity: "error" });
    score -= 15;
  }
  const staticEmails = [...rules.toStaticEmails, ...rules.ccStaticEmails, ...rules.bccStaticEmails];
  if (staticEmails.some((email) => !email.toLowerCase().endsWith("@satopharma.com"))) {
    issues.push({ message: "External static recipients need careful review before publishing.", severity: "warning" });
    score -= 10;
  }

  const normalizedScore = Math.max(0, Math.min(100, score));
  const hasErrors = issues.some((issue) => issue.severity === "error");
  if (hasErrors || normalizedScore < 60) {
    return { issues, label: "Broken", score: normalizedScore, status: "broken" };
  }
  if (issues.length > 0 || normalizedScore < 90) {
    return { issues, label: "Needs Attention", score: normalizedScore, status: "needs_attention" };
  }
  return { issues, label: "Good", score: normalizedScore, status: "good" };
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

function mapDraft(row: DraftTableRow | null | undefined, key: EmailTemplateKey) {
  if (!row?.template_snapshot || !row.rules_snapshot) return null;
  return {
    editedAt: row.edited_at ?? new Date().toISOString(),
    editedBy: row.edited_by ?? null,
    reason: row.reason ?? null,
    rules: normalizeRules(row.rules_snapshot, key),
    template: {
      ...templateDefaults[key],
      ...row.template_snapshot,
      templateKey: key,
    },
  };
}

function toTemplateRow(
  template: EmailTemplateDefinition,
  row?: TemplateTableRow | null,
  rules?: RulesTableRow | null,
  draftRow?: DraftTableRow | null,
): EmailTemplateRow {
  const liveRules = mapRules(rules, template.templateKey);
  const draft = mapDraft(draftRow, template.templateKey);
  const displayTemplate = draft?.template ?? template;
  const displayRules = draft?.rules ?? liveRules;
  const publishedIsActive = template.isActive;
  const hasDraftChanges = Boolean(draft);
  const publicationState: EmailTemplatePublicationState = hasDraftChanges
    ? (publishedIsActive ? "draft_changes" : "draft_unpublished")
    : (publishedIsActive ? "published" : "inactive");
  const publishedUpdatedAt = row?.updated_at ?? new Date().toISOString();
  const draftEditedAt = draft?.editedAt ?? null;
  // "Updated" must show the LATEST change: an old draft must not mask a newer live save
  // (a June 6 draft previously pinned the card date while saves kept landing later).
  const draftIsNewer = Boolean(
    draftEditedAt && Date.parse(draftEditedAt) > (Date.parse(publishedUpdatedAt) || 0),
  );
  return {
    ...displayTemplate,
    category: templateCategories[template.templateKey],
    createdAt: row?.created_at ?? new Date().toISOString(),
    draftEditedAt,
    draftEditedBy: draft?.editedBy ?? null,
    hasDraftChanges,
    health: getEmailTemplateHealth(displayTemplate, displayRules),
    publicationState,
    publishedIsActive,
    publishedUpdatedAt,
    rules: displayRules,
    updatedAt: draftIsNewer ? (draftEditedAt as string) : publishedUpdatedAt,
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

async function readTemplateDrafts() {
  const result = await getSupabaseAdmin()
    .from(emailTemplateDraftsTable)
    .select("template_key,template_snapshot,rules_snapshot,edited_by,edited_at,reason");

  if (result.error) {
    if (tableMissing(result.error)) return [] as DraftTableRow[];
    throw result.error;
  }
  return (result.data ?? []) as DraftTableRow[];
}

export async function getEmailTemplateCatalog(options: { includeDrafts?: boolean } = {}): Promise<EmailTemplateRow[]> {
  try {
    const [{ templates, rules }, drafts] = await Promise.all([
      readTemplateTables(),
      options.includeDrafts ? readTemplateDrafts() : Promise.resolve([] as DraftTableRow[]),
    ]);
    return emailTemplateKeys
      .map((key) => {
        const templateRow = templates.find((row) => normalizeTemplateKey(row.template_key) === key) ?? null;
        const rulesRow = rules.find((row) => normalizeTemplateKey(row.template_key) === key) ?? null;
        const draftRow = drafts.find((row) => normalizeTemplateKey(row.template_key) === key) ?? null;
        return toTemplateRow(mapTemplate(templateRow, key), templateRow, rulesRow, draftRow);
      })
      .sort((left, right) => left.templateName.localeCompare(right.templateName));
  } catch (error) {
    if (!tableMissing(error)) throw error;
    return emailTemplateKeys
      .map((key) => toTemplateRow(templateDefaults[key], null, null))
      .sort((left, right) => left.templateName.localeCompare(right.templateName));
  }
}

export function getEmailTemplateCategoryOptions() {
  return [...emailTemplateCategories];
}

export async function getEmailTemplateDesignerCatalog() {
  return getEmailTemplateCatalog({ includeDrafts: true });
}

export async function getEmailTemplateReadinessMetrics() {
  const templates = await getEmailTemplateCatalog({ includeDrafts: true });
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

function mapHistory(row: HistoryTableRow): EmailTemplateHistoryEntry | null {
  const key = normalizeTemplateKey(row.template_key);
  if (!key || !row.template_snapshot || !row.rules_snapshot || !row.version_number) return null;
  const action = ["draft", "publish", "rollback", "save"].includes(String(row.action))
    ? (row.action as EmailTemplateHistoryAction)
    : "save";
  return {
    action,
    changedAt: row.changed_at ?? new Date().toISOString(),
    changedBy: row.changed_by ?? null,
    id: row.id,
    reason: row.reason ?? null,
    rollbackSourceVersion: row.rollback_source_version ?? null,
    rulesSnapshot: normalizeRules(row.rules_snapshot, key),
    templateKey: key,
    templateSnapshot: {
      ...templateDefaults[key],
      ...row.template_snapshot,
      templateKey: key,
    },
    versionNumber: row.version_number,
  };
}

async function recordTemplateHistory(input: {
  action: EmailTemplateHistoryAction;
  actor?: string | null;
  reason?: string | null;
  rollbackSourceVersion?: number | null;
  rules: EmailTemplateRecipientRules;
  template: EmailTemplateDefinition;
}) {
  const supabase = getSupabaseAdmin();
  const latest = await supabase
    .from(emailTemplateHistoryTable)
    .select("version_number")
    .eq("template_key", input.template.templateKey)
    .order("version_number", { ascending: false })
    .limit(1);

  if (latest.error) {
    if (tableMissing(latest.error)) {
      // tableMissing also matches a transient PostgREST schema-cache miss, so a publish
      // could mutate the live template with no version/audit record. Surface it instead
      // of swallowing fully silently.
      console.log("Email template history not recorded (table missing / schema cache)", {
        level: "warning",
        tags: { component: "email-templates", action: input.action },
        extra: { templateKey: input.template.templateKey },
      });
      return;
    }
    throw latest.error;
  }

  const currentVersion = Number((latest.data?.[0] as { version_number?: number } | undefined)?.version_number ?? 0);
  const inserted = await supabase.from(emailTemplateHistoryTable).insert({
    action: input.action,
    changed_by: input.actor ?? null,
    reason: text(input.reason),
    rollback_source_version: input.rollbackSourceVersion ?? null,
    rules_snapshot: input.rules,
    template_key: input.template.templateKey,
    template_snapshot: input.template,
    version_number: currentVersion + 1,
  });

  if (inserted.error) {
    if (tableMissing(inserted.error)) {
      console.log("Email template history insert skipped (table missing / schema cache)", {
        level: "warning",
        tags: { component: "email-templates", action: input.action },
        extra: { templateKey: input.template.templateKey },
      });
      return;
    }
    throw inserted.error;
  }
}

export async function getEmailTemplateHistory(templateKey: string) {
  const key = normalizeTemplateKey(templateKey);
  if (!key) return [];

  const result = await getSupabaseAdmin()
    .from(emailTemplateHistoryTable)
    .select("id,template_key,version_number,action,template_snapshot,rules_snapshot,changed_by,changed_at,reason,rollback_source_version")
    .eq("template_key", key)
    .order("version_number", { ascending: false })
    .limit(20);

  if (result.error) {
    if (tableMissing(result.error)) return [];
    throw result.error;
  }

  return ((result.data ?? []) as HistoryTableRow[])
    .map(mapHistory)
    .filter((entry): entry is EmailTemplateHistoryEntry => Boolean(entry));
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

function buildTemplateSnapshot(
  key: EmailTemplateKey,
  payload: EmailTemplatePayload,
  fallback: EmailTemplateDefinition,
) {
  return {
    bodyHtml: sanitizeEmailTemplateHtml(text(payload.bodyHtml ?? fallback.bodyHtml)),
    bodyText: text(payload.bodyText ?? fallback.bodyText),
    closingText: text(payload.closingText ?? fallback.closingText),
    description: text(payload.description ?? fallback.description),
    greeting: text(payload.greeting ?? fallback.greeting),
    isActive: Boolean(payload.isActive ?? fallback.isActive),
    previewText: text(payload.previewText ?? fallback.previewText),
    subject: text(payload.subject ?? fallback.subject),
    templateKey: key,
    templateName: text(payload.templateName ?? fallback.templateName),
  } satisfies EmailTemplateDefinition;
}

async function saveEmailTemplateDraft(input: {
  actor?: string | null;
  key: EmailTemplateKey;
  reason?: string | null;
  rules: EmailTemplateRecipientRules;
  template: EmailTemplateDefinition;
}) {
  const now = new Date().toISOString();
  const result = await getSupabaseAdmin()
    .from(emailTemplateDraftsTable)
    .upsert(
      {
        edited_at: now,
        edited_by: input.actor ?? null,
        reason: text(input.reason),
        rules_snapshot: input.rules,
        template_key: input.key,
        template_snapshot: input.template,
      },
      { onConflict: "template_key" },
    );

  if (result.error) {
    if (tableMissing(result.error)) return null;
    throw result.error;
  }

  await recordTemplateHistory({
    action: "draft",
    actor: input.actor,
    reason: input.reason,
    rules: input.rules,
    template: input.template,
  });

  const published = await getEmailTemplate(input.key);
  const fallback = published ?? toTemplateRow(templateDefaults[input.key], null, null);
  return toTemplateRow(
    {
      bodyHtml: fallback.bodyHtml,
      bodyText: fallback.bodyText,
      closingText: fallback.closingText,
      description: fallback.description,
      greeting: fallback.greeting,
      isActive: fallback.publishedIsActive,
      previewText: fallback.previewText,
      subject: fallback.subject,
      templateKey: input.key,
      templateName: fallback.templateName,
    },
    null,
    null,
    {
      edited_at: now,
      edited_by: input.actor ?? null,
      reason: text(input.reason),
      rules_snapshot: input.rules,
      template_key: input.key,
      template_snapshot: input.template,
    },
  );
}

async function clearEmailTemplateDraft(key: EmailTemplateKey) {
  const result = await getSupabaseAdmin().from(emailTemplateDraftsTable).delete().eq("template_key", key);
  if (result.error && !tableMissing(result.error)) throw result.error;
}

export async function saveEmailTemplate(
  templateKey: string,
  payload: EmailTemplatePayload,
  actor?: string | null,
  options: { action?: EmailTemplateHistoryAction; reason?: string | null; rollbackSourceVersion?: number | null } = {},
) {
  const key = normalizeTemplateKey(templateKey);
  if (!key) throw new Error("Unsupported email template.");
  const validation = validateEmailTemplatePayload(payload);
  if (!validation.isValid) throw new EmailTemplateValidationError(validation.issues);
  const action = options.action ?? (payload.isActive ? "publish" : "save");
  const reason = text(options.reason ?? payload.changeReason);
  if (action === "publish" && reason.length < 10) {
    throw new EmailTemplateValidationError([{
      field: "changeReason",
      message: "Publishing an email template requires a change reason of at least 10 characters.",
      type: "required",
    }]);
  }

  const current = await getEmailTemplate(key);
  const fallback = current ?? toTemplateRow(templateDefaults[key], null, null);
  const now = new Date().toISOString();
  const templateSnapshot = buildTemplateSnapshot(key, payload, fallback);
  const rules = normalizeRules(payload.rules, key);

  if (action === "draft") {
    return saveEmailTemplateDraft({
      actor,
      key,
      reason,
      rules,
      template: templateSnapshot,
    });
  }

  const template = {
    body_html: templateSnapshot.bodyHtml,
    body_text: templateSnapshot.bodyText,
    closing_text: templateSnapshot.closingText,
    description: templateSnapshot.description,
    greeting: templateSnapshot.greeting,
    is_active: action === "publish" ? true : templateSnapshot.isActive,
    preview_text: templateSnapshot.previewText,
    subject: templateSnapshot.subject,
    template_key: key,
    template_name: templateSnapshot.templateName,
    updated_at: now,
    updated_by: actor ?? null,
  };

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

  const savedTemplate: EmailTemplateDefinition = {
    bodyHtml: template.body_html,
    bodyText: template.body_text,
    closingText: template.closing_text,
    description: template.description,
    greeting: template.greeting,
    isActive: template.is_active,
    previewText: template.preview_text,
    subject: template.subject,
    templateKey: key,
    templateName: template.template_name,
  };
  await recordTemplateHistory({
    action,
    actor,
    reason,
    rollbackSourceVersion: options.rollbackSourceVersion,
    rules,
    template: savedTemplate,
  });

  if (action === "publish") await clearEmailTemplateDraft(key);

  return getEmailTemplate(key);
}

export async function rollbackEmailTemplate(input: {
  actor?: string | null;
  reason?: string | null;
  templateKey: string;
  versionNumber: number;
}) {
  const key = normalizeTemplateKey(input.templateKey);
  if (!key) throw new Error("Unsupported email template.");
  const reason = text(input.reason);
  if (reason.length < 10) {
    throw new EmailTemplateValidationError([{
      field: "changeReason",
      message: "Rollback requires a reason of at least 10 characters.",
      type: "required",
    }]);
  }

  const history = await getEmailTemplateHistory(key);
  const selected = history.find((entry) => entry.versionNumber === input.versionNumber);
  if (!selected) throw new Error("Template history version not found.");

  return saveEmailTemplate(key, {
    ...selected.templateSnapshot,
    changeReason: reason,
    rules: selected.rulesSnapshot,
  }, input.actor, {
    action: "rollback",
    reason,
    rollbackSourceVersion: selected.versionNumber,
  });
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

const managerChainScopedRoles = new Set<EmailTemplateRecipientRole>([
  "district_manager",
  "national_sales_manager",
  "regional_sales_manager",
]);

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
  if (role === "employee_team") {
    // Teammates = everyone sharing the employee's direct manager, excluding the employee
    // (select "Employee" separately to include them). Vacant manager seats resolve to an
    // empty team, same as the existing manager_chain behavior.
    if (!employee?.managerHrId) return [];
    return contacts
      .filter((contact) => hrIdMatches(contact.managerHrId, employee.managerHrId) && !hrIdMatches(contact.hrId, employee.hrId))
      .map((contact) => ({ email: contact.email, name: contact.name }));
  }
  if (role === "direct_reports") {
    if (!employee?.hrId) return [];
    return contacts
      .filter((contact) => hrIdMatches(contact.managerHrId, employee.hrId))
      .map((contact) => ({ email: contact.email, name: contact.name }));
  }
  if (role === "employee_line") {
    if (!employee?.line) return [];
    return contacts
      .filter((contact) => lineMatches(contact.line, [employee.line as string]))
      .map((contact) => ({ email: contact.email, name: contact.name }));
  }
  if (managerChainScopedRoles.has(role)) {
    return managerChain(contacts, employee)
      .filter((manager) => roleMatches(manager, role, employee, rules))
      .map((manager) => ({ email: manager.email, name: manager.name }));
  }
  return contacts.filter((contact) => roleMatches(contact, role, employee, rules)).map((contact) => ({ email: contact.email, name: contact.name }));
}

export async function resolveTemplateRecipients(input: {
  candidateEmail?: string | null;
  context?: Partial<EmailTemplateContext>;
  fallbackTo?: string[] | null;
  template?: EmailTemplatePayload;
  templateKey: string;
}) {
  const key = normalizeTemplateKey(input.templateKey);
  if (!key) throw new Error("Unsupported email template.");

  const [template, contacts] = await Promise.all([getEmailTemplate(key), loadContacts()]);
  const rules = input.template?.rules ? normalizeRules(input.template.rules, key) : template?.rules ?? defaultRules[key];
  const employeeHrId = input.context?.employeeHrId;
  const employee = contacts.find((contact) => hrIdMatches(contact.hrId, employeeHrId)) ?? null;
  let rawRecipientCount = 0;

  const build = (roles: EmailTemplateRecipientRole[], staticEmails: string[]) => {
    const raw = [
      ...roles.flatMap((role) => resolveRoleRecipients(role, contacts, employee, input.candidateEmail, rules)),
      ...staticEmails.map((email) => ({ email, name: "Static recipient" })),
    ];
    rawRecipientCount += raw.length;
    return dedupe(raw);
  };

  let to = build(rules.toRoles, rules.toStaticEmails);
  if (to.length === 0) {
    to = cleanEmails(input.fallbackTo ?? []).map((email) => ({ email, name: "Fallback recipient" }));
  }
  const cc = removeEmails(build(rules.ccRoles, rules.ccStaticEmails), to);
  const bcc = removeEmails(build(rules.bccRoles, rules.bccStaticEmails), [...to, ...cc]);

  const finalRecipientCount = to.length + cc.length + bcc.length;

  return {
    bcc,
    cc,
    diagnostics: {
      duplicateRecipientsRemoved: Math.max(0, rawRecipientCount - finalRecipientCount),
      finalRecipientCount,
      rawRecipientCount,
    },
    to,
  };
}

function rulesUseAnyRole(rules: EmailTemplateRecipientRules, roles: EmailTemplateRecipientRole[]) {
  const configured = [...rules.toRoles, ...rules.ccRoles, ...rules.bccRoles];
  return roles.some((role) => configured.includes(role));
}

export async function simulateTemplateRecipients(input: {
  candidateEmail?: string | null;
  context?: Partial<EmailTemplateContext>;
  template?: EmailTemplatePayload;
  templateKey: string;
}) {
  const key = normalizeTemplateKey(input.templateKey);
  if (!key) throw new Error("Unsupported email template.");
  const current = input.template?.rules ? null : await getEmailTemplate(key);
  const rules = input.template?.rules ? normalizeRules(input.template.rules, key) : current?.rules ?? defaultRules[key];
  const resolved = await resolveTemplateRecipients({
    candidateEmail: input.candidateEmail,
    context: input.context,
    template: input.template,
    templateKey: key,
  });
  const warnings: string[] = [];
  const employeeRoles: EmailTemplateRecipientRole[] = [
    "employee",
    "direct_manager",
    "manager_of_manager",
    "manager_chain",
    "district_manager",
    "regional_sales_manager",
    "national_sales_manager",
    "line_manager",
    "same_line_selected_titles",
  ];

  if (rulesUseAnyRole(rules, ["candidate"]) && !text(input.candidateEmail)) {
    warnings.push("Candidate routing is selected, but no candidate email was provided for this simulation.");
  }

  if (rulesUseAnyRole(rules, employeeRoles) && !text(input.context?.employeeHrId)) {
    warnings.push("Employee or manager routing is selected, but no employee HR ID was provided for this simulation.");
  }

  if (resolved.diagnostics.finalRecipientCount === 0) {
    warnings.push("No recipients resolved. Publishing this template may cause sends to be skipped.");
  }

  if (resolved.diagnostics.duplicateRecipientsRemoved > 0) {
    warnings.push(`${resolved.diagnostics.duplicateRecipientsRemoved} duplicate recipient(s) were removed across TO, CC, and BCC.`);
  }

  return { ...resolved, warnings };
}

function contextVariables(input: Partial<EmailTemplateContext>, recipientName: string) {
  return {
    amount: text(input.amount),
    area: text(input.area),
    approvalFlow: text(input.approvalFlow),
    candidateName: text(input.candidateName),
    ctaLabel: text(input.ctaLabel || "Open in Phoenix Workforce"),
    ctaUrl: text(input.ctaUrl),
    date: text(input.date || new Date().toISOString().slice(0, 10)),
    destination: text(input.destination),
    duration: text(input.duration),
    excuseType: text(input.excuseType),
    excuseDate: text(input.excuseDate),
    endDate: text(input.endDate),
    employeeHrId: text(input.employeeHrId),
    employeeName: text(input.employeeName),
    expiryText: text(input.expiryText),
    feedback: text(input.feedback),
    hireDate: text(input.hireDate),
    honorific: text(input.honorific),
    interviewDate: text(input.interviewDate),
    interviewLocation: text(input.interviewLocation),
    interviewerName: text(input.interviewerName),
    interviewTime: text(input.interviewTime),
    jobTitle: text(input.jobTitle),
    line: text(input.line),
    managerName: text(input.managerName),
    meetingUrl: text(input.meetingUrl),
    nextStep: text(input.nextStep),
    planTable: text(input.planTable),
    planTableText: text(input.planTableText),
    digestTable: text(input.digestTable),
    digestTableText: text(input.digestTableText),
    weekLabel: text(input.weekLabel),
    scoreTable: text(input.scoreTable),
    scoreTableText: text(input.scoreTableText),
    recipientName,
    startDate: text(input.startDate),
    status: text(input.status),
    subject: text(input.subject),
    summary: text(input.summary),
    vacationBalance: text(input.vacationBalance),
    vacationType: text(input.vacationType),
    // Marketing-request tokens.
    currentStep: text(input.currentStep),
    customerName: text(input.customerName),
    estimatedCost: text(input.estimatedCost),
    payDate: text(input.payDate),
    productsTable: text(input.productsTable),
    productsTableText: text(input.productsTableText),
    requestCode: text(input.requestCode),
    requesterName: text(input.requesterName),
    requiredRoi: text(input.requiredRoi),
    returnCallout: text(input.returnCallout),
    returnCalloutText: text(input.returnCalloutText),
    roiWindow: text(input.roiWindow),
  };
}

function recipientNameForGreeting(recipients: Recipient[], context: Partial<EmailTemplateContext>) {
  if (context.recipientName) return text(context.recipientName);
  if (recipients.length === 1 && recipients[0]?.name) return text(recipients[0].name);
  return "Team";
}

function templateSupportsAction(templateKey: EmailTemplateKey) {
  return templateKey !== EMAIL_TEMPLATE_KEYS.BIRTHDAY;
}

function templateSubtitle(templateKey: EmailTemplateKey) {
  if (templateKey === EMAIL_TEMPLATE_KEYS.BIRTHDAY) {
    return "Today we are celebrating you. Wishing you a joyful birthday and a year full of success.";
  }
  return undefined;
}

export function renderEmailTemplate(
  template: EmailTemplateDefinition,
  context: Partial<EmailTemplateContext> = {},
  recipients: Recipient[] = [],
) {
  const variables = contextVariables(context, recipientNameForGreeting(recipients, context));
  // {{planTable}} is a body-only block: the plain body gets its text projection, while
  // single-line fields (subject, greeting, closing, preview) resolve it to "" so a
  // misplaced token can never dump multi-line employee text into a header-like field.
  const bodyTextVariables = {
    ...variables,
    planTable: variables.planTableText,
    digestTable: variables.digestTableText,
    scoreTable: variables.scoreTableText,
    productsTable: variables.productsTableText,
    returnCallout: variables.returnCalloutText,
  };
  const inlineVariables = {
    ...variables,
    planTable: "",
    digestTable: "",
    productsTable: "",
    returnCallout: "",
    scoreTable: "",
  };
  const subject = interpolate(template.subject, inlineVariables, false) || template.templateName;
  const greeting = interpolate(template.greeting, inlineVariables, false);
  const bodyHtml = sanitizeEmailTemplateHtml(interpolate(template.bodyHtml, variables, true, htmlBlockTokens));
  const bodyText = interpolate(template.bodyText, bodyTextVariables, false);
  const closingText = interpolate(template.closingText, inlineVariables, false);
  const previewLine = interpolate(template.previewText, inlineVariables, false);
  const previewText = previewLine || subject;
  const action = templateSupportsAction(template.templateKey) && variables.ctaUrl
    ? { href: variables.ctaUrl, label: variables.ctaLabel || "Open in Phoenix Workforce" }
    : undefined;
  // Curated per-key banners (birthday) win; otherwise the template's preview text doubles
  // as the visible banner line under the header title so admins can edit it per template.
  const subtitle = templateSubtitle(template.templateKey) ?? (previewLine || undefined);

  return {
    html: renderPhoenixEmailHtml({
      action,
      bodyHtml: bodyHtml.trim() ? bodyHtml : renderEmailParagraphs(bodyText),
      closingText,
      greeting,
      previewText,
      subject,
      subtitle,
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

function samplePlanTableContext(): Partial<EmailTemplateContext> {
  return buildSamplePlanTable();
}

function sampleCoachingScoreContext(): Partial<EmailTemplateContext> {
  return buildSampleCoachingScoreTable();
}

// Admin previews have no real request — populate the marketing tokens with demo values so the
// /admin/email-templates preview shows what the marketing_request template renders as.
function sampleMarketingContext(): Partial<EmailTemplateContext> {
  const cell = "border:1px solid #fce7cf;padding:8px 10px;font-size:13px;text-align:left;color:#0f172a";
  const cellR = `${cell};text-align:right`;
  const head = "background-color:#0f172a;color:#ffffff;border:1px solid #0f172a;padding:8px 10px;font-size:12px;text-align:left";
  const headR = `${head};text-align:right`;
  const rows: Array<[string, string, string]> = [
    ["Pediacare Drops 15ml", "120", "EGP 1,800"],
    ["Pediacare Syrup 100ml", "60", "EGP 900"],
  ];
  return {
    currentStep: "Marketing Review",
    customerName: "El Ezaby — Nasr City",
    estimatedCost: "EGP 3,000",
    payDate: "2026-07-01",
    productsTable:
      '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%">' +
      `<thead><tr><th style="${head}">Product</th><th style="${headR}">Qty</th><th style="${headR}">Value</th></tr></thead>` +
      `<tbody>${rows.map((row) => `<tr><td style="${cell}">${row[0]}</td><td style="${cellR}">${row[1]}</td><td style="${cellR}">${row[2]}</td></tr>`).join("")}</tbody></table>`,
    productsTableText: rows.map((row) => `- ${row.join(" | ")}`).join("\n"),
    requestCode: "MKT-REQ-SAMPLE",
    requiredRoi: "EGP 30,000",
    returnCallout: "",
    returnCalloutText: "",
    roiWindow: "Jul – Aug 2026",
  };
}

function buildSampleCoachingScoreTable(): { scoreTable: string; scoreTableText: string } {
  const metricCell = "border:1px solid #E2E8F0;padding:10px 12px;font-size:13px;line-height:1.45;text-align:left;color:#0F172A";
  const scoreCell = "border:1px solid #E2E8F0;padding:10px 12px;font-size:13px;line-height:1.45;text-align:right;color:#0F172A";
  const head = "background-color:#0F172A;color:#ffffff;border:1px solid #0F172A;padding:10px 12px;font-size:12px;line-height:1.4;text-align:left;font-weight:700";
  const rows: Array<[string, string, string, string]> = [
    ["Medical & Patient/Physician Knowledge", "Knowledge", "4 / 5", "#166534"],
    ["Product Knowledge", "Knowledge", "5 / 5", "#166534"],
    ["Opening, Patient Profile & Attractive Approach", "Call Structure Skills", "4 / 5", "#166534"],
    ["Handling Customer Objection", "Business Intelligence", "3 / 5", "#92400E"],
    ["Time & Territory Planning", "Business Planning", "4 / 5", "#166534"],
    ["Discipline", "Personal Skills", "5 / 5", "#166534"],
  ];
  return {
    scoreTable: [
      '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;border:1px solid #E2E8F0">',
      `<thead><tr><th style="${head}">Metric</th><th style="${head};text-align:right">Score</th></tr></thead>`,
      `<tbody>${rows.map((row, index) => {
        const background = index % 2 === 0 ? "#FFFFFF" : "#F8FAFC";
        return `<tr style="background-color:${background}"><td style="${metricCell}"><strong style="color:#0F172A;font-size:13px;line-height:1.45">${row[0]}</strong><br /><span style="color:#64748B;font-size:11px;line-height:1.4">${row[1]}</span></td><td style="${scoreCell}"><strong style="color:${row[3]};font-size:13px">${row[2]}</strong></td></tr>`;
      }).join("")}</tbody>`,
      "</table>",
    ].join(""),
    scoreTableText: rows.map((row) => `${row[0]} (${row[1]}): ${row[2]}`).join("\n"),
  };
}

function sampleDigestContext(): Partial<EmailTemplateContext> {
  return { weekLabel: "2026-06-24 to 2026-06-30", ...buildSampleDigestTable() };
}

function buildSampleDigestTable(): { digestTable: string; digestTableText: string } {
  const cell = "border:1px solid #e2e8f0;padding:8px 10px;font-size:13px;text-align:left";
  const cellR = `${cell};text-align:right`;
  const head = "background-color:#0f172a;color:#ffffff;padding:8px 10px;font-size:12px;text-align:left";
  const headR = `${head};text-align:right`;
  const rows: Array<{ date: string; value: string; qty: string; reason: string }> = [
    { date: "Mon, 24 Jun 2026", value: "150.00 EGP", qty: "0.25", reason: "Late 20 min but completed the required hours — penalty halved." },
  ];
  return {
    digestTable: [
      '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%">',
      `<thead><tr><th style="${head}">Day</th><th style="${headR}">Deduction Value</th><th style="${headR}">Quantity</th></tr></thead>`,
      `<tbody>${rows
        .map(
          (row) =>
            `<tr><td style="${cell}">${row.date}</td><td style="${cellR}">${row.value}</td><td style="${cellR}">${row.qty}</td></tr>` +
            `<tr><td colspan="3" style="${cell};border-top:none;color:#64748b;font-size:12px;">${row.reason}</td></tr>`,
        )
        .join("")}</tbody>`,
      "</table>",
    ].join(""),
    digestTableText: rows.map((row) => `- ${row.date}: ${row.value}, ${row.qty} day(s) — ${row.reason}`).join("\n"),
  };
}

function buildSamplePlanTable(): { planTable: string; planTableText: string } {
  const cell = "border:1px solid #E5E7EB;padding:8px 10px;font-size:13px;text-align:left";
  const head = "background-color:#0F172A;color:#ffffff;border:1px solid #0F172A;padding:8px 10px;font-size:12px;text-align:left";
  const rows: Array<[string, string, string, string]> = [
    ["Sun 2026-06-14", "<strong>Cairo East clinics</strong><br />Field", "Nasr City - Cairo East", "Coach the new rep on cardiology objection handling"],
    ["Mon 2026-06-15", "<strong>Cycle meeting</strong><br />Meeting", "Head Office", "Align Q3 targets with the marketing team"],
    ["Tue 2026-06-16", "<strong>Double visit</strong><br />Double Visit", "Heliopolis", "Double visit with Ahmed Hassan"],
  ];
  return {
    planTable: [
      '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%">',
      `<thead><tr><th style="${head}">Date</th><th style="${head}">Activity</th><th style="${head}">Location</th><th style="${head}">Objective</th></tr></thead>`,
      `<tbody>${rows.map((row) => `<tr>${row.map((value) => `<td style="${cell}">${value}</td>`).join("")}</tr>`).join("")}</tbody>`,
      "</table>",
    ].join(""),
    planTableText: rows
      .map((row) => `- ${row.map((value) => value.replace(/<br \/>/g, " - ").replace(/<[^>]+>/g, "")).join(" | ")}`)
      .join("\n"),
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
  // Admin previews have no real plan submission - substitute a small demo table so a
  // weekly_plans template shows what {{planTable}} actually renders as. Real sends pass
  // a real table (or "" - the token then disappears).
  let context = input.context;
  if (templateKey === EMAIL_TEMPLATE_KEYS.WEEKLY_PLANS && !text(input.context?.planTable).includes("<table")) {
    context = { ...input.context, ...samplePlanTableContext() };
  } else if (templateKey === EMAIL_TEMPLATE_KEYS.COACHING_REPORT && !text(input.context?.scoreTable).includes("<table")) {
    context = { ...input.context, ...sampleCoachingScoreContext() };
  } else if (templateKey === EMAIL_TEMPLATE_KEYS.MARKETING_REQUEST && !text(input.context?.productsTable).includes("<table")) {
    context = { ...sampleMarketingContext(), ...input.context };
  } else if (templateKey === EMAIL_TEMPLATE_KEYS.ATTENDANCE_DIGEST && !text(input.context?.digestTable).includes("<table")) {
    context = { ...sampleDigestContext(), ...input.context };
  }
  const rendered = renderEmailTemplate(draft, context, recipients);
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

  const authTemplateKeys: Set<string> = new Set([
    EMAIL_TEMPLATE_KEYS.PASSWORD_SETUP,
    EMAIL_TEMPLATE_KEYS.PASSWORD_RESET,
    EMAIL_TEMPLATE_KEYS.USER_CREATED,
  ]);
  const unsubscribeHeaders = ((): Record<string, string> | undefined => {
    if (authTemplateKeys.has(key)) return undefined;
    const mailto = `<mailto:${process.env.NOTIFICATION_REPLY_TO || systemEmail.defaultReplyTo}?subject=unsubscribe>`;
    const base = String(process.env.NOTIFICATION_DASHBOARD_URL ?? "").replace(/\/+$/, "");
    const primary = to.length === 1 ? to[0].email : undefined;
    // RFC 8058 one-click needs an HTTPS endpoint + a single recipient to mint a token for.
    if (!base || !primary) return { "List-Unsubscribe": mailto };
    const token = createUnsubscribeToken(primary, key);
    return {
      "List-Unsubscribe": `<${base}/api/email/unsubscribe/${token}>, ${mailto}`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    };
  })();

  return sendPhoenixEmail({
    bcc: bcc.map((recipient) => recipient.email),
    cc: cc.map((recipient) => recipient.email),
    // Privacy: when a template resolves to multiple TO recipients (HR fan-out), move them
    // to BCC behind a neutral visible To.
    fanoutToBcc: true,
    from: input.from ?? undefined,
    headers: unsubscribeHeaders,
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
    weekLabel: "2026-06-24 to 2026-06-30",
    // Test sends have no real plan submission - the demo table shows what {{planTable}}
    // renders as (mirrors previewTemplate).
    ...(key === EMAIL_TEMPLATE_KEYS.WEEKLY_PLANS ? buildSamplePlanTable() : {}),
    ...(key === EMAIL_TEMPLATE_KEYS.COACHING_REPORT ? buildSampleCoachingScoreTable() : {}),
    ...(key === EMAIL_TEMPLATE_KEYS.ATTENDANCE_DIGEST ? buildSampleDigestTable() : {}),
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
