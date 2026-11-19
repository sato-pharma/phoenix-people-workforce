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
import { NOTIFICATION_BELL_CATEGORIES } from "@/lib/notifications/notification-bell-categories";

export function normalizeNotificationHrId(value: string | null | undefined): string {
  // One canonical HR_ID normaliser (src/lib/hr-id.ts): folds the legacy aaa -> AA alias and
  // uppercases. `?? ""` preserves this function's non-null string contract. Deliberately NOT
  // normalizeHrIdForAccess — that strips every non-alphanumeric, which would erase the "@" the
  // isValidRecipientHrId guard below relies on to reject an email token, turning a fail-closed
  // check fail-open.
  return canonicalHrIdForDisplay(value) ?? "";
}

/**
 * Categories shown in the personal bell — DERIVED from the notification registry's bell half
 * (notification-bell-categories.ts, re-exported by notification-types.ts), never written here by hand
 * (REC-084 phase 2, 19 Nov 2026). Every reason a category is on the list lives beside it there, and
 * tests/notification-registry-loose-ends.test.ts holds that list to the categories the code writes.
 * A read-path allowlist only; it does not mutate or delete any data.
 */
export const PERSONAL_BELL_CATEGORIES: readonly string[] = NOTIFICATION_BELL_CATEGORIES.map((entry) => entry.category);

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
