import {
  emailTemplateKeys,
  previewTemplate,
  simulateTemplateRecipients,
  validateEmailTemplatePayload,
  type EmailTemplateKey,
  type EmailTemplatePayload,
  type EmailTemplateRecipientRole,
  type EmailTemplateRecipientRules,
} from "@/lib/email-templates/service";
import { sanitizeEmailTemplateHtml } from "@/lib/email/email-safety";

export type EmailDesignerVariable = {
  allowedTemplateTypes: EmailTemplateKey[];
  category: "Candidate" | "Company" | "Contract" | "Employee" | "Manager" | "Payroll";
  label: string;
  sampleValue: string;
  token: string;
};

export type EmailRecipientPresetKey =
  | "candidate"
  | "direct_manager"
  | "direct_reports"
  | "employee"
  | "employee_line"
  | "employee_team"
  | "finance_team"
  | "hr_team"
  | "manager_chain";

export type EmailRecipientPreset = {
  description: string;
  key: EmailRecipientPresetKey;
  label: string;
  role: EmailTemplateRecipientRole;
};

export type TemplateRecipientPresetSelection = {
  bcc?: EmailRecipientPresetKey[];
  cc?: EmailRecipientPresetKey[];
  to?: EmailRecipientPresetKey[];
};

export type EmailDraftValidationIssue = {
  field: string;
  message: string;
  severity: "error" | "warning";
  token?: string;
};

const allTemplateTypes = [...emailTemplateKeys] as EmailTemplateKey[];

const variableCatalog: EmailDesignerVariable[] = [
  { category: "Employee", label: "Employee Name", sampleValue: "Mariam Adel", token: "employeeName", allowedTemplateTypes: allTemplateTypes },
  { category: "Employee", label: "Employee HR ID", sampleValue: "PHX-1024", token: "employeeHrId", allowedTemplateTypes: allTemplateTypes },
  { category: "Employee", label: "Job Title", sampleValue: "Medical Representative", token: "jobTitle", allowedTemplateTypes: allTemplateTypes },
  { category: "Employee", label: "Line", sampleValue: "Cardio Line", token: "line", allowedTemplateTypes: allTemplateTypes },
  { category: "Employee", label: "Area", sampleValue: "Cairo", token: "area", allowedTemplateTypes: allTemplateTypes },
  { category: "Manager", label: "Manager Name", sampleValue: "Omar Nabil", token: "managerName", allowedTemplateTypes: allTemplateTypes },
  { category: "Candidate", label: "Candidate Name", sampleValue: "Ahmed Hassan", token: "candidateName", allowedTemplateTypes: ["offer", "interview_invitation", "interview_feedback", "password_setup", "password_reset"] },
  { category: "Candidate", label: "Interview Date", sampleValue: "2026-06-10", token: "interviewDate", allowedTemplateTypes: ["interview_invitation", "interview_feedback"] },
  { category: "Candidate", label: "Interview Time", sampleValue: "10:30 AM", token: "interviewTime", allowedTemplateTypes: ["interview_invitation"] },
  { category: "Candidate", label: "Interview Location", sampleValue: "Cairo Office", token: "interviewLocation", allowedTemplateTypes: ["interview_invitation"] },
  { category: "Candidate", label: "Interviewer Name", sampleValue: "Nour Samir", token: "interviewerName", allowedTemplateTypes: ["interview_invitation"] },
  { category: "Candidate", label: "Meeting Link", sampleValue: "https://meet.example.com/phoenix", token: "meetingUrl", allowedTemplateTypes: ["interview_invitation"] },
  { category: "Candidate", label: "Feedback", sampleValue: "Strong role alignment", token: "feedback", allowedTemplateTypes: ["interview_feedback"] },
  { category: "Candidate", label: "Next Step", sampleValue: "Schedule final interview", token: "nextStep", allowedTemplateTypes: ["interview_feedback"] },
  { category: "Contract", label: "Start Date", sampleValue: "2026-06-01", token: "startDate", allowedTemplateTypes: allTemplateTypes },
  { category: "Contract", label: "End Date", sampleValue: "2026-06-05", token: "endDate", allowedTemplateTypes: allTemplateTypes },
  { category: "Contract", label: "Hire Date", sampleValue: "2026-06-01", token: "hireDate", allowedTemplateTypes: ["probation_workflow", "probation_reminder", "contract_renewal"] },
  { category: "Contract", label: "Expiry Text", sampleValue: "24 hours", token: "expiryText", allowedTemplateTypes: ["password_setup", "password_reset", "user_created"] },
  { category: "Payroll", label: "Vacation Balance", sampleValue: "12 days", token: "vacationBalance", allowedTemplateTypes: ["leave_request", "leave_approval", "leave_rejection"] },
  { category: "Company", label: "Approval Flow", sampleValue: "Manager then HR", token: "approvalFlow", allowedTemplateTypes: allTemplateTypes },
  { category: "Company", label: "Status", sampleValue: "Pending manager approval", token: "status", allowedTemplateTypes: allTemplateTypes },
  { category: "Company", label: "Date", sampleValue: "2026-05-31", token: "date", allowedTemplateTypes: allTemplateTypes },
  { category: "Company", label: "Duration", sampleValue: "5 days", token: "duration", allowedTemplateTypes: allTemplateTypes },
  { category: "Company", label: "Action Link", sampleValue: "https://phoenix.example.com/action", token: "ctaUrl", allowedTemplateTypes: allTemplateTypes },
  { category: "Company", label: "Action Button Text", sampleValue: "Open in Phoenix Workforce", token: "ctaLabel", allowedTemplateTypes: allTemplateTypes },
  { category: "Company", label: "Recipient Name", sampleValue: "Omar", token: "recipientName", allowedTemplateTypes: allTemplateTypes },
  { category: "Company", label: "Email Subject", sampleValue: "Phoenix Workforce notification", token: "subject", allowedTemplateTypes: allTemplateTypes },
  { category: "Company", label: "Summary", sampleValue: "A workflow update needs review.", token: "summary", allowedTemplateTypes: allTemplateTypes },
  { category: "Company", label: "Vacation Type", sampleValue: "Annual Leave", token: "vacationType", allowedTemplateTypes: ["leave_request", "leave_approval", "leave_rejection"] },
];

