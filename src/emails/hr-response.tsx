import {
  PhoenixEmailLayout,
  type PhoenixEmailAction,
  type PhoenixEmailMetadataRow,
  renderEmailParagraphs,
  renderPhoenixEmailHtml,
  renderPhoenixEmailText,
} from "@/emails/phoenix-email-layout";

export type HrResponseEmailProps = {
  action?: PhoenixEmailAction;
  bodyText: string;
  closingText?: string;
  greeting?: string;
  metadataRows?: PhoenixEmailMetadataRow[];
  previewText?: string;
  signatureName?: string;
  subject: string;
  subtitle?: string;
  title?: string;
};

export function HrResponseEmail(props: HrResponseEmailProps) {
  return <PhoenixEmailLayout {...toLayoutProps(props)} bodyHtml={renderEmailParagraphs(props.bodyText)} />;
}

function toLayoutProps(props: HrResponseEmailProps) {
  return {
    action: props.action,
    bodyText: props.bodyText,
    closingText: props.closingText ?? "If you need any further clarification, please let us know.",
    greeting: props.greeting,
    metadataRows: props.metadataRows,
    previewText: props.previewText ?? "A professional HR reply from Phoenix Workforce.",
    signatureName: props.signatureName ?? "Phoenix HR Team",
    subject: props.subject,
    subtitle: props.subtitle,
    title: props.title ?? "Phoenix HR Response",
  };
}

export function renderHrResponseEmailHtml(props: HrResponseEmailProps) {
  const layout = toLayoutProps(props);
  return renderPhoenixEmailHtml({
    ...layout,
    bodyHtml: renderEmailParagraphs(props.bodyText),
  });
}

export function renderHrResponseEmailText(props: HrResponseEmailProps) {
  const layout = toLayoutProps(props);
  return renderPhoenixEmailText(layout);
}
