import {
  renderEmailParagraphs,
  renderPhoenixEmailHtml,
  renderPhoenixEmailText,
  type PhoenixEmailAction,
  type PhoenixEmailMetadataRow,
} from "@/emails/phoenix-email-layout";
import { sendPhoenixEmail, type SendPhoenixEmailResult } from "@/lib/email/send-phoenix-email";
import { sendTemplatedEmail } from "@/lib/email-templates/service";
import {
  vacationTypeLabel,
  vacationUnpaidReasonLabel,
} from "@/lib/vacation/calculations";
import type { VacationDecision, VacationRequestRecord } from "@/lib/vacation/types";

type VacationManagerEmailInput = {
  managerEmail: string;
  managerName: string;
  policyWarnings?: string[];
  request: VacationRequestRecord;
  /** Absolute Action Center review link used as the email CTA (no direct approve/reject). */
  reviewUrl: string;
};

type VacationDecisionEmailInput = {
  cc: string[];
  decision: VacationDecision;
  employeeEmail: string;
  request: VacationRequestRecord;
};

function formatDays(days: number) {
  return `${Number(days.toFixed(2))} day${days === 1 ? "" : "s"}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatPaymentStatus(request: VacationRequestRecord) {
  if (request.paymentStatus === "partial") {
    return `Payment status: partially paid (${formatDays(request.paidDurationDays)} paid, ${formatDays(request.unpaidDurationDays)} unpaid)`;
  }
  return `Payment status: ${request.paymentStatus}${request.unpaidReason ? ` (${vacationUnpaidReasonLabel(request.unpaidReason)})` : ""}`;
}

export function buildVacationDecisionUrl(input: {
  baseUrl: string;
  decision: VacationDecision;
  requestId: string;
  token: string;
}) {
  const url = new URL(`/api/vacations/requests/${encodeURIComponent(input.requestId)}/decision`, input.baseUrl);
  url.searchParams.set("decision", input.decision);
  url.searchParams.set("token", input.token);
  return url.toString();
}

/**
 * True only when sendTemplatedEmail skipped because the template itself is missing,
 * unsupported, or deactivated — NOT when there were simply no deliverable recipients.
 * Only these cases warrant the plain fallback below; a recipient-less skip would also
 * produce no fallback recipients, so re-sending is pointless.
 */
function isTemplateUnavailableSkip(result: SendPhoenixEmailResult): boolean {
  if (!("skipped" in result) || !result.skipped) return false;
  const reason = String((result as { reason?: string }).reason ?? "").toLowerCase();
  return (
    reason.includes("template not found") ||
    reason.includes("is inactive") ||
    reason.includes("unsupported email template")
  );
}

/**
 * Minimal neutral email used ONLY when the matching WYSIWYG template has been
 * deactivated/deleted, so a vacation notification is never silently dropped. The
 * styled template is the normal path; this still uses the shared Phoenix layout so
 * fallback sends stay aligned with light/dark email rendering.
 */
function buildFallbackEmail(input: {
  heading: string;
  rows: Array<[string, string]>;
  cta?: { label: string; url: string };
  subject: string;
  title: string;
}): { html: string; text: string } {
  const metadataRows: PhoenixEmailMetadataRow[] = input.rows.map(([label, value]) => ({ label, value }));
  const action: PhoenixEmailAction | undefined = input.cta?.url
    ? { href: input.cta.url, label: input.cta.label }
    : undefined;
  const html = renderPhoenixEmailHtml({
    action,
    bodyHtml: renderEmailParagraphs(input.heading),
    metadataRows,
    previewText: input.heading,
    subject: input.subject,
    title: input.title,
  });
  const text = renderPhoenixEmailText({
    action,
    bodyText: input.heading,
    metadataRows,
    title: input.title,
  });
  return { html, text };
}

export async function sendVacationManagerDecisionEmail(input: VacationManagerEmailInput): Promise<SendPhoenixEmailResult> {
  const policyWarningText = input.policyWarnings?.length
    ? ` Policy review required: ${input.policyWarnings.join(" ")} HR owns the final decision.`
    : " HR owns the final decision after manager review.";
  const hireDate = input.request.employeeHireDate ? formatDate(input.request.employeeHireDate) : "Not available";
  const duration = formatDays(input.request.durationDays);
  const period = `${formatDate(input.request.startDate)} to ${formatDate(input.request.endDate)}`;
  const approvalFlow = input.request.vacationType === "annual"
    ? "Annual vacation requests require Manager Review followed by HR Final Review."
    : "This vacation request requires manager review and HR final review.";

  const templated = await sendTemplatedEmail({
    context: {
      approvalFlow,
      ctaLabel: "Review Leave Request",
      ctaUrl: input.reviewUrl,
      // The leave_request template renders the hiring date via {{date}}.
      date: hireDate,
      duration,
      employeeHrId: input.request.employeeHrId,
      employeeName: input.request.employeeName,
      endDate: formatDate(input.request.endDate),
      hireDate,
      // The leave_request greeting is "Dear {{managerName}},".
      managerName: input.managerName || "Manager",
      recipientName: input.managerName || "Manager",
      startDate: formatDate(input.request.startDate),
      status: `Duration: ${duration}. ${formatPaymentStatus(input.request)}.${policyWarningText}`,
      subject: `Vacation request from ${input.request.employeeName}`,
      summary: `${input.request.employeeName} submitted a ${vacationTypeLabel(input.request.vacationType)} request.`,
      vacationBalance: formatDays(input.request.balanceBeforeDays),
      vacationType: vacationTypeLabel(input.request.vacationType),
    },
    employeeHrId: input.request.employeeHrId,
    fallbackTo: [input.managerEmail],
    // replaceRecipients: the approval workflow engine owns routing for vacation emails — each
    // approver gets exactly their own personally-greeted copy. Without it, the template's
    // editor-configured recipient rules (TO direct_manager, CC hr) merge into EVERY per-approver
    // send, so copies greeted to one approver also land in other inboxes (looks like the flow
    // "skipped the manager" / "went to the manager-of-manager").
    overrides: { replaceRecipients: true, to: [input.managerEmail] },
    templateKey: "leave_request",
  });
  if (!isTemplateUnavailableSkip(templated)) return templated;

  const fallback = buildFallbackEmail({
    heading: `${input.request.employeeName} submitted a ${vacationTypeLabel(input.request.vacationType)} request that needs your review.`,
    rows: [
      ["Employee", `${input.request.employeeName} (${input.request.employeeHrId})`],
      ["Period", period],
      ["Duration", duration],
    ],
    cta: { label: "Review Leave Request", url: input.reviewUrl },
    subject: `Vacation request from ${input.request.employeeName}`,
    title: "Vacation request review",
  });
  return sendPhoenixEmail({
    html: fallback.html,
    idempotencyKey: `vacation:${input.request.id}:leave_request_fallback:${input.managerEmail.toLowerCase()}`,
    subject: `Vacation request from ${input.request.employeeName}`,
    text: fallback.text,
    to: [input.managerEmail],
  });
}

export async function sendVacationDecisionResultEmail(input: VacationDecisionEmailInput): Promise<SendPhoenixEmailResult> {
  const approved = input.decision === "approve";
  const statusLine = approved
    ? "Your vacation request has been approved by the vacation approval workflow."
    : `Your vacation request has been rejected by the vacation approval workflow.${input.request.hrDecisionComment ? ` Reason: ${input.request.hrDecisionComment}` : ""}`;
  const templated = await sendTemplatedEmail({
    context: {
      employeeHrId: input.request.employeeHrId,
      employeeName: input.request.employeeName,
      endDate: formatDate(input.request.endDate),
      recipientName: input.request.employeeName,
      startDate: formatDate(input.request.startDate),
      status: statusLine,
      subject: `Vacation request ${approved ? "approved" : "rejected"}`,
      vacationType: vacationTypeLabel(input.request.vacationType),
    },
    employeeHrId: input.request.employeeHrId,
    fallbackTo: [input.employeeEmail],
    // Engine-owned routing (see leave_request note): employee TO + approver CC, never the
    // template's editor recipient rules.
    overrides: { cc: input.cc, replaceRecipients: true, to: [input.employeeEmail] },
    templateKey: approved ? "leave_approval" : "leave_rejection",
  });
  if (!isTemplateUnavailableSkip(templated)) return templated;

  const fallback = buildFallbackEmail({
    heading: statusLine,
    rows: [
      ["Type", vacationTypeLabel(input.request.vacationType)],
      ["Period", `${formatDate(input.request.startDate)} to ${formatDate(input.request.endDate)}`],
      ["Status", approved ? "Approved" : "Rejected"],
    ],
    subject: `Vacation request ${approved ? "approved" : "rejected"}`,
    title: `Vacation request ${approved ? "approved" : "rejected"}`,
  });
  return sendPhoenixEmail({
    cc: input.cc,
    html: fallback.html,
    idempotencyKey: `vacation:${input.request.id}:decision_${input.decision}_fallback:${input.employeeEmail.toLowerCase()}`,
    subject: `Vacation request ${approved ? "approved" : "rejected"}`,
    text: fallback.text,
    to: [input.employeeEmail],
  });
}
