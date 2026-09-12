import { systemDeployment } from "@/config/system-settings";
import { sanitizeEmailTemplateHtml } from "@/lib/email/email-safety";
import { HOUSE_COLORS } from "@/lib/hiring-pack/house-identity";
import { satoLogoUrl } from "@/lib/offers/brand";

/**
 * The Sato Pharma email: the house identity (SATO-DIS-2026-01) as an email body, never the Phoenix
 * shell. Owner 2026-09-11: "use the Sato identity, not the Phoenix".
 *
 * Nested tables, inline styles and px units, because Outlook lays mail out with Word and ignores
 * flex and grid. The mark is the ON-LIGHT png by absolute URL: the stock file sets SATO in white,
 * and Gmail and Outlook both drop `data:` images.
 *
 * The ink rule and the square-edge rule reach the sender's own body too: background fills are
 * stripped from it, so a highlight colour picked in the editor cannot put a filled area in the mail.
 */

const MAX_WIDTH = 640;
const LOGO_WIDTH = 136;
const COMPANY_NAME = "Sato Pharma";
const FONT_STACK = "Arial,Helvetica,sans-serif";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripFills(html: string): string {
  return html
    .replace(/\sbgcolor\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/background-color\s*:\s*[^;"']*;?/gi, "");
}

/** Direction per block, so an Arabic line and an English line each read the right way. */
function directionPerBlock(html: string): string {
  return html.replace(/<(p|li|td|th|blockquote)((?:\s[^>]*)?)>/gi, (match, tag: string, attributes: string) =>
    /\sdir\s*=/i.test(attributes) ? match : `<${tag} dir="auto"${attributes}>`,
  );
}

export function prepareSatoEmailBody(bodyHtml: string): string {
  return directionPerBlock(stripFills(sanitizeEmailTemplateHtml(bodyHtml)));
}

export function satoEmailHtmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|li|tr|blockquote|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function logoBaseUrl(): string {
  const configured = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || systemDeployment.productionUrl;
  return /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
}

export type SatoEmailContent = {
  subject: string;
  bodyHtml: string;
  signOff: string;
};

export function renderSatoEmail(content: SatoEmailContent): { html: string; text: string } {
  const subject = content.subject.trim();
  const signOff = content.signOff.trim();
  const body = prepareSatoEmailBody(content.bodyHtml);
  const logo = satoLogoUrl(logoBaseUrl());

  const signOffRow = signOff
    ? `<tr><td dir="auto" style="padding:24px 0 0 0;font-size:15px;line-height:24px;color:${HOUSE_COLORS.body}">` +
      `Regards,<br><strong style="color:${HOUSE_COLORS.deep}">${escapeHtml(signOff)}</strong></td></tr>`
    : "";

  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light only">' +
    `<title>${escapeHtml(subject)}</title></head>` +
    '<body style="margin:0;padding:0;background:#ffffff">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;background:#ffffff">' +
    '<tr><td align="center" style="padding:24px 16px">' +
    `<table role="presentation" width="${MAX_WIDTH}" cellpadding="0" cellspacing="0" border="0" ` +
    `style="width:100%;max-width:${MAX_WIDTH}px;border-collapse:collapse;font-family:${FONT_STACK};color:${HOUSE_COLORS.body}">` +
    `<tr><td style="padding:0 0 14px 0"><img src="${escapeHtml(logo)}" width="${LOGO_WIDTH}" alt="${COMPANY_NAME}" ` +
    `style="display:block;width:${LOGO_WIDTH}px;height:auto;border:0"></td></tr>` +
    `<tr><td style="border-top:2px solid ${HOUSE_COLORS.blue};font-size:0;line-height:0">&nbsp;</td></tr>` +
    `<tr><td dir="auto" style="padding:22px 0 4px 0;font-size:20px;line-height:28px;font-weight:bold;color:${HOUSE_COLORS.deep}">${escapeHtml(subject)}</td></tr>` +
    `<tr><td style="padding:10px 0 0 0;font-size:15px;line-height:24px;color:${HOUSE_COLORS.body}">${body}</td></tr>` +
    signOffRow +
    `<tr><td style="padding:32px 0 0 0;border-bottom:1px solid ${HOUSE_COLORS.hair};font-size:0;line-height:0">&nbsp;</td></tr>` +
    `<tr><td style="padding:10px 0 0 0;font-size:11px;line-height:16px;color:${HOUSE_COLORS.muted}">${COMPANY_NAME}</td></tr>` +
    "</table></td></tr></table></body></html>";

  const textParts = [subject, satoEmailHtmlToText(body)];
  if (signOff) textParts.push(`Regards,\n${signOff}`);
  textParts.push(`--\n${COMPANY_NAME}`);

  return { html, text: textParts.filter(Boolean).join("\n\n") };
}
