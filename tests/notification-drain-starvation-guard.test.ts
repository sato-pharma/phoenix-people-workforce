import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Head-of-line starvation in the notification retry drains — why this test exists.
 *
 * A terminally-failed row keeps a status the drain's own query selects (`failed`) and a
 * `next_attempt_at` of NULL, which that query's `.or(next_attempt_at.is.null, …)` MATCHES. So it
 * never leaves the due window. The eligibility test that would discard it — `attempts <
 * max_attempts` — runs in JS, *after* the SQL `.limit()`/`.range()` has already counted it.
 *
 * Once `limit` exhausted rows collect at the head of the queue, every run fetches the same corpses,
 * discards all of them, and returns an empty batch. Forever. The cron stays green, HTTP 200,
 * `attempted: 0`, and nothing downstream can tell that apart from "the queue is empty" — which is
 * why it ran for 13 days on the email outbox before anyone noticed (#2462), silently killing every
 * email retry in that window.
 *
 * #2462 fixed the email outbox by paging past the dead rows. That works, but it has a ceiling
 * (`outboxScanPageSize * outboxMaxScanPages` = 1,000 rows) and the dead rows still accumulate, so
 * the same freeze returns once 1,000 of them collect. It also left the telegram and push drains
 * untouched — and on 2026-08-27 the telegram window already held 25 exhausted rows against a limit
 * of 50, push 16. Both were counting toward the identical failure.
 *
 * The cure these tests pin is to keep dead rows OUT of the window in SQL. `attempts < max_attempts`
 * is not expressible in PostgREST (no column-to-column comparison), but `attempts < 5` is — and
 * `max_attempts` is `NOT NULL DEFAULT 5` on both tables, carrying 5 on all 22,304 production rows,
 * written only from these constants. So the two tests coincide for every row this app creates.
 *
 * The headline assertion is the first in each block: the drain's query must carry
 * `.lt("attempts", <the constant>)`. Break that and the drain starves again, silently.
 *
 * These are source assertions rather than behavioural ones because the telegram and push drains
 * call `getSupabaseAdmin()` directly and take no injectable reader. Every slice below is taken by
 * MARKER, never by a fixed byte window — a byte window false-fails the moment anything above it in
 * the file shifts.
 */

const EMAIL = "../src/lib/notifications/email.ts";
const SYSTEM = "../src/lib/notifications/system.ts";

function read(relative: string) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

/** Slice one function's query-builder chain: from `marker` to the `if (error)` that follows it. */
function sliceQuery(source: string, marker: string, label: string) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${label}: could not find ${JSON.stringify(marker)} — it was renamed or removed`);
  const end = source.indexOf("if (error", start);
  assert.notEqual(end, -1, `${label}: no error check found after ${JSON.stringify(marker)}`);
  assert.ok(end > start, `${label}: slice is inverted`);
  return source.slice(start, end);
}

/** The literal a `const <name> = <n>;` declaration is bound to. */
function constValue(source: string, name: string) {
  const match = source.match(new RegExp(`const ${name} = (\\d+);`));
  assert.ok(match, `expected a numeric declaration for ${name}`);
  return Number(match[1]);
}

export async function runNotificationDrainStarvationGuardTests() {
  const emailSource = read(EMAIL);
  const systemSource = read(SYSTEM);

  const drains = [
    {
      constant: "notificationOutboxMaxAttempts",
      label: "email outbox drain",
      marker: "async function fetchDueNotificationOutboxPage",
      source: emailSource,
    },
    {
      constant: "notificationDeliveryMaxAttempts",
      label: "telegram delivery retry drain",
      marker: "export async function processTelegramDeliveryRetries",
      source: systemSource,
    },
    {
      constant: "notificationDeliveryMaxAttempts",
      label: "push delivery retry drain",
      marker: "export async function processPushDeliveryRetries",
      source: systemSource,
    },
  ];

  for (const drain of drains) {
    const query = sliceQuery(drain.source, drain.marker, drain.label);

    // THE HEADLINE. Without this the drain starves behind its own dead rows.
    assert.ok(
      query.includes(`.lt("attempts", ${drain.constant})`),
      `${drain.label}: the query MUST carry .lt("attempts", ${drain.constant}). Without it, rows `
        + "that have burned every retry stay in the due window forever (terminal rows keep "
        + "status 'failed' and next_attempt_at NULL, both of which this query matches) and are only "
        + "discarded in JS AFTER the row cap. Once the cap is filled with them the drain returns an "
        + "empty batch on every run, permanently, with a green cron and no error — the exact failure "
        + "that killed every email retry for 13 days.",
    );

    // A literal here silently decouples from the eligibility check the loop actually applies.
    assert.doesNotMatch(
      query,
      /\.lt\("attempts", \d/,
      `${drain.label}: filter on the named constant, never a bare number — a literal drifts away `
        + "from the per-row max_attempts check without anything failing.",
    );

    // Ties in created_at make page/limit boundaries undefined between separate reads.
    assert.ok(
      query.includes(`.order("id"`),
      `${drain.label}: needs .order("id") after .order("created_at"). created_at is not unique `
        + "(7 production rows share one), and without a total order the row at a page or limit "
        + "boundary can be skipped or returned twice.",
    );
    const createdAtAt = query.indexOf(`.order("created_at"`);
    const idAt = query.indexOf(`.order("id"`);
    assert.ok(
      createdAtAt !== -1 && createdAtAt < idAt,
      `${drain.label}: .order("id") must come AFTER .order("created_at") — it is the tiebreaker, `
        + "not the primary sort. Ahead of it, the queue stops draining oldest-first.",
    );
  }

  // The SQL filter is only equivalent to the per-row check while both say 5, which is also the
  // column default. If someone retunes one, this fires rather than the drain quietly mis-selecting.
  const outboxMax = constValue(emailSource, "notificationOutboxMaxAttempts");
  const deliveryMax = constValue(systemSource, "notificationDeliveryMaxAttempts");
  assert.equal(
    outboxMax,
    5,
    "notificationOutboxMaxAttempts must match notification_outbox.max_attempts (NOT NULL DEFAULT 5). "
      + "If the retry budget genuinely changes, change the column default in a migration too — "
      + "otherwise the SQL prefilter and the per-row check disagree and rows are wrongly skipped.",
  );
  assert.equal(
    deliveryMax,
    5,
    "notificationDeliveryMaxAttempts must match notification_deliveries.max_attempts "
      + "(NOT NULL DEFAULT 5) — same reasoning as the outbox constant above.",
  );

  // The JS eligibility checks must survive: the SQL filter is a prefilter, not the authority.
  assert.ok(
    read(EMAIL).includes("row.attempts < row.max_attempts"),
    "the email loader must KEEP its per-row attempts < max_attempts filter — the SQL filter compares "
      + "against a constant, so it is only exact while every row carries that max_attempts. The JS "
      + "check is what stays correct if one ever does not.",
  );
  const perRowChecks = systemSource.match(/if \(attempts >= maxAttempts\) continue;/g) ?? [];
  assert.ok(
    perRowChecks.length >= 2,
    "the telegram and push drains must KEEP their per-row `attempts >= maxAttempts` guards — the "
      + `SQL prefilter does not replace them (found ${perRowChecks.length}, expected at least 2).`,
  );
}
