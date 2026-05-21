import {
  PhoenixEmailLayout,
  type PhoenixEmailAction,
  type PhoenixEmailMetadataRow,
  renderEmailParagraphs,
  renderPhoenixEmailHtml,
  renderPhoenixEmailText,
} from "@/emails/phoenix-email-layout";

export type GeneralNotificationEmailProps = {
  action?: PhoenixEmailAction;
  closingText?: string;
  greeting?: string;
  metadataRows?: PhoenixEmailMetadataRow[];
  bodyText?: string;
  previewText?: string;
  signatureName?: string;
  subject: string;
  summary: string;
  title: string;
};

function bodyHtml(props: GeneralNotificationEmailProps) {
  const content = props.bodyText ?? props.summary;
  return `
    ${props.greeting ? renderEmailParagraphs(props.greeting) : ""}
    ${renderEmailParagraphs(content)}
    ${props.closingText ? renderEmailParagraphs(props.closingText) : ""}`;
}

export function GeneralNotificationEmail(props: GeneralNotificationEmailProps) {
  return <PhoenixEmailLayout {...props} previewText={props.previewText ?? props.summary} bodyHtml={bodyHtml(props)} />;
}

export function renderGeneralNotificationEmailHtml(props: GeneralNotificationEmailProps) {
  return renderPhoenixEmailHtml({
    action: props.action,
    bodyHtml: bodyHtml(props),
    metadataRows: props.metadataRows,
    previewText: props.previewText ?? props.summary,
    signatureName: props.signatureName,
    subject: props.subject,
    title: props.title,
  });
}

export function renderGeneralNotificationEmailText(props: GeneralNotificationEmailProps) {
  return renderPhoenixEmailText({
    action: props.action,
    bodyText: [props.greeting, props.bodyText ?? props.summary, props.closingText].filter(Boolean).join("\n\n"),
    metadataRows: props.metadataRows,
    signatureName: props.signatureName,
    title: props.title,
  });
}
