import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  loadDueNotificationOutboxRows,
  type NotificationEmailInput,
  type NotificationOutboxRow,
} from "../src/lib/notifications/email.ts";

/**
 * The outbox batch window - why this test exists.
 *
 * On 2026-08-27 the production notification outbox was found frozen. The drain cron
 * (`/api/notifications/process?limit=50`, cron-job.org, every 5 minutes) was green: HTTP 200 on
 * every run, no errors anywhere. It had also processed exactly nothing since 2026-08-14, and 49
 * genuinely retryable emails had been sitting in the queue behind the blockage for 13 days.
 *
 * The cause was an ordering bug, not a broken query. A row that burns through its attempts never
 * leaves the ('pending','failed') window - nothing marks it terminal - and `attempts < max_attempts`
 * cannot be expressed in the SQL filter, because PostgREST has no column-to-column comparison. So
 * the loader fetched with `.limit(limit)` and applied the eligibility test afterwards, in JS. That
 * caps the batch BEFORE the dead rows are discarded rather than after. Once the number of exhausted
 * rows at the head of the queue reached the limit - exactly 50 of them, against a limit of 50 -
 * every run fetched the same 50 corpses, filtered all 50 away, and returned an empty batch forever.
 * Nothing downstream could tell that apart from "the queue is empty", which is why it ran silently
 * for 13 days and no alert fired.
 *
 * The fix pages past exhausted rows instead of letting one batch of them cap the scan. These tests
 * drive `loadDueNotificationOutboxRows` with an injected page fetcher, so the starvation case is
 * reproduced exactly, without a database.
 *
 * The headline assertion is the first one: a retryable row sitting behind a full batch of exhausted
 * rows must still come back. Break the paging and that assertion is the one that fires.
 */

const outboxScanPageSize = 100;
const outboxMaxScanPages = 10;

const samplePayload: NotificationEmailInput = {
  subject: "Outbox regression fixture",
  summary: "Never actually sent - this row exists only inside the test process.",
  title: "Outbox regression fixture",
};

function makeRow(id: string, attempts: number): NotificationOutboxRow {
  return {
    attempts,
    created_at: "2026-08-14T00:00:00.000Z",
    dedupe_key: `dedupe:${id}`,
    id,
    last_error: attempts > 0 ? "previous attempt failed" : null,
    locked_at: null,
    max_attempts: 5,
    next_attempt_at: null,
    payload: samplePayload,
    provider_message_id: null,
    sent_at: null,
    status: attempts > 0 ? "failed" : "pending",
    updated_at: "2026-08-14T00:00:00.000Z",
  };
}

/** `count` rows that have used up every attempt - the shape that froze production. */
function exhaustedRows(count: number, prefix = "dead"): NotificationOutboxRow[] {
  return Array.from({ length: count }, (_unused, index) => makeRow(`${prefix}-${index}`, 5));
}

function retryableRow(id: string): NotificationOutboxRow {
  return makeRow(id, 1);
}

/** A fake `.range(from, to)` reader over a fixed queue, recording every window it was asked for. */
function makePager(queue: NotificationOutboxRow[]) {
  const ranges: Array<[number, number]> = [];
  return {
    fetchPage: async (from: number, to: number) => {
      ranges.push([from, to]);
      return queue.slice(from, to + 1);
    },
    ranges,
  };
}

/** The structured second argument the loader passes to `console.log`. */
type LoggedPayload = {
  extra?: {
    limit?: number;
    pagesRead?: number;
    returned?: number;
    scanCappedAtPageLimit?: boolean;
    scanWindow?: number;
    skippedExhausted?: number;
  };
  level?: string;
  tags?: Record<string, string>;
};

