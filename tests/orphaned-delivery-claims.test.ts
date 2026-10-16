import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  closeOrphanedDeliveryClaim,
  DELIVERY_CLAIM_GRACE_MS,
  isOrphanedDeliveryClaim,
  ORPHANED_DELIVERY_CLAIM_REASON,
} from "../src/lib/notifications/system.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * A send killed between its claim and its fill-in must not leave a permanent alarm - why this exists.
 *
 * `claimDelivery` writes an empty `pending` notification_deliveries row before it sends, and fills it
 * in when the send ends. On 2026-10-16 at 06:37:04 a deploy replaced the container in the middle of
 * `phoenix-notify-daily`: one Telegram claim (B-119, a marketing overdue reminder) had been written
 * and never filled. The Telegram retry drain found it due, saw no payload to send, stepped over it
 * WITHOUT counting an attempt, and did so again on every 5-minute tick - so `assessDrainHealth` read
 * "work was due and nothing was attempted" for ever, and `phoenix-process-notifications` pinged
 * /fail from 06:40 on.
 *
 * The headline assertion is the second block: a bare claim older than the grace is CLOSED. The first
 * and the third matter as much - a claim inside the grace may be a send still in flight, and the
 * close must never overwrite a row somebody filled in between the read and the write.
 */

const NOW = Date.parse("2026-10-16T04:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

type Recorded = {
  eqs: Array<[string, unknown]>;
  ins: Array<[string, unknown]>;
  lte: Array<[string, unknown]>;
  patch: Record<string, unknown> | null;
  table: string | null;
};

/** A recording stand-in for the one chain the helper uses: update().eq().in().lte().select(). */
function fakeSupabase(result: { data: unknown[] | null; error: unknown }) {
  const rec: Recorded = { eqs: [], ins: [], lte: [], patch: null, table: null };
  let updates = 0;
  const chain = {
    eq(column: string, value: unknown) {
      rec.eqs.push([column, value]);
      return chain;
    },
    in(column: string, value: unknown) {
      rec.ins.push([column, value]);
      return chain;
    },
    lte(column: string, value: unknown) {
      rec.lte.push([column, value]);
      return chain;
    },
    select() {
      return Promise.resolve(result);
    },
  };
  const client = {
    from(table: string) {
      rec.table = table;
      return {
        update(patch: Record<string, unknown>) {
          updates += 1;
          rec.patch = patch;
          return chain;
        },
      };
    },
  };
  return { client: client as never, rec, updateCount: () => updates };
}

function captureLogLines() {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return { lines, restore: () => { console.log = original; } };
}

function slice(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `source must contain ${from}`);
  const end = source.indexOf(to, start + from.length);
  assert.ok(end > start, `source must contain ${to} after ${from}`);
  return source.slice(start, end);
}

