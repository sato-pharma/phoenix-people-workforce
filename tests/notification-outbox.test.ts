import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  NOTIFICATION_OUTBOX_TABLE,
  notificationTableMissing,
  notificationWriteQueue,
  readQueuedNotificationWrite,
} from "../src/lib/notifications/notification-outbox.ts";

/**
 * THE NOTIFICATION WRITES SURVIVE A DATABASE RESTART.
 *
 * Owner, 23 Oct 2026: "protect the notification writes with the same outbox". On 22 October
 * production Postgres restarted FOUR times between 11:30 and 14:25 Cairo — postmaster start moving
 * at 08:30, 08:51, 09:33 and 11:25 UTC, recorded by the `database_restarted` detector, with
 * Cloudflare 520s and 521s at the edge. Everything writing through a short client timeout in those
 * minutes lost what it was writing.
 *
 * 🔴 WHAT MAKES THIS DIFFERENT FROM THE AUDIT TRAIL, AND WORSE. A lost audit row is a missing
 * record. A lost `notification_deliveries` row is a SECOND REAL EMAIL OR TELEGRAM MESSAGE to a
 * person: `upsertDelivery` is what records that a send succeeded, it used to swallow its own
 * failure with a log line, and the retry drain re-sends any delivery row still sitting open. So an
 * outage during the status write did not merely lose bookkeeping — it armed a duplicate send.
 *
 * The mechanism itself (the retry, the landing probe, the back-off, the throttle) is proved in
 * `tests/audit-outbox.test.ts`. What is proved here is the part that is specific to notifications,
 * including the one write that must NOT be queued.
 */
export function runNotificationOutboxTests() {
  const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf8");
  const SYSTEM = "src/lib/notifications/system.ts";

  // ── A STORED PAYLOAD IS CHECKED BEFORE IT IS TRUSTED ─────────────────────────────────────────
  assert.equal(readQueuedNotificationWrite(null), null);
  assert.equal(readQueuedNotificationWrite({}), null);
  assert.equal(
    readQueuedNotificationWrite({ kind: "notification_event", row: { a: 1 } }),
    null,
    "an event write with no event_key cannot be deduplicated on replay, so it is not replayed",
  );
  assert.equal(
    readQueuedNotificationWrite({ idempotencyKey: "k", kind: "notification_delivery" }),
    null,
    "a delivery write with no row has nothing to write",
  );
  assert.equal(
    readQueuedNotificationWrite({ eventKey: "e", kind: "notification_event", row: [1, 2] }),
    null,
    "an array is not a row",
  );
  assert.equal(readQueuedNotificationWrite({ eventKey: "e", kind: "invented", row: { a: 1 } }), null);

  const event = readQueuedNotificationWrite({ eventKey: "ek", kind: "notification_event", row: { subject: "x" } });
  assert.ok(event && event.kind === "notification_event" && event.eventKey === "ek");
  const delivery = readQueuedNotificationWrite({
    idempotencyKey: "ik",
    kind: "notification_delivery",
    row: { status: "sent" },
  });
  assert.ok(delivery && delivery.kind === "notification_delivery" && delivery.idempotencyKey === "ik");

  // ── WHAT IS WORTH KEEPING, AND WHAT A RETRY CAN NEVER FIX ────────────────────────────────────
  //
  // 🔴 THIS PREDICATE IS DELIBERATELY NARROWER THAN `schemaMissing` IN system.ts, which also
  // returns true for ANY error text containing the table's own name. That is tolerable where it
  // only decides whether to log. Here it decides whether to KEEP the write.
  assert.equal(notificationTableMissing(new Error("Could not find the table 'public.x'")), true);
  assert.equal(notificationTableMissing(new Error("PGRST205: not in schema cache")), true);
  assert.equal(notificationTableMissing(new Error('relation "notification_deliveries" does not exist')), true);
  assert.equal(
    notificationTableMissing(new Error("AbortError: Supabase request timed out.")),
    false,
    "the outage error is the whole reason the queue exists — it must be queued, never discarded",
  );
  assert.equal(
    notificationTableMissing({ code: "57014", message: "canceling statement due to statement timeout" }),
    false,
    "a statement timeout is a retry-worthy failure",
  );
  assert.equal(
    notificationTableMissing(new Error("insert into notification_deliveries failed: connection reset")),
    false,
    "AN ERROR THAT MERELY NAMES THE TABLE IS NOT A MISSING TABLE. system.ts's broader schemaMissing " +
      "would call this one 'schema missing' and throw the write away — losing exactly the write " +
      "this queue exists to keep.",
  );
  assert.equal(
    notificationWriteQueue.queueable?.(new Error("AbortError: Supabase request timed out.")),
    true,
    "the queue must accept an outage failure",
  );
  assert.equal(
    notificationWriteQueue.queueable?.(new Error("Could not find the table 'public.x'")),
    false,
    "and must refuse one a retry can never fix, or the row backs off for ever and is never written",
  );
  assert.equal(notificationWriteQueue.table, NOTIFICATION_OUTBOX_TABLE);

  // ── THE OUTCOME WRITE IS QUEUED; THE PRECONDITION WRITE IS NOT ───────────────────────────────
  const systemSource = read(SYSTEM);

  const upsertDeliveryStart = systemSource.indexOf("async function upsertDelivery(");
  assert.ok(upsertDeliveryStart > 0, `${SYSTEM} must still define upsertDelivery.`);
  const upsertDeliveryBody = systemSource.slice(upsertDeliveryStart, systemSource.indexOf("function isUniqueViolation"));
  assert.ok(
    upsertDeliveryBody.includes('kind: "notification_delivery"'),
    `${SYSTEM}'s upsertDelivery must persist through the outbox. A lost status write leaves the ` +
      "delivery row open, and the retry drain sends open rows again — a second real message.",
  );

  const createEventStart = systemSource.indexOf("async function createNotificationEvent(");
  assert.ok(createEventStart > 0, `${SYSTEM} must still define createNotificationEvent.`);
  const createEventBody = systemSource.slice(createEventStart, upsertDeliveryStart);
  assert.ok(
    !createEventBody.includes("persistNotificationWrite"),
    `${SYSTEM}'s createNotificationEvent must NOT be queued. Its id is what the delivery claim ` +
      "anchors to, so a caller that gets no id does not send — and a queued row landing hours later " +
      "would write a `status: 'sent'` notification asserting a send that never happened.",
  );
  assert.ok(
    createEventBody.includes("OUTBOX_RETRY_TIMEOUT_MS"),
    `${SYSTEM}'s createNotificationEvent must still RETRY, so a brief outage does not abort a send.`,
  );
  assert.ok(
    createEventBody.includes("OUTBOX_FIRST_ATTEMPT_TIMEOUT_MS"),
    "and its first attempt must stay on the shared request-path budget, not a number of its own.",
  );

  // ── THE QUEUE HAS A TABLE TO LAND IN ─────────────────────────────────────────────────────────
  //
  // CI reads migration FILES and never touches a database. The table was applied and read back out
  // of pg_class on staging and production by hand.
  const migration = read("supabase/migrations/20261023210001_notification_write_outbox.sql");
  assert.ok(migration.includes("create table if not exists public.notification_write_outbox"));
  for (const column of ["payload jsonb", "attempts integer", "last_error", "next_attempt_at", "created_at"]) {
    assert.ok(migration.includes(column), `notification_write_outbox is missing ${column}`);
  }
  assert.ok(
    migration.includes("enable row level security"),
    "a queued row carries a notification's whole payload, recipient included — service-role only.",
  );
  assert.ok(migration.includes("revoke all on public.notification_write_outbox from anon, authenticated"));
}
