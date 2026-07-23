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
import { listEmailCustomVariables } from "@/lib/email-templates/custom-variables";
import { sanitizeEmailTemplateHtml } from "@/lib/email/email-safety";
import { renderPhoenixMetadataTable, renderPhoenixMetadataTableText } from "@/emails/phoenix-email-layout";

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
  { category: "Candidate", label: "Candidate Name", sampleValue: "Ahmed Hassan", token: "candidateName", allowedTemplateTypes: ["offer", "offer_status", "interview_invitation", "interview_feedback", "recruitment_update", "password_setup", "password_reset"] },
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
  { category: "Company", label: "Submitted Plan Table", sampleValue: "(the submitted plan days as a table)", token: "planTable", allowedTemplateTypes: ["weekly_plans"] },
  { category: "Company", label: "Vacation Type", sampleValue: "Annual Leave", token: "vacationType", allowedTemplateTypes: ["leave_request", "leave_approval", "leave_rejection"] },
  // Everything below closes a gap between this designer's own token catalog and the
  // authoritative allowlist (placeholderHints/EmailTemplateContext in email-templates/service.ts)
  // — validateEmailTemplateDraft checks {{tokens}} against ONLY this file's variableCatalog, so a
  // token declared there but missing here always failed "Run backend review" with a false
  // "Unknown variable" error, even though the real send-time renderer resolves it correctly.
  { category: "Company", label: "Honorific", sampleValue: "Dr. ", token: "honorific", allowedTemplateTypes: allTemplateTypes },
  { category: "Payroll", label: "Amount", sampleValue: "1,250 EGP", token: "amount", allowedTemplateTypes: allTemplateTypes },
  { category: "Company", label: "Destination", sampleValue: "Alexandria, Egypt", token: "destination", allowedTemplateTypes: ["outstation"] },
  { category: "Company", label: "Excuse Type", sampleValue: "Morning excuse", token: "excuseType", allowedTemplateTypes: ["excuse_request", "excuse_decision"] },
  { category: "Company", label: "Excuse Date", sampleValue: "2026-06-12", token: "excuseDate", allowedTemplateTypes: ["excuse_request", "excuse_decision"] },
  { category: "Company", label: "Details Table", sampleValue: "(a premium zebra-striped label/value summary table)", token: "detailsTable", allowedTemplateTypes: allTemplateTypes },
  { category: "Company", label: "Digest Table", sampleValue: "(a weekly digest summary table)", token: "digestTable", allowedTemplateTypes: ["dv_planner_weekly", "probation_weekly_digest"] },
  { category: "Company", label: "Week Label", sampleValue: "2026-06-08 to 2026-06-14", token: "weekLabel", allowedTemplateTypes: ["dv_planner_weekly", "probation_weekly_digest"] },
  { category: "Company", label: "Score Table", sampleValue: "(the coaching score breakdown table)", token: "scoreTable", allowedTemplateTypes: ["coaching_report"] },
  { category: "Payroll", label: "Estimated Cost", sampleValue: "50,000 EGP", token: "estimatedCost", allowedTemplateTypes: ["marketing_request"] },
  { category: "Payroll", label: "Required ROI", sampleValue: "3.5x", token: "requiredRoi", allowedTemplateTypes: ["marketing_request"] },
  { category: "Company", label: "ROI Window", sampleValue: "90 days", token: "roiWindow", allowedTemplateTypes: ["marketing_request"] },
  { category: "Payroll", label: "Pay Date", sampleValue: "2026-06-30", token: "payDate", allowedTemplateTypes: ["marketing_request"] },
  { category: "Company", label: "Customer Name", sampleValue: "El Ezaby Pharmacy", token: "customerName", allowedTemplateTypes: ["marketing_request"] },
  { category: "Company", label: "Current Step", sampleValue: "Regional Manager review", token: "currentStep", allowedTemplateTypes: ["marketing_request"] },
  { category: "Company", label: "Request Code", sampleValue: "REQ-0208", token: "requestCode", allowedTemplateTypes: ["marketing_request"] },
  { category: "Company", label: "Requester Name", sampleValue: "Youssef Ahmed", token: "requesterName", allowedTemplateTypes: ["marketing_request"] },
  { category: "Company", label: "Products Table", sampleValue: "(the requested products/financials table)", token: "productsTable", allowedTemplateTypes: ["marketing_request"] },
  { category: "Company", label: "Return Callout", sampleValue: "(the return/rejection reason callout)", token: "returnCallout", allowedTemplateTypes: ["marketing_request"] },
  { category: "Employee", label: "Probation Day", sampleValue: "45", token: "probationDay", allowedTemplateTypes: ["probation_dv_snapshot", "probation_day30", "probation_day60", "probation_day75"] },
  { category: "Employee", label: "DV Date", sampleValue: "2026-06-10", token: "dvDate", allowedTemplateTypes: ["probation_dv_snapshot"] },
  { category: "Employee", label: "Evaluator Name", sampleValue: "Nour Samir", token: "evaluatorName", allowedTemplateTypes: ["probation_dv_snapshot"] },
  { category: "Employee", label: "Evaluator Role", sampleValue: "District Manager", token: "evaluatorRole", allowedTemplateTypes: ["probation_dv_snapshot"] },
  { category: "Employee", label: "Visit Count", sampleValue: "4", token: "visitCount", allowedTemplateTypes: ["probation_dv_snapshot"] },
  { category: "Employee", label: "DV Progress", sampleValue: "DM 2/3 · TM 1/1 · Total 3/4", token: "dvProgress", allowedTemplateTypes: ["probation_dv_snapshot"] },
  { category: "Employee", label: "Risk Status", sampleValue: "Action Required", token: "riskStatus", allowedTemplateTypes: ["probation_dv_snapshot", "probation_day30", "probation_day60", "probation_day75"] },
  { category: "Employee", label: "Provisional Score", sampleValue: "6.85 / 10", token: "provisionalScore", allowedTemplateTypes: ["probation_dv_snapshot", "probation_day30", "probation_day60", "probation_day75"] },
  { category: "Employee", label: "Days Remaining", sampleValue: "12", token: "daysRemaining", allowedTemplateTypes: ["probation_dv_snapshot", "probation_day30", "probation_day60", "probation_day75"] },
  { category: "Employee", label: "Milestone Day", sampleValue: "60", token: "milestoneDay", allowedTemplateTypes: ["probation_day30", "probation_day60", "probation_day75"] },
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

