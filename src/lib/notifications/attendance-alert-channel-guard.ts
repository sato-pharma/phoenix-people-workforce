import type { SystemNotificationChannel } from "@/lib/notifications/system";

// Owner rule (2026-08-09, restating and hardening the 2026-08-08 decision): the attendance
// ingestion alert must NEVER be delivered by email. It reaches Super Admins in-app and by push
// only.
//
// Why this is a hard post-filter and not just a policy row: email was already "retired" for this
// alert in two places — the `channels: ["in_app", "push"]` passed at the call site, and the
// matching `attendance.attendance_agent_ingestion_stalled` entry in policy.ts. Two co-operating
// config values are exactly the kind of thing that drifts apart: a future edit to either one, an
// explicit `channels` at a new call site, or a Telegram-failure fallback that re-enters the
// pipeline with `channels: ["email","in_app"]`, would quietly put email back. This filter runs
// over the RESOLVED channel list, so it holds whatever the policy table, the call site, or a
// fallback decides.
//
// The original reason email was dropped is worth keeping in view: the alert was addressed to the
// shared HR inbox, so it never named a person who could act, and it fired once every night for as
// long as an outage lasted. An unactionable nightly email is not a smaller problem than silence —
// it is the thing that trains people to ignore the channel.
//
// Keyed on the ingestion-stall event type rather than `module: "attendance"`, so ordinary
// attendance notifications to employees keep their email.
//
// Kept dependency-free (type-only import) so it stays trivially unit-testable, matching
// payslip-channel-guard.ts and marketing-sla-channel-guard.ts.

export function isAttendanceIngestionAlertEvent(
  module: string | null | undefined,
  eventType: string | null | undefined,
): boolean {
  const normalizedModule = String(module ?? "").trim().toLowerCase();
  const normalizedEvent = String(eventType ?? "").trim().toLowerCase();
  if (normalizedModule !== "attendance") return false;
  return normalizedEvent === "attendance_agent_ingestion_stalled";
}

export function enforceAttendanceAlertEmailBlock(
  channels: readonly SystemNotificationChannel[],
  module: string | null | undefined,
  eventType: string | null | undefined,
): SystemNotificationChannel[] {
  const deduped = Array.from(new Set(channels));
  return isAttendanceIngestionAlertEvent(module, eventType)
    ? deduped.filter((channel) => channel !== "email")
    : deduped;
}
