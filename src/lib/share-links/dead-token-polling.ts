// THE JUDGEMENT on a share-link token that is DEAD and still being read — pure, no IO.
//
// THE SILENCE THIS EXISTS TO BREAK, said plainly, because it already happened and lasted two
// months. On 2026-08-05 the Direct Orders live Google Sheet was copied while its feed token was
// still written into the script. The token was rotated out the same afternoon, and from 15:22 that
// day the copy's one-minute trigger has been answered 403 — roughly 84,500 times by 2026-10-03.
// Nothing said a word. Production was healthy, every cron was green, the copy's own Apps Script
// logged the refusal into a spreadsheet nobody opens, and the only place the pattern was visible
// at all was Railway's HTTP log, which no part of this application can read. It was found by
// accident, 31 days in, while verifying logs after an unrelated deploy.
//
// A dead token being polled is not a security incident — 403 is the right answer and the data is
// not exposed. It is a SECOND SHEET somewhere showing figures frozen on the day it died, with no
// stale banner, which somebody may still be reading as current. That is the harm, and it is
// invisible from inside Phoenix unless something counts the refusals.
//
// SEPARATED FROM THE ALARM ON PURPOSE, the same way `job-heartbeat-assess.ts` is separated from
// `job-heartbeat-alert.ts` and `cv-lifecycle-link-expiry.ts` from its own alert. This file has no
// imports at all, so the verdict is unit-testable without a database and can be read by a screen
// later without bundling the Supabase client for the browser.

/**
 * How many refusals a dead token must have collected before it is worth telling anyone about.
 *
 * Ten, because the thing being detected is an AUTOMATION — a trigger, a formula, a script — and
 * one of those produces a refusal a minute. A human clicking a stale bookmark produces one or two,
 * and paging the owner about that would teach him to ignore the alert. Ten is reached in ten
 * minutes by a real poller and essentially never by a person.
 */
export const DEAD_TOKEN_POLL_MIN_REFUSALS = 10;

/**
 * How recently it must have been refused to count as STILL being polled.
 *
 * 24 hours, because the answer is only actionable while the thing is running. A token refused
 * steadily last March and quiet ever since is history: the trigger was stopped, and reporting it
 * would be reporting a closed incident for ever. The counter is never reset, so the window — not
 * the count — is what makes the alert stop once the ghost does.
 */
export const DEAD_TOKEN_POLL_WINDOW_MS = 24 * 60 * 60 * 1000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The minimum a judgement needs. Structural, so a raw row and a screen's row type both fit. */
export type DeadTokenPollJudgeableLink = {
  expiresAt: string | null;
  id: string;
  label: string | null;
  lastRefusedAt: string | null;
  refusedCount: number;
  revokedAt: string | null;
  /** Human name of the feed this link belongs to — "Direct Orders", never a table name. */
  sheet: string;
};

export type DeadTokenPoll = {
  /** Whole days since the token died, so the message can say how long this has been going on. */
  deadForDays: number;
  id: string;
  label: string | null;
  lastRefusedAt: string;
  refusals: number;
  /** Why it is dead. Revocation is a deliberate act and takes precedence over a lapsed date. */
  reason: "expired" | "revoked";
  sheet: string;
};

export type DeadTokenPollVerdict = {
  /** Nothing to say: no dead token has been read recently, or none has been read enough times. */
  healthy: boolean;
  /** Dead tokens still being read, busiest first. */
  polled: DeadTokenPoll[];
};

/** Whole days between two instants, floored — the unit the answer is acted on in. */
function wholeDaysBetween(fromMs: number, toMs: number): number {
  return Math.floor((toMs - fromMs) / MS_PER_DAY);
}

/** `Date.parse` that answers `null` rather than `NaN`, so every caller has to handle the gap. */
function instant(value: string | null): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The single judgement, pure and total.
 *
 * `nowMs` is a parameter rather than a `Date.now()` call so every branch is testable without
 * freezing a clock.
 *
 * A LIVE link being read is the feature working and is never reported — this fires only on a link
 * that is revoked or past its expiry. That is the whole distinction the alert rests on: the live
 * sheet and the ghost are indistinguishable by traffic, and only the link's own state separates
 * them.
 */
