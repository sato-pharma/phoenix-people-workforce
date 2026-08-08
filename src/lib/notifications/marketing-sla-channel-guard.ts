import type { SystemNotificationChannel } from "@/lib/notifications/system";

// Owner rule (2026-07-25): a marketing-request SLA reminder must NEVER be
// delivered by email again. Retired entirely after this exact notification type produced a
// real incident: 93 pending_approval requests with no approval step any human could act on
// re-escalated an unactionable "critical" email to approvers every morning for weeks.
// In-app, Telegram, and push stay available -- only email is permanently blocked. Enforced as
// a hard post-filter over the resolved channel list so it holds regardless of the policy
// table, an explicit call-site `channels`, or the Telegram-failure fallback that re-enters the
// pipeline with `channels: ["email","in_app"]` -- same proven pattern as
// payslip-channel-guard.ts, which this deliberately mirrors rather than extends (keeping each
// guard single-purpose and independently readable).
//
// Keyed on BOTH module AND the 2 SLA eventTypes -- unlike payslip-channel-guard.ts's eventType-
// only match ("payslip" is a near-unique substring), "due_date_reminder"/
// "overdue_reminder" are generic enough that a future module could plausibly reuse one of
// them; grepping the whole src tree found no such collision today, but the extra module check
// costs nothing and removes the risk going forward. The OTHER marketing_requests lifecycle
// notifications (request_submitted, request_assigned, request_approved, request_rejected,
// request_returned, request_completed) are untouched -- only the 2 SLA reminder
// types lose email.

const MARKETING_SLA_EMAIL_BLOCKED_EVENT_TYPES = new Set(["due_date_reminder", "overdue_reminder"]);
const MARKETING_REQUESTS_MODULE = "marketing_requests";

export function isMarketingSlaEventType(module: string | null | undefined, eventType: string | null | undefined): boolean {
  const isMarketingModule = String(module ?? "").trim().toLowerCase() === MARKETING_REQUESTS_MODULE;
  return isMarketingModule && MARKETING_SLA_EMAIL_BLOCKED_EVENT_TYPES.has(String(eventType ?? "").trim().toLowerCase());
}

export function enforceMarketingSlaEmailBlock(
  channels: readonly SystemNotificationChannel[],
  module: string | null | undefined,
  eventType: string | null | undefined,
): SystemNotificationChannel[] {
  const deduped = Array.from(new Set(channels));
  return isMarketingSlaEventType(module, eventType) ? deduped.filter((channel) => channel !== "email") : deduped;
}
