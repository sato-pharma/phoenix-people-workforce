import {
  PhoenixEmailLayout,
  renderEmailParagraphs,
  renderPhoenixEmailHtml,
  renderPhoenixEmailText,
} from "@/emails/phoenix-email-layout";

export type OfferLetterEmailProps = {
  acceptUrl: string;
  actionLinksEnabled?: boolean;
  baseSalary: string;
  basicSalary: string;
  candidateName: string;
  declineUrl: string;
  expiresAt?: string | null;
  issueDate: string;
  jobTitle: string;
  netSalary: string;
  offerCode: string;
  reportingLine: string;
  reportingManager: string;
  reviewUrl: string;
  startDate: string;
  totalMonthlyPackage: string;
  territory: string;
};

function offerBodyText(props: OfferLetterEmailProps) {
  return `On behalf of Sato Pharmaceuticals, we are delighted to offer you the ${props.jobTitle} position, reporting to ${props.reportingManager}. You will be assigned to ${props.territory}, with a planned start date of ${props.startDate}.

Please review the offer details below. If you are interested, use the secure review button to open your detailed offer page and choose your response there.`;
}

function offerBodyHtml(props: OfferLetterEmailProps) {
  // Expiry is surfaced as a dedicated "Offer Expires" row in the details table below, so no
  // separate callout box here (a light inline box also renders low-contrast in dark clients).
  return renderEmailParagraphs(offerBodyText(props));
}

function metadataRows(props: OfferLetterEmailProps) {
  // Deliberately NO salary rows in the email body — compensation lives on the secure
  // offer page and inside the attached offer-letter PDF only.
  return [
    { label: "Offer ID", value: props.offerCode },
    { label: "Position", value: props.jobTitle },
    { label: "Line", value: props.reportingLine },
    { label: "Area", value: props.territory },
    { label: "Direct Manager", value: props.reportingManager },
    { label: "Hiring Date", value: props.startDate },
    { label: "Issued Date", value: props.issueDate },
    ...(props.expiresAt ? [{ label: "Offer Expires", value: props.expiresAt }] : []),
  ];
}

export function OfferLetterEmail(props: OfferLetterEmailProps) {
  return (
    <PhoenixEmailLayout
      action={props.actionLinksEnabled === false ? undefined : { href: props.reviewUrl, label: "Interested - Review Details" }}
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
    action: props.actionLinksEnabled === false ? undefined : { href: props.reviewUrl, label: "Interested - Review Details" },
    bodyHtml: offerBodyHtml(props),
    closingText: "We are excited about the possibility of welcoming you to the team. HR is available for any clarification before you decide.",
    greeting: `Dear ${props.candidateName},`,
    metadataRows: metadataRows(props),
    previewText: `Official ${props.jobTitle} offer from Phoenix Workforce.`,
    subject: `${props.jobTitle} Job Offer`,
    title: `${props.jobTitle} Job Offer`,
  });
}

export function renderOfferLetterEmailText(props: OfferLetterEmailProps) {
  return renderPhoenixEmailText({
    action: props.actionLinksEnabled === false ? undefined : { href: props.reviewUrl, label: "Interested - Review Details" },
    bodyText: [
      offerBodyText(props),
      "",
      props.actionLinksEnabled === false ? "Offer action links are inactive in local test mode." : `Review Offer Details: ${props.reviewUrl}`,
    ].join("\n"),
    closingText: "We are excited about the possibility of welcoming you to the team. HR is available for any clarification before you decide.",
    greeting: `Dear ${props.candidateName},`,
    metadataRows: metadataRows(props),
    title: `${props.jobTitle} Job Offer`,
  });
}
