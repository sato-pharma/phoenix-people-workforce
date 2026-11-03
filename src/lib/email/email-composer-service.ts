import crypto from "crypto";

import { systemIdentity, systemDeployment } from "@/config/system-settings";
import { invalidCommunicationEmails, splitCommunicationEmailList } from "@/lib/communication/metrics";
import {
  assertReachableEmailImage,
  buildManualComposerIdempotencyKey,
  sanitizeEmailTemplateHtml,
  validateManualEmailRecipientPolicy,
} from "@/lib/email/email-safety";
import {
  buildPhoenixHrReplyEmail,
  phoenixHrEmailSignatureHostedUrl,
  phoenixHrEmailSignatureSmallPath,
  type PhoenixHrEmailTone,
} from "@/lib/email/phoenix-hr-reply-template";
import { getEmailDesignerMetadata } from "@/lib/email/email-designer";
import { getEmailTemplateCatalog } from "@/lib/email-templates/service";
import { getEmployeeDirectory, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type ComposerRecipientSelection =
  | { email: string; label?: string | null; type: "email" }
  | { hrId: string; label?: string | null; type: "employee" }
  | { key: ComposerRecipientGroupKey; label?: string | null; type: "group" };

export type ComposerRecipientGroupKey = "finance_team" | "hr_team" | "managers";

export type ComposerRecipientSelections = {
  bccSelections?: ComposerRecipientSelection[];
  ccSelections?: ComposerRecipientSelection[];
  toSelections?: ComposerRecipientSelection[];
};

export type ComposerPayload = ComposerRecipientSelections & {
  bcc?: unknown;
  cc?: unknown;
  clientRequestId?: unknown;
  externalJustification?: unknown;
  recipientName?: unknown;
  replyMessage?: unknown;
  replyMessageHtml?: unknown;
  senderName?: unknown;
  subject?: unknown;
  templateKey?: unknown;
  to?: unknown;
  tone?: unknown;
};

export type EmailDeliveryAnalytics = {
  externalRecipients30d: number;
  failed30d: number;
  lastManualSendAt: string | null;
  providerEvents30d: Record<string, number>;
  recentManualSends: Array<{
    createdAt: string | null;
    externalCount: number;
    status: string;
    subject: string;
    templateKey: string | null;
    totalRecipients: number;
  }>;
  sent30d: number;
  skipped30d: number;
};

const allowedTones = new Set<PhoenixHrEmailTone>(["professional", "warm", "firm", "concise"]);

const composerGroups = [
  { description: "Employees whose department or job title mentions HR.", key: "hr_team", label: "HR Team" },
  { description: "Employees whose department or job title mentions Finance.", key: "finance_team", label: "Finance Team" },
  { description: "Employees with manager titles or direct reports.", key: "managers", label: "Managers" },
] satisfies Array<{ description: string; key: ComposerRecipientGroupKey; label: string }>;

function stringField(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function employeeEmail(employee: EmployeeDirectoryRow) {
  return normalizeEmail(employee.workEmail ?? "");
}

function employeeLabel(employee: EmployeeDirectoryRow) {
  return `${employee.displayName} (${employee.hrId})`;
}

function employeeSearchText(employee: EmployeeDirectoryRow) {
  return [
    employee.displayName,
    employee.fullName,
    employee.hrId,
    employee.workEmail,
    employee.departmentName,
    employee.jobTitle,
    employee.positionTitle,
    employee.managerName,
    employee.lineName,
  ].filter(Boolean).join(" ").toLowerCase();
}

function roleText(employee: EmployeeDirectoryRow) {
  return `${employee.departmentName ?? ""} ${employee.jobTitle ?? ""} ${employee.positionTitle ?? ""}`.toLowerCase();
}

/**
 * The substring rule behind this composer's three groups. Deliberately not the distribution lists:
 * owner 2026-09-11, the lists belong to the Sato Email Composer and nothing else.
 */
function groupEmployees(key: ComposerRecipientGroupKey, employees: EmployeeDirectoryRow[]) {
  if (key === "hr_team") {
    return employees.filter((employee) => roleText(employee).includes("hr"));
  }
  if (key === "finance_team") {
    return employees.filter((employee) => roleText(employee).includes("finance"));
  }

  const managerIds = new Set(employees.map((employee) => employee.managerHrId?.toLowerCase()).filter(Boolean));
  return employees.filter((employee) => managerIds.has(employee.hrId.toLowerCase()) || roleText(employee).includes("manager"));
}

function addEmail(output: Array<{ email: string; label: string; source: string }>, email: string, label: string, source: string) {
  const normalized = normalizeEmail(email);
  if (!normalized) return;
  output.push({ email: normalized, label, source });
}

function resolveSelection(selection: ComposerRecipientSelection, employees: EmployeeDirectoryRow[]) {
  const output: Array<{ email: string; label: string; source: string }> = [];
  if (selection.type === "email") {
    addEmail(output, selection.email, selection.label ?? selection.email, "Manual email");
    return output;
  }
  if (selection.type === "employee") {
    const employee = employees.find((row) => row.hrId.toLowerCase() === selection.hrId.toLowerCase());
    if (employee) addEmail(output, employeeEmail(employee), employeeLabel(employee), "Employee");
    return output;
  }
  for (const employee of groupEmployees(selection.key, employees)) {
    addEmail(output, employeeEmail(employee), employeeLabel(employee), selection.label ?? selection.key);
  }
  return output;
}

function composerContextFromEmployee(employee: EmployeeDirectoryRow | null | undefined) {
  return {
    area: employee?.areaName ?? "",
    employeeHrId: employee?.hrId ?? "",
    employeeName: employee?.displayName ?? "",
    jobTitle: employee?.positionTitle ?? employee?.jobTitle ?? "",
    line: employee?.lineName ?? "",
    managerName: employee?.managerName ?? "",
    recipientName: employee?.displayName?.split(/\s+/)[0] ?? "",
    summary: "",
  };
}

function firstSelectedEmployee(input: ComposerPayload, employees: EmployeeDirectoryRow[]) {
  const selections = [
    ...(input.toSelections ?? []),
    ...(input.ccSelections ?? []),
    ...(input.bccSelections ?? []),
  ];
  const employeeSelection = selections.find((selection): selection is Extract<ComposerRecipientSelection, { type: "employee" }> => selection.type === "employee");
  if (employeeSelection) {
    return employees.find((employee) => employee.hrId.toLowerCase() === employeeSelection.hrId.toLowerCase()) ?? null;
  }
  const firstEmail = normalizeEmail(splitCommunicationEmailList(input.to)[0] ?? "");
  return employees.find((employee) => employeeEmail(employee) === firstEmail) ?? null;
}

/**
 * Resolve a token to its own string value. Inherited Object.prototype names
 * ({{__proto__}}, {{toString}}, ...) match the token grammar but are not data - without
 * the hasOwnProperty/typeof guards they leak prototype members or throw.
 */
function contextValue(context: Record<string, string>, token: string) {
  const resolved = Object.prototype.hasOwnProperty.call(context, token) ? context[token] : "";
  return typeof resolved === "string" ? resolved : "";
}

export function interpolateComposerText(value: string, context: Record<string, string>) {
  return value.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, token: string) => contextValue(context, token));
}

function escapeInterpolatedHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Rich-body counterpart of interpolateComposerText: resolved variable VALUES are
 * HTML-escaped (an employee name must never inject markup) and the whole result goes
 * through the server sanitizer, so the WYSIWYG client is never the security boundary.
 */
export function interpolateComposerHtml(value: string, context: Record<string, string>) {
  if (!value.trim()) return "";
  const interpolated = value.replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (_match, token: string) => escapeInterpolatedHtml(contextValue(context, token)),
  );
  return sanitizeEmailTemplateHtml(interpolated);
}

/**
 * Server-side plain-text projection of the (already interpolated + sanitized) rich body.
 * The text MIME part is derived here rather than trusted from the client, so the
 * multipart/alternative parts can never diverge regardless of client behavior.
 */
export function composerHtmlToText(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|blockquote|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Tokens composerContextFromEmployee actually fills with real values. */
export const composerContextTokens = ["area", "employeeHrId", "employeeName", "jobTitle", "line", "managerName", "recipientName"] as const;

function dedupeChannels(input: {
  bcc: Array<{ email: string; label: string; source: string }>;
  cc: Array<{ email: string; label: string; source: string }>;
  to: Array<{ email: string; label: string; source: string }>;
}) {
  const seen = new Set<string>();
  let duplicateRecipientsRemoved = 0;
  const dedupe = (items: Array<{ email: string; label: string; source: string }>) => {
    const output: Array<{ email: string; label: string; source: string }> = [];
    for (const item of items) {
      if (seen.has(item.email)) {
        duplicateRecipientsRemoved += 1;
        continue;
      }
      seen.add(item.email);
      output.push(item);
    }
    return output;
  };

  const to = dedupe(input.to);
  const cc = dedupe(input.cc);
  const bcc = dedupe(input.bcc);
  return { bcc, cc, duplicateRecipientsRemoved, to };
}

export async function getEmailComposerOptions() {
  const [{ employees }, templates, analytics] = await Promise.all([
    getEmployeeDirectory(),
    getEmailTemplateCatalog(),
    getManualEmailDeliveryAnalytics(),
  ]);
  const metadata = getEmailDesignerMetadata();
  const employeeOptions = employees
    .filter((employee) => employee.workEmail)
    .slice(0, 200)
    .map((employee) => ({
      departmentName: employee.departmentName,
      email: employee.workEmail,
      hrId: employee.hrId,
      label: employeeLabel(employee),
      lineName: employee.lineName,
      managerName: employee.managerName,
      title: employee.positionTitle ?? employee.jobTitle,
    }));

  const policy = validateManualEmailRecipientPolicy({ to: [] });
  return {
    allowedDomains: policy.allowedDomains,
    analytics,
    employeeOptions,
    groups: composerGroups,
    maxRecipients: policy.maxRecipients,
    templates: templates.map((template) => ({
      description: template.description,
      isActive: template.isActive,
      templateKey: template.templateKey,
      templateName: template.templateName,
    })),
    tones: [
      { label: "Formal", value: "professional" },
      { label: "Friendly", value: "warm" },
      { label: "Short", value: "concise" },
      { label: "Detailed", value: "firm" },
    ],
    // Only tokens the composer context can actually resolve - offering the full designer
    // catalog here would insert chips that silently interpolate to "" in sent emails.
    variables: metadata.variables.filter((variable) => (composerContextTokens as readonly string[]).includes(variable.token)),
  };
}

export async function getManualEmailDeliveryAnalytics(): Promise<EmailDeliveryAnalytics> {
  const sinceIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const supabase = getSupabaseAdmin();
  const [manual, provider] = await Promise.all([
    supabase
      .from("manual_email_send_audit")
      .select("to_recipients,cc_recipients,bcc_recipients,external_recipients,status,subject,template_key,created_at")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("email_delivery_events")
      .select("status,occurred_at")
      .gte("occurred_at", sinceIso)
      .limit(500),
  ]);

  const manualRows = manual.error ? [] : ((manual.data ?? []) as Array<{
    bcc_recipients: string[] | null;
    cc_recipients: string[] | null;
    created_at: string | null;
    external_recipients: string[] | null;
    status: string | null;
    subject: string | null;
    template_key: string | null;
    to_recipients: string[] | null;
  }>);
  const providerRows = provider.error ? [] : ((provider.data ?? []) as Array<{ status: string | null }>);
  const providerEvents30d = providerRows.reduce<Record<string, number>>((acc, row) => {
    const status = String(row.status ?? "unknown").toLowerCase();
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});

  return {
    externalRecipients30d: manualRows.reduce((total, row) => total + (row.external_recipients?.length ?? 0), 0),
    failed30d: manualRows.filter((row) => row.status === "failed").length,
    lastManualSendAt: manualRows[0]?.created_at ?? null,
    providerEvents30d,
    recentManualSends: manualRows.slice(0, 8).map((row) => ({
      createdAt: row.created_at,
      externalCount: row.external_recipients?.length ?? 0,
      status: row.status ?? "unknown",
      subject: row.subject ?? "No subject",
      templateKey: row.template_key,
      totalRecipients: (row.to_recipients?.length ?? 0) + (row.cc_recipients?.length ?? 0) + (row.bcc_recipients?.length ?? 0),
    })),
    sent30d: manualRows.filter((row) => row.status === "sent").length,
    skipped30d: manualRows.filter((row) => row.status === "skipped").length,
  };
}

export async function searchComposerEmployees(query: string) {
  const { employees } = await getEmployeeDirectory();
  const normalized = query.trim().toLowerCase();
  return employees
    .filter((employee) => employee.workEmail && (!normalized || employeeSearchText(employee).includes(normalized)))
    .slice(0, 25)
    .map((employee) => ({
      departmentName: employee.departmentName,
      email: employee.workEmail,
      hrId: employee.hrId,
      label: employeeLabel(employee),
      lineName: employee.lineName,
      managerName: employee.managerName,
      title: employee.positionTitle ?? employee.jobTitle,
    }));
}

export async function resolveComposerRecipients(input: ComposerPayload) {
  const { employees } = await getEmployeeDirectory();
  const to = splitCommunicationEmailList(input.to)
    .map((email) => ({ email: normalizeEmail(email), label: email, source: "Manual email" }));
  const cc = splitCommunicationEmailList(input.cc)
    .map((email) => ({ email: normalizeEmail(email), label: email, source: "Manual email" }));
  const bcc = splitCommunicationEmailList(input.bcc)
    .map((email) => ({ email: normalizeEmail(email), label: email, source: "Manual email" }));
  const resolvedSelections = {
    bcc: (input.bccSelections ?? []).flatMap((selection) => resolveSelection(selection, employees)),
    cc: (input.ccSelections ?? []).flatMap((selection) => resolveSelection(selection, employees)),
    to: (input.toSelections ?? []).flatMap((selection) => resolveSelection(selection, employees)),
  };
  const channels = dedupeChannels({
    bcc: [...bcc, ...resolvedSelections.bcc],
    cc: [...cc, ...resolvedSelections.cc],
    to: [...to, ...resolvedSelections.to],
  });
  const warnings: string[] = [];
  const allEmails = [...channels.to, ...channels.cc, ...channels.bcc].map((item) => item.email);
  const invalidRecipients = invalidCommunicationEmails(allEmails);
  const context = composerContextFromEmployee(firstSelectedEmployee(input, employees));

  if (invalidRecipients.length > 0) warnings.push(`Invalid recipient address: ${invalidRecipients[0]}.`);
  if (channels.duplicateRecipientsRemoved > 0) warnings.push(`${channels.duplicateRecipientsRemoved} duplicate recipient(s) were removed.`);

  return {
    ...channels,
    emails: {
      bcc: channels.bcc.map((item) => item.email),
      cc: channels.cc.map((item) => item.email),
      to: channels.to.map((item) => item.email),
    },
    context,
    totalRecipients: allEmails.length,
    warnings,
  };
}

function isLocalUrl(value: string) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function publicAssetUrl(publicPath: string, requestUrl: string) {
  const configuredBase =
    process.env.HR_EMAIL_ASSET_BASE_URL ||
    process.env.NOTIFICATION_DASHBOARD_URL ||
    process.env.APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    systemDeployment.productionUrl ||
    new URL(requestUrl).origin;
  const base = /^https?:\/\//i.test(configuredBase) ? configuredBase : `https://${configuredBase}`;

  return `${base.replace(/\/+$/, "")}/${publicPath.replace(/^\/+/, "")}`;
}

export function emailSignatureUrl(requestUrl: string) {
  const explicitUrl = process.env.HR_EMAIL_SIGNATURE_URL?.trim();
  if (explicitUrl) return explicitUrl;

  if (!process.env.HR_EMAIL_ASSET_BASE_URL?.trim()) {
    return phoenixHrEmailSignatureHostedUrl;
  }

  const assetUrl = publicAssetUrl(phoenixHrEmailSignatureSmallPath, requestUrl);
  return isLocalUrl(assetUrl) ? phoenixHrEmailSignatureHostedUrl : assetUrl;
}

export function normalizeComposerBody(input: ComposerPayload) {
  const tone = allowedTones.has(input.tone as PhoenixHrEmailTone)
    ? (input.tone as PhoenixHrEmailTone)
    : "professional";

  return {
    clientRequestId: stringField(input.clientRequestId),
    externalJustification: stringField(input.externalJustification),
    recipientName: stringField(input.recipientName),
    replyMessage: stringField(input.replyMessage),
    replyMessageHtml: stringField(input.replyMessageHtml),
    senderName: stringField(input.senderName) || systemIdentity.hrSignatureName,
    subject: stringField(input.subject),
    templateKey: stringField(input.templateKey),
    tone,
  };
}

export async function previewManualEmail(input: ComposerPayload, requestUrl: string) {
  const normalized = normalizeComposerBody(input);
  const resolved = await resolveComposerRecipients(input);
  const subject = interpolateComposerText(normalized.subject, resolved.context);
  const replyMessage = interpolateComposerText(normalized.replyMessage, resolved.context);
  const replyMessageHtml = interpolateComposerHtml(normalized.replyMessageHtml, resolved.context);
  const recipientPolicy = validateManualEmailRecipientPolicy({
    bcc: resolved.emails.bcc,
    cc: resolved.emails.cc,
    externalJustification: normalized.externalJustification,
    to: resolved.emails.to,
  });
  const signatureImageSrc = emailSignatureUrl(requestUrl);
  let signatureImageWarning: string | null = null;

  try {
    const imageCheck = await assertReachableEmailImage(signatureImageSrc);
    signatureImageWarning = imageCheck.warning ?? null;
  } catch (error) {
    signatureImageWarning = error instanceof Error ? error.message : "Signature image check failed.";
  }

  const generated = buildPhoenixHrReplyEmail({
    cc: resolved.emails.cc.join(", "),
    recipientName: normalized.recipientName || resolved.context.recipientName,
    // With a rich body, the text part is projected from the same html server-side so the
    // multipart/alternative parts cannot diverge.
    replyMessage: replyMessageHtml ? composerHtmlToText(replyMessageHtml) || replyMessage : replyMessage,
    replyMessageHtml,
    senderName: normalized.senderName,
    signatureImageSrc,
    subject,
    to: resolved.emails.to.join(", "),
    tone: normalized.tone,
  });

  return {
    html: generated.html,
    plainText: generated.plainText,
    recipientPolicy,
    recipients: resolved,
    signatureImageWarning,
    subject,
    warnings: [
      ...resolved.warnings,
      ...recipientPolicy.issues.map((issue) => issue.message),
      ...(signatureImageWarning ? [signatureImageWarning] : []),
      ...(subject ? [] : ["Subject is required before sending."]),
      ...(replyMessage ? [] : ["Message body is required before sending."]),
    ],
  };
}

export function buildComposerIdempotency(input: {
  bcc: string[];
  cc: string[];
  normalized: ReturnType<typeof normalizeComposerBody>;
  to: string[];
}) {
  return buildManualComposerIdempotencyKey({
    bcc: input.bcc,
    cc: input.cc,
    clientRequestId: input.normalized.clientRequestId,
    recipientName: input.normalized.recipientName,
    // The rich body participates in the idempotency hash so editing only formatting
    // (same plain text) still counts as a different email.
    replyMessage: [input.normalized.replyMessage, input.normalized.replyMessageHtml].filter(Boolean).join("\n@@html@@\n"),
    senderName: input.normalized.senderName,
    subject: input.normalized.subject,
    to: input.to,
    tone: input.normalized.tone,
  });
}

export async function recordManualEmailSendAudit(input: {
  actor: string | null;
  bcc: string[];
  cc: string[];
  clientRequestId: string;
  errorMessage?: string | null;
  externalJustification?: string | null;
  externalRecipients: string[];
  providerMessageId?: string | null;
  providerReason?: string | null;
  providerSkipped?: boolean;
  status: "failed" | "sent" | "skipped";
  subject: string;
  templateKey?: string | null;
  to: string[];
}) {
  const recipientsHash = crypto
    .createHash("sha256")
    .update(JSON.stringify({
      bcc: input.bcc.map(normalizeEmail).sort(),
      cc: input.cc.map(normalizeEmail).sort(),
      to: input.to.map(normalizeEmail).sort(),
    }))
    .digest("hex");

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("manual_email_send_audit").insert({
    actor: input.actor,
    bcc_recipients: input.bcc,
    cc_recipients: input.cc,
    client_request_id: input.clientRequestId,
    error_message: input.errorMessage ?? null,
    external_justification: input.externalJustification ?? null,
    external_recipients: input.externalRecipients,
    provider_message_id: input.providerMessageId ?? null,
    provider_reason: input.providerReason ?? null,
    provider_skipped: input.providerSkipped ?? false,
    recipients_hash: recipientsHash,
    status: input.status,
    subject: input.subject,
    template_key: input.templateKey || null,
    to_recipients: input.to,
  });

  if (error) throw error;
}
