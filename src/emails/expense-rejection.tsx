import { GeneralNotificationEmail, type GeneralNotificationEmailProps, renderGeneralNotificationEmailHtml, renderGeneralNotificationEmailText } from "@/emails/general-notification";

export type ExpenseRejectionEmailProps = GeneralNotificationEmailProps;

export function ExpenseRejectionEmail(props: ExpenseRejectionEmailProps) {
  return <GeneralNotificationEmail {...props} />;
}

export function renderExpenseRejectionEmailHtml(props: ExpenseRejectionEmailProps) {
  return renderGeneralNotificationEmailHtml(props);
}

export function renderExpenseRejectionEmailText(props: ExpenseRejectionEmailProps) {
  return renderGeneralNotificationEmailText(props);
}