export async function runNotificationOutboxBatchWindowTests() {
  // The headline. This is the production incident, reproduced.
  {
    const survivor = retryableRow("the-one-that-waited-13-days");
    const queue = [...exhaustedRows(50), survivor];
    const pager = makePager(queue);

    const due = await loadDueNotificationOutboxRows(50, pager.fetchPage);

    assert.deepEqual(
      due.map((row) => row.id),
      [survivor.id],
      "a retryable row sitting behind a FULL batch of exhausted rows must still be returned - "
        + "this is the exact shape that froze the production outbox for 13 days (50 exhausted rows "
        + "against a limit of 50). If this assertion fails, the batch is being capped before the "
        + "dead rows are discarded instead of after, and email retries are silently dead again.",
    );
  }

  // Exhausted rows deeper than a single page must not stop the scan either.
  {
    const survivor = retryableRow("behind-two-and-a-half-pages");
    const queue = [...exhaustedRows(250), survivor];
    const pager = makePager(queue);

    const due = await loadDueNotificationOutboxRows(50, pager.fetchPage);

    assert.deepEqual(
      due.map((row) => row.id),
      [survivor.id],
      "a retryable row behind 250 exhausted rows must be found - one wider page is not a fix, the "
        + "scan has to actually page.",
    );
    assert.equal(pager.ranges.length, 3, "reaching row 250 takes three pages of 100");
    assert.deepEqual(
      pager.ranges,
      [
        [0, 99],
        [100, 199],
        [200, 299],
      ],
      "pages must be contiguous and inclusive - an off-by-one here skips rows silently, which is "
        + "the same failure mode in a new costume",
    );
  }

  // An exhausted row must never be handed to the sender, however deep the scan goes.
  {
    const queue = [
      ...exhaustedRows(30),
      retryableRow("live-1"),
      ...exhaustedRows(30, "dead-b"),
      retryableRow("live-2"),
    ];
    const due = await loadDueNotificationOutboxRows(50, makePager(queue).fetchPage);

    assert.deepEqual(
      due.map((row) => row.id),
      ["live-1", "live-2"],
      "only rows with attempts < max_attempts may be returned, in queue order",
    );
    assert.equal(
      due.every((row) => row.attempts < row.max_attempts),
      true,
      "no exhausted row may survive the filter - retrying one forever is what filled the queue",
    );
  }

  // The limit still means something: paging past corpses must not turn into an unbounded batch.
  {
    const queue = Array.from({ length: 400 }, (_unused, index) => retryableRow(`live-${index}`));
    const due = await loadDueNotificationOutboxRows(10, makePager(queue).fetchPage);

    assert.equal(due.length, 10, "the caller's limit is still an upper bound on the batch");
    assert.equal(due[0]?.id, "live-0", "the oldest due row is still first - order is preserved");
  }

  // A short page means the queue is exhausted: stop, do not keep asking.
  {
    const pager = makePager(exhaustedRows(10));
    const due = await loadDueNotificationOutboxRows(50, pager.fetchPage);

    assert.deepEqual(due, [], "an all-exhausted queue yields nothing, which is correct");
    assert.equal(
      pager.ranges.length,
      1,
      "a page shorter than the page size means there is no more queue - asking again is a wasted "
        + "round trip on every single drain run",
    );
  }

  // And the scan is bounded: a pathological queue must not turn the drain into an endless loop.
  {
    const pager = makePager(exhaustedRows(5_000));
    const due = await loadDueNotificationOutboxRows(50, pager.fetchPage);

    assert.deepEqual(due, [], "5,000 exhausted rows yield nothing");
    assert.equal(
      pager.ranges.length,
      outboxMaxScanPages,
      `the scan stops after ${outboxMaxScanPages} pages (${outboxMaxScanPages * outboxScanPageSize} `
        + "rows) rather than walking the whole table on every run",
    );
  }

  // Source guard: the shape that caused the incident must not quietly return.
  {
    const source = readFileSync(new URL("../src/lib/notifications/email.ts", import.meta.url), "utf8");
    const marker = "async function fetchDueNotificationOutboxPage";
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, "the due-page fetcher must still exist under that name");

    // Slice by marker, never by a fixed byte window - a byte window false-fails the moment the
    // file shifts above it.
    const end = source.indexOf("\n}", start);
    assert.notEqual(end, -1, "the due-page fetcher must be a closed function body");
    const fetcher = source.slice(start, end);

    assert.equal(
      fetcher.includes(".range("),
      true,
      "the due-page fetcher must read a range - that is what lets the loader page past exhausted rows",
    );
    assert.equal(
      fetcher.includes(".limit("),
      false,
      "the due-page fetcher must NOT cap the SQL read: `.limit()` here re-creates the 2026-08-14 "
        + "freeze, because the eligibility test cannot run in SQL and therefore runs after the cap",
    );
  }

  // ---------------------------------------------------------------------------------------------
  // The SIGNAL. Paging past dead rows cures the freeze; it does not cure the blindness that let the
  // freeze last thirteen days, and those are two different defects. Ported from the parallel fix in
  // PR #2463, which found this and was superseded by #2462 before it could land.
  // ---------------------------------------------------------------------------------------------

  /** Run the loader with `console.log` captured, so the emitted signal can be asserted on. */
  async function captureLogs(limit: number, queue: NotificationOutboxRow[]) {
    const entries: Array<{ message: string; payload: LoggedPayload }> = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => {
      entries.push({ message: String(args[0]), payload: args[1] as LoggedPayload });
    };
    try {
      const due = await loadDueNotificationOutboxRows(limit, makePager(queue).fetchPage);
      return { due, entries };
    } finally {
      // Restore in `finally`: a throw here would otherwise leave every later test in this process
      // writing into the array above instead of to the terminal.
      console.log = realLog;
    }
  }

  const walkedPastMessage = "Outbox batch walked past exhausted rows";

  // The headline for this half of the fix.
  {
    const survivor = retryableRow("behind-the-corpses");
    const { entries } = await captureLogs(50, [...exhaustedRows(50), survivor]);
    const entry = entries.find((item) => item.message === walkedPastMessage);

    assert.notEqual(
      entry,
      undefined,
      "walking past exhausted rows MUST emit a log line. The drain returned HTTP 200 and "
        + "`attempted: 0` every five minutes for thirteen days and nothing anywhere said why - an "
        + "empty queue and a starved queue are indistinguishable from the outside. Paging past the "
        + "dead rows silently fixes the freeze and leaves that blindness exactly as it was, so the "
        + "next occurrence is just as invisible as the one that cost thirteen days of retries.",
    );
    assert.equal(
      entry?.payload?.extra?.skippedExhausted,
      50,
      "the count must be the number of dead rows actually walked past - that number climbing over "
        + "days is the early warning, and a bare 'something was skipped' cannot show a trend",
    );
    assert.equal(entry?.payload?.extra?.returned, 1, "and it must say how many live rows the batch got");
  }

  // A healthy queue must stay quiet, or the signal is worthless.
  {
    const { entries } = await captureLogs(10, [retryableRow("live-1"), retryableRow("live-2")]);

    assert.equal(
      entries.some((item) => item.message === walkedPastMessage),
      false,
      "a queue with no exhausted rows must log NOTHING. A line on every healthy tick is noise, and "
        + "noise on a 5-minute cron is how the real warning gets filtered out and ignored",
    );
  }

  // Degraded (walked past some) and about-to-starve (ran out of scan) must not look the same.
  {
    const mild = await captureLogs(50, [...exhaustedRows(50), retryableRow("survivor")]);
    const mildEntry = mild.entries.find((item) => item.message === walkedPastMessage);
    assert.equal(
      mildEntry?.payload?.level,
      "warning",
      "walking past dead rows but still filling the batch is a warning, not yet an incident",
    );

    // A full scan window of corpses, batch still unfilled: the freeze, back at a higher threshold.
    const starved = await captureLogs(50, exhaustedRows(outboxScanPageSize * outboxMaxScanPages));
    const starvedEntry = starved.entries.find((item) => item.message === walkedPastMessage);
    assert.deepEqual(starved.due, [], "a fully exhausted scan window returns nothing - the 2026-08-14 shape");
    assert.equal(
      starvedEntry?.payload?.extra?.scanCappedAtPageLimit,
      true,
      "when the scan hits its ceiling with the batch still unfilled, THAT is the freeze returning "
        + "at a higher threshold, and it must be distinguishable from an ordinary walk-past",
    );
    assert.equal(
      starvedEntry?.payload?.level,
      "error",
      "and it must escalate past 'warning' - a degraded drain and a dead one cannot share a level, "
        + "or the dead one is invisible again",
    );
  }
}
