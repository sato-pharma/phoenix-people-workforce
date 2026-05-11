import {
  phoenixEmailSignatureHostedUrl,
  renderEmailParagraphs,
  renderPhoenixEmailHtml,
  renderPhoenixEmailText,
} from "../../emails/phoenix-email-layout.tsx";

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
export const phoenixHrEmailSignatureHostedUrl = phoenixEmailSignatureHostedUrl;

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

export function buildPhoenixHrReplyEmail(
  input: PhoenixHrReplyTemplateInput,
): PhoenixHrReplyTemplateOutput {
  const tone = input.tone ?? "professional";
  const config = toneConfig[tone];
  const recipient = input.recipientName?.trim() || "there";
  const sender = input.senderName?.trim() || "Phoenix HR Team";
  const subject = input.subject.trim() || "HR Reply";
  const bodyText = input.replyMessage.trim() || "Write your reply message in the composer before sending this email.";

  const html = renderPhoenixEmailHtml({
    bodyHtml: renderEmailParagraphs(bodyText),
    closingText: config.closing,
    greeting: `Dear ${recipient},`,
    previewText: config.preheader,
    signatureImageSrc: input.signatureImageSrc,
    signatureName: sender,
    subject,
    title: config.title,
  });

  return {
    html,
    plainText: [
      `To: ${input.to || "-"}`,
      input.cc ? `CC: ${input.cc}` : "",
      `Subject: ${subject}`,
      "",
      renderPhoenixEmailText({
        bodyText,
        closingText: config.closing,
        greeting: `Dear ${recipient},`,
        signatureName: sender,
        title: config.title,
      }),
    ]
      .filter((line, index, list) => line !== "" || list[index - 1] !== "")
      .join("\n"),
    preheader: config.preheader,
  };
}
