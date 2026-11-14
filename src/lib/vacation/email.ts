import { raiseApproval } from "@/lib/approvals/raise-approval";
import {
  renderEmailParagraphs,
  renderPhoenixEmailHtml,
  renderPhoenixEmailText,
  renderPhoenixMetadataTable,
  renderPhoenixMetadataTableText,
  type PhoenixEmailAction,
  type PhoenixEmailMetadataRow,
} from "@/emails/phoenix-email-layout";
import { systemDeployment } from "@/config/system-settings";
import type { SendPhoenixEmailResult } from "@/lib/email/send-phoenix-email";
import { sendDurableEmail } from "@/lib/notifications/durable-email";
import {
  vacationTypeLabel,
  vacationUnpaidReasonLabel,
} from "@/lib/vacation/calculations";
import type { VacationDecision, VacationRequestRecord, VacationType } from "@/lib/vacation/types";

type VacationManagerEmailInput = {
  cc?: string[];
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
  employeeDisplayName?: string;
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

  const detailsRows: PhoenixEmailMetadataRow[] = [
    { label: "Request code", value: input.request.requestCode },
    { label: "Employee", value: `${input.request.employeeName} (${input.request.employeeHrId})` },
    { label: "Hiring date", value: hireDate },
    { label: "Available balance", value: formatDays(input.request.balanceBeforeDays) },
    { label: "Period", value: period },
    { label: "Duration", value: duration },
    { label: "Approval flow", value: approvalFlow },
  ];
  const templated = await raiseApproval({ module: "leave", step: "waiting" }, { via: "durable-email", message: { sender: "templated", input: {
    context: {
      approvalFlow,
      ctaLabel: "Review Leave Request",
      ctaUrl: input.reviewUrl,
      // The leave_request template renders the hiring date via {{date}}.
      date: hireDate,
      requestCode: input.request.requestCode,
      detailsTable: renderPhoenixMetadataTable(detailsRows),
      detailsTableText: renderPhoenixMetadataTableText(detailsRows),
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
    // replaceRecipients: the approval workflow engine owns routing for vacation emails:
    // one actionable manager TO, visibility recipients in CC.
    overrides: { cc: input.cc, replaceRecipients: true, to: [input.managerEmail] },
    templateKey: "leave_request",
  } }, dedupeKey: `vacation:${input.request.id}:leave_request:${input.managerEmail.toLowerCase()}` });
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
  const fallbackKey = `vacation:${input.request.id}:leave_request_fallback:${input.managerEmail.toLowerCase()}`;
  return raiseApproval({ module: "leave", step: "waiting" }, { via: "durable-email", message: { sender: "phoenix", input: {
    cc: input.cc,
    html: fallback.html,
    idempotencyKey: fallbackKey,
    origin: { employeeHrId: input.request.employeeHrId, eventType: "vacation_manager_decision", module: "vacation" },
    subject: `Vacation request from ${input.request.employeeName}`,
    text: fallback.text,
    to: [input.managerEmail],
  } }, dedupeKey: fallbackKey });
}

export async function sendVacationDecisionResultEmail(input: VacationDecisionEmailInput): Promise<SendPhoenixEmailResult> {
  const approved = input.decision === "approve";
  const statusLine = approved
    ? "Your vacation request has been approved by the vacation approval workflow."
    : `Your vacation request has been rejected by the vacation approval workflow.${input.request.hrDecisionComment ? ` Reason: ${input.request.hrDecisionComment}` : ""}`;
  const detailsRows: PhoenixEmailMetadataRow[] = [
    { label: "Request code", value: input.request.requestCode },
    { label: "Leave type", value: vacationTypeLabel(input.request.vacationType) },
    { label: "Period", value: `${formatDate(input.request.startDate)} to ${formatDate(input.request.endDate)}` },
    { label: "Duration", value: formatDays(input.request.durationDays) },
    ...(approved ? [] : [{ label: "Rejection reason", value: input.request.hrDecisionComment ?? "—" }]),
  ];
  const templated = await raiseApproval({ decision: approved ? "approved" : "rejected", module: "leave", step: "decided" }, { via: "durable-email", message: { sender: "templated", input: {
    context: {
      // CTA + duration are used by both decision templates; the rejection template also uses
      // {{status}} as the Request ID, {{summary}} as the rejection reason, and {{managerName}}.
      // Without these the admin-edited leave_approval/leave_rejection emails render blank cells.
      ctaLabel: "Open in Phoenix Workforce",
      ctaUrl: systemDeployment.productionUrl,
      detailsTable: renderPhoenixMetadataTable(detailsRows),
      detailsTableText: renderPhoenixMetadataTableText(detailsRows),
      duration: formatDays(input.request.durationDays),
      employeeHrId: input.request.employeeHrId,
      employeeName: input.request.employeeName,
      endDate: formatDate(input.request.endDate),
      managerName: input.request.managerName || "your manager",
      recipientName: input.employeeDisplayName ?? input.request.employeeName,
      startDate: formatDate(input.request.startDate),
      requestCode: input.request.requestCode,
      // {{status}} carries the request identity on the rejection template. It used to pass the
      // raw uuid, which is precisely the thing nobody can read back to you over the phone.
      status: approved ? statusLine : input.request.requestCode,
      subject: `Vacation request ${approved ? "approved" : "rejected"}`,
      summary: approved ? statusLine : (input.request.hrDecisionComment ?? "—"),
      vacationType: vacationTypeLabel(input.request.vacationType),
    },
    employeeHrId: input.request.employeeHrId,
    fallbackTo: [input.employeeEmail],
    // Engine-owned routing (see leave_request note): employee TO + approver CC, never the
    // template's editor recipient rules.
    overrides: { cc: input.cc, replaceRecipients: true, to: [input.employeeEmail] },
    templateKey: approved ? "leave_approval" : "leave_rejection",
  } }, dedupeKey: `vacation:${input.request.id}:decision_${input.decision}:${input.employeeEmail.toLowerCase()}` });
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
  const fallbackKey = `vacation:${input.request.id}:decision_${input.decision}_fallback:${input.employeeEmail.toLowerCase()}`;
  return raiseApproval({ decision: approved ? "approved" : "rejected", module: "leave", step: "decided" }, { via: "durable-email", message: { sender: "phoenix", input: {
    cc: input.cc,
    html: fallback.html,
    idempotencyKey: fallbackKey,
    origin: { employeeHrId: input.request.employeeHrId, eventType: "vacation_decision_result", module: "vacation" },
    subject: `Vacation request ${approved ? "approved" : "rejected"}`,
    text: fallback.text,
    to: [input.employeeEmail],
  } }, dedupeKey: fallbackKey });
}

type VacationManagerStepResultEmailInput = {
  cc: string[];
  decision: VacationDecision;
  employeeDisplayName?: string;
  employeeEmail: string;
  managerDecisionComment: string | null;
  managerName: string;
  nextStep: string;
  request: VacationRequestRecord;
};

/**
 * Notifies the employee (CC: HR) after each intermediate manager decision —
 * i.e. before the final HR step. Used for both approve and reject at any
 * management step so the employee always gets an email, not just Telegram/in-app.
 */
export async function sendVacationManagerStepResultEmail(
  input: VacationManagerStepResultEmailInput,
): Promise<SendPhoenixEmailResult> {
  const approved = input.decision === "approve";
  const action = approved ? "approved" : "rejected";
  const heading = approved
    ? `${input.managerName} approved your ${vacationTypeLabel(input.request.vacationType)} request. ${input.nextStep}`
    : `${input.managerName} rejected your ${vacationTypeLabel(input.request.vacationType)} request.${input.managerDecisionComment ? ` Reason: ${input.managerDecisionComment}` : ""}`;
  const detailsRows: PhoenixEmailMetadataRow[] = [
    { label: "Request code", value: input.request.requestCode },
    { label: "Type", value: vacationTypeLabel(input.request.vacationType) },
    { label: "Period", value: `${formatDate(input.request.startDate)} to ${formatDate(input.request.endDate)}` },
    { label: "Manager", value: input.managerName },
    { label: "Decision", value: approved ? "Approved" : "Rejected" },
    ...(!approved && input.managerDecisionComment ? [{ label: "Reason", value: input.managerDecisionComment }] : []),
  ];
  const templated = await raiseApproval({ decision: approved ? "approved" : "rejected", module: "leave", step: "decided" }, { via: "durable-email", message: { sender: "templated", input: {
    context: {
      ctaLabel: "Open in Phoenix Workforce",
      ctaUrl: systemDeployment.productionUrl,
      detailsTable: renderPhoenixMetadataTable(detailsRows),
      detailsTableText: renderPhoenixMetadataTableText(detailsRows),
      duration: formatDays(input.request.durationDays),
      employeeHrId: input.request.employeeHrId,
      employeeName: input.request.employeeName,
      endDate: formatDate(input.request.endDate),
      managerName: input.managerName,
      nextStep: approved ? input.nextStep : "",
      requestCode: input.request.requestCode,
      recipientName: input.employeeDisplayName ?? input.request.employeeName,
      startDate: formatDate(input.request.startDate),
      status: approved ? "Approved" : `Rejected${input.managerDecisionComment ? ` — ${input.managerDecisionComment}` : ""}`,
      subject: `Vacation request ${action} by ${input.managerName}`,
      summary: heading,
      vacationType: vacationTypeLabel(input.request.vacationType),
    },
    employeeHrId: input.request.employeeHrId,
    fallbackTo: [input.employeeEmail],
    overrides: { cc: input.cc, replaceRecipients: true, to: [input.employeeEmail] },
    templateKey: "leave_manager_step_decision",
  } }, dedupeKey: `vacation:${input.request.id}:manager_step_${action}:${input.employeeEmail.toLowerCase()}` });
  if (!isTemplateUnavailableSkip(templated)) return templated;

  const rows: Array<[string, string]> = [
    ["Type", vacationTypeLabel(input.request.vacationType)],
    ["Period", `${formatDate(input.request.startDate)} to ${formatDate(input.request.endDate)}`],
    ["Manager", input.managerName],
    ["Decision", approved ? "Approved" : "Rejected"],
    ...(approved ? [["Next step", input.nextStep] as [string, string]] : []),
  ];
  const fallback = buildFallbackEmail({
    heading,
    rows,
    subject: `Vacation request ${action} by ${input.managerName}`,
    title: `Vacation request ${action}`,
  });
  const fallbackKey = `vacation:${input.request.id}:manager_step_${action}:employee:${input.employeeEmail.toLowerCase()}`;
  return raiseApproval({ decision: approved ? "approved" : "rejected", module: "leave", step: "decided" }, { via: "durable-email", message: { sender: "phoenix", input: {
    cc: input.cc,
    html: fallback.html,
    idempotencyKey: fallbackKey,
    origin: { employeeHrId: input.request.employeeHrId, eventType: "vacation_manager_step_result", module: "vacation" },
    subject: `Vacation request ${action} by ${input.managerName}`,
    text: fallback.text,
    to: [input.employeeEmail],
  } }, dedupeKey: fallbackKey });
}

type VacationBalanceSettlementEmailInput = {
  employeeDisplayName?: string;
  employeeEmail: string;
  managerEmail: string;
  cc: string[];
  /** Lean subset — the Payroll Copilot's own read of the unpaid request, not the full enriched VacationRequestRecord. */
  request: {
    durationDays: number;
    employeeHrId: string;
    employeeName: string;
    endDate: string;
    id: string;
    startDate: string;
    vacationType: VacationType;
  };
  /** The EGP amount that would have been deducted from salary — for display only, no deduction occurs. */
  wouldHaveDeductedAmount: number;
};

/**
 * Notifies the employee and their manager (CC: HR) when the CEO settles an
 * unpaid-leave request's cost against vacation balance instead of deducting
 * it from payroll (Payroll Copilot's Unpaid Vacation tab). Idempotent per
 * request — the caller stamps `email_sent_at` on the settlement row and never
 * calls this a second time for the same settlement.
 */
export async function sendVacationBalanceSettlementEmail(
  input: VacationBalanceSettlementEmailInput,
): Promise<SendPhoenixEmailResult> {
  const duration = formatDays(input.request.durationDays);
  const period = `${formatDate(input.request.startDate)} to ${formatDate(input.request.endDate)}`;
  const amount = `EGP ${Math.round(input.wouldHaveDeductedAmount).toLocaleString("en-US")}`;
  const heading = `Based on ${input.request.employeeName}'s ${vacationTypeLabel(input.request.vacationType)} leave (${period}, ${duration}), a deduction of ${amount} would normally apply to this month's payroll for the unpaid portion. The system administrator has approved settling this against the vacation balance instead — no salary deduction will occur.`;

  const templated = await sendDurableEmail({ sender: "templated", input: {
    context: {
      amount,
      duration,
      employeeHrId: input.request.employeeHrId,
      employeeName: input.request.employeeName,
      endDate: formatDate(input.request.endDate),
      recipientName: input.employeeDisplayName ?? input.request.employeeName,
      startDate: formatDate(input.request.startDate),
      subject: `Vacation balance settlement — ${input.request.employeeName}`,
      vacationType: vacationTypeLabel(input.request.vacationType),
    },
    employeeHrId: input.request.employeeHrId,
    fallbackTo: [input.employeeEmail, input.managerEmail],
    // Engine-owned routing: employee + manager both get the notice, HR in CC.
    overrides: { cc: input.cc, replaceRecipients: true, to: [input.employeeEmail, input.managerEmail] },
    templateKey: "vacation_balance_settlement",
  } }, { dedupeKey: `vacation:${input.request.id}:balance_settlement` });
  if (!isTemplateUnavailableSkip(templated)) return templated;

  const fallback = buildFallbackEmail({
    heading,
    rows: [
      ["Employee", `${input.request.employeeName} (${input.request.employeeHrId})`],
      ["Type", vacationTypeLabel(input.request.vacationType)],
      ["Period", period],
      ["Duration", duration],
      ["Amount waived", amount],
    ],
    subject: `Vacation balance settlement — ${input.request.employeeName}`,
    title: "Vacation balance settlement",
  });
  const fallbackKey = `vacation:${input.request.id}:balance_settlement_fallback`;
  return sendDurableEmail({ sender: "phoenix", input: {
    cc: input.cc,
    html: fallback.html,
    idempotencyKey: fallbackKey,
    origin: { employeeHrId: input.request.employeeHrId, eventType: "vacation_balance_settlement", module: "vacation" },
    subject: `Vacation balance settlement — ${input.request.employeeName}`,
    text: fallback.text,
    to: [input.employeeEmail, input.managerEmail],
  } }, { dedupeKey: fallbackKey });
}

type VacationReturnedEmailInput = {
  cc: string[];
  decisionComment: string | null;
  employeeDisplayName?: string;
  employeeEmail: string;
  managerName: string;
  request: VacationRequestRecord;
};

/**
 * Notifies the employee (CC: HR) when a manager returns their vacation request
 * for revision, so the employee gets all 3 channels (email + Telegram + in-app).
 */
export async function sendVacationReturnedEmail(
  input: VacationReturnedEmailInput,
): Promise<SendPhoenixEmailResult> {
  const heading = `${input.managerName} returned your ${vacationTypeLabel(input.request.vacationType)} request for revision.${input.decisionComment ? ` Reason: ${input.decisionComment}` : ""}`;
  const templated = await raiseApproval({ decision: "returned", module: "leave", step: "returned" }, { via: "durable-email", message: { sender: "templated", input: {
    context: {
      ctaLabel: "Open in Phoenix Workforce",
      ctaUrl: systemDeployment.productionUrl,
      duration: formatDays(input.request.durationDays),
      employeeHrId: input.request.employeeHrId,
      employeeName: input.request.employeeName,
      endDate: formatDate(input.request.endDate),
      managerName: input.managerName,
      recipientName: input.employeeDisplayName ?? input.request.employeeName,
      startDate: formatDate(input.request.startDate),
      requestCode: input.request.requestCode,
      status: "Returned for revision",
      subject: "Vacation request returned for revision",
      summary: input.decisionComment ?? "No reason provided",
      vacationType: vacationTypeLabel(input.request.vacationType),
    },
    employeeHrId: input.request.employeeHrId,
    fallbackTo: [input.employeeEmail],
    overrides: { cc: input.cc, replaceRecipients: true, to: [input.employeeEmail] },
    templateKey: "leave_returned",
  } }, dedupeKey: `vacation:${input.request.id}:returned:${input.employeeEmail.toLowerCase()}` });
  if (!isTemplateUnavailableSkip(templated)) return templated;

  const fallback = buildFallbackEmail({
    heading,
    rows: [
      ["Request code", input.request.requestCode],
      ["Type", vacationTypeLabel(input.request.vacationType)],
      ["Period", `${formatDate(input.request.startDate)} to ${formatDate(input.request.endDate)}`],
      ["Returned by", input.managerName],
      ["Reason", input.decisionComment ?? "No reason provided"],
      ["Action required", "Please review the reason and resubmit your request"],
    ],
    subject: "Vacation request returned for revision",
    title: "Vacation request returned for revision",
  });
  const fallbackKey = `vacation:${input.request.id}:returned:employee:${input.employeeEmail.toLowerCase()}`;
  return raiseApproval({ decision: "returned", module: "leave", step: "returned" }, { via: "durable-email", message: { sender: "phoenix", input: {
    cc: input.cc,
    html: fallback.html,
    idempotencyKey: fallbackKey,
    origin: { employeeHrId: input.request.employeeHrId, eventType: "vacation_returned", module: "vacation" },
    subject: "Vacation request returned for revision",
    text: fallback.text,
    to: [input.employeeEmail],
  } }, dedupeKey: fallbackKey });
}
