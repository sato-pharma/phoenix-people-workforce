import type { SendPhoenixEmailResult } from "@/lib/email/send-phoenix-email";
import { sendTemplatedEmail } from "@/lib/email-templates/service";
import {
  vacationTypeLabel,
  vacationUnpaidReasonLabel,
} from "@/lib/vacation/calculations";
import type { VacationDecision, VacationRequestRecord } from "@/lib/vacation/types";

type VacationManagerEmailInput = {
  approveUrl: string;
  managerEmail: string;
  managerName: string;
  policyWarnings?: string[];
  rejectUrl: string;
  request: VacationRequestRecord;
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

export async function sendVacationManagerDecisionEmail(input: VacationManagerEmailInput): Promise<SendPhoenixEmailResult> {
  const policyWarningText = input.policyWarnings?.length
    ? ` Policy review required: ${input.policyWarnings.join(" ")} HR owns the final decision.`
    : " HR owns the final decision after manager review.";

  return sendTemplatedEmail({
    context: {
      approvalFlow: input.request.vacationType === "annual"
        ? "Annual vacation requests require Manager Review followed by HR Final Review."
        : "This vacation request requires manager review and HR final review.",
      ctaLabel: "Review Leave Request",
      ctaUrl: input.approveUrl,
      duration: formatDays(input.request.durationDays),
      employeeHrId: input.request.employeeHrId,
      employeeName: input.request.employeeName,
      endDate: formatDate(input.request.endDate),
      hireDate: input.request.employeeHireDate ? formatDate(input.request.employeeHireDate) : "Not available",
      recipientName: input.managerName || "Manager",
      startDate: formatDate(input.request.startDate),
      status: `Duration: ${formatDays(input.request.durationDays)}. ${formatPaymentStatus(input.request)}.${policyWarningText}`,
      subject: `Vacation request from ${input.request.employeeName}`,
      summary: `${input.request.employeeName} submitted a ${vacationTypeLabel(input.request.vacationType)} request.`,
      vacationBalance: formatDays(input.request.balanceBeforeDays),
      vacationType: vacationTypeLabel(input.request.vacationType),
    },
    employeeHrId: input.request.employeeHrId,
    fallbackTo: [input.managerEmail],
    overrides: { to: [input.managerEmail] },
    templateKey: "leave_request",
  });
}

export async function sendVacationDecisionResultEmail(input: VacationDecisionEmailInput): Promise<SendPhoenixEmailResult> {
  const approved = input.decision === "approve";
  return sendTemplatedEmail({
    context: {
      employeeHrId: input.request.employeeHrId,
      employeeName: input.request.employeeName,
      endDate: formatDate(input.request.endDate),
      recipientName: input.request.employeeName,
      startDate: formatDate(input.request.startDate),
      status: approved
        ? "Your vacation request has been approved by HR final review."
        : `Your vacation request has been rejected by HR final review.${input.request.hrDecisionComment ? ` Reason: ${input.request.hrDecisionComment}` : ""}`,
      subject: `Vacation request ${approved ? "approved" : "rejected"}`,
      vacationType: vacationTypeLabel(input.request.vacationType),
    },
    employeeHrId: input.request.employeeHrId,
    fallbackTo: [input.employeeEmail],
    overrides: { cc: input.cc, to: [input.employeeEmail] },
    templateKey: approved ? "leave_approval" : "leave_rejection",
  });
}
