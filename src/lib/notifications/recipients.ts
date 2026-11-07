/**
 * Canonical, fail-closed recipient visibility for in-app notifications.
 *
 * A viewer may see a notification ONLY if they are the notification's employee
 * subject, OR they appear in its explicit recipients list. Everything else is
 * DENIED by default. Invalid recipient tokens — empty values, email addresses,
 * and disposable PHASE/fixture identifiers — are ignored so legacy/fixture rows
 * can never leak to a real viewer (and never accidentally broadcast).
 *
 * This module is pure (string comparisons only) so it is trivially unit-testable
 * and safe to import from any layer. It is the single source of truth for "can
 * this viewer see this notification".
 */

import { canonicalHrIdForDisplay } from "@/lib/hr-id.ts";

export function normalizeNotificationHrId(value: string | null | undefined): string {
  // One canonical HR_ID normaliser (src/lib/hr-id.ts): folds the legacy aaa -> AA alias and
  // uppercases. `?? ""` preserves this function's non-null string contract. Deliberately NOT
  // normalizeHrIdForAccess — that strips every non-alphanumeric, which would erase the "@" the
  // isValidRecipientHrId guard below relies on to reject an email token, turning a fail-closed
  // check fail-open.
  return canonicalHrIdForDisplay(value) ?? "";
}

/**
 * Categories produced by the CURRENT notification code and shown in the personal
 * bell. Legacy/orphaned categories (e.g. "leave", superseded by "vacation_request")
 * are intentionally excluded so stale rows with mis-assigned recipients can never
 * surface — even though they are otherwise correctly recipient-matched. This is a
 * read-path allowlist only; it does not mutate or delete any data.
 */
export const PERSONAL_BELL_CATEGORIES = [
  "vacation_request",
  "probation",
  "coaching_report",
  "general",
  "internal_message",
  "excuse",
  "recruitment",
  // Emitted by notifyDirectOrder (src/lib/direct-orders/service.ts). Its in_app deliveries are
  // recorded "sent", so leaving it off this list produced the one failure mode monitoring cannot
  // catch: the approver never sees the request and the delivery audit reports success. Any new
  // category added to a createSystemNotification call must land here too, or it goes nowhere.
  "direct_order_request",
  // Emitted by notifyEarlyBirdsRecommendation (src/lib/early-birds/notify.ts). Same rule as
  // direct_order_request above: leave it off and the District Manager's bell stays empty while the
  // delivery audit cheerfully reports "sent".
  "early_bird_recommendation",
  // Emitted by notifyAttendanceWeekReleased and notifyAttendanceDisputeDecided
  // (src/lib/attendance/digest-notify.ts). The in-app bell is one of only two channels the weekly
  // attendance review has, so leaving it off would leave most employees — the ones with no Telegram
  // linked — with no notice at all.
  "attendance_digest",
  // Emitted by notifyPhoenixCrm (src/lib/phoenix-crm/server/notifications.ts): requests and weekly
  // plans waiting for a manager, and the decisions back to the rep. Leave it off and the bell stays
  // empty while the delivery audit reports "sent".
  "phoenix_crm",
  // The six below were written as in_app "sent" for months while the bell filtered them out, found by
  // the in-app-sent-must-be-bell-renderable reconciliation check on 2026-10-23 (215 rows, three of
  // the six still being written that day). Each is addressed to one named person, so each belongs.
  //   weekly_plan       — weekly-planning/drift-check.ts, the plan-drift alert
  //   crm               — the iReports360 account-setup reminder and chase. Its writer was retired on
  //                       2026-11-07 with the vendor CRM, and the category stays so the reminders
  //                       already in people's bells still open (history is never hidden).
  //   security          — notifications/settings.ts, "your Telegram was linked"
  //   system            — notifications/dead-telegram-link-alert.ts, the dead-link alert
  //   market_awareness  — market-awareness/notifications.ts, activity approved / decision pending
  //   outstation        — outstation high-risk digest
  "weekly_plan",
  "crm",
  "security",
  "system",
  "market_awareness",
  "outstation",
] as const;

const personalBellCategorySet = new Set<string>(PERSONAL_BELL_CATEGORIES);

export function getConfiguredHrNotificationEmails() {
  return String(process.env.HR_NOTIFICATION_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
}

/** True when a notification category is a current/supported personal-bell category. */
export function isPersonalBellCategory(category: string | null | undefined): boolean {
  return personalBellCategorySet.has(String(category ?? "").trim().toLowerCase());
}

/**
 * True only for a usable HR_ID recipient token: non-empty, not an email address,
 * and not a disposable phase/fixture placeholder. These guards stop legacy rows
 * (e.g. recipients stored as emails, or "PHASE17_..." fixture ids) from being
 * treated as real recipients.
 */
export function isValidRecipientHrId(value: string | null | undefined): boolean {
  const normalized = normalizeNotificationHrId(value);
  if (!normalized) return false;
  if (normalized.includes("@")) return false; // email address, not an HR_ID
  if (normalized.startsWith("PHASE")) return false; // disposable phase fixture id
  if (normalized.includes("FIXTURE")) return false; // fixture marker
  return true;
}

export type NotificationRecipientRow = {
  employeeHrId?: string | null;
  recipients?: unknown;
};

/**
 * Fail-closed visibility decision. Visible iff the viewer is the notification's
 * employee subject OR a valid explicit recipient. No implicit role/company
 * broadcast: an admin/Super Admin only sees a notification here if they are the
 * subject or an explicit recipient (a personal bell, not an everyone-feed).
 */
export function canViewerSeeNotification(
  viewerHrId: string | null | undefined,
  row: NotificationRecipientRow,
): boolean {
  const viewer = normalizeNotificationHrId(viewerHrId);
  if (!viewer) return false;

  if (
    isValidRecipientHrId(row.employeeHrId) &&
    normalizeNotificationHrId(row.employeeHrId) === viewer
  ) {
    return true;
  }

  const recipients = Array.isArray(row.recipients) ? row.recipients : [];
  return recipients.some(
    (recipient) =>
      isValidRecipientHrId(recipient as string | null | undefined) &&
      normalizeNotificationHrId(recipient as string | null | undefined) === viewer,
  );
}
