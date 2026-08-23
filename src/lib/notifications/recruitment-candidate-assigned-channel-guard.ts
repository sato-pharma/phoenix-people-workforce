import type { SystemNotificationChannel } from "@/lib/notifications/system";

// Owner rule (2026-08-24): sending a candidate to a hiring manager must NEVER be delivered by
// email. The manager is told in-app and by push only.
//
// The ask arrived the moment the feature was first used in anger: a shortlist of 14 people for the
// vacant Upper Egypt 2 anti-infective district manager seat was ready to push to the line's
// National Sales Manager, and the answer to "who should receive it" was "no, don't send emails".
// There was no way to honour that — pushCandidatesToManager passes
// `channels: ["in_app", "email", "push"]` at the call site, and resolveBasePolicyChannels returns an
// explicit call-site list verbatim, so the button emailed unconditionally. This is the sixth guard
// of exactly this shape, after payslips, marketing SLA reminders, Early Birds, the attendance
// ingestion stall alert, and the "new CV received" notice.
//
// Why a hard post-filter rather than only fixing the call site: three separate places can put email
// back, and they have on other events. The call-site `channels` list (now ["in_app", "push"]), the
// `recruitment.candidate_assigned` policy row (now in-app + push, added because the `recruitment.*`
// row it would otherwise fall through to carries email), and the Telegram-failure fallback in
// system.ts, which re-enters the pipeline with `channels: ["email","in_app","push"]` whatever the
// original send asked for. Three co-operating values are three chances to drift; this filter runs
// over the RESOLVED list, so it holds regardless of what any of them decide.
//
// Keyed on module + the single "candidate_assigned" eventType, NOT on `module: "recruitment"` —
// offers, interviews and the rest of the recruitment module keep their email. Both call sites in
// hiring-manager-notify.ts (the direct push and the requisition-level assignment) use that one
// event type, so both are covered by the one key.
//
// Kept dependency-free (type-only import) so it stays trivially unit-testable, matching the five
// guards it mirrors.

const RECRUITMENT_MODULE = "recruitment";

/** The one event type a manager-facing candidate push is ever written under. */
const CANDIDATE_ASSIGNED_EVENT_TYPE = "candidate_assigned";

export function isCandidateAssignedEvent(
  module: string | null | undefined,
  eventType: string | null | undefined,
): boolean {
  const normalizedModule = String(module ?? "").trim().toLowerCase();
  const normalizedEvent = String(eventType ?? "").trim().toLowerCase();
  if (normalizedModule !== RECRUITMENT_MODULE) return false;
  return normalizedEvent === CANDIDATE_ASSIGNED_EVENT_TYPE;
}

export function enforceCandidateAssignedEmailBlock(
  channels: readonly SystemNotificationChannel[],
  module: string | null | undefined,
  eventType: string | null | undefined,
): SystemNotificationChannel[] {
  const deduped = Array.from(new Set(channels));
  return isCandidateAssignedEvent(module, eventType)
    ? deduped.filter((channel) => channel !== "email")
    : deduped;
}
