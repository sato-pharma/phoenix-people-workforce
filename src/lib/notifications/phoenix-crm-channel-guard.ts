import type { SystemNotificationChannel } from "@/lib/notifications/system";

// Owner rule (2026-09-16): Phoenix CRM tells people IN-APP and by TELEGRAM only — a grade or drop
// request waiting for the district manager, a request decided, a weekly plan sent for review, a
// plan approved or returned. Email is blocked for the whole module.
//
// ONE exception, by the owner's own order (2026-10-01): a rep's request to edit a week he already sent
// runs the district manager → SFE → HR, and "every step" goes by email, in-app and Telegram to the
// next person to act, the rep, the district manager and SFE. Those five event types — and only those —
// keep their email. Every other Phoenix CRM notice, the 06:55 digest included, stays email-free.
//
// Same shape, and for the same reason, as early-birds-channel-guard.ts: the policy row is the
// intent, this post-filter is the enforcement. Email re-enters the pipeline from an explicit
// call-site `channels`, from the code defaults in resolveBasePolicyChannels, and from the
// Telegram-failure fallback (`["email","in_app"]`) — and Telegram failing is the EXPECTED case for
// every rep and manager who has not linked it.
//
// Keyed on MODULE, so a notice added to the module later is covered the day it is written — and the
// exception on the exact event type, so it cannot widen by accident.

const PHOENIX_CRM_MODULE = "phoenix_crm";

/** The request to edit a sent week, at each of its steps (owner, 2026-10-01). Nothing else emails. */
export const PHOENIX_CRM_EMAIL_EVENT_TYPES: readonly string[] = [
  "plan_edit_waiting",
  "plan_edit_moved_on",
  "plan_edit_refused",
  "plan_edit_reopened",
  "plan_edit_expired",
];

export function isPhoenixCrmModule(module: string | null | undefined): boolean {
  return String(module ?? "").trim().toLowerCase() === PHOENIX_CRM_MODULE;
}

function emailAllowed(eventType: string | null | undefined): boolean {
  return PHOENIX_CRM_EMAIL_EVENT_TYPES.includes(String(eventType ?? "").trim().toLowerCase());
}

/** The channels a Phoenix CRM notice asks for: in-app, Telegram, and email only for the five above. */
export function phoenixCrmChannels(eventType: string, inAppOnly = false): SystemNotificationChannel[] {
  if (inAppOnly) return ["in_app"];
  return emailAllowed(eventType) ? ["in_app", "email", "telegram"] : ["in_app", "telegram"];
}

export function enforcePhoenixCrmEmailBlock(
  channels: readonly SystemNotificationChannel[],
  module: string | null | undefined,
  eventType?: string | null,
): SystemNotificationChannel[] {
  const deduped = Array.from(new Set(channels));
  if (!isPhoenixCrmModule(module) || emailAllowed(eventType)) return deduped;
  return deduped.filter((channel) => channel !== "email");
}
