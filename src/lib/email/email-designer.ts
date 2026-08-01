import {
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
import { TOKEN_REGISTRY, type TokenCategory } from "@/lib/email-templates/token-registry";

export type EmailDesignerVariable = {
  allowedTemplateTypes: readonly EmailTemplateKey[];
  category: TokenCategory;
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

// Derived from TOKEN_REGISTRY (the single source of truth — see token-registry.ts's header) so
// this chip picker can never independently drift from what actually renders (contextVariables)
// or what's allowed to save/publish (placeholderHints). Used to produce a stale, hand-listed
// "Unknown variable" false-positive on "Run backend review" every time a token was added to one
// list and not this one.
const variableCatalog: EmailDesignerVariable[] = TOKEN_REGISTRY.map((t) => ({
  allowedTemplateTypes: t.allowedTemplateTypes,
  category: t.category,
  label: t.label,
  sampleValue: t.sampleValue,
  token: t.token,
}));

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

export function sampleTemplateContext(): Record<string, string> {
  // Generated from TOKEN_REGISTRY — was previously a hand-listed object that had already drifted
  // out of sync (missing digestTable/weekLabel/scoreTable and every marketing and
  // probation-milestone token), so "Backend Preview" silently showed blank fields for them.
  const base = Object.fromEntries(
    TOKEN_REGISTRY.filter((t) => !t.isHtmlBlock).map((t) => [t.token, t.sampleValue]),
  );
  return {
    ...base,
    // "Dr. " for manager-facing greetings; sample as empty so {{honorific}}{{recipientName}}
    // reads naturally as "Ahmed" rather than presupposing a title.
    honorific: "",
    recipientName: "Ahmed",
    // Trusted-HTML-block sample so the Review & Publish preview shows a real rendered
    // zebra table instead of silently resolving {{detailsTable}} to an empty string.
    detailsTable: renderPhoenixMetadataTable(sampleDetailsRows),
    detailsTableText: renderPhoenixMetadataTableText(sampleDetailsRows),
  };
}
