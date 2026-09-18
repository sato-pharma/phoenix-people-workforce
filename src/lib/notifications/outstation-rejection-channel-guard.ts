import type { SystemNotificationChannel } from "@/lib/notifications/system";

// Owner rule (2026-09-19): when an expense is REJECTED, the employee is told IN-APP — never by
// email. "I don't want him to receive an email that his expense is rejected." Telegram and push
// were not part of the ruling and stay as they were.
//
// Same shape, and for the same reason, as recruitment-candidate-assigned-channel-guard.ts: the call
// site is the intent, this post-filter is the enforcement. notifyOutstationDecision
// (src/lib/outstation/service.ts) no longer asks for email, but two other places put it back
// whatever the call site says — the Telegram-failure fallback in system.ts re-enters the pipeline
// with `channels: ["email","in_app","push"]`, and so does triggerTelegramRetryExhaustionFallback
// once the retry worker gives up. Before this change neither fired for a rejection, because email
// was already in the original send (`emailAttempted`); taking email out of the call site is exactly
// what arms them. This filter runs over the RESOLVED list, so it holds regardless.
//
// Keyed on module + the single "request_rejected" eventType, NOT on `module: "outstation"` — the
// submit notice (To the employee, Cc his manager, Bcc Super Admin) is an owner-ruled email
// (2026-09-04) and must keep it, as must the SLA and departure-photo reminders.
//
// Kept dependency-free (type-only import) so it stays trivially unit-testable, matching the guards
// it mirrors.

const OUTSTATION_MODULE = "outstation";

/** The one event type an expense rejection is ever written under. */
const REJECTION_EVENT_TYPE = "request_rejected";

export function isOutstationRejectionEvent(
  module: string | null | undefined,
  eventType: string | null | undefined,
): boolean {
  const normalizedModule = String(module ?? "").trim().toLowerCase();
  const normalizedEvent = String(eventType ?? "").trim().toLowerCase();
  if (normalizedModule !== OUTSTATION_MODULE) return false;
  return normalizedEvent === REJECTION_EVENT_TYPE;
}

export function enforceOutstationRejectionEmailBlock(
  channels: readonly SystemNotificationChannel[],
  module: string | null | undefined,
  eventType: string | null | undefined,
): SystemNotificationChannel[] {
  const deduped = Array.from(new Set(channels));
  return isOutstationRejectionEvent(module, eventType)
    ? deduped.filter((channel) => channel !== "email")
    : deduped;
}
