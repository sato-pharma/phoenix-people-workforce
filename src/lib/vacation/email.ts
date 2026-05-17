import {
  escapeEmailHtml,
  renderEmailParagraphs,
  renderPhoenixEmailHtml,
  renderPhoenixEmailText,
  type PhoenixEmailMetadataRow,
} from "@/emails/phoenix-email-layout";
import { sendPhoenixEmail, type SendPhoenixEmailResult } from "@/lib/email/send-phoenix-email";
import {
  vacationDayPartLabel,
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

function requestMetadata(request: VacationRequestRecord): PhoenixEmailMetadataRow[] {
  return [
    { label: "Employee", value: `${request.employeeName} (${request.employeeHrId})` },
    { label: "Vacation Type", value: vacationTypeLabel(request.vacationType) },
    { label: "Day Part", value: vacationDayPartLabel(request.dayPart) },
    { label: "Start Date", value: formatDate(request.startDate) },
    { label: "End Date", value: formatDate(request.endDate) },
    { label: "Duration", value: formatDays(request.durationDays) },
    { label: "Payment", value: request.paymentStatus === "paid" ? "Paid" : "Unpaid" },
    {
      label: "Unpaid Reason",
      value: request.unpaidReason ? vacationUnpaidReasonLabel(request.unpaidReason) : null,
    },
    { label: "Balance Before", value: formatDays(request.balanceBeforeDays) },
    { label: "Balance After", value: formatDays(request.balanceAfterDays) },
  ];
}

function renderActionButtons(input: { approveUrl: string; rejectUrl: string }) {
  const buttonBase =
    "display:inline-block;border:1px solid;border-radius:12px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:900;line-height:1.2;text-decoration:none;padding:12px 18px";

  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:22px;border-collapse:collapse">
      <tr>
        <td style="padding-right:10px">
          <a href="${escapeEmailHtml(input.approveUrl)}" style="${buttonBase};border-color:#bbf7d0;background:#ecfdf5;color:#047857">Approve</a>
        </td>
        <td>
          <a href="${escapeEmailHtml(input.rejectUrl)}" style="${buttonBase};border-color:#fecaca;background:#fff1f2;color:#be123c">Reject</a>
        </td>
      </tr>
    </table>`;
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
  const subject = `Vacation request from ${input.request.employeeName}`;
  const bodyText = [
    `${input.request.employeeName} submitted a ${vacationTypeLabel(input.request.vacationType)} request.`,
    `Duration: ${formatDays(input.request.durationDays)} from ${formatDate(input.request.startDate)} to ${formatDate(input.request.endDate)}.`,
    `Payment status: ${input.request.paymentStatus}${input.request.unpaidReason ? ` (${vacationUnpaidReasonLabel(input.request.unpaidReason)})` : ""}.`,
    "Use the approval buttons below to complete the manager decision.",
  ].join("\n\n");

  const html = renderPhoenixEmailHtml({
    bodyHtml: `${renderEmailParagraphs(bodyText)}${renderActionButtons(input)}`,
    greeting: `Dear ${input.managerName || "Manager"},`,
    metadataRows: requestMetadata(input.request),
    previewText: `${input.request.employeeName} is waiting for your vacation decision.`,
    subject,
    subtitle: "Direct manager action required.",
    title: "Vacation Request Approval",
  });

  const text = renderPhoenixEmailText({
    bodyText: `${bodyText}\n\nApprove: ${input.approveUrl}\nReject: ${input.rejectUrl}`,
    greeting: `Dear ${input.managerName || "Manager"},`,
    metadataRows: requestMetadata(input.request),
    title: "Vacation Request Approval",
  });

  return sendPhoenixEmail({
    html,
    idempotencyKey: `vacation-manager-${input.request.id}`,
    subject,
    text,
    to: [input.managerEmail],
  });
}

export async function sendVacationDecisionResultEmail(input: VacationDecisionEmailInput): Promise<SendPhoenixEmailResult> {
  const approved = input.decision === "approve";
  const subject = `Vacation request ${approved ? "approved" : "rejected"}`;
  const bodyText = approved
    ? "Your vacation request has been approved by your direct manager."
    : `Your vacation request has been rejected by your direct manager.${input.request.managerDecisionComment ? `\n\nReason: ${input.request.managerDecisionComment}` : ""}`;

  const html = renderPhoenixEmailHtml({
    bodyHtml: renderEmailParagraphs(bodyText),
    greeting: `Dear ${input.request.employeeName},`,
    metadataRows: requestMetadata(input.request),
    previewText: subject,
    subject,
    subtitle: "Manager decision completed.",
    title: subject,
  });

  const text = renderPhoenixEmailText({
    bodyText,
    greeting: `Dear ${input.request.employeeName},`,
    metadataRows: requestMetadata(input.request),
    title: subject,
  });

  return sendPhoenixEmail({
    cc: input.cc,
    html,
    idempotencyKey: `vacation-decision-${input.request.id}-${input.decision}`,
    subject,
    text,
    to: [input.employeeEmail],
  });
}
