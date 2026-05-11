import { GeneralNotificationEmail, type GeneralNotificationEmailProps, renderGeneralNotificationEmailHtml, renderGeneralNotificationEmailText } from "@/emails/general-notification";

export type ExpenseApprovalEmailProps = GeneralNotificationEmailProps;

export function ExpenseApprovalEmail(props: ExpenseApprovalEmailProps) {
  return <GeneralNotificationEmail {...props} />;
}

export function renderExpenseApprovalEmailHtml(props: ExpenseApprovalEmailProps) {
  return renderGeneralNotificationEmailHtml(props);
}

export function renderExpenseApprovalEmailText(props: ExpenseApprovalEmailProps) {
  return renderGeneralNotificationEmailText(props);
}
