import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Contract guards for read-receipts on digest notifications
 * (src/lib/attendance/digest-read-receipts.ts): reuses the existing
 * notification-engine tables (notification_deliveries,
 * notification_user_states, email_delivery_events) rather than a parallel
 * tracking mechanism, and surfaces "has this employee actually seen it yet"
 * on the settlement dashboard's pending-digest list.
 */
export function runAttendanceDigestReadReceiptsTests() {
  const service = readFileSync("src/lib/attendance/digest-read-receipts.ts", "utf8");

  // 1. Batched, not N+1: the dashboard calls this once for every pending
  //    digest, so the lookup must be keyed off a single .in() query, not a
  //    per-digest round trip.
  assert.match(service, /\.in\("notification_event_id", uniqueEventIds\)/, "delivery lookup must be batched across all event IDs in one query");

  // 2. In-app read signal comes from the real read-receipt column, not a
  //    delivery/sent timestamp being misread as "read".
  assert.match(service, /notification_user_states/, "in-app read signal must come from notification_user_states.read_at");
  assert.match(service, /\.not\("read_at", "is", null\)/, "only rows with a real read_at count as read, not every delivered row");

  // 3. Email read signal comes from the real Resend open-tracking webhook
  //    event type, matched via provider_message_id — not assumed from send.
  assert.match(service, /event_type", "email\.opened"/, "email read signal must be the real email.opened webhook event, not assumed from delivery");

  // 4. Earliest-read semantics: if multiple read signals exist, the FIRST
  //    one is the meaningful "when did they first see it" timestamp.
  assert.match(service, /if \(!current \|\| row\.read_at < current\)/, "in-app read aggregation must keep the earliest read_at, not the latest");
  assert.match(service, /if \(!current \|\| row\.occurred_at < current\)/, "email-open aggregation must keep the earliest occurred_at, not the latest");

  // 5. Untracked digests (sent before this feature, or notification failed
  //    to queue) must report tracked:false, never a false "not read yet"
  //    read as if it were a confirmed signal.
  assert.match(service, /tracked: false/, "an untracked digest must be distinguishable from a tracked-but-unread one");

  // 6. The original send is the tracked anchor point — a later reminder
  //    resend must NOT overwrite it, or a real earlier read would be lost.
  const dashboard = readFileSync("src/lib/attendance/settlement-dashboard.ts", "utf8");
  assert.doesNotMatch(
    dashboard,
    /recordDigestNotificationEvent/,
    "remindAllPendingDigests must not re-anchor read-receipt tracking on every reminder resend — only the original send does",
  );
  const settlementService = readFileSync("src/lib/attendance/settlement-service.ts", "utf8");
  assert.match(settlementService, /await recordDigestNotificationEvent\(input\.digestId, eventId\)/, "sendDigest must record the notification event as the read-receipt anchor");

  // 7. The dashboard surfaces the receipt per pending digest, not just
  //    computing it and discarding it.
  assert.match(dashboard, /hasBeenRead: receipt \? receipt\.hasBeenRead : null/, "getSettlementDashboard must surface hasBeenRead on every pending digest");

  const view = readFileSync("src/components/attendance/settlement-dashboard-view.tsx", "utf8");
  assert.match(view, /digest\.hasBeenRead === true/, "the dashboard UI must render the read-receipt status, not just fetch it");
}
