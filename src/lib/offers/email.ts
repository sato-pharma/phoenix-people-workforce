import { emailNotificationsEnabled, resolveNotificationDelivery } from "@/lib/notifications/email";
import type { OfferTemplate } from "@/lib/offers/templates";

type SendEmailResult =
  | { id?: string; skipped?: false }
  | { reason: string; skipped: true };

export type JobOfferEmailInput = {
  acceptUrl: string;
  actionLinksEnabled?: boolean;
  candidateEmail: string;
  candidateName: string;
  declineUrl: string;
  issuedAt?: string | null;
  expiresAt?: string | null;
  jobTitle: string;
  offerCode: string;
  reportingLine?: string | null;
  reportingManager: string;
  salaryAmount?: number | null;
  startDate?: string | null;
  template?: OfferTemplate | null;
  territory?: string | null;
  territoryName?: string | null;
};

const resendEndpoint = "https://api.resend.com/emails";

function escapeHtml(value: string | number | null | undefined) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatCurrencyEGP(value: number | null | undefined) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(Number(value)) ? Number(value) : 0);
}

export function formatDate(value: string | null | undefined) {
  if (!value) return "To be confirmed";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(date);
}

function compensation(input: JobOfferEmailInput) {
  const total = input.salaryAmount ?? input.template?.monthlyPackage ?? 0;

  return {
    basicSalary: input.template?.basicSalary ?? total,
    costOfLivingAllowance: input.template?.costOfLivingAllowance ?? 0,
    totalMonthlyPackage: total,
    transportationAllowance:
      input.template?.transportationAllowance ??
      input.template?.internalTransportationAllowance ??
      0,
  };
}

function paragraph(text: string) {
  return `<p style="margin:0;color:#334155;font-size:15px;line-height:1.7">${text}</p>`;
}

function sectionTitle(title: string) {
  return `<h2 style="margin:0 0 12px;color:#0f172a;font-size:16px;line-height:1.3;font-weight:800">${escapeHtml(title)}</h2>`;
}

function bulletList(items: string[]) {
  return `
    <ul style="margin:0;padding:0 0 0 18px;color:#334155;font-size:14px;line-height:1.75">
      ${items.map((item) => `<li style="margin:0 0 6px">${escapeHtml(item)}</li>`).join("")}
    </ul>`;
}

function legalCard(icon: string, title: string, items: string[]) {
  return `
    <div style="margin-top:12px;border:1px solid #f1f5f9;background:#fbfdff;border-radius:12px;padding:14px 16px">
      <div style="font-weight:800;margin:0 0 8px;color:#0f172a;font-size:14px">${escapeHtml(icon)} ${escapeHtml(title)}</div>
      <ul style="margin:0;padding:0 0 0 18px;color:#334155;font-size:13px;line-height:1.65">
        ${items.map((item) => `<li style="margin:0 0 6px">${escapeHtml(item)}</li>`).join("")}
      </ul>
    </div>`;
}

