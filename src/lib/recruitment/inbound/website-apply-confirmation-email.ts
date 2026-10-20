// Recruitment / careers site — the applicant's confirmation e-mail.
//
// When someone applies from www.satopharma.com/careers and their CV is safely captured, they receive
// one automated confirmation letter. It is rendered in the SATO house template (SATO-DIS-2026-01) —
// the same identity the Sato Pharma website and the Sato Email Composer use, NOT the Phoenix shell.
// Owner request: "when someone submit application, he receive an automated email, premium polished
// with the same identity and design of the website", and "the email is ... branded Sato template
// and identity", never Phoenix.
//
// The render half is PURE (no I/O, no clock) so the wording stays unit-testable; the send half mirrors
// interview-invitations.ts field for field — same From mailbox, same declared-external candidate, same
// reply-to — so the confirmation rides the exact delivery path already trusted for candidate mail.

import { createHash } from "node:crypto";

import { systemEmail } from "@/config/system-settings";
import { sendPhoenixEmail } from "@/lib/email/send-phoenix-email";
import { escapeHtml } from "@/lib/hiring-pack/render-shared";
import { emailNotificationsEnabled } from "@/lib/notifications/email";
import { candidateGreetingName } from "@/lib/recruitment/candidate-greeting";
import { renderSatoEmail } from "@/lib/sato-email/render";
import { satoEmailFrom } from "@/lib/sato-email/service";

export type WebsiteApplyConfirmationContent = {
  /** The applicant's own name, as they typed it on the form. */
  fullName: string;
  /** The public title of the role applied for (WebsiteApplyRole.title). */
  roleTitle: string;
};

/**
 * The confirmation as a SATO-DIS-2026-01 letter. PURE. Three short paragraphs in the voice of the
 * house template — received, what we do with it, what happens next — with the role named so the mail
 * reads unmistakably as a confirmation of THIS application.
 */
export function renderWebsiteApplyConfirmationEmail(
  content: WebsiteApplyConfirmationContent,
): { subject: string; html: string; text: string } {
  // "Dear Dr Mariam": every candidate is greeted with Dr (owner, 2026-10-20 — candidate-greeting.ts).
  const name = candidateGreetingName(content.fullName);
  const role = content.roleTitle.trim();
  const subject = `We've received your application — ${role}`;
  const rendered = renderSatoEmail({
    bodyHtml:
      `<p>Dear ${escapeHtml(name)},</p>` +
      `<p>Thank you for applying to Sato Pharma. Your application for the ` +
      `<strong>${escapeHtml(role)}</strong> position has reached our talent team, and your CV has ` +
      `been received and stored securely.</p>` +
      `<p>We review every application personally. If your experience matches what the role needs, ` +
      `we will contact you directly to take the next step — there is nothing further you need to do ` +
      `for now.</p>` +
      `<p>Thank you for considering a career with us.</p>`,
    footnote: "This is an automated confirmation of an application you submitted at satopharma.com/careers.",
    kicker: "Application received",
    // Sign with the DEPARTMENT only. The house template already carries "Sato Pharma" in the
    // letterhead logo and the "Issued by Sato Pharma" provenance stamp, so putting the company name
    // in the sign-off too made it read twice (the duplicate the owner flagged). Same convention as
    // interview-invitations.ts, which signs "Human Resources".
    signOff: "Human Resources",
    subject,
  });
  return { html: rendered.html, subject, text: rendered.text };
}

/**
 * Send the confirmation to the applicant. BEST-EFFORT by contract: the caller
 * (submitWebsiteApplication) never fails an application because a confirmation could not be sent, so
 * this returns quietly when e-mail is switched off or the address is empty, and any provider error is
 * the caller's to swallow. The applicant belongs to nobody in the employee directory, so — exactly as
 * interview-invitations.ts does — their address is declared as an intended external recipient.
 */
export async function sendWebsiteApplyConfirmation(input: {
  email: string;
  fullName: string;
  roleTitle: string;
}): Promise<void> {
  if (!emailNotificationsEnabled()) return;
  const to = input.email.trim().toLowerCase();
  if (!to) return;

  const { subject, html, text } = renderWebsiteApplyConfirmationEmail({
    fullName: input.fullName,
    roleTitle: input.roleTitle,
  });

  // One confirmation per applicant per role: a double-submit within the hour is still one e-mail.
  const hour = Math.floor(Date.now() / 3_600_000);
  const idempotencyKey = `website-apply-confirm-${createHash("sha256")
    .update(`${to}|${input.roleTitle.trim().toLowerCase()}|${hour}`)
    .digest("hex")
    .slice(0, 40)}`;

  await sendPhoenixEmail({
    externalRecipients: [to],
    // The company's own name in the inbox list, from the mailbox the Sato Email Composer sends from.
    from: satoEmailFrom(systemEmail.satoComposerFromEmail),
    html,
    idempotencyKey,
    // Transactional: a confirmation of an action the person just took, so a stale marketing
    // unsubscribe must not withhold it (see loadSuppressedRecipients).
    notificationType: "careers_application_confirmation",
    origin: {
      eventType: "careers_application_confirmation",
      module: "recruitment.website-apply",
      recipientHrId: null,
    },
    replyTo: systemEmail.satoComposerReplyToEmail,
    subject,
    text,
    to: [to],
  });
}
