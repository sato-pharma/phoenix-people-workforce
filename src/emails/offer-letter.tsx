import {
  PhoenixEmailLayout,
  escapeEmailHtml,
  renderEmailParagraphs,
  renderPhoenixEmailHtml,
  renderPhoenixEmailText,
} from "@/emails/phoenix-email-layout";

export type OfferLetterEmailProps = {
  acceptUrl: string;
  actionLinksEnabled?: boolean;
  candidateName: string;
  declineUrl: string;
  expiresAt?: string | null;
  issueDate: string;
  jobTitle: string;
  offerCode: string;
  reportingLine: string;
  reportingManager: string;
  startDate: string;
  totalMonthlyPackage: string;
  territory: string;
};

function offerBodyText(props: OfferLetterEmailProps) {
  return `On behalf of Sato Pharmaceuticals, we are delighted to offer you the ${props.jobTitle} position, reporting to ${props.reportingManager}. You will be assigned to ${props.territory}, with a planned start date of ${props.startDate}.

Please review the offer details below and confirm your decision using the secure action link.`;
}

function offerBodyHtml(props: OfferLetterEmailProps) {
  return `
    ${renderEmailParagraphs(offerBodyText(props))}
    ${
      props.expiresAt
        ? `<div style="margin:18px 0 0;border:1px solid #fed7aa;background:#fff7ed;color:#9a3412;border-radius:12px;padding:12px 14px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.55;font-weight:700">
            This secure offer link expires on ${escapeEmailHtml(props.expiresAt)}. Please confirm your decision before then.
          </div>`
        : ""
    }`;
}

function metadataRows(props: OfferLetterEmailProps) {
  return [
    { label: "Offer ID", value: props.offerCode },
    { label: "Job Title", value: props.jobTitle },
    { label: "Line", value: props.reportingLine },
    { label: "Area", value: props.territory },
    { label: "Direct Manager", value: props.reportingManager },
    { label: "Start Date", value: props.startDate },
    { label: "Total Monthly Package", value: props.totalMonthlyPackage },
    { label: "Issued Date", value: props.issueDate },
  ];
}

export function OfferLetterEmail(props: OfferLetterEmailProps) {
  return (
    <PhoenixEmailLayout
      action={props.actionLinksEnabled === false ? undefined : { href: props.acceptUrl, label: "Accept & Join Sato" }}
      bodyHtml={offerBodyHtml(props)}
      greeting={`Dear ${props.candidateName},`}
      metadataRows={metadataRows(props)}
      previewText={`Official ${props.jobTitle} offer from Phoenix Workforce.`}
      subject={`${props.jobTitle} Job Offer`}
      title={`${props.jobTitle} Job Offer`}
    />
  );
}

export function renderOfferLetterEmailHtml(props: OfferLetterEmailProps) {
  return renderPhoenixEmailHtml({
    action: props.actionLinksEnabled === false ? undefined : { href: props.acceptUrl, label: "Accept & Join Sato" },
    bodyHtml: offerBodyHtml(props),
    closingText: "You can contact HR for any clarification before making your decision.",
    greeting: `Dear ${props.candidateName},`,
    metadataRows: metadataRows(props),
    previewText: `Official ${props.jobTitle} offer from Phoenix Workforce.`,
    subject: `${props.jobTitle} Job Offer`,
    title: `${props.jobTitle} Job Offer`,
  });
}

export function renderOfferLetterEmailText(props: OfferLetterEmailProps) {
  return renderPhoenixEmailText({
    action: props.actionLinksEnabled === false ? undefined : { href: props.acceptUrl, label: "Accept & Join Sato" },
    bodyText: [
      offerBodyText(props),
      "",
      props.actionLinksEnabled === false ? "Offer action links are inactive in local test mode." : `Decline Offer: ${props.declineUrl}`,
    ].join("\n"),
    closingText: "You can contact HR for any clarification before making your decision.",
    greeting: `Dear ${props.candidateName},`,
    metadataRows: metadataRows(props),
    title: `${props.jobTitle} Job Offer`,
  });
}
