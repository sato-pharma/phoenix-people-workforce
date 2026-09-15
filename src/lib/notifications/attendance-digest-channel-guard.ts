import type { SystemNotificationChannel } from "@/lib/notifications/system";

// Owner rule (2026-09-15): the weekly attendance review reaches the employee IN-APP and by
// TELEGRAM only. Email is permanently blocked for the whole module.
//
// Same shape, and for the same reason, as early-birds-channel-guard.ts: the policy row is the
// intent, this post-filter is the enforcement. Email re-enters the pipeline from an explicit
// call-site `channels`, from the code defaults in resolveBasePolicyChannels, and from the
// Telegram-failure fallback (`["email","in_app"]`) — and Telegram failing is the EXPECTED case for
// every employee who has not linked it, which is most of them.
//
// Keyed on MODULE alone. The release notice, the dispute outcome and anything added later are all
// the same conversation about the same money; a narrower key would leave a gap for the next event.

const ATTENDANCE_DIGEST_MODULE = "attendance_digest";

export function isAttendanceDigestModule(module: string | null | undefined): boolean {
  return String(module ?? "").trim().toLowerCase() === ATTENDANCE_DIGEST_MODULE;
}

export function enforceAttendanceDigestEmailBlock(
  channels: readonly SystemNotificationChannel[],
  module: string | null | undefined,
): SystemNotificationChannel[] {
  const deduped = Array.from(new Set(channels));
  return isAttendanceDigestModule(module) ? deduped.filter((channel) => channel !== "email") : deduped;
}
