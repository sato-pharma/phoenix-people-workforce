export type PhoenixHrEmailTone = "professional" | "warm" | "firm" | "concise";

export type PhoenixHrReplyTemplateInput = {
  cc?: string;
  recipientName?: string;
  replyMessage: string;
  senderName?: string;
  signatureImageSrc?: string;
  subject: string;
  to: string;
  tone?: PhoenixHrEmailTone;
};

export type PhoenixHrReplyTemplateOutput = {
  html: string;
  plainText: string;
  preheader: string;
};

export const phoenixHrEmailSignaturePath = "/assets/branding/phoenix-hr-email-signature.png";
export const phoenixHrEmailSignatureSmallPath = "/assets/branding/phoenix-hr-signature-small.png";
export const phoenixHrEmailSignatureHostedUrl =
  "https://futuretalents.satopharma.com/FTP-WP/wp-content/uploads/2026/05/ChatGPT-Image-May-1-2026-09_41_55-PM-1-1.png";

const blackTextStyle = "color:#0f172a!important;-webkit-text-fill-color:#0f172a!important";

const toneConfig: Record<
  PhoenixHrEmailTone,
  {
    closing: string;
    preheader: string;
    title: string;
  }
> = {
  concise: {
    closing: "Please let us know if anything else is needed.",
    preheader: "A concise HR reply from Phoenix Workforce.",
    title: "HR Reply",
  },
  firm: {
    closing: "Please follow the guidance above so we can proceed without delay.",
    preheader: "An official HR response from Phoenix Workforce.",
    title: "Official HR Response",
  },
  professional: {
    closing: "If you need any further clarification, please let us know.",
    preheader: "A professional HR reply from Phoenix Workforce.",
    title: "Phoenix HR Response",
  },
  warm: {
    closing: "Thank you for your cooperation, and we are here if you need any support.",
    preheader: "A supportive HR reply from Phoenix Workforce.",
    title: "Phoenix HR Support",
  },
};

