import { GeneralNotificationEmail, type GeneralNotificationEmailProps, renderGeneralNotificationEmailHtml, renderGeneralNotificationEmailText } from "@/emails/general-notification";

export type PasswordResetEmailProps = GeneralNotificationEmailProps;

export function PasswordResetEmail(props: PasswordResetEmailProps) {
  return <GeneralNotificationEmail {...props} />;
}

export function renderPasswordResetEmailHtml(props: PasswordResetEmailProps) {
  return renderGeneralNotificationEmailHtml(props);
}

export function renderPasswordResetEmailText(props: PasswordResetEmailProps) {
  return renderGeneralNotificationEmailText(props);
}