export function assessDeadTokenPolling(
  links: readonly DeadTokenPollJudgeableLink[],
  nowMs: number,
): DeadTokenPollVerdict {
  const polled: DeadTokenPoll[] = [];

  for (const link of links) {
    const revokedMs = instant(link.revokedAt);
    const expiresMs = instant(link.expiresAt);
    const expired = expiresMs !== null && expiresMs <= nowMs;
    // Revoked OR lapsed. Anything else is a working link, whatever its refusal history says — a
    // passcode typo on the human surface also refuses, and that must never page anyone.
    if (revokedMs === null && !expired) continue;

    const lastRefusedMs = instant(link.lastRefusedAt);
    // Never refused, or an unparseable stamp. An unparseable one is not a verdict: judging it
    // would invent a time that is not there, and the row is still visible to anyone querying.
    if (lastRefusedMs === null) continue;
    if (nowMs - lastRefusedMs > DEAD_TOKEN_POLL_WINDOW_MS) continue;

    const refusals = Number(link.refusedCount);
    if (!Number.isFinite(refusals) || refusals < DEAD_TOKEN_POLL_MIN_REFUSALS) continue;

    // Revocation wins when both apply: it is the act somebody took, and it is the earlier and more
    // useful fact — the rotation revoked this token, which is why the ghost started failing.
    const diedMs = revokedMs ?? expiresMs ?? nowMs;
    polled.push({
      deadForDays: Math.max(0, wholeDaysBetween(diedMs, nowMs)),
      id: link.id,
      label: link.label,
      lastRefusedAt: link.lastRefusedAt ?? "",
      reason: revokedMs !== null ? "revoked" : "expired",
      refusals: Math.trunc(refusals),
      sheet: link.sheet,
    });
  }

  // Busiest first, then longest-running, then by id so the order — and therefore the alert's
  // idempotency key — is stable across runs for the same set.
  polled.sort(
    (a, b) => b.refusals - a.refusals || b.deadForDays - a.deadForDays || a.id.localeCompare(b.id),
  );

  return { healthy: polled.length === 0, polled };
}

/** Pure message builder — no IO, so the wording is unit-testable without a database. */
export function buildDeadTokenPollMessage(verdict: DeadTokenPollVerdict): string {
  const name = (label: string | null) => label ?? "an unlabelled link";
  const lines: string[] = [];

  lines.push("🛑 A dead sheet link is still being read every few seconds.");
  lines.push("");
  for (const poll of verdict.polled) {
    const age = poll.deadForDays === 0 ? "today" : `${poll.deadForDays} day(s) ago`;
    lines.push(
      `· ${poll.sheet} — ${name(poll.label)} was ${poll.reason} ${age}`
        + ` and has been refused ${poll.refusals.toLocaleString("en-US")} time(s).`,
    );
  }
  lines.push("");
  lines.push("Phoenix is refusing it correctly and no data is going out. What it means is that a");
  lines.push("SECOND copy of that sheet exists somewhere, still running its own refresh trigger,");
  lines.push("showing figures frozen on the day the link died — with no stale banner on it.");
  lines.push("");
  lines.push("Stop the copy rather than giving it a token: script.google.com ▸ Triggers, in each");
  lines.push("Google account in turn, and delete the refresh trigger whose executions log a 403.");
  return lines.join("\n");
}

/** One channel's outcome, as `createSystemNotification` reports it — only the two fields read here. */
export type DeadTokenAlarmDelivery = { reason?: string; status: string };

export type DeadTokenAlarmOutcome = {
  /** Recipients with at least one channel sent, or queued to go out (quiet hours, a retry). */
  reached: number;
  /** Recipients whose every channel was already sent under today's key — the 15-minute repeat. */
  repeats: number;
  /** Recipients the alarm meant to reach today and did not: every channel failed or was skipped. */
  unreached: number;
};

/**
 * Count what a run of the alarm really did, per recipient.
 *
 * The sweep runs every 15 minutes and the idempotency key holds the message to once a Cairo day,
 * so 95 of 96 runs send nothing — `claimDelivery` answers "Delivery already sent." on every
 * channel. The alarm used to count a recipient as delivered as soon as the call returned, and wrote
 * "delivered to 1 recipient(s)" into `audit_logs` 96 times a day (1,792 rows from 3 to 22 Oct 2026)
 * while the owner received exactly one message a day. A repeat is not a delivery and is not a
 * failure either; it is nothing, and the caller writes no row for it.
 */
export function summariseDeadTokenAlarmDeliveries(perRecipient: DeadTokenAlarmDelivery[][]): DeadTokenAlarmOutcome {
  const outcome: DeadTokenAlarmOutcome = { reached: 0, repeats: 0, unreached: 0 };
  for (const deliveries of perRecipient) {
    if (deliveries.some((delivery) => ["sent", "pending", "retrying"].includes(delivery.status))) {
      outcome.reached += 1;
    } else if (
      deliveries.length > 0
      && deliveries.every((delivery) => delivery.status === "skipped" && /^Delivery already /.test(delivery.reason ?? ""))
    ) {
      outcome.repeats += 1;
    } else {
      outcome.unreached += 1;
    }
  }
  return outcome;
}
