import { systemIdentity } from "@/config/system-settings";
import {
  renderEmailParagraphs,
  renderPhoenixEmailHtml,
  renderPhoenixEmailText,
} from "@/emails/phoenix-email-layout";

export type TelegramConnectEmailProps = {
  connectUrl: string;
  expiresLabel?: string | null;
  name?: string | null;
};

const connectSteps = [
  "Tap the connect link below — it opens the official Phoenix Workforce bot in Telegram.",
  "Press START (or send /start) inside the chat. Your account links automatically and securely.",
  "Done — approvals, payroll alerts, contracts, leave, and reminders now arrive in Telegram instantly.",
] as const;

function stepsHtml() {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 4px;border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt">${connectSteps
    .map(
      (step, index) => `
      <tr>
        <td style="vertical-align:top;padding:0 12px 14px 0;width:26px">
          <div style="width:24px;height:24px;border-radius:12px;background:#f97316;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:800;line-height:24px;text-align:center">${index + 1}</div>
        </td>
        <td class="phoenix-text" style="vertical-align:top;padding:0 0 14px;color:#3c4043;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:400;line-height:1.6">${step}</td>
      </tr>`,
    )
    .join("")}</table>`;
}

function bodyHtml(props: TelegramConnectEmailProps) {
  const intro = `${systemIdentity.appName} can now deliver your HR notifications straight to Telegram — a fast, secure notifications center in your pocket. Connect once and stay informed wherever you are.`;
  const closing = props.expiresLabel
    ? `For your security this is a personal, single-use link that expires on ${props.expiresLabel}. If it expires, you can reconnect any time from your Phoenix portal under Notification Settings.`
    : `This is your personal, single-use connection link. You can also connect any time from your Phoenix portal under Notification Settings.`;
  return `
    ${props.name ? renderEmailParagraphs(`Dear ${props.name},`) : ""}
    ${renderEmailParagraphs(intro)}
    ${stepsHtml()}
    ${renderEmailParagraphs(closing)}`;
}

export function renderTelegramConnectEmailHtml(props: TelegramConnectEmailProps) {
  return renderPhoenixEmailHtml({
    action: { href: props.connectUrl, label: "Open Telegram & connect", tone: "primary" },
    bodyHtml: bodyHtml(props),
    previewText: `Connect Telegram to receive your ${systemIdentity.appName} notifications instantly.`,
    subject: `Connect Telegram to ${systemIdentity.appName}`,
    title: "Your Telegram notifications center",
  });
}

export function renderTelegramConnectEmailText(props: TelegramConnectEmailProps) {
  const bodyLines = [
    props.name ? `Dear ${props.name},` : "",
    `${systemIdentity.appName} can now deliver your HR notifications directly to Telegram.`,
    "",
    "How to connect:",
    ...connectSteps.map((step, index) => `${index + 1}. ${step}`),
  ]
    .filter((line, index, list) => line !== "" || list[index - 1] !== "")
    .join("\n");

  return renderPhoenixEmailText({
    action: { href: props.connectUrl, label: "Open Telegram & connect" },
    bodyText: bodyLines,
    closingText: props.expiresLabel ? `This personal link is single-use and expires on ${props.expiresLabel}.` : undefined,
    title: "Your Telegram notifications center",
  });
}
