// The Telegram connect invitation's numbered walkthrough.
//
// The invitation's WORDING moved to /admin/email-templates under "Telegram Connect Invitation"
// on 2026-09-09, and the whole-email renderers that used to live here went with it. These steps
// stayed: they are a styled structure rather than a sentence, and reach the template body as
// the {{stepsBlock}} token.
const connectSteps = [
  "Tap the connect link below — it opens the official Phoenix Workforce bot in Telegram.",
  "Press START (or send /start) inside the chat. Your account links automatically and securely.",
  "Done — approvals, payroll alerts, contracts, leave, and reminders now arrive in Telegram instantly.",
] as const;

/**
 * The numbered connect walkthrough. Exported (2026-09-09) because the invitation's WORDING now
 * lives in /admin/email-templates under "Telegram Connect Invitation", while these steps stay
 * here: they are a styled structure, not a sentence, and reach the body as {{stepsBlock}}.
 */
export function telegramConnectStepsHtml() {
  return stepsHtml();
}

export function telegramConnectStepsText() {
  return connectSteps.map((step, index) => `${index + 1}. ${step}`).join("\n");
}

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