function unknownVariables(template: EmailTemplatePayload, extraAllowedTokens: ReadonlySet<string>) {
  const issues: EmailDraftValidationIssue[] = [];
  for (const [field, value] of fieldsToValidate(template)) {
    const text = String(value ?? "");
    const malformed = (text.match(/\{\{/g) ?? []).length !== (text.match(/\}\}/g) ?? []).length;
    if (malformed) {
      issues.push({ field, message: "A variable is incomplete. Use the format {{Employee Name}} from the chips.", severity: "error" });
    }
    for (const match of text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
      if (!allowedTokenSet.has(match[1]) && !extraAllowedTokens.has(match[1])) {
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
  const customVariables = await listEmailCustomVariables();
  const customTokens = new Set(customVariables.filter((variable) => variable.sourceAllowed).map((variable) => variable.token));
  const payloadValidation = validateEmailTemplatePayload(template, customTokens);
  const issues: EmailDraftValidationIssue[] = [
    ...payloadValidation.issues.map((issue) => ({ ...issue, severity: "error" as const })),
    ...payloadValidation.warnings.map((issue) => ({ ...issue, severity: "warning" as const })),
    ...unknownVariables(template, customTokens),
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

const sampleDetailsRows = [
  { label: "Type", value: "Annual Leave" },
  { label: "Period", value: "2026-08-01 to 2026-08-05" },
  { label: "Manager", value: "Omar Nabil" },
  { label: "Decision", value: "Approved" },
];

export function sampleTemplateContext() {
  return {
    amount: "1,250 EGP",
    area: "Cairo",
    candidateName: "Ahmed Hassan",
    ctaLabel: "Open in Phoenix Workforce",
    ctaUrl: "https://phoenix.example.com/action",
    date: "2026-05-31",
    // Trusted-HTML-block sample so the Review & Publish preview shows a real rendered
    // zebra table instead of silently resolving {{detailsTable}} to an empty string.
    detailsTable: renderPhoenixMetadataTable(sampleDetailsRows),
    detailsTableText: renderPhoenixMetadataTableText(sampleDetailsRows),
    destination: "Alexandria, Egypt",
    employeeHrId: "PHX-1024",
    employeeName: "Mariam Adel",
    endDate: "2026-06-05",
    excuseDate: "2026-06-12",
    excuseType: "Morning excuse",
    feedback: "Strong role alignment and positive interview discussion.",
    hireDate: "2026-06-01",
    // "Dr. " for manager-facing greetings; sample as empty so {{honorific}}{{recipientName}}
    // reads naturally as "Ahmed" rather than presupposing a title.
    honorific: "",
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
