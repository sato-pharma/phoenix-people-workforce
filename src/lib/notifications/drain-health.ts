import { notificationOutboxMaxAttempts, notificationOutboxTable } from "@/lib/notifications/email";
import { DELIVERY_CLAIM_GRACE_MS, notificationDeliveryMaxAttempts } from "@/lib/notifications/system";
import { logWarning } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Does the drain actually drain?
 *
 * Between 2026-08-14 and 2026-08-27 every notification retry in this system was dropped, and
 * nothing anywhere noticed. The cron fired every 5 minutes, returned HTTP 200, and reported
 * `attempted: 0` — which is byte-for-byte what a healthy, empty queue reports. 49 real emails sat
 * behind the blockage for 13 days. #2462, #2464 and #2465 fixed the three mechanisms that caused
 * it; this module exists because none of them fixed the part that let it hide.
 *
 * The liveness monitor could not have caught it. `withDeadMansSwitch` alerts on a ping that did not
 * arrive — a job that stopped, was paused, or crashed. This job never stopped. It ran perfectly and
 * did nothing, so it pinged `success` 3,700 times in a row while the queue was frozen.
 *
 * Nor can a counter inside the loop. #2465 added exactly that — a warning when the scan walks past
 * exhausted rows — and it was dead on arrival, because #2464 had merged six minutes earlier and
 * added a SQL filter that keeps those rows out of the scan entirely. An alert keyed to one
 * implementation detail dies the moment that detail is refactored, and says nothing about the ten
 * other ways a drain can stop working.
 *
 * So this asserts a black-box invariant instead, one that holds no matter what the internals do:
 *
 *     A queue that had work DUE BEFORE THIS RUN STARTED, and attempted nothing, is broken.
 *
 * There is no threshold and no grace period to tune. "Due before the run started" is measured
 * against the run's own start timestamp, so a row inserted while the drain was working cannot
 * trigger it, and a row waiting on a legitimate retry backoff is not due and does not count. A busy
 * drain that is working through a genuine backlog reports `attempted > 0` and stays quiet. The only
 * shape that fires is the one that hid for 13 days: work was there to do, and nothing was done.
 *
 * It would have caught the original freeze on the first cycle after it began — within 5 minutes
 * rather than 13 days.
 */

/**
 * `approval_email` is not a drain of its own: it is the durable approval emails (durable-email.ts,
 * REC-048) that used every outbox retry. Nothing attempts them again until someone presses "send
 * again" on Email Notifications, so their reading always carries `attempted: 0` and any such row
 * makes the run unhealthy — the same alarm, the same people, the same once-a-day Telegram as a frozen
 * drain, with no new channel.
 */
export type DrainQueueName = "approval_email" | "deferred" | "outbox" | "push" | "telegram";

export type DrainQueueReading = {
  /** Rows this run actually tried to send. */
  attempted: number;
  queue: DrainQueueName;
  /**
   * Rows that were already due when this run STARTED and are still undrained. `null` means the
   * probe itself could not answer — never treated as a fault, see `assessDrainHealth`.
   */
  strandedBefore: number | null;
};

export type DrainHealthVerdict = {
  healthy: boolean;
  /** The queues that had due work and attempted nothing. Empty when healthy. */
  stranded: DrainQueueReading[];
};

/**
 * The whole rule, kept pure so it can be tested without a database — the failure it guards against
 * is a logic mistake, and a source-level assertion cannot see one.
 *
 * A `null` reading is UNKNOWN, not broken. A probe that fails must never manufacture an alert: the
 * point of this module is to stay silent unless something is genuinely wrong, and a monitoring
 * query erroring is not the application failing.
 */
export function assessDrainHealth(readings: DrainQueueReading[]): DrainHealthVerdict {
  const stranded = readings.filter(
    (reading) => reading.attempted === 0 && reading.strandedBefore !== null && reading.strandedBefore > 0,
  );
  return { healthy: stranded.length === 0, stranded };
}

/** One line for a log or a dead-man's-switch payload. */
export function describeDrainHealth(verdict: DrainHealthVerdict): string {
  if (verdict.healthy) return "all drains attempted their due work";
  return verdict.stranded
    .map((reading) =>
      reading.queue === "approval_email"
        ? `approval_email: ${reading.strandedBefore} approval email(s) out of retries — send again from Email Notifications`
        : `${reading.queue}: ${reading.strandedBefore} row(s) due before the run, 0 attempted`,
    )
    .join("; ");
}

/**
 * Rows that were due before `runStartedAtIso` and are still sitting in the queue.
 *
 * `created_at <= runStartedAt` is not redundant beside the `next_attempt_at` clause: it is what
 * removes the race. A row inserted while the drain was mid-flight is genuinely undrained but was
 * never this run's job, and counting it would make a healthy drain look broken under load.
 *
 * Returns `null` rather than throwing — a monitoring probe must not be able to fail the cron it is
 * watching.
 */
