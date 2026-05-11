import { GeneralNotificationEmail, type GeneralNotificationEmailProps, renderGeneralNotificationEmailHtml, renderGeneralNotificationEmailText } from "@/emails/general-notification";

export type PayslipEmailProps = GeneralNotificationEmailProps;

export function PayslipEmail(props: PayslipEmailProps) {
  return <GeneralNotificationEmail {...props} />;
}

export function renderPayslipEmailHtml(props: PayslipEmailProps) {
  return renderGeneralNotificationEmailHtml(props);
}

export function renderPayslipEmailText(props: PayslipEmailProps) {
  return renderGeneralNotificationEmailText(props);
}