export function buildOfferEmailHtml(input: JobOfferEmailInput) {
  const comp = compensation(input);
  const actionLinksEnabled = input.actionLinksEnabled ?? true;
  const title = `${input.jobTitle} Job Offer`;
  const territory = input.territoryName || input.territory || "your assigned territory";
  const lineName = input.reportingLine || "To be assigned";
  const issueDate = formatDate(input.issuedAt);
  const expiry = input.expiresAt
    ? `<div style="margin:18px 0 0;border:1px solid #fed7aa;background:#fff7ed;color:#9a3412;border-radius:12px;padding:12px 14px;font-size:13px;line-height:1.55;font-weight:700">
        This secure offer link expires on ${escapeHtml(formatDate(input.expiresAt))}. Please confirm your decision before then.
      </div>`
    : "";

  const roleSummary = `
    <div style="margin-top:22px;border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc;padding:16px">
      ${sectionTitle("Role Overview")}
      <table style="width:100%;border-collapse:collapse;font-size:14px;color:#0f172a">
        <tr>
          <td style="padding:6px 0;color:#64748b;width:135px">Job Title</td>
          <td style="padding:6px 0;font-weight:700">${escapeHtml(input.jobTitle)}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;color:#64748b">Line</td>
          <td style="padding:6px 0;font-weight:700">${escapeHtml(lineName)}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;color:#64748b">Area</td>
          <td style="padding:6px 0;font-weight:700">${escapeHtml(territory)}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;color:#64748b">Direct Manager</td>
          <td style="padding:6px 0;font-weight:700">${escapeHtml(input.reportingManager)}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;color:#64748b">Start Date</td>
          <td style="padding:6px 0;font-weight:700">${escapeHtml(formatDate(input.startDate))}</td>
        </tr>
      </table>
      <p style="margin:12px 0 0;color:#64748b;font-size:13px;line-height:1.6">
        This package represents your fixed monthly compensation excluding incentives.
      </p>
    </div>`;

  const legalBlocks = legalCard("⏳", "Probation", [
    "Your probation period will be three months from your start date.",
    "A formal performance review will be conducted at the end of the probation period.",
    "The company reserves the right to terminate during probation according to company policy and applicable law.",
  ])
    .concat(legalCard("📅", "Annual Leave", [
      "You will be entitled to annual leave according to Egyptian labor law.",
      "Official national holidays will apply according to company policy.",
    ]))
    .concat(
      legalCard("📄", "Contract Duration", [
        "This contract is valid for one year.",
        "It is renewable based on mutual agreement.",
        "Either party may terminate with one-month prior written notice, subject to company policy and applicable law.",
      ]),
    )
    .concat(
      legalCard("🔒", "Confidentiality", [
        "You must keep all company information confidential, including trade secrets, trademarks, and proprietary data.",
      ]),
    );

  return `<!doctype html>
<html>
  <body style="margin:0;background:#f3f4f6;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
    <div style="max-width:640px;margin:0 auto">
      <div style="overflow:hidden;border:1px solid #e5e7eb;border-radius:18px;background:#ffffff;box-shadow:0 20px 48px rgba(15,23,42,0.10)">
        <div style="background:#070b12;padding:26px 28px;color:#ffffff">
          <div style="font-size:11px;letter-spacing:0.24em;font-weight:800;color:#fb923c;text-transform:uppercase">Phoenix Workforce HR System</div>
          <h1 style="margin:12px 0 0;font-size:24px;line-height:1.25;font-weight:900;color:#ffffff">${escapeHtml(title)}</h1>
          <p style="margin:14px 0 0;color:#e2e8f0;font-size:15px;line-height:1.6">Dear ${escapeHtml(input.candidateName)},</p>
        </div>

        <div style="padding:26px 28px">
          ${paragraph(
            `On behalf of Sato Pharmaceuticals, we are delighted to offer you the ${input.jobTitle} position, reporting to ${input.reportingManager}. You will be assigned to ${territory}, with a planned start date of ${formatDate(input.startDate)}.`,
          )}
          <div style="margin-top:14px;display:flex;gap:8px;align-items:center">
            <span style="display:inline-block;background:#0f766e;color:#ecfeff;padding:6px 10px;border-radius:999px;font-size:12px;font-weight:700">Step 1: Review</span>
            <span style="display:inline-block;background:#f8fafc;color:#64748b;padding:6px 10px;border-radius:999px;font-size:12px;font-weight:700">Step 2: Accept</span>
          </div>
          ${expiry}
          ${roleSummary}

          <div style="margin-top:26px">
            ${sectionTitle("Compensation")}
            <table style="width:100%;border-collapse:separate;border-spacing:0;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;font-size:14px">
              <tr>
                <td style="padding:13px 16px;background:#f8fafc;border-bottom:1px solid #e5e7eb;color:#475569;font-weight:700">Basic Salary</td>
                <td style="padding:13px 16px;background:#f8fafc;border-bottom:1px solid #e5e7eb;color:#0f172a;font-weight:800;text-align:right">${formatCurrencyEGP(comp.basicSalary)}</td>
              </tr>
              <tr>
                <td style="padding:13px 16px;border-bottom:1px solid #e5e7eb;color:#475569;font-weight:700">Transportation Allowance</td>
                <td style="padding:13px 16px;border-bottom:1px solid #e5e7eb;color:#0f172a;font-weight:800;text-align:right">${formatCurrencyEGP(comp.transportationAllowance)}</td>
              </tr>
              <tr>
                <td style="padding:13px 16px;background:#f8fafc;border-bottom:1px solid #e5e7eb;color:#475569;font-weight:700">Cost of Living Allowance</td>
                <td style="padding:13px 16px;background:#f8fafc;border-bottom:1px solid #e5e7eb;color:#0f172a;font-weight:800;text-align:right">${formatCurrencyEGP(comp.costOfLivingAllowance)}</td>
              </tr>
              <tr>
                <td style="padding:15px 16px;background:#fff7ed;color:#9a3412;font-size:16px;font-weight:900">Total Monthly Package</td>
                <td style="padding:15px 16px;background:#fff7ed;color:#9a3412;font-size:18px;font-weight:900;text-align:right">${formatCurrencyEGP(comp.totalMonthlyPackage)}</td>
              </tr>
            </table>
          </div>

          <div style="margin-top:22px">
            ${sectionTitle("🌟 Why Join Sato Pharma?")}
            ${bulletList([
              "Fast-growing pharmaceutical organization",
              "Structured career path in Medical Sales",
              "Continuous training and development programs",
              "Exposure to leading product lines",
            ])}
          </div>

          <div style="margin-top:26px">${sectionTitle("Incentive & Other Benefits")}${bulletList([
            "Eligibility for a performance-based incentive according to company policy.",
            "Private medical insurance according to the company executive medical scheme.",
            "Social insurance coverage according to local regulations.",
            "Business travel and related expenses according to company policy.",
          ])}</div>

          ${legalBlocks}

          <div style="margin-top:26px;border-top:1px solid #e5e7eb;padding-top:22px">
            <p style="margin:0 0 12px;color:#334155;font-size:14px;line-height:1.6">
              You can contact HR for any clarification before making your decision.
            </p>
            <p style="margin:0 0 14px;color:#334155;font-size:14px;line-height:1.6">
              For any questions, please contact: <strong>HR Team – hr@satopharma.com</strong>
            </p>
            ${paragraph(
              actionLinksEnabled
                ? "To confirm your acceptance of this offer, please click the Accept & Join Sato button below."
                : "The offer action buttons are shown for local testing and will be activated after deployment.",
            )}
            <div style="margin-top:18px">
              ${
                actionLinksEnabled
                  ? `<a href="${escapeHtml(input.acceptUrl)}" style="display:inline-block;margin:0 10px 10px 0;border-radius:12px;background:#ea580c;color:#ffffff;font-size:14px;font-weight:800;text-decoration:none;padding:13px 20px;box-shadow:0 8px 16px rgba(234,88,12,0.25)">Accept & Join Sato</a>
              <a href="${escapeHtml(input.declineUrl)}" style="display:inline-block;margin:0 0 10px;border:1px solid #ef4444;border-radius:12px;background:#ffffff;color:#b91c1c;font-size:14px;font-weight:800;text-decoration:none;padding:12px 19px">Decline Offer</a>`
                  : `<span style="display:inline-block;margin:0 10px 10px 0;border-radius:12px;background:#ea580c;color:#ffffff;font-size:14px;font-weight:800;text-decoration:none;padding:13px 20px">Accept & Join Sato</span>
              <span style="display:inline-block;margin:0 0 10px;border:1px solid #ef4444;border-radius:12px;background:#ffffff;color:#b91c1c;font-size:14px;font-weight:800;text-decoration:none;padding:12px 19px">Decline Offer</span>`
              }
            </div>
          </div>
        </div>

        <div style="border-top:1px solid #e5e7eb;background:#f8fafc;padding:16px 28px;color:#64748b;font-size:12px;line-height:1.6">
          Offer ID: ${escapeHtml(input.offerCode)}<br />
          Issued Date: ${escapeHtml(issueDate)}<br />
          This is a system-generated official offer via Phoenix Workforce.<br />
          ${
            actionLinksEnabled
              ? "This is a secure offer link. Please use it only to accept or decline your offer."
              : "Secure offer links will be active after deployment."
          }
        </div>
      </div>
    </div>
  </body>
</html>`;
}