function escapeHtml(value: string | number | null | undefined) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeMultilineText(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function renderMessageParagraphs(replyMessage: string) {
  const paragraphs = normalizeMultilineText(replyMessage);

  if (paragraphs.length === 0) {
    return `
      <p class="phoenix-text" style="margin:0;${blackTextStyle};font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:400;line-height:1.75">
        Write your reply message in the composer before sending this email.
      </p>`;
  }

  return paragraphs
    .map((paragraph) => {
      const lines = paragraph
        .split("\n")
        .map((line) => escapeHtml(line.trim()))
        .filter(Boolean)
        .join("<br />");

      return `<p class="phoenix-text" style="margin:0 0 14px;${blackTextStyle};font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:400;line-height:1.75">${lines}</p>`;
    })
    .join("");
}

function formatPlainText(input: PhoenixHrReplyTemplateInput, closing: string) {
  const recipient = input.recipientName?.trim() || "there";
  const sender = input.senderName?.trim() || "Phoenix HR Team";
  const lines = [
    `To: ${input.to || "-"}`,
    input.cc ? `CC: ${input.cc}` : "",
    `Subject: ${input.subject || "-"}`,
    "",
    `Dear ${recipient},`,
    "",
    input.replyMessage.trim() || "[Write your reply message here.]",
    "",
    closing,
    "",
    "Best regards,",
    sender,
    "Phoenix HR Team",
  ].filter((line, index, list) => line !== "" || list[index - 1] !== "");

  return lines.join("\n");
}

export function buildPhoenixHrReplyEmail(
  input: PhoenixHrReplyTemplateInput,
): PhoenixHrReplyTemplateOutput {
  const tone = input.tone ?? "professional";
  const config = toneConfig[tone];
  const recipient = input.recipientName?.trim() || "there";
  const sender = input.senderName?.trim() || "Phoenix HR Team";
  const signatureImageSrc = input.signatureImageSrc?.trim() || phoenixHrEmailSignatureHostedUrl;
  const subject = input.subject.trim() || "HR Reply";

  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>${escapeHtml(subject)}</title>
    <style>
      :root { color-scheme: light; supported-color-schemes: light; }
      @keyframes phoenixGlow {
        0% { opacity: .76; box-shadow: 0 0 10px rgba(249,115,22,.28); }
        50% { opacity: 1; box-shadow: 0 0 24px rgba(249,115,22,.48); }
        100% { opacity: .76; box-shadow: 0 0 10px rgba(249,115,22,.28); }
      }
      @keyframes phoenixSweep {
        0% { background-position: -180px 0; }
        100% { background-position: 220px 0; }
      }
      @keyframes phoenixFloat {
        0% { opacity: .28; transform: translateY(0) scale(.9); }
        50% { opacity: .9; transform: translateY(-7px) scale(1); }
        100% { opacity: .28; transform: translateY(0) scale(.9); }
      }
      @media (prefers-color-scheme: dark) {
        body { background:#ffffff !important; color:#0f172a !important; }
        .phoenix-outer { background:#ffffff !important; }
        .phoenix-shell { background:#ffffff !important; }
        .phoenix-body { background:#ffffff !important; color:#0f172a !important; }
        .phoenix-header { background:#070b12 !important; color:#ffffff !important; }
        .phoenix-text { color:#0f172a !important; }
        .phoenix-muted { color:#475569 !important; }
        .phoenix-title { color:#ffffff !important; }
      }
      [data-ogsc] body,
      [data-ogsc] .phoenix-outer { background:#ffffff !important; color:#0f172a !important; }
      [data-ogsc] .phoenix-shell,
      [data-ogsc] .phoenix-body { background:#ffffff !important; color:#0f172a !important; }
      [data-ogsc] .phoenix-header { background:#070b12 !important; color:#ffffff !important; }
      [data-ogsc] .phoenix-text { color:#0f172a !important; }
      [data-ogsc] .phoenix-muted { color:#475569 !important; }
      @media screen and (max-width: 640px) {
        .phoenix-outer { padding: 14px !important; }
        .phoenix-shell { width: 100% !important; max-width: 100% !important; }
        .phoenix-header { padding: 24px 22px !important; }
        .phoenix-body { padding: 22px !important; }
        .phoenix-title { font-size: 22px !important; line-height: 1.25 !important; }
        .phoenix-signature { width: 170px !important; max-width: 70% !important; }
      }
    </style>
  </head>
  <body bgcolor="#ffffff" style="margin:0;padding:0;background:#ffffff!important;color:#0f172a!important;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;text-size-adjust:100%">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(config.preheader)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#ffffff" style="width:100%;background:#ffffff!important;background-image:linear-gradient(#ffffff,#ffffff);border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt">
      <tr>
        <td class="phoenix-outer" align="center" bgcolor="#ffffff" style="padding:28px 14px;background:#ffffff!important;background-image:linear-gradient(#ffffff,#ffffff)">
          <table class="phoenix-shell" role="presentation" width="680" cellspacing="0" cellpadding="0" border="0" bgcolor="#ffffff" style="width:680px;max-width:680px;border-collapse:separate;border-spacing:0;background:#ffffff!important;background-image:linear-gradient(#ffffff,#ffffff);border:1px solid #dbe3ee;border-radius:22px;overflow:hidden;box-shadow:0 20px 50px rgba(15,23,42,0.14);mso-table-lspace:0pt;mso-table-rspace:0pt">
            <tr>
              <td class="phoenix-header" bgcolor="#070b12" style="padding:30px 30px 28px;background:#070b12!important;background-image:linear-gradient(135deg,#070b12 0%,#0d1423 58%,#1b1008 100%);border-radius:22px 22px 0 0;color:#ffffff!important">
                <div style="margin:0;color:#fb923c!important;-webkit-text-fill-color:#fb923c!important;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:900;letter-spacing:0.24em;line-height:1.4;text-transform:uppercase">Phoenix Workforce HR System</div>
                <h1 class="phoenix-title" style="margin:12px 0 0;color:#ffffff!important;-webkit-text-fill-color:#ffffff!important;font-family:Arial,Helvetica,sans-serif;font-size:25px;font-weight:900;letter-spacing:-0.02em;line-height:1.22">${escapeHtml(config.title)}</h1>
                <p style="margin:12px 0 0;color:#dbeafe!important;-webkit-text-fill-color:#dbeafe!important;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:400;line-height:1.65">Official HR communication prepared through Phoenix Workforce.</p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:18px;width:100%;border-collapse:collapse">
                  <tr>
                    <td style="width:92px;vertical-align:middle">
                      <div style="width:86px;height:3px;border-radius:999px;background:#f97316;background-image:linear-gradient(90deg,#fb923c,#f97316,#fed7aa);box-shadow:0 0 18px rgba(249,115,22,.42);animation:phoenixGlow 2.6s ease-in-out infinite"></div>
                    </td>
                    <td style="vertical-align:middle">
                      <div style="height:3px;border-radius:999px;background:#1e293b;background-image:linear-gradient(90deg,rgba(251,146,60,0),rgba(251,146,60,.75),rgba(254,215,170,0));background-size:180px 3px;background-repeat:no-repeat;animation:phoenixSweep 3.2s linear infinite"></div>
                    </td>
                    <td style="width:62px;text-align:right;vertical-align:middle">
                      <span style="display:inline-block;width:6px;height:6px;border-radius:999px;background:#fb923c;box-shadow:0 0 12px rgba(251,146,60,.8);animation:phoenixFloat 2.8s ease-in-out infinite"></span>
                      <span style="display:inline-block;margin-left:8px;width:4px;height:4px;border-radius:999px;background:#fed7aa;box-shadow:0 0 10px rgba(254,215,170,.7);animation:phoenixFloat 3.4s ease-in-out infinite"></span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td class="phoenix-body" bgcolor="#ffffff" style="padding:26px 30px 30px;background:#ffffff!important;background-image:linear-gradient(#ffffff,#ffffff);color:#0f172a!important">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt">
                  <tr>
                    <td class="phoenix-text" style="padding-top:0;${blackTextStyle}">
                      <p class="phoenix-text" style="margin:0 0 16px;${blackTextStyle};font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:400;line-height:1.7">Dear ${escapeHtml(recipient)},</p>
                      ${renderMessageParagraphs(input.replyMessage)}
                      <p class="phoenix-text" style="margin:16px 0 0;${blackTextStyle};font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:400;line-height:1.75">${escapeHtml(config.closing)}</p>
                    </td>
                  </tr>
                </table>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt">
                  <tr>
                    <td style="padding-top:22px">
                      <div style="height:1px;background:#dbe3ee;line-height:1px;font-size:1px">&nbsp;</div>
                    </td>
                  </tr>
                  <tr>
                    <td class="phoenix-text" style="padding-top:18px;${blackTextStyle}">
                      <p class="phoenix-text" style="margin:0;${blackTextStyle};font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:900;line-height:1.7">Best regards,</p>
                      <p class="phoenix-text" style="margin:4px 0 0;${blackTextStyle};font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:900;line-height:1.7">${escapeHtml(sender)}</p>
                      <div style="margin-top:16px;text-align:left">
                        <img
                          alt=""
                          class="phoenix-signature"
                          src="${escapeHtml(signatureImageSrc)}"
                          width="112"
                          height="112"
                          style="display:block;margin:0;width:112px;max-width:112px;height:112px;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic"
                        />
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return {
    html,
    plainText: formatPlainText(input, config.closing),
    preheader: config.preheader,
  };
}
