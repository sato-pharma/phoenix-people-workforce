import type { SystemNotificationChannel } from "@/lib/notifications/system";

// Owner rule (2026-09-16): Phoenix CRM tells people IN-APP and by TELEGRAM only — a grade or drop
// request waiting for the district manager, a request decided, a weekly plan sent for review, a
// plan approved or returned. Email is permanently blocked for the whole module.
//
// Same shape, and for the same reason, as early-birds-channel-guard.ts: the policy row is the
// intent, this post-filter is the enforcement. Email re-enters the pipeline from an explicit
// call-site `channels`, from the code defaults in resolveBasePolicyChannels, and from the
// Telegram-failure fallback (`["email","in_app"]`) — and Telegram failing is the EXPECTED case for
// every rep and manager who has not linked it.
//
// Keyed on MODULE alone, so a notice added to the module later is covered the day it is written.

const PHOENIX_CRM_MODULE = "phoenix_crm";

export function isPhoenixCrmModule(module: string | null | undefined): boolean {
  return String(module ?? "").trim().toLowerCase() === PHOENIX_CRM_MODULE;
}

export function enforcePhoenixCrmEmailBlock(
  channels: readonly SystemNotificationChannel[],
  module: string | null | undefined,
): SystemNotificationChannel[] {
  const deduped = Array.from(new Set(channels));
  return isPhoenixCrmModule(module) ? deduped.filter((channel) => channel !== "email") : deduped;
}