async function countDueOutboxRows(runStartedAtIso: string): Promise<number | null> {
  try {
    const { count, error } = await getSupabaseAdmin()
      .from(notificationOutboxTable)
      .select("id", { count: "exact", head: true })
      .in("status", ["pending", "failed"])
      .lt("attempts", notificationOutboxMaxAttempts)
      .lte("created_at", runStartedAtIso)
      .or(`next_attempt_at.is.null,next_attempt_at.lte.${runStartedAtIso}`);

    if (error) throw error;
    return count ?? 0;
  } catch (error) {
    logWarning("Outbox drain-health probe failed (non-fatal — no alert is raised from an unknown reading)", {
      error,
      labels: { event: "drain_health_probe_failed", queue: "outbox" },
    });
    return null;
  }
}

async function countDueDeliveryRows(
  queue: Exclude<DrainQueueName, "outbox">,
  runStartedAtIso: string,
): Promise<number | null> {
  // `deferred` is the deferred-email channel: it has no attempts budget in its own drain query, so
  // it is filtered by status alone. The other two carry the same retry budget the outbox does.
  const channel = queue === "deferred" ? "email" : queue;
  const statuses = queue === "deferred" ? ["pending"] : ["failed", "pending", "retrying"];
  // A row touched inside the claim grace may be a send still in flight (a bare claim, filled in
  // when the send ends) - not stranded work. The drains close such a row once it is older than
  // this, so the probe and the drains must use the same line; see DELIVERY_CLAIM_GRACE_MS.
  const claimGraceCutoffIso = new Date(Date.parse(runStartedAtIso) - DELIVERY_CLAIM_GRACE_MS).toISOString();

  try {
    let query = getSupabaseAdmin()
      .from("notification_deliveries")
      .select("id", { count: "exact", head: true })
      .eq("channel", channel)
      .in("status", statuses)
      .lte("created_at", runStartedAtIso)
      .lte("updated_at", claimGraceCutoffIso)
      .or(`next_attempt_at.is.null,next_attempt_at.lte.${runStartedAtIso}`);

    if (queue !== "deferred") query = query.lt("attempts", notificationDeliveryMaxAttempts);

    const { count, error } = await query;
    if (error) throw error;
    return count ?? 0;
  } catch (error) {
    logWarning("Delivery drain-health probe failed (non-fatal — no alert is raised from an unknown reading)", {
      error,
      labels: { event: "drain_health_probe_failed", queue },
    });
    return null;
  }
}

/**
 * Reads every drain queue's leftover due work as of `runStartedAtIso`. Pair with the `attempted`
 * count each drain step returned, then hand the pairs to `assessDrainHealth`.
 */
export async function readDrainQueueBacklog(
  runStartedAtIso: string,
): Promise<Record<DrainQueueName, number | null>> {
  const [outbox, telegram, push, deferred, approvalEmail] = await Promise.all([
    countDueOutboxRows(runStartedAtIso),
    countDueDeliveryRows("telegram", runStartedAtIso),
    countDueDeliveryRows("push", runStartedAtIso),
    countDueDeliveryRows("deferred", runStartedAtIso),
    countExhaustedApprovalEmails(runStartedAtIso),
  ]);

  return { approval_email: approvalEmail, deferred, outbox, push, telegram };
}

/** How long an approval email that ran out of retries keeps the alarm up before it is left to the list. */
export const EXHAUSTED_APPROVAL_EMAIL_ALARM_DAYS = 7;

/**
 * Durable approval emails (durable-email.ts) that used every outbox retry and were written in the last
 * EXHAUSTED_APPROVAL_EMAIL_ALARM_DAYS days. Each one is an approval email nobody received; "send
 * again" re-queues it and the reading clears. `null` when the probe cannot answer, like the others.
 */
async function countExhaustedApprovalEmails(runStartedAtIso: string): Promise<number | null> {
  const windowStartIso = new Date(
    Date.parse(runStartedAtIso) - EXHAUSTED_APPROVAL_EMAIL_ALARM_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  try {
    const { count, error } = await getSupabaseAdmin()
      .from(notificationOutboxTable)
      .select("id", { count: "exact", head: true })
      .eq("status", "failed")
      .eq("payload->>kind", "direct_email")
      .gte("attempts", notificationOutboxMaxAttempts)
      .gte("created_at", windowStartIso);

    if (error) throw error;
    return count ?? 0;
  } catch (error) {
    logWarning("Approval-email drain-health probe failed (non-fatal — no alert is raised from an unknown reading)", {
      error,
      labels: { event: "drain_health_probe_failed", queue: "approval_email" },
    });
    return null;
  }
}