const recipientPresets: EmailRecipientPreset[] = [
  { description: "Send directly to the employee in the selected context.", key: "employee", label: "Employee", role: "employee" },
  { description: "Send to the employee's direct manager.", key: "direct_manager", label: "Direct Manager", role: "direct_manager" },
  { description: "Send to every manager above the employee.", key: "manager_chain", label: "Manager Chain", role: "manager_chain" },
  { description: "Send to the employee's teammates - everyone reporting to the same direct manager.", key: "employee_team", label: "Employee's Team", role: "employee_team" },
  { description: "Send to everyone who reports directly to the employee.", key: "direct_reports", label: "Direct Reports", role: "direct_reports" },
  { description: "Send to every active employee in the same line as the employee.", key: "employee_line", label: "Employee's Line", role: "employee_line" },
  { description: "Send to HR users found in the employee directory.", key: "hr_team", label: "HR Team", role: "hr" },
  { description: "Send to Finance users found in the employee directory.", key: "finance_team", label: "Finance Team", role: "finance" },
  { description: "Send to a candidate email provided by the workflow.", key: "candidate", label: "Candidate", role: "candidate" },
];

const presetRoleMap = new Map(recipientPresets.map((preset) => [preset.key, preset.role]));
const allowedTokenSet = new Set(variableCatalog.map((variable) => variable.token));

export function getEmailDesignerMetadata() {
  return {
    allowedFormatting: ["bold", "italic", "bulletedList", "numberedList", "link", "buttonLink", "paragraph", "divider"],
    recipientPresets,
    variables: variableCatalog,
  };
}

function cleanPresetValues(values: unknown): EmailRecipientPresetKey[] {
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is EmailRecipientPresetKey => typeof value === "string" && presetRoleMap.has(value as EmailRecipientPresetKey));
}

export function compileTemplateRecipientPresets(
  presets: TemplateRecipientPresetSelection | null | undefined,
  advancedRules?: Partial<EmailTemplateRecipientRules>,
): Partial<EmailTemplateRecipientRules> {
  const roleValues = (values: unknown) =>
    cleanPresetValues(values).map((preset) => presetRoleMap.get(preset)).filter((role): role is EmailTemplateRecipientRole => Boolean(role));

  return {
    ...(advancedRules ?? {}),
    bccRoles: Array.from(new Set([...(advancedRules?.bccRoles ?? []), ...roleValues(presets?.bcc)])),
    ccRoles: Array.from(new Set([...(advancedRules?.ccRoles ?? []), ...roleValues(presets?.cc)])),
    toRoles: Array.from(new Set([...(advancedRules?.toRoles ?? []), ...roleValues(presets?.to)])),
  };
}

