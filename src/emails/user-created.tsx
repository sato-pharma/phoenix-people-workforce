import { GeneralNotificationEmail, type GeneralNotificationEmailProps, renderGeneralNotificationEmailHtml, renderGeneralNotificationEmailText } from "@/emails/general-notification";

export type UserCreatedEmailProps = GeneralNotificationEmailProps;

export function UserCreatedEmail(props: UserCreatedEmailProps) {
  return <GeneralNotificationEmail {...props} />;
}

export function renderUserCreatedEmailHtml(props: UserCreatedEmailProps) {
  return renderGeneralNotificationEmailHtml(props);
}

export function renderUserCreatedEmailText(props: UserCreatedEmailProps) {
  return renderGeneralNotificationEmailText(props);
}
