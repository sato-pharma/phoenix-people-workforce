import { GeneralNotificationEmail, type GeneralNotificationEmailProps, renderGeneralNotificationEmailHtml, renderGeneralNotificationEmailText } from "@/emails/general-notification";

export type LeaveApprovalEmailProps = GeneralNotificationEmailProps;

export function LeaveApprovalEmail(props: LeaveApprovalEmailProps) {
  return <GeneralNotificationEmail {...props} />;
}

export function renderLeaveApprovalEmailHtml(props: LeaveApprovalEmailProps) {
  return renderGeneralNotificationEmailHtml(props);
}

export function renderLeaveApprovalEmailText(props: LeaveApprovalEmailProps) {
  return renderGeneralNotificationEmailText(props);
}