function fieldsToValidate(template: EmailTemplatePayload) {
  return [
    ["subject", template.subject],
    ["greeting", template.greeting],
    ["previewText", template.previewText],
    ["bodyHtml", template.bodyHtml],
    ["bodyText", template.bodyText],
    ["closingText", template.closingText],
  ] as const;
}

function unknownVariables(template: EmailTemplatePayload) {
  const issues: EmailDraftValidationIssue[] = [];
  for (const [field, value] of fieldsToValidate(template)) {
    const text = String(value ?? "");
    const malformed = (text.match(/\{\{/g) ?? []).length !== (text.match(/\}\}/g) ?? []).length;
    if (malformed) {
      issues.push({ field, message: "A variable is incomplete. Use the format {{Employee Name}} from the chips.", severity: "error" });
    }
    for (const match of text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
      if (!allowedTokenSet.has(match[1])) {
        issues.push({
          field,
          message: `Unknown variable {{${match[1]}}}. Use a variable chip so the backend can render it safely.`,
          severity: "error",
          token: match[1],
        });
      }
    }
  }
  return issues;
}

export async function validateEmailTemplateDraft(input: {
  candidateEmail?: string | null;
  employeeHrId?: string | null;
  presets?: TemplateRecipientPresetSelection | null;
  template: EmailTemplatePayload;
  templateKey: string;
}) {
  const rules = compileTemplateRecipientPresets(input.presets, input.template.rules);
  const template = {
    ...input.template,
    bodyHtml: sanitizeEmailTemplateHtml(String(input.template.bodyHtml ?? "")),
    rules,
  };
  const payloadValidation = validateEmailTemplatePayload(template);
  const issues: EmailDraftValidationIssue[] = [
    ...payloadValidation.issues.map((issue) => ({ ...issue, severity: "error" as const })),
    ...payloadValidation.warnings.map((issue) => ({ ...issue, severity: "warning" as const })),
    ...unknownVariables(template),
  ];
  const simulation = await simulateTemplateRecipients({
    candidateEmail: input.candidateEmail,
    context: { employeeHrId: input.employeeHrId },
    template,
    templateKey: input.templateKey,
  });

  if (simulation.diagnostics.finalRecipientCount === 0) {
    issues.push({ field: "rules", message: "No recipients resolved. Choose at least one recipient preset or add a safe static email.", severity: "error" });
  }
  for (const warning of simulation.warnings) {
    issues.push({ field: "recipients", message: warning, severity: "warning" });
  }

  const preview = await previewTemplate(input.templateKey, {
    context: sampleTemplateContext(),
    template,
  });

  return {
    compiledRules: rules,
    duplicateRecipientsRemoved: simulation.diagnostics.duplicateRecipientsRemoved,
    issues,
    isReadyToPublish: !issues.some((issue) => issue.severity === "error"),
    preview,
    sanitizedTemplate: template,
    simulation,
  };
}

export function sampleTemplateContext() {
  return {
    area: "Cairo",
    candidateName: "Ahmed Hassan",
    ctaLabel: "Open in Phoenix Workforce",
    ctaUrl: "https://phoenix.example.com/action",
    date: "2026-05-31",
    employeeHrId: "PHX-1024",
    employeeName: "Mariam Adel",
    endDate: "2026-06-05",
    feedback: "Strong role alignment and positive interview discussion.",
    hireDate: "2026-06-01",
    interviewDate: "2026-06-10",
    interviewLocation: "Phoenix Workforce Cairo Office",
    interviewerName: "Nour Samir",
    interviewTime: "10:30 AM",
    jobTitle: "Medical Representative",
    line: "Cardio Line",
    managerName: "Omar Nabil",
    meetingUrl: "https://meet.example.com/phoenix-interview",
    nextStep: "Share final feedback with HR.",
    recipientName: "Ahmed",
    startDate: "2026-06-01",
    status: "Pending manager approval",
    subject: "Phoenix Workforce notification",
    summary: "This is a sample HR notification generated by the backend.",
    vacationBalance: "12 days",
    vacationType: "Annual Leave",
  };
}
