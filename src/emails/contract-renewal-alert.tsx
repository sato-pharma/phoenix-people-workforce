import { GeneralNotificationEmail, type GeneralNotificationEmailProps, renderGeneralNotificationEmailHtml, renderGeneralNotificationEmailText } from "@/emails/general-notification";

export type ContractRenewalAlertEmailProps = GeneralNotificationEmailProps;

export function ContractRenewalAlertEmail(props: ContractRenewalAlertEmailProps) {
  return <GeneralNotificationEmail {...props} />;
}

export function renderContractRenewalAlertEmailHtml(props: ContractRenewalAlertEmailProps) {
  return renderGeneralNotificationEmailHtml(props);
}

export function renderContractRenewalAlertEmailText(props: ContractRenewalAlertEmailProps) {
  return renderGeneralNotificationEmailText(props);
}
