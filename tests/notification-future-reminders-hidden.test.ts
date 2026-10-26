import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { noticeIsDue } from "../src/lib/notifications/due-today.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * A reminder written ahead of time stays off the bell until its day.
 *
 * The probation sweep writes all of a probation's reminders at once, so on 2026-10-24 Rasha's bell
 * read "Nora Kamle srour's probation feedback is due" for a rep hired 1 Nov, with the reminder dated
 * 1 Dec. Production then held 110 such future rows. The reads below are fenced in SQL (so the future
 * rows cannot use up the read limit) and the bell checks again after its query.
 *
 * Files are read inside the function, never at module load, so a break test sees the edited file.
 */
function code(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

export function runNotificationFutureRemindersHiddenTests() {
  // ── The rule itself, against a fixed Cairo day ───────────────────────────────────────────────
  const today = "2026-10-24";
  assert.equal(noticeIsDue({ scheduled_for: "2026-12-01" }, today), false, "a Dec 01 reminder is not on the bell on Oct 24");
  assert.equal(noticeIsDue({ scheduled_for: "2026-10-25" }, today), false, "tomorrow's reminder is not due today");
  assert.equal(noticeIsDue({ scheduled_for: "2026-10-24" }, today), true, "a reminder is due ON its day");
  assert.equal(noticeIsDue({ scheduled_for: "2026-09-30" }, today), true, "a past notice stays on the bell");
  assert.equal(noticeIsDue({ scheduled_for: "2026-10-24T00:00:00+00:00" }, today), true, "a timestamp is read by its date");

  // ── The bell: all three reads fenced in SQL, and the rows checked again after ─────────────────
  const inApp = code("src/lib/notifications/in-app.ts");
  const bellStart = inApp.indexOf("export async function listInAppNotificationsForViewer(");
  const bellEnd = inApp.indexOf("export async function", bellStart + 1);
  assert.ok(bellStart >= 0 && bellEnd > bellStart, "the bell's list function is found");
  const bell = inApp.slice(bellStart, bellEnd);
  assert.equal(
    countOf(bell, `.lte("scheduled_for", today)`),
    3,
    "each of the bell's three notification_events reads is fenced at today, or future reminders fill its limit",
  );
  assert.equal(countOf(bell, "noticeIsDue(row, today)"), 1, "the bell checks each row again after its query");
  assert.match(bell, /const today = todayInCairo\(\)/, "the bell's day is the Cairo day, never the server's UTC day");

  // ── The module badges count the same rows the bell shows ─────────────────────────────────────
  const unread = code("src/lib/notifications/unread.ts");
  assert.equal(countOf(unread, `.lte("scheduled_for", today)`), 1, "module badges never count a reminder before its day");
  assert.equal(countOf(unread, "noticeIsDue(row, today)"), 1, "module badges check each row again after the query");
  assert.match(unread, /scheduled_for/, "the badge read selects scheduled_for, or the after-check sees no date");

  // ── The employee portal's five notices: newest DUE first ──────────────────────────────────────
  const portal = code("src/lib/employee-portal/service.ts");
  const portalStart = portal.indexOf("async function fetchPortalNotifications(");
  const portalEnd = portal.indexOf("async function", portalStart + 1);
  assert.ok(portalStart >= 0 && portalEnd > portalStart, "the portal notice read is found");
  assert.equal(
    countOf(portal.slice(portalStart, portalEnd), `.lte("scheduled_for", todayInCairo())`),
    1,
    "the portal's five slots are ordered by scheduled_for, so without the fence they go to reminders months ahead",
  );
}
