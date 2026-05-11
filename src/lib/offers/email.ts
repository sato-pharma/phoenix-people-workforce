import {
  renderOfferLetterEmailHtml,
  renderOfferLetterEmailText,
  type OfferLetterEmailProps,
} from "@/emails/offer-letter";
import { sendPhoenixEmail } from "@/lib/email/send-phoenix-email";
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
    totalMonthlyPackage: total,
  };
}

function offerTemplateProps(input: JobOfferEmailInput): OfferLetterEmailProps {
  const comp = compensation(input);

  return {
    acceptUrl: input.acceptUrl,
    actionLinksEnabled: input.actionLinksEnabled ?? true,
    candidateName: input.candidateName,
    declineUrl: input.declineUrl,
    expiresAt: input.expiresAt ? formatDate(input.expiresAt) : null,
    issueDate: formatDate(input.issuedAt),
    jobTitle: input.jobTitle,
    offerCode: input.offerCode,
    reportingLine: input.reportingLine || "To be assigned",
    reportingManager: input.reportingManager,
    startDate: formatDate(input.startDate),
    totalMonthlyPackage: formatCurrencyEGP(comp.totalMonthlyPackage),
    territory: input.territoryName || input.territory || "your assigned territory",
  };
}

export function buildOfferEmailHtml(input: JobOfferEmailInput) {
  return renderOfferLetterEmailHtml(offerTemplateProps(input));
}

export function buildOfferEmailText(input: JobOfferEmailInput) {
  return renderOfferLetterEmailText(offerTemplateProps(input));
}

export async function sendJobOfferEmail(input: JobOfferEmailInput): Promise<SendEmailResult> {
  if (!emailNotificationsEnabled()) {
    return { reason: "EMAIL_NOTIFICATIONS_ENABLED is not true.", skipped: true };
  }

  const from = process.env.JOB_OFFER_EMAIL_FROM || process.env.NOTIFICATION_EMAIL_FROM;
  const subject = `${input.jobTitle} Job Offer`;
  const delivery = await resolveNotificationDelivery({
    candidateEmail: input.candidateEmail,
    notificationType: "offer",
    recipientMode: "candidate",
    subject,
    summary: `Offer prepared for ${input.candidateName}.`,
    title: subject,
  });

  if (!from) return { reason: "JOB_OFFER_EMAIL_FROM or NOTIFICATION_EMAIL_FROM is missing.", skipped: true };
  if (delivery.skipped) return delivery;

  const requestId = `offer-${input.offerCode}-${input.candidateEmail}`.toLowerCase().replace(/[^a-z0-9._-]/g, "-");

  return sendPhoenixEmail({
    from,
    html: buildOfferEmailHtml(input),
    idempotencyKey: requestId,
    subject,
    text: buildOfferEmailText(input),
    to: delivery.recipients,
  });
}
