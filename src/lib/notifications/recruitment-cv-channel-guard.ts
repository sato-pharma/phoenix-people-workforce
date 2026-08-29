import type { SystemNotificationChannel } from "@/lib/notifications/system";

// Owner rule (2026-08-15): the "new CV received" notice must never be delivered by email — only
// in-app and Telegram (plus push). Every other recruitment notification (offers, interviews, the
// WhatsApp-intake-down/dead-letter/spike alerts in recruitment-notify.ts, which are already
// Telegram-only) is untouched — this is scoped to the single inbound-CV event.
//
// Enforced as a hard post-filter over the RESOLVED channel list, not as a policy-table edit alone,
// because the policy table is not the last word on what gets sent. Email can re-enter from an
// explicit call-site `channels`, or from the Telegram-failure fallback that re-enters the
// notification pipeline with `channels: ["email","in_app","push"]` (see
// triggerTelegramRetryExhaustionFallback in system.ts) — which matters here specifically because
// Telegram failing is the expected case while a Talent Acquisition reviewer hasn't linked their
// Telegram yet, exactly the moment a policy-table-only rule would be silently defeated.
//
// Same proven pattern as early-birds-channel-guard.ts, marketing-sla-channel-guard.ts, and
// attendance-alert-channel-guard.ts, deliberately mirrored rather than merged into them so each
// guard stays single-purpose and independently readable.
//
// Keyed on module + the single "recruitment_inbound_cv" eventType (not `module: "recruitment"`),
// so ordinary recruitment notifications keep their email. Kept dependency-free (type-only import)
// so it stays trivially unit-testable, matching the guards above.

const RECRUITMENT_MODULE = "recruitment";

// Both forms of "a CV came in". The per-CV event now fires only for a CV whose file could not be
// attached; the routine arrivals are summarised once a Cairo day by the digest (see
// src/lib/recruitment/inbound/daily-cv-digest.ts). The owner's rule is about the NOTICE, not about
// how many CVs it covers, so the digest is inside it — and it had to be added here explicitly,
// because the `recruitment.*` policy row it would otherwise fall through to carries email.
// "recruitment_whatsapp_text_only" joined on 2026-08-29: an applicant messaging the advertised line
// without attaching a CV is the same class of notice — someone applied — and carries the same owner
// rule. It matters here more than for the other two, not less: this event fires on a person's FIRST
// contact, the moment at which a stray email would be most visibly wrong.
// "recruitment_whatsapp_unreadable_cv" joined on 2026-08-29 alongside it, and belongs here for the
// same reason one step further on: somebody applied, and the only thing separating it from
// recruitment_inbound_cv is that the file could not be read. A notice about a CV we could not open
// is still a notice that a CV arrived.
const CV_RECEIVED_EVENT_TYPES = new Set([
  "recruitment_inbound_cv",
  "recruitment_daily_cv_digest",
  "recruitment_whatsapp_text_only",
  "recruitment_whatsapp_unreadable_cv",
]);

export function isRecruitmentCvReceivedEvent(
  module: string | null | undefined,
  eventType: string | null | undefined,
): boolean {
  const normalizedModule = String(module ?? "").trim().toLowerCase();
  const normalizedEvent = String(eventType ?? "").trim().toLowerCase();
  if (normalizedModule !== RECRUITMENT_MODULE) return false;
  return CV_RECEIVED_EVENT_TYPES.has(normalizedEvent);
}

export function enforceRecruitmentCvEmailBlock(
  channels: readonly SystemNotificationChannel[],
  module: string | null | undefined,
  eventType: string | null | undefined,
): SystemNotificationChannel[] {
  const deduped = Array.from(new Set(channels));
  return isRecruitmentCvReceivedEvent(module, eventType)
    ? deduped.filter((channel) => channel !== "email")
    : deduped;
}
