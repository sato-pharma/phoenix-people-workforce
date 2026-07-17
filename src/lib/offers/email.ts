import {
  renderOfferLetterEmailHtml,
  renderOfferLetterEmailText,
  type OfferLetterEmailProps,
} from "@/emails/offer-letter";
import { sendTemplatedEmail } from "@/lib/email-templates/service";
import type { OfferTemplate } from "@/lib/offers/templates";

type SendEmailResult =
  | { id?: string; skipped?: false }
  | { reason: string; skipped: true };

export type JobOfferEmailInput = {
  acceptUrl: string;
  actionLinksEnabled?: boolean;
  baseSalary?: number | null;
  basicSalary?: number | null;
  candidateEmail: string;
  candidateName: string;
  declineUrl: string;
  issuedAt?: string | null;
  expiresAt?: string | null;
  jobTitle: string;
  netSalary?: number | null;
  offerCode: string;
  reportingLine?: string | null;
  reportingManager: string;
  reviewUrl?: string | null;
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
    baseSalary: formatCurrencyEGP(input.baseSalary),
    basicSalary: formatCurrencyEGP(input.basicSalary),
    candidateName: input.candidateName,
    declineUrl: input.declineUrl,
    expiresAt: input.expiresAt ? formatDate(input.expiresAt) : null,
    issueDate: formatDate(input.issuedAt),
    jobTitle: input.jobTitle,
    netSalary: formatCurrencyEGP(input.netSalary ?? comp.totalMonthlyPackage),
    offerCode: input.offerCode,
    reportingLine: input.reportingLine || "To be assigned",
    reportingManager: input.reportingManager,
    startDate: formatDate(input.startDate),
    totalMonthlyPackage: formatCurrencyEGP(comp.totalMonthlyPackage),
    territory: input.territoryName || input.territory || "your assigned territory",
    reviewUrl: input.reviewUrl || input.acceptUrl,
  };
}

export function buildOfferEmailHtml(input: JobOfferEmailInput) {
  return renderOfferLetterEmailHtml(offerTemplateProps(input));
}

export function buildOfferEmailText(input: JobOfferEmailInput) {
  return renderOfferLetterEmailText(offerTemplateProps(input));
}

export async function sendJobOfferEmail(input: JobOfferEmailInput): Promise<SendEmailResult> {
  return sendTemplatedEmail({
    candidateEmail: input.candidateEmail,
    context: {
      area: input.territoryName || input.territory || "Assigned territory",
      candidateName: input.candidateName,
      ctaLabel: "Review Offer Details",
      ctaUrl: input.reviewUrl || input.acceptUrl,
      date: input.issuedAt ?? null,
      jobTitle: input.jobTitle,
      line: input.reportingLine || "To be assigned",
      managerName: input.reportingManager,
      recipientName: input.candidateName,
      startDate: formatDate(input.startDate),
      status: `Offer code ${input.offerCode}`,
      subject: `${input.jobTitle} Job Offer`,
      summary: `Offer prepared for ${input.candidateName}.`,
    },
    fallbackTo: [input.candidateEmail],
    from: process.env.JOB_OFFER_EMAIL_FROM || process.env.NOTIFICATION_EMAIL_FROM,
    // Candidate replies to a job offer must reach the HR inbox (a real receiving mailbox),
    // not the outbound sending address. Reply-To needs no SPF/DKIM, so hr@satopharma.com is
    // safe here even though sends go out via the verified send.satopharma.com domain.
    replyTo: process.env.JOB_OFFER_REPLY_TO || "hr@satopharma.com",
    templateKey: "offer",
  });
}