export async function runOrphanedDeliveryClaimTests() {
  // 1 - the age rule. Unknown age is NOT old: a row we cannot date is never closed on a guess.
  {
    assert.equal(
      isOrphanedDeliveryClaim({ created_at: iso(NOW - 30 * MIN), updated_at: iso(NOW - 30 * MIN) }, NOW),
      true,
      "a claim nobody touched for half an hour is orphaned",
    );
    assert.equal(
      isOrphanedDeliveryClaim({ updated_at: iso(NOW - (DELIVERY_CLAIM_GRACE_MS - 1)) }, NOW),
      false,
      "one millisecond inside the grace may still be a send in flight",
    );
    assert.equal(
      isOrphanedDeliveryClaim({ updated_at: iso(NOW - DELIVERY_CLAIM_GRACE_MS) }, NOW),
      true,
      "exactly at the grace is orphaned - the drain and the probe both treat the line as inclusive",
    );
    assert.equal(
      isOrphanedDeliveryClaim({ created_at: iso(NOW - 60 * MIN), updated_at: iso(NOW - MIN) }, NOW),
      false,
      "updated_at decides, not created_at: a row touched a minute ago is alive however old it is",
    );
    assert.equal(isOrphanedDeliveryClaim({ created_at: iso(NOW - 60 * MIN) }, NOW), true, "created_at stands in when updated_at is absent");
    assert.equal(isOrphanedDeliveryClaim({}, NOW), false, "no timestamps at all is unknown, never orphaned");
    assert.equal(isOrphanedDeliveryClaim({ updated_at: "not a date" }, NOW), false, "an unparseable stamp is unknown, never orphaned");
  }

  // 2 - THE HEADLINE: the 06:37:04 row. An old bare claim is closed as `skipped`, with its reason,
  // and no further attempt scheduled - which is what finally empties the drain-health reading.
  {
    const { client, rec, updateCount } = fakeSupabase({ data: [{ id: "row-1" }], error: null });
    const closed = await closeOrphanedDeliveryClaim(
      client,
      { attempts: 0, created_at: iso(NOW - 3 * 60 * MIN), id: "row-1", updated_at: iso(NOW - 3 * 60 * MIN) },
      NOW,
    );
    assert.equal(closed, true, "an old bare claim must be closed");
    assert.equal(updateCount(), 1);
    assert.equal(rec.table, "notification_deliveries");
    assert.equal(rec.patch?.status, "skipped", "closed means skipped, so no drain ever picks it up again");
    assert.equal(rec.patch?.next_attempt_at, null, "and nothing schedules another try");
    assert.equal(rec.patch?.last_error, ORPHANED_DELIVERY_CLAIM_REASON, "the row must say WHY it was closed");
    assert.equal(rec.patch?.attempts, 0, "no attempt is invented for a send that never ran");
    assert.deepEqual(rec.eqs, [["id", "row-1"]], "exactly this row");
  }

  // 3 - the close is CONDITIONAL, so a send that fills the row in between our read and our write is
  // never overwritten: still open, and still untouched since the grace cutoff.
  {
    const { client, rec } = fakeSupabase({ data: [], error: null });
    const closed = await closeOrphanedDeliveryClaim(
      client,
      { attempts: 0, id: "row-2", updated_at: iso(NOW - 40 * MIN) },
      NOW,
    );
    assert.equal(closed, false, "a conditional update that matched no row closed nothing");
    assert.deepEqual(rec.ins, [["status", ["failed", "pending", "retrying"]]], "only a row that is STILL open");
    assert.deepEqual(
      rec.lte,
      [["updated_at", iso(NOW - DELIVERY_CLAIM_GRACE_MS)]],
      "only a row still untouched since the grace cutoff - the guard against clobbering a fill-in",
    );
  }

  // 4 - inside the grace nothing is written at all.
  {
    const { client, updateCount } = fakeSupabase({ data: [{ id: "row-3" }], error: null });
    const closed = await closeOrphanedDeliveryClaim(client, { id: "row-3", updated_at: iso(NOW - 2 * MIN) }, NOW);
    assert.equal(closed, false, "a young claim is left alone");
    assert.equal(updateCount(), 0, "and not even a conditional write is attempted");
  }

  // 5 - a failed write never throws (the drain must finish its tick) and is not reported as closed.
  {
    const { client } = fakeSupabase({ data: null, error: new Error("boom") });
    const log = captureLogLines();
    let closed: boolean;
    try {
      closed = await closeOrphanedDeliveryClaim(client, { id: "row-4", updated_at: iso(NOW - 40 * MIN) }, NOW);
    } finally {
      log.restore();
    }
    assert.equal(closed, false, "an errored close is not a closed claim");
    assert.ok(
      log.lines.some((l) => l.includes("orphaned_delivery_claim_close_failed")),
      "and it must be sayable, not silent",
    );
  }

  // 6 - WIRING (comment-stripped, CRLF-safe): both drains close an orphan instead of stepping over
  // it, and read the two columns the age rule needs. A bare `continue` on the no-payload branch is
  // exactly the defect, so it must not come back.
  {
    const system = stripComments(readFileSync(new URL("../src/lib/notifications/system.ts", import.meta.url), "utf8"));
    const telegramDrain = slice(system, "export async function processTelegramDeliveryRetries", "export async function processPushDeliveryRetries");
    const pushDrain = slice(system, "export async function processPushDeliveryRetries", "export async function retryTelegramDeliveryById");

    for (const [label, body] of [["telegram", telegramDrain], ["push", pushDrain]] as const) {
      assert.ok(body.includes("closeOrphanedDeliveryClaim(supabase, row, nowMs)"), `${label} drain must close an orphaned claim`);
      assert.match(body, /created_at,updated_at"\)/, `${label} drain must read created_at and updated_at to date the claim`);
      assert.ok(body.includes("closedOrphans"), `${label} drain must report how many it closed`);
    }
    assert.doesNotMatch(
      telegramDrain,
      /if \(!isResendableTelegramPayload\(telegram\)\)\s*continue;/,
      "the telegram drain must not step over a payload-less row without closing it",
    );
    assert.doesNotMatch(
      pushDrain,
      /if \(!push\?\.externalId \|\| !push\?\.title \|\| !push\?\.message\)\s*continue;/,
      "the push drain must not step over a payload-less row without closing it",
    );
  }

  // 7 - the PROBE AND THE DRAINS AGREE. If the probe counted a claim the drains still wait on, a
  // killed send would trip the day's one drain alert in the minutes before the drain closed it.
  {
    const probe = stripComments(readFileSync(new URL("../src/lib/notifications/drain-health.ts", import.meta.url), "utf8"));
    const delivery = slice(probe, "async function countDueDeliveryRows", "export async function readDrainQueueBacklog");
    assert.ok(probe.includes("DELIVERY_CLAIM_GRACE_MS"), "the probe must use the drains' own grace constant");
    assert.ok(
      delivery.includes('.lte("updated_at", claimGraceCutoffIso)'),
      "the delivery probe must ignore rows touched inside the claim grace",
    );
    const outbox = slice(probe, "async function countDueOutboxRows", "async function countDueDeliveryRows");
    assert.ok(!outbox.includes("updated_at"), "the email OUTBOX is a different table and keeps its own rule");
  }
}
