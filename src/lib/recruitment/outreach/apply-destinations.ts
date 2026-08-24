// Recruitment / ATS — where an apply link actually points.
//
// Reads configuration rather than taking new settings: the recruitment inbox is already declared in
// RECRUITMENT_EMAIL_INBOXES_JSON and polled every few minutes, so an advert should point at the same
// mailbox the intake pipeline is already watching. Pointing anywhere else would produce applications
// nothing reads.
//
// WhatsApp is the one value that has to be stated, because the number an APPLICANT should message is
// not derivable from the webhook config: the phone_number_id in the Meta app is an opaque id, and
// resolving it to a dialable number needs a live Graph call that an advert-composing screen has no
// business making. One env var, and the UI says plainly when it is unset.

import { loadConfiguredMailboxes } from "@/lib/recruitment/inbound/email-mailboxes-config";
import { normalizeWhatsAppNumber } from "@/lib/recruitment/outreach/job-advert";

export type ApplyDestinations = {
  /** Dialable international number, digits only, or null when not configured. */
  whatsappNumber: string | null;
  /** The careers mailbox the poller already watches, or null when none is configured. */
  email: string | null;
};

/**
 * Resolves both apply destinations.
 *
 * Either may legitimately be null. The composer then offers only the channel that works and says
 * why the other is missing — an advert carrying a dead link is worse than an advert carrying one.
 */
export function resolveApplyDestinations(): ApplyDestinations {
  const whatsappNumber = normalizeWhatsAppNumber(process.env.RECRUITMENT_APPLY_WHATSAPP_NUMBER);

  // Prefer a mailbox whose gate actually accepts CVs; fall back to the first configured one so a
  // single-mailbox setup keeps working without special-casing.
  const mailboxes = loadConfiguredMailboxes();
  const preferred = mailboxes.find((mailbox) => mailbox.cvGate !== "strict") ?? mailboxes[0] ?? null;
  const email = preferred?.user?.trim() ?? null;

  return { email: email && email.length > 0 ? email : null, whatsappNumber };
}
