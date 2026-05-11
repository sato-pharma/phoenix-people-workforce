import { GeneralNotificationEmail, type GeneralNotificationEmailProps, renderGeneralNotificationEmailHtml, renderGeneralNotificationEmailText } from "@/emails/general-notification";

export type ProbationAlertEmailProps = GeneralNotificationEmailProps;

export function ProbationAlertEmail(props: ProbationAlertEmailProps) {
  return <GeneralNotificationEmail {...props} />;
}

export function renderProbationAlertEmailHtml(props: ProbationAlertEmailProps) {
  return renderGeneralNotificationEmailHtml(props);
}

export function renderProbationAlertEmailText(props: ProbationAlertEmailProps) {
  return renderGeneralNotificationEmailText(props);
}
