import {
  phoenixEmailSignatureHostedUrl,
  renderEmailParagraphs,
  renderPhoenixEmailHtml,
  renderPhoenixEmailText,
} from "../../emails/phoenix-email-layout.tsx";
import { systemHrReplyEmailText, systemIdentity } from "@/config/system-settings";

export type PhoenixHrEmailTone = "professional" | "warm" | "firm" | "concise";

export type PhoenixHrReplyTemplateInput = {
  cc?: string;
  recipientName?: string;
  replyMessage: string;
  /**
   * Optional rich body from the WYSIWYG composer. Callers MUST sanitize it
   * (sanitizeEmailTemplateHtml) before passing it here; when present it replaces the
   * paragraph-wrapped plain text in the HTML part, while replyMessage still feeds the
   * plain-text part.
   */
  replyMessageHtml?: string;
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
    preheader: systemHrReplyEmailText.concisePreheader,
    title: "HR Reply",
  },
  firm: {
    closing: "Please follow the guidance above so we can proceed without delay.",
    preheader: systemHrReplyEmailText.firmPreheader,
    title: "Official HR Response",
  },
  professional: {
    closing: "If you need any further clarification, please let us know.",
    preheader: systemHrReplyEmailText.professionalPreheader,
    title: "Phoenix HR Response",
  },
  warm: {
    closing: "Thank you for your cooperation, and we are here if you need any support.",
    preheader: systemHrReplyEmailText.warmPreheader,
    title: "Phoenix HR Support",
  },
};

export function buildPhoenixHrReplyEmail(
  input: PhoenixHrReplyTemplateInput,
): PhoenixHrReplyTemplateOutput {
  const tone = input.tone ?? "professional";
  const config = toneConfig[tone];
  const recipient = input.recipientName?.trim() || "there";
  const sender = input.senderName?.trim() || systemIdentity.hrSignatureName;
  const subject = input.subject.trim() || "HR Reply";
  const bodyText = input.replyMessage.trim() || "Write your reply message in the composer before sending this email.";

  const html = renderPhoenixEmailHtml({
    bodyHtml: input.replyMessageHtml?.trim() ? input.replyMessageHtml : renderEmailParagraphs(bodyText),
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
