import { GeneralNotificationEmail, type GeneralNotificationEmailProps, renderGeneralNotificationEmailHtml, renderGeneralNotificationEmailText } from "@/emails/general-notification";

export type InvestigationNoticeEmailProps = GeneralNotificationEmailProps;

export function InvestigationNoticeEmail(props: InvestigationNoticeEmailProps) {
  return <GeneralNotificationEmail {...props} />;
}

export function renderInvestigationNoticeEmailHtml(props: InvestigationNoticeEmailProps) {
  return renderGeneralNotificationEmailHtml(props);
}

export function renderInvestigationNoticeEmailText(props: InvestigationNoticeEmailProps) {
  return renderGeneralNotificationEmailText(props);
}
