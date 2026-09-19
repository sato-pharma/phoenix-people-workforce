// Recruitment — the interview invitation as an e-mail, in the SATO template.
//
// PURE (no database, no clock): it turns the message the invitation screen previews into the house
// letter the Sato Email Composer sends — SATO-DIS-2026-01, never the Phoenix shell. Owner, 2026-09-19:
// "I want the emails that are fired in this module to be fired in the SATO template."

import { escapeHtml } from "@/lib/hiring-pack/render-shared";
import type { InvitationKind, InvitationMessage } from "@/lib/recruitment/interview-invitation";
import { renderSatoEmail } from "@/lib/sato-email/render";

/** A bare "www.…" or a full URL becomes a link; anything else stays text. */
function linkedValue(value: string): string {
  const text = value.trim();
  if (/^https?:\/\/\S+$/i.test(text)) return `<a href="${escapeHtml(text)}" style="color:#0A6BA6">${escapeHtml(text)}</a>`;
  if (/^www\.\S+$/i.test(text)) return `<a href="https://${escapeHtml(text)}" style="color:#0A6BA6">${escapeHtml(text)}</a>`;
  return escapeHtml(text);
}

/**
 * The invitation as a SATO-DIS-2026-01 mail — the house letter the Sato Email Composer sends, not the
 * Phoenix shell (owner, 2026-09-19: "fired in the SATO template"). The details are the zebra table
 * the house format allows; the one button is a plain link, because the ink rule allows no filled area.
 */
export function renderInvitationEmail(name: string, message: InvitationMessage, kind: InvitationKind): { html: string; text: string } {
  const intro = kind === "company_details" ? "Kindly find below our company details." : "Kindly find below the interview details.";
  const rows = message.rows.map((row) => `<tr><td><strong>${escapeHtml(row.label)}</strong></td><td>${linkedValue(row.value)}</td></tr>`).join("");
  const action = message.action ? `<p><a href="${escapeHtml(message.action.href)}" style="color:#0A6BA6;font-weight:bold">${escapeHtml(message.action.label)}</a></p>` : "";
  const closing = kind === "company_details" ? "" : "<p>We look forward to meeting you.</p>";
  return renderSatoEmail({
    bodyHtml: `<p>Hello ${escapeHtml(name)},</p><p>${intro}</p><table><tbody>${rows}</tbody></table>${action}${closing}`,
    footnote: "This message was sent to you personally by Sato Pharma Human Resources.",
    kicker: kind === "company_details" ? "Company details" : "Interview invitation",
    signOff: "Human Resources",
    subject: message.subject,
  });
}
