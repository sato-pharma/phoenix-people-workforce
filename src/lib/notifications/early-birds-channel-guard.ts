import type { SystemNotificationChannel } from "@/lib/notifications/system";

// Owner rule (2026-08-09): Early Birds is delivered IN-APP and by TELEGRAM only. Email is
// permanently blocked for the whole module — not one event type, the module.
//
// Enforced as a hard post-filter over the RESOLVED channel list, not as a policy-table edit alone,
// because the policy table is not the last word on what gets sent. Email re-enters the pipeline
// from at least three other directions: an explicit call-site `channels`, the code defaults in
// resolveBasePolicyChannels (several of which are literally ["in_app", "email"]), and the
// Telegram-failure fallback that re-enters with `channels: ["email","in_app"]` — which is
// especially relevant here, because Telegram failing is the EXPECTED case while managers are
// still unlinked. A policy row alone would let the fallback quietly restore exactly the channel
// the owner banned.
//
// Same proven pattern as payslip-channel-guard.ts and marketing-sla-channel-guard.ts, and
// deliberately mirrored rather than merged into them: each guard stays single-purpose and
// independently readable, so deleting one can never silently widen another.
//
// Keyed on MODULE alone, unlike the marketing-SLA guard's module+eventType pair. Early Birds has
// no email-carrying event that survives — recommendation, approval, rejection and the auto-crown
// notice are all covered — so a narrower key would only create a gap for the next event type
// somebody adds.

const EARLY_BIRDS_MODULE = "early_birds";

export function isEarlyBirdsModule(module: string | null | undefined): boolean {
  return String(module ?? "").trim().toLowerCase() === EARLY_BIRDS_MODULE;
}

export function enforceEarlyBirdsEmailBlock(
  channels: readonly SystemNotificationChannel[],
  module: string | null | undefined,
): SystemNotificationChannel[] {
  const deduped = Array.from(new Set(channels));
  return isEarlyBirdsModule(module) ? deduped.filter((channel) => channel !== "email") : deduped;
}
