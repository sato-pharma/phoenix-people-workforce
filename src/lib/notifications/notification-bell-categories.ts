/**
 * THE BELL'S HALF OF THE NOTIFICATION REGISTRY (REC-084 phase 2, 19 Nov 2026).
 *
 * The personal bell lists a notice only when its category is one of these — `PERSONAL_BELL_CATEGORIES`
 * in recipients.ts is DERIVED from this list, never written by hand any more. It is re-exported by
 * notification-types.ts, the registry, and `tests/notification-registry-loose-ends.test.ts` holds it to
 * the code both ways: every category a notice is written under (named by the sender, or defaulted from
 * its module by `defaultNotificationCategory`) is here or in `OFF_THE_BELL_CATEGORIES`, and every
 * category here is still written by some sender — or says it is kept so notices already in people's
 * bells still open.
 *
 * 🔴 Adding a category here puts every stored notice of that category on its recipients' bells, so a
 * new entry is a decision about who sees what, never a tidy-up. The order is the order the bell has
 * always passed to the database.
 *
 * Legacy categories (e.g. "leave", superseded by "vacation_request") are deliberately absent so stale
 * rows with mis-assigned recipients can never surface. This is a read-path allowlist only; it does not
 * change or delete any data. Pure — no imports — so the bell and the reconciliation checks can read it.
 */

export type NotificationBellCategory = {
  category: string;
  /** Who writes it, and why it belongs on the bell. */
  why: string;
  /** Set when no sender writes it any more and it stays only so notices already in bells still open. */
  keptForHistory?: true;
};

export const NOTIFICATION_BELL_CATEGORIES: readonly NotificationBellCategory[] = [
  { category: "vacation_request", why: "leave requests and decisions (the default for the vacation and leave modules)" },
  { category: "probation", why: "probation reminders and decisions (the default for the probation module)" },
  { category: "coaching_report", why: "coaching reports (the default for the coaching module)" },
  { category: "general", why: "every notice that names no category of its own" },
  { category: "internal_message", why: "internal messages (internal-messages/service.ts), and the default for that module" },
  { category: "excuse", why: "excuse requests, decisions and the drift alert (the default for the excuse module)" },
  { category: "recruitment", why: "recruitment notices to a named person (the default for the recruitment module)" },
  {
    category: "direct_order_request",
    why: "notifyDirectOrder (direct-orders/service.ts). Its in-app deliveries are recorded sent, so leaving it off produced the one failure monitoring cannot catch: the approver never sees the request and the delivery audit reports success.",
  },
  {
    category: "early_bird_recommendation",
    why: "notifyEarlyBirdsRecommendation (early-birds/notify.ts). Leave it off and the District Manager's bell stays empty while the delivery audit reports sent.",
  },
  {
    category: "attendance_digest",
    why: "notifyAttendanceWeekReleased and notifyAttendanceDisputeDecided (attendance/digest-notify.ts). The bell is one of only two channels the weekly attendance review has.",
  },
  {
    category: "phoenix_crm",
    why: "notifyPhoenixCrm (phoenix-crm/server/notifications.ts): requests and weekly plans waiting for a manager, and the decisions back to the rep.",
  },
  // The six below were written as in-app "sent" for months while the bell filtered them out, found by
  // the in-app-sent-must-be-bell-renderable reconciliation check on 2026-10-23 (215 rows). Each is
  // addressed to one named person, so each belongs.
  { category: "weekly_plan", why: "weekly-planning/drift-check.ts, the plan-drift alert" },
  {
    category: "crm",
    keptForHistory: true,
    why: "the iReports360 account-setup reminder and chase. Its writer was retired on 2026-11-07 with the vendor CRM; the category stays so the reminders already in people's bells still open (history is never hidden).",
  },
  { category: "security", why: "notifications/settings.ts, \"your Telegram was linked\"" },
  { category: "system", why: "notifications/dead-telegram-link-alert.ts, the dead-link alert" },
  { category: "market_awareness", why: "market-awareness/notifications.ts, activity approved / decision pending" },
  {
    category: "outstation",
    keptForHistory: true,
    why: "the outstation high-risk digest. No sender writes this category today (measured 19 Nov 2026: nothing in the code sends high_risk_digest any more); it stays so the digests already in people's bells still open.",
  },
];

/**
 * Categories a sender writes that are deliberately NOT on the bell, each with its reason. Empty today:
 * every category the code writes is a bell category. A notice written under one of these is never
 * listed on anyone's bell, so an entry here is a decision too.
 */
export const OFF_THE_BELL_CATEGORIES: ReadonlyArray<{ category: string; why: string }> = [];

/**
 * The category the engine gives a notice that names none (system.ts `categoryFor`): a few modules have
 * their own bell category, everything else is "general". Moved here unchanged so the registry test can
 * ask it of every send that names no category.
 */
export function defaultNotificationCategory(moduleName: string | null | undefined): string {
  const name = String(moduleName ?? "").trim().toLowerCase();
  if (name === "vacation" || name === "leave") return "vacation_request";
  if (name === "excuse" || name === "excuses") return "excuse";
  if (name === "coaching") return "coaching_report";
  if (name === "internal_message" || name === "internal_messages") return "internal_message";
  if (name === "probation") return "probation";
  if (name === "recruitment") return "recruitment";
  return "general";
}
