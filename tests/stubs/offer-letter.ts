export type OfferLetterEmailProps = {
  candidateName: string;
  jobTitle: string;
  offerCode: string;
};

export function OfferLetterEmail(props: OfferLetterEmailProps) {
  return props;
}

export function renderOfferLetterEmailHtml(props: OfferLetterEmailProps) {
  return `<h1>${props.jobTitle}</h1><p>${props.candidateName}</p>`;
}

export function renderOfferLetterEmailText(props: OfferLetterEmailProps) {
  return `${props.jobTitle}\n\n${props.candidateName}`;
}
