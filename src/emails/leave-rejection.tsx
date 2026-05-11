import { GeneralNotificationEmail, type GeneralNotificationEmailProps, renderGeneralNotificationEmailHtml, renderGeneralNotificationEmailText } from "@/emails/general-notification";

export type LeaveRejectionEmailProps = GeneralNotificationEmailProps;

export function LeaveRejectionEmail(props: LeaveRejectionEmailProps) {
  return <GeneralNotificationEmail {...props} />;
}

export function renderLeaveRejectionEmailHtml(props: LeaveRejectionEmailProps) {
  return renderGeneralNotificationEmailHtml(props);
}

export function renderLeaveRejectionEmailText(props: LeaveRejectionEmailProps) {
  return renderGeneralNotificationEmailText(props);
}
