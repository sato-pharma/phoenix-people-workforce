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
  return sendTemplatedEmail({
    context: {
      ctaLabel: "Review Leave Request",
      ctaUrl: input.approveUrl,
      employeeHrId: input.request.employeeHrId,
      employeeName: input.request.employeeName,
      endDate: formatDate(input.request.endDate),
      recipientName: input.managerName || "Manager",
      startDate: formatDate(input.request.startDate),
      status: `Duration: ${formatDays(input.request.durationDays)}. Payment status: ${input.request.paymentStatus}${input.request.unpaidReason ? ` (${vacationUnpaidReasonLabel(input.request.unpaidReason)})` : ""}.`,
      subject: `Vacation request from ${input.request.employeeName}`,
      summary: `${input.request.employeeName} submitted a ${vacationTypeLabel(input.request.vacationType)} request.`,
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
        ? "Your vacation request has been approved by your direct manager."
        : `Your vacation request has been rejected by your direct manager.${input.request.managerDecisionComment ? ` Reason: ${input.request.managerDecisionComment}` : ""}`,
      subject: `Vacation request ${approved ? "approved" : "rejected"}`,
      vacationType: vacationTypeLabel(input.request.vacationType),
    },
    employeeHrId: input.request.employeeHrId,
    fallbackTo: [input.employeeEmail],
    overrides: { cc: input.cc, to: [input.employeeEmail] },
    templateKey: approved ? "leave_approval" : "leave_rejection",
  });
}
