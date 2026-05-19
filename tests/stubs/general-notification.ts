export type GeneralNotificationEmailProps = {
  subject: string;
  summary: string;
  title: string;
};

export function GeneralNotificationEmail(props: GeneralNotificationEmailProps) {
  return props;
}

export function renderGeneralNotificationEmailHtml(props: GeneralNotificationEmailProps) {
  return `<p>${props.title}</p><p>${props.summary}</p>`;
}

export function renderGeneralNotificationEmailText(props: GeneralNotificationEmailProps) {
  return `${props.title}\n\n${props.summary}`;
}
