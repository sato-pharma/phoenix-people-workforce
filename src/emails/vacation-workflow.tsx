import {
  PhoenixEmailMetadataRow,
  escapeEmailHtml,
  renderEmailParagraphs,
  renderPhoenixEmailHtml,
  renderPhoenixEmailText,
} from "@/emails/phoenix-email-layout";
import type { VacationRequestRecord } from "@/lib/leave/requests";

export type VacationWorkflowDecision = "approve" | "reject";
export type VacationWorkflowRequest = VacationRequestRecord & {
  reason: string;
};

function toAbsoluteUrl(baseUrl: string, path: string) {
  if (/^https?:\/\//i.test(path)) return path;
  if (!baseUrl) return path;
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function formatDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "N/A";
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function metadataRows(request: VacationWorkflowRequest) {
  return [
    { label: "Request ID", value: request.id },
    { label: "Employee Name", value: request.employeeName },
    { label: "Employee HR ID", value: request.employeeId || "N/A" },
    { label: "Employee Email", value: request.employeeEmail || "N/A" },
    { label: "Vacation Type", value: request.requestType },
    { label: "Day Type", value: request.dayType },
    { label: "Start Date", value: formatDate(request.startDate) },
    { label: "End Date", value: formatDate(request.endDate) },
    { label: "Calculated Duration", value: `${request.totalDays.toFixed(2)} day(s)` },
    { label: "Half-Day Impact", value: `${request.halfDayImpact.toFixed(2)} day(s)` },
    { label: "Payment Status", value: request.paymentStatus },
    { label: "Available Balance", value: `${request.availableBalanceAtSubmission.toFixed(2)} day(s)` },
    { label: "Current Annual Entitlement", value: `${request.currentAnnualEntitlementAtSubmission.toFixed(2)} day(s)` },
    { label: "First-Year Entitlement", value: `${request.firstYearEntitlementAtSubmission.toFixed(2)} day(s)` },
    { label: "Used Paid Leave", value: `${request.usedPaidLeaveAtSubmission.toFixed(2)} day(s)` },
    { label: "Remaining Paid Balance", value: `${request.remainingPaidBalanceAtSubmission.toFixed(2)} day(s)` },
    { label: "Unpaid Leave Days", value: `${request.unpaidLeaveDaysAtSubmission.toFixed(2)} day(s)` },
    { label: "Pending Leave Impact", value: `${request.pendingLeaveImpactAtSubmission.toFixed(2)} day(s)` },
    { label: "Hiring Date", value: formatDate(request.employeeHireDate) },
    { label: "Reason", value: request.reason || "No reason provided." },
  ];
}

function formatBodyWithButtons(props: { approveUrl: string; request: VacationWorkflowRequest; rejectUrl: string }) {
  return `
    ${renderEmailParagraphs(
      `A new ${props.request.requestType} request from ${props.request.employeeName} is waiting for your approval. Please review the leave details below and use the secure decision links or open the leave dashboard.`,
    )}
    <div style="margin:18px 0 0;border:1px solid #fed7aa;background:#fff7ed;color:#9a3412;border-radius:12px;padding:12px 14px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.55;font-weight:700">
      Decision required: approve or reject this leave request from the links below.
    </div>
    <div style="margin:18px 0 0;padding:4px 0 0">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse">
        <tr>
          <td style="padding-right:8px;width:50%">
            <a href="${escapeEmailHtml(props.approveUrl)}" style="display:block;text-align:center;background:#0f766e;border:1px solid #14b8a6;color:#ffffff;text-decoration:none;padding:12px 16px;border-radius:10px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:900">Approve</a>
          </td>
          <td style="width:50%">
            <a href="${escapeEmailHtml(props.rejectUrl)}" style="display:block;text-align:center;background:#ffffff;border:1px solid #c2410c;color:#991b1b;text-decoration:none;padding:12px 16px;border-radius:10px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:900">Reject</a>
          </td>
        </tr>
      </table>
    </div>`;
}

function buildManagerDecisionUrls(baseUrl: string, requestId: string, reportPath: string) {
  const encodedId = encodeURIComponent(requestId);
  return {
    approveUrl: toAbsoluteUrl(baseUrl, `${reportPath}?requestId=${encodedId}&decision=approve`),
    rejectUrl: toAbsoluteUrl(baseUrl, `${reportPath}?requestId=${encodedId}&decision=reject`),
    dashboardUrl: toAbsoluteUrl(baseUrl, reportPath),
  };
}

export function buildVacationManagerApprovalEmailHtml(input: {
  actorName?: string;
  baseUrl: string;
  request: VacationWorkflowRequest;
  reportPath?: string;
}) {
  const actorName = input.actorName?.trim() || "Direct Manager";
  const reportPath = input.reportPath || "/vacation-report";
  const { approveUrl, rejectUrl, dashboardUrl } = buildManagerDecisionUrls(input.baseUrl, input.request.id, reportPath);

  return renderPhoenixEmailHtml({
    action: {
      href: dashboardUrl,
      label: "Open Vacation Report",
      tone: "secondary",
    },
    bodyHtml: formatBodyWithButtons({ approveUrl, rejectUrl, request: input.request }),
    closingText: "Thank you for handling this vacation request promptly.",
    greeting: `Dear ${actorName},`,
    metadataRows: metadataRows(input.request) as PhoenixEmailMetadataRow[],
    previewText: `Vacation approval required for ${input.request.employeeName}.`,
    subject: "Phoenix Vacation Request Approval Required",
    title: "Vacation Approval Required",
  });
}

export function buildVacationManagerApprovalEmailText(input: {
  actorName?: string;
  baseUrl: string;
  request: VacationWorkflowRequest;
  reportPath?: string;
}) {
  const actorName = input.actorName?.trim() || "Direct Manager";
  const reportPath = input.reportPath || "/vacation-report";
  const { approveUrl, rejectUrl, dashboardUrl } = buildManagerDecisionUrls(input.baseUrl, input.request.id, reportPath);
  const requestLines = metadataRows(input.request)
    .map((item) => `${item.label}: ${item.value}`)
    .join("\n");

  return renderPhoenixEmailText({
    action: {
      href: dashboardUrl,
      label: "Open Vacation Report",
    },
    bodyText: [
      `A new ${input.request.requestType} request from ${input.request.employeeName} is waiting for your approval.`,
      "",
      `Approve: ${approveUrl}`,
      `Reject: ${rejectUrl}`,
      `Open Dashboard: ${dashboardUrl}`,
    ].join("\n"),
    closingText: "Thank you for handling this vacation request promptly.",
    greeting: `Dear ${actorName},`,
    metadataRows: metadataRows(input.request) as PhoenixEmailMetadataRow[],
    title: "Vacation Approval Required",
  });
}

function buildDecisionMessage(decision: VacationWorkflowDecision) {
  return decision === "approve"
    ? "Your vacation request has been approved. Please review details in your dashboard."
    : "Your vacation request has been rejected. Please review details in your dashboard.";
}

export function buildVacationDecisionEmailHtml(input: {
  actorName?: string;
  baseUrl: string;
  decision: VacationWorkflowDecision;
  request: VacationWorkflowRequest;
  reportPath?: string;
}) {
  const actorName = input.actorName?.trim() || "Team Member";
  const reportPath = input.reportPath || "/vacation-report";
  const dashboardUrl = toAbsoluteUrl(input.baseUrl, reportPath);
  const statusText = input.decision === "approve" ? "Approved" : "Rejected";

  return renderPhoenixEmailHtml({
    action: {
      href: dashboardUrl,
      label: "Open Vacation Report",
      tone: input.decision === "approve" ? "secondary" : "danger",
    },
    bodyHtml: `
      ${renderEmailParagraphs(`${actorName}, your vacation request status is now ${statusText}.`)}
      ${renderEmailParagraphs(buildDecisionMessage(input.decision))}
      <div style="margin:18px 0 0;border:1px solid ${input.decision === "approve" ? "#bbf7d0" : "#fecaca"};background:${input.decision === "approve" ? "#f0fdf4" : "#fff1f2"};color:${input.decision === "approve" ? "#166534" : "#9f1239"};border-radius:12px;padding:12px 14px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.55;font-weight:700">
        Current status: ${escapeEmailHtml(statusText)}.
      </div>
    `,
    closingText: "Thank you for keeping your leave records up to date.",
    greeting: `Dear ${actorName},`,
    metadataRows: metadataRows(input.request) as PhoenixEmailMetadataRow[],
    previewText: `Vacation request ${statusText}: ${input.request.employeeName}`,
    subject: `Phoenix Vacation Request ${statusText} - ${input.request.employeeName}`,
    title: `Vacation Request ${statusText}`,
  });
}

export function buildVacationDecisionEmailText(input: {
  actorName?: string;
  baseUrl: string;
  decision: VacationWorkflowDecision;
  request: VacationWorkflowRequest;
  reportPath?: string;
}) {
  const actorName = input.actorName?.trim() || "Team Member";
  const reportPath = input.reportPath || "/vacation-report";
  const statusText = input.decision === "approve" ? "Approved" : "Rejected";
  const details = metadataRows(input.request)
    .map((item) => `${item.label}: ${item.value}`)
    .join("\n");

  return renderPhoenixEmailText({
    action: {
      href: toAbsoluteUrl(input.baseUrl, reportPath),
      label: "Open Vacation Report",
    },
    bodyText: [
      `${actorName}, your vacation request status is now ${statusText.toLowerCase()}.`,
      "",
      details,
      "",
      `Open Dashboard: ${toAbsoluteUrl(input.baseUrl, reportPath)}`,
    ].join("\n"),
    closingText: "Thank you for keeping your leave records up to date.",
    greeting: `Dear ${actorName},`,
    metadataRows: metadataRows(input.request) as PhoenixEmailMetadataRow[],
    title: `Vacation Request ${statusText}`,
  });
}
