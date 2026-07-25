import type { SystemNotificationChannel } from "@/lib/notifications/system";

// Owner rule: a PAYSLIP notification must NEVER be delivered by email — ever. Payslips are
// delivered in-app, push, and (when allowed) a generic Telegram nudge only. This is enforced as a
// hard post-filter over the resolved channel list so it holds regardless of the policy table, an
// explicit call-site `channels`, or the Telegram-failure fallbacks that re-enter the notification
// pipeline with `channels: ["email","in_app"]`.
//
// Owner override 2026-07-25: push used to be blocked here too (a locked device's lock screen has
// no authentication, a bigger exposure than email), but the owner explicitly authorized push for
// payroll/payslip notifications — see policy.ts's payroll.* / payroll.payslip_available rows and
// the matching change in system.ts's resolveBasePolicyChannels. Only email stays hard-blocked now.
//
// Keyed on the payslip *eventType* (not `module: "payroll"`) so genuine payroll-admin emails
// (e.g. `workflow_updated`, `salary_upload_imported`) keep their email. Kept dependency-free
// (type-only import) so it stays trivially unit-testable.

export function isPayslipEventType(eventType: string | null | undefined): boolean {
  return String(eventType ?? "").trim().toLowerCase().includes("payslip");
}

export function enforcePayslipEmailBlock(
  channels: readonly SystemNotificationChannel[],
  eventType: string | null | undefined,
): SystemNotificationChannel[] {
  const deduped = Array.from(new Set(channels));
  return isPayslipEventType(eventType) ? deduped.filter((channel) => channel !== "email") : deduped;
}
