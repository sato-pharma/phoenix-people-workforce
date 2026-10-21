import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEAD_TOKEN_POLL_MIN_REFUSALS,
  DEAD_TOKEN_POLL_WINDOW_MS,
  assessDeadTokenPolling,
  buildDeadTokenPollMessage,
  summariseDeadTokenAlarmDeliveries,
  type DeadTokenPollJudgeableLink,
} from "@/lib/share-links/dead-token-polling";
import { SHARE_LINK_FEEDS } from "@/lib/share-links/feeds";

/**
 * A dead share-link token that is still being read, and the alarm that finally says so.
 *
 * NOTHING HERE TOUCHES A DATABASE. `dead-token-polling.ts` and `feeds.ts` are import-free by
 * design precisely so this file can read them; the IO lives in `dead-token-polling-alert.ts` and
 * `refusal-counter.ts`, which are deliberately NOT imported — doing so would pull
 * `@/lib/supabase/server` into a unit test.
 *
 * Three different things are pinned, and they fail for different reasons:
 *
 *   1. The verdict itself, including the real 2026-08-05 shape: a Direct Orders sheet copy that
 *      polled a revoked token once a minute for 59 days while Phoenix said nothing.
 *   2. That the three token guards still COUNT the refusal on both dead branches. This is the one
 *      that matters most, because removing the count breaks the feature silently — the judgement
 *      keeps passing its own tests against a column nothing writes any more, and the verdict is
 *      "healthy" for ever.
 *   3. That the alarm carries no email channel, and that the feed registry's table names are the
 *      ones the three services actually query. A mistyped table name there reads nothing and
 *      reports healthy; it cannot fail any other way.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-03T08:35:00.000Z");

function link(overrides: Partial<DeadTokenPollJudgeableLink> = {}): DeadTokenPollJudgeableLink {
  return {
    expiresAt: "2100-01-01T00:00:00.000Z",
    id: "link-1",
    label: "Owner live Google Sheet feed",
    lastRefusedAt: new Date(NOW - 60 * 1000).toISOString(),
    refusedCount: 1_440,
    revokedAt: new Date(NOW - 59 * DAY).toISOString(),
    sheet: "Direct Orders",
    ...overrides,
  };
}

export async function runShareLinkDeadTokenPollingTests() {
  // ---------------------------------------------------------------------------
  // 1. The shape this exists for: the 2026-08-05 ghost sheet.
  // ---------------------------------------------------------------------------
  const ghost = assessDeadTokenPolling(
    [link({ refusedCount: 84_496, revokedAt: new Date(NOW - 59 * DAY).toISOString() })],
    NOW,
  );
  assert.equal(ghost.healthy, false, "a revoked token polled once a minute for 59 days must not read as healthy");
  assert.equal(ghost.polled.length, 1);
  assert.equal(ghost.polled[0]?.reason, "revoked");
  assert.equal(ghost.polled[0]?.refusals, 84_496);
  assert.equal(ghost.polled[0]?.deadForDays, 59, "deadForDays comes from the revocation, not from first sighting");
  assert.equal(ghost.polled[0]?.sheet, "Direct Orders");

  // ---------------------------------------------------------------------------
  // 2. A LIVE link is never reported, however much traffic it carries. This is the whole
  //    distinction the alert rests on — the live sheet and the ghost look identical by traffic,
  //    and only the link's own state separates them. A passcode typo on the human surface also
  //    refuses, and that must never page anybody.
  // ---------------------------------------------------------------------------
  const live = assessDeadTokenPolling([link({ refusedCount: 99_999, revokedAt: null })], NOW);
  assert.equal(live.healthy, true, "a live, unexpired link is the feature working — never a finding");

  // ---------------------------------------------------------------------------
  // 3. The floor separates an automation from a person. One stale bookmark is not a stuck trigger.
  // ---------------------------------------------------------------------------
  const human = assessDeadTokenPolling([link({ refusedCount: DEAD_TOKEN_POLL_MIN_REFUSALS - 1 })], NOW);
  assert.equal(human.healthy, true, `below ${DEAD_TOKEN_POLL_MIN_REFUSALS} refusals is a person, not a poller`);
  const automation = assessDeadTokenPolling([link({ refusedCount: DEAD_TOKEN_POLL_MIN_REFUSALS })], NOW);
  assert.equal(automation.healthy, false, "the floor is inclusive — exactly the threshold is a finding");

  // ---------------------------------------------------------------------------
  // 4. The window is what makes the alert STOP once the ghost does. The counter is never reset, so
  //    without this a closed incident would be reported every day for ever.
  // ---------------------------------------------------------------------------
  const stopped = assessDeadTokenPolling(
    [link({ lastRefusedAt: new Date(NOW - DEAD_TOKEN_POLL_WINDOW_MS - HOUR).toISOString() })],
    NOW,
  );
  assert.equal(stopped.healthy, true, "a trigger somebody stopped yesterday is history, not a finding");
  const stillGoing = assessDeadTokenPolling(
    [link({ lastRefusedAt: new Date(NOW - DEAD_TOKEN_POLL_WINDOW_MS + HOUR).toISOString() })],
    NOW,
  );
  assert.equal(stillGoing.healthy, false, "inside the window is still being polled");

  // ---------------------------------------------------------------------------
  // 5. Expiry is the other way a link dies, and revocation wins when both apply.
  // ---------------------------------------------------------------------------
  const lapsed = assessDeadTokenPolling(
    [link({ expiresAt: new Date(NOW - 10 * DAY).toISOString(), revokedAt: null })],
    NOW,
  );
  assert.equal(lapsed.polled[0]?.reason, "expired");
  assert.equal(lapsed.polled[0]?.deadForDays, 10, "a lapsed link's age is measured from its expiry");
  const both = assessDeadTokenPolling(
    [link({ expiresAt: new Date(NOW - 10 * DAY).toISOString(), revokedAt: new Date(NOW - 40 * DAY).toISOString() })],
    NOW,
  );
  assert.equal(both.polled[0]?.reason, "revoked", "revocation is the act somebody took and takes precedence");
  assert.equal(both.polled[0]?.deadForDays, 40);

  // ---------------------------------------------------------------------------
  // 6. Unparseable stamps are skipped, never guessed at and never thrown on.
  // ---------------------------------------------------------------------------
  const unparseable = assessDeadTokenPolling(
    [
      link({ id: "bad-refused", lastRefusedAt: "not a date" }),
      link({ id: "no-refusal", lastRefusedAt: null }),
      link({ id: "bad-dates", expiresAt: "nonsense", revokedAt: "nonsense" }),
      link({ id: "bad-count", refusedCount: Number.NaN }),
    ],
    NOW,
  );
  assert.equal(unparseable.healthy, true, "an unjudgeable row is skipped, not invented and not thrown on");

  // ---------------------------------------------------------------------------
  // 7. Order is busiest first and STABLE on ties — the alert's idempotency key is built from this
  //    list, so an unstable order would send the same finding again under a different key.
  // ---------------------------------------------------------------------------
  const ordered = assessDeadTokenPolling(
    [
      link({ id: "b-quiet", refusedCount: 20 }),
      link({ id: "a-loud", refusedCount: 5_000, sheet: "Marketing Requests" }),
      link({ id: "c-tied", refusedCount: 20 }),
      link({ id: "a-tied", refusedCount: 20 }),
    ],
    NOW,
  );
  assert.deepEqual(
    ordered.polled.map((poll) => poll.id),
    ["a-loud", "a-tied", "b-quiet", "c-tied"],
    "busiest first, then by id so the same set always produces the same key",
  );

  // ---------------------------------------------------------------------------
  // 8. The message says what it is, how long, and what to do — and carries no token.
  // ---------------------------------------------------------------------------
  const message = buildDeadTokenPollMessage(ghost);
  assert.ok(message.includes("Direct Orders"), "the message names the sheet in words, never a table");
  assert.ok(message.includes("84,496"), "the refusal count is readable, with separators");
  assert.ok(message.includes("59 day(s) ago"), "it says how long this has been going on");
  assert.ok(
    message.includes("no data is going out"),
    "it must say plainly that nothing is exposed — this is a stale-copy problem, not a breach",
  );
  assert.ok(message.includes("script.google.com"), "it carries the one action that actually stops it");
  assert.ok(!/[A-Za-z0-9_-]{32,}/.test(message), "no token-shaped string may ever reach the message body");

  // ---------------------------------------------------------------------------
  // 9. THE COUNTING ITSELF. Both dead branches of all three guards must record the refusal, or the
  //    judgement above grades a column nothing writes and answers "healthy" for ever.
  // ---------------------------------------------------------------------------
  const guards = [
    { file: "src/lib/direct-orders/report-share-links.ts", fn: "assertDirectOrderShareToken" },
    { file: "src/lib/marketing-requests/report-share-links.ts", fn: "assertMarketingShareToken" },
    { file: "src/lib/recruitment/cv-lifecycle-share-links.ts", fn: "assertCvLifecycleShareToken" },
  ];
  for (const guard of guards) {
    const source = readFileSync(guard.file, "utf8");
    const body = source.slice(source.indexOf(`export async function ${guard.fn}`));
    assert.ok(body.length > 0, `${guard.fn} not found in ${guard.file}`);
    const revoked = body.indexOf("revoked_at");
    const expired = body.indexOf("expires_at");
    assert.ok(revoked >= 0 && expired >= 0, `${guard.file}: both dead branches must still be there`);
    const counts = [...body.matchAll(/noteDeadShareTokenRead\(/g)];
    assert.ok(
      counts.length >= 2,
      `${guard.file}: both the revoked and the expired branch of ${guard.fn} must count the refusal `
        + "— without it a polled dead token is invisible to Phoenix again, exactly as it was for 59 days",
    );
    // And the refusal must still BE a refusal: counting it may not swallow the throw.
    assert.ok(
      body.includes('throw forbiddenError("This link has been revoked.")')
        && body.includes('throw forbiddenError("This link has expired.")'),
      `${guard.file}: counting the read must not change the answer the caller gets`,
    );
  }

  // ---------------------------------------------------------------------------
  // 10. The registry names the tables the services actually query, and the alarm sends no email.
  // ---------------------------------------------------------------------------
  const tables = SHARE_LINK_FEEDS.map((feed) => feed.table);
  assert.deepEqual(
    [...tables].sort(),
    [
      "ats_cv_lifecycle_share_links",
      "direct_order_report_share_links",
      "marketing_request_report_share_links",
    ],
    "the sweep reads these three tables — a name that matches no table reads nothing and reports healthy",
  );
  for (const feed of SHARE_LINK_FEEDS) {
    assert.ok(feed.sheet.trim().length > 0, `${feed.table} must carry a human sheet name`);
    assert.ok(
      feed.screen === null || feed.screen.startsWith("/"),
      `${feed.table}: a screen is an app path or nothing at all`,
    );
  }
  for (const guard of guards) {
    const source = readFileSync(guard.file, "utf8");
    assert.ok(
      tables.some((table) => source.includes(table)),
      `${guard.file} queries a share-link table the registry does not list`,
    );
  }

  const alarm = readFileSync("src/lib/share-links/dead-token-polling-alert.ts", "utf8");
  assert.ok(
    alarm.includes('channels: ["in_app", "telegram", "push"]'),
    "the alarm's channels are in-app, Telegram and push",
  );
  assert.ok(
    !/"email"/.test(alarm),
    "no email — a system-health alarm must not travel by a channel it might be reporting broken",
  );
  assert.ok(
    alarm.includes('.eq("surface", "feed")'),
    "feed links only: a feed token is never typed by a person, which is what makes the message's claim true",
  );
  assert.ok(
    !/select\([^)]*token/.test(alarm),
    "the sweep must never select the token column — it cannot reach a log line if it is never read",
  );

  // 4. The audit row says what the run really did. The sweep runs every 15 minutes and the
  // idempotency key holds the message to once a Cairo day, so 95 of 96 runs send nothing — yet
  // the alarm wrote "delivered to 1 recipient(s)" on every one of them (1,792 rows, 3–22 Oct 2026).
  const repeat = [
    { reason: "Delivery already sent.", status: "skipped" },
    { reason: "Delivery already sent.", status: "skipped" },
    { reason: "Delivery already in progress.", status: "skipped" },
  ];
  assert.deepEqual(
    summariseDeadTokenAlarmDeliveries([repeat]),
    { reached: 0, repeats: 1, unreached: 0 },
    "a 15-minute repeat of today's alert is a repeat — never counted as delivered",
  );
  assert.deepEqual(
    summariseDeadTokenAlarmDeliveries([[{ status: "sent" }, { reason: "Telegram is not connected.", status: "skipped" }]]),
    { reached: 1, repeats: 0, unreached: 0 },
    "one channel out is a delivery",
  );
  assert.deepEqual(
    summariseDeadTokenAlarmDeliveries([[{ reason: "Deferred by quiet hours.", status: "pending" }], [{ status: "retrying" }]]),
    { reached: 2, repeats: 0, unreached: 0 },
    "a message queued to go out is on its way",
  );
  assert.deepEqual(
    summariseDeadTokenAlarmDeliveries([[{ status: "failed" }, { reason: "Telegram disabled by user preference.", status: "skipped" }], []]),
    { reached: 0, repeats: 0, unreached: 2 },
    "every channel failing or skipped for a real reason is NOT a repeat — that run must still be recorded",
  );
  assert.ok(
    alarm.includes("summariseDeadTokenAlarmDeliveries(") && !/delivered \+= 1/.test(alarm),
    "the alarm counts deliveries from what createSystemNotification reported, never by the call returning",
  );
  assert.ok(
    /outcome\.reached === 0 && outcome\.unreached === 0\)\s*\{\s*return /.test(alarm),
    "a run where everyone was already alerted today returns before writing an audit row",
  );
}