export function buildOfferEmailText(input: JobOfferEmailInput) {
  const comp = compensation(input);
  const actionLinksEnabled = input.actionLinksEnabled ?? true;
  const territory = input.territoryName || input.territory || "your assigned territory";
  const issueDate = formatDate(input.issuedAt);

  return [
    "Phoenix Workforce HR System",
    `${input.jobTitle} Job Offer`,
    "",
    `Dear ${input.candidateName},`,
    "",
    "Role Overview",
    `Job Title: ${input.jobTitle}`,
    `Line: ${input.reportingLine || "To be assigned"}`,
    `Area: ${territory}`,
    `Direct Manager: ${input.reportingManager}`,
    `Start Date: ${formatDate(input.startDate)}`,
    "",
    `On behalf of Sato Pharmaceuticals, we are delighted to offer you the ${input.jobTitle} position, reporting to ${input.reportingManager}. You will be assigned to ${territory}, with a planned start date of ${formatDate(input.startDate)}.`,
    "This package represents your fixed monthly compensation excluding incentives.",
    input.expiresAt ? `This secure offer link expires on ${formatDate(input.expiresAt)}.` : "",
    input.expiresAt ? "To confirm your acceptance of this offer, please click the Accept & Join Sato button below." : "",
    "",
    "🌟 Why Join Sato Pharma?",
    "- Fast-growing pharmaceutical organization",
    "- Structured career path in Medical Sales",
    "- Continuous training and development programs",
    "- Exposure to leading product lines",
    "",
    "Compensation",
    `Basic Salary: ${formatCurrencyEGP(comp.basicSalary)}`,
    `Transportation Allowance: ${formatCurrencyEGP(comp.transportationAllowance)}`,
    `Cost of Living Allowance: ${formatCurrencyEGP(comp.costOfLivingAllowance)}`,
    `Total Monthly Package: ${formatCurrencyEGP(comp.totalMonthlyPackage)}`,
    "",
    "Incentive & Other Benefits",
    "- Performance-based incentive according to company policy.",
    "- Private medical insurance according to the company executive medical scheme.",
    "- Social insurance according to local regulations.",
    "- Business travel and related expenses according to company policy.",
    "",
    "⏳ Probation",
    "- Three months from start date.",
    "- Formal performance review at the end of probation.",
    "- The company reserves the right to terminate during probation according to company policy and applicable law.",
    "",
    "📅 Annual Leave",
    "- Annual leave according to Egyptian labor law.",
    "- Official national holidays according to company policy.",
    "",
    "📄 Contract Duration",
    "- This contract is valid for one year.",
    "- Renewable based on mutual agreement.",
    "- Either party may terminate with one-month prior written notice, subject to policy and law.",
    "",
    "🔒 Confidentiality",
    "- You must keep company information, trade secrets, trademarks, and proprietary data confidential.",
    "",
    "You can contact HR for any clarification before making your decision.",
    "For any questions, please contact: HR Team – hr@satopharma.com",
    "",
    actionLinksEnabled
      ? "To confirm your acceptance of this offer, please click the Accept button below."
      : "The offer action buttons are shown for local testing and will be activated after deployment.",
    actionLinksEnabled ? `Accept & Join Sato: ${input.acceptUrl}` : "Accept & Join Sato: inactive in local test mode",
    actionLinksEnabled ? `Decline Offer: ${input.declineUrl}` : "Decline Offer: inactive in local test mode",
    "",
    `Offer ID: ${input.offerCode}`,
    `Issued Date: ${issueDate}`,
    "This is a system-generated official offer via Phoenix Workforce.",
    actionLinksEnabled
      ? "This is a secure offer link. Please use it only to accept or decline your offer."
      : "Secure offer links will be active after deployment.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function sendJobOfferEmail(input: JobOfferEmailInput): Promise<SendEmailResult> {
  if (!emailNotificationsEnabled()) {
    return { reason: "EMAIL_NOTIFICATIONS_ENABLED is not true.", skipped: true };
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.JOB_OFFER_EMAIL_FROM || process.env.NOTIFICATION_EMAIL_FROM;
  const delivery = await resolveNotificationDelivery({
    candidateEmail: input.candidateEmail,
    notificationType: "offer",
    recipientMode: "candidate",
    subject: `${input.jobTitle} Job Offer`,
    summary: `Offer prepared for ${input.candidateName}.`,
    title: `${input.jobTitle} Job Offer`,
  });

  if (!apiKey) return { reason: "RESEND_API_KEY is missing.", skipped: true };
  if (!from) return { reason: "JOB_OFFER_EMAIL_FROM or NOTIFICATION_EMAIL_FROM is missing.", skipped: true };
  if (delivery.skipped) return delivery;

  const requestId = `offer-${input.offerCode}-${input.candidateEmail}`.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  const response = await fetch(resendEndpoint, {
    body: JSON.stringify({
      from,
      html: buildOfferEmailHtml(input),
      replyTo: process.env.NOTIFICATION_REPLY_TO || undefined,
      subject: `${input.jobTitle} Job Offer`,
      text: buildOfferEmailText(input),
      to: delivery.recipients,
    }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": requestId,
    },
    method: "POST",
  });

  const payload = (await response.json().catch(() => null)) as { error?: string; id?: string; message?: string } | null;

  if (!response.ok) {
    throw new Error(payload?.message ?? payload?.error ?? `Resend request failed with ${response.status}.`);
  }

  if (!payload?.id) {
    throw new Error("Resend accepted the request without returning a message id.");
  }

  return { id: payload.id, skipped: false };
}
