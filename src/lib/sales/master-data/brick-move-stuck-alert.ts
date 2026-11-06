import { writeAuditLog } from "@/lib/admin/audit";
import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import { createSystemNotification } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Tells a human, in-app + Telegram, that a brick move has stopped landing.
 *
 * WHAT THIS WATCHES THAT THE HEARTBEAT CANNOT. The two alerts cover the two halves of the same
 * fault and neither can see the other's:
 *
 *   - `phoenix-brick-move-drain` stops FIRING  → the heartbeat register says so (declared job,
 *     one hour of grace), and it knows nothing about what is in the queue.
 *   - the drain fires perfectly and the queue never empties → the register is happy, every fire is
 *     a success, and the move stays half-applied for ever. That is this file.
 *
 * The second is not hypothetical: `refreshMovedBrickFiles` keeps the claim on a file that failed
 * and tries it again once the claim lapses, so one file that can never be rebuilt is retried for
 * ever without ever blocking the files behind it. Until
 * `20261013130000_sos_fact_rollup_statement_timeout.sql` there was a live cause —
 * `phx_refresh_sos_fact_rollup` ran under the PostgREST role's 8 seconds and the largest sales
 * files exceeded it every attempt. That cause is gone; this says so if another one appears.
 *
 * WHY THE THRESHOLD IS AN HOUR, not a number of attempts. The table carries no attempt counter —
 * only `moved_at`, `refresh_started_at` and `refreshed_at` — so elapsed time is the signal that
 * exists. An hour is far outside any honest backlog: the clock fires three times an hour and a fire
 * rebuilds tens of files, so even the 188 files of the مدينة قنا move of 2026-10-13 drain well
 * inside it. A file still waiting an hour after the move is not a queue working through a backlog.
 *
 * DELIBERATELY NO EMAIL, and do not "fix" that back — the owner's standing rule is that no feature
 * adds an outbound email. In-app, Telegram and push, on the same
 * `weekly_system_health_digest` audience the stranded-job and outbox-drain alerts already use, so
 * there is no new key, no migration, and it can be retargeted or silenced from
 * /admin/notification-recipients.
 */

const AUDIENCE_KEY = "weekly_system_health_digest" as const;
const EVENT_TYPE = "brick_move_queue_stuck";
const ACTOR = "brick-move-drain";

/** How long a queued sales file may wait before its silence means something. */
export const BRICK_MOVE_STUCK_AFTER_MS = 60 * 60 * 1000;

export type StuckBrickMoveFile = {
  oldBrickId: string;
  batchId: string;
  movedAt: string;
  /** When the drain last picked this file up, or null if it has never been claimed. */
  refreshStartedAt: string | null;
};

export type BrickMoveStuckVerdict = {
  /** True when nothing has been waiting too long — the healthy state, including an empty queue. */
  healthy: boolean;
  /** Files past the threshold, oldest first. */
  stuck: readonly StuckBrickMoveFile[];
  /** The retired bricks those files belong to, de-duplicated, for the title and the alert key. */
  bricks: readonly string[];
  /** How long the oldest stuck file has been waiting, in whole minutes. */
  oldestWaitingMinutes: number;
};

/** Cairo wall-clock, because every time reported to the owner is Cairo local. */
function cairoTimestamp(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
  }).format(new Date(iso));
}

/** Cairo calendar day — the idempotency bucket. */
function cairoDayKey(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(now);
}

/**
 * Pure — no IO, so the rule itself is unit-testable without a database.
 *
 * A row with no `movedAt` that can be parsed is treated as NOT stuck: this alert must never fire on
 * data it cannot read, or the first malformed row trains the owner to ignore it.
 */
export function assessStuckBrickMoveFiles(input: {
  rows: readonly StuckBrickMoveFile[];
  now: Date;
  stuckAfterMs?: number;
}): BrickMoveStuckVerdict {
  const threshold = input.stuckAfterMs ?? BRICK_MOVE_STUCK_AFTER_MS;
  const nowMs = input.now.getTime();

  const stuck = input.rows
    .map((row) => ({ row, movedMs: new Date(row.movedAt).getTime() }))
    .filter((entry) => Number.isFinite(entry.movedMs) && nowMs - entry.movedMs >= threshold)
    .sort((a, b) => a.movedMs - b.movedMs)
    .map((entry) => entry.row);

  const oldestMs = stuck.length > 0 ? new Date(stuck[0]!.movedAt).getTime() : nowMs;

  return {
    bricks: [...new Set(stuck.map((row) => row.oldBrickId))],
    healthy: stuck.length === 0,
    oldestWaitingMinutes: Math.floor((nowMs - oldestMs) / 60_000),
    stuck,
  };
}

/** Pure message builder, in the owner's own terms: what is wrong, what it costs, what to do. */
export function buildBrickMoveStuckMessage(verdict: BrickMoveStuckVerdict): string {
  const hours = Math.floor(verdict.oldestWaitingMinutes / 60);
  const minutes = verdict.oldestWaitingMinutes % 60;
  const waited = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  return [
    "🛑 A brick move has not finished landing.",
    "",
    `${verdict.stuck.length} sales file(s) have been waiting ${waited} to have their totals rebuilt.`,
    "The move itself already applied — the brick, the customer map and the sales rows all point at",
    "the new area — so until these are rebuilt every screen shows the figures from BEFORE the move,",
    "with nothing on the page saying so.",
    "",
    "Waiting longest:",
    ...verdict.stuck.slice(0, 8).map((file) => {
      const claimed = file.refreshStartedAt
        ? `last attempted ${cairoTimestamp(file.refreshStartedAt)}`
        : "never attempted";
      return `  • ${file.oldBrickId} — moved ${cairoTimestamp(file.movedAt)} Cairo, ${claimed}`;
    }),
    ...(verdict.stuck.length > 8 ? [`  • …and ${verdict.stuck.length - 8} more`] : []),
    "",
    "The drain clock retries each file for ever, so this will not clear on its own if the rebuild",
    "itself is what is failing. The log line `brick_move_drain_incomplete` carries the reason.",
  ].join("\n");
}

/** Reads the queue. Pending files only — a rebuilt file is of no interest. */
export async function readPendingBrickMoveFiles(): Promise<StuckBrickMoveFile[]> {
  // Paged: one read stops at a fixed row count with no error, and the alert reports how many are stuck.
  // The key is (old_brick_id, batch_id), so both end the order and the walk is total.
  const data = await fetchAllRows<{ batch_id: unknown; moved_at: unknown; old_brick_id: unknown; refresh_started_at: unknown }>(
    () =>
      getSupabaseAdmin()
        .from("source_of_sales_brick_move_files")
        .select("old_brick_id, batch_id, moved_at, refresh_started_at")
        .is("refreshed_at", null)
        .order("moved_at", { ascending: true })
        .order("old_brick_id", { ascending: true }),
    "batch_id",
  );
  return data.map((row) => ({
    batchId: String(row.batch_id),
    movedAt: String(row.moved_at),
    oldBrickId: String(row.old_brick_id),
    refreshStartedAt: row.refresh_started_at ? String(row.refresh_started_at) : null,
  }));
}

export type BrickMoveStuckAlertResult = {
  delivered: number;
  reason?: string;
  skipped: boolean;
  stuck: number;
};

/**
 * Best-effort — NEVER throws. A failed alert must not turn a stalled queue into a second,
 * self-inflicted incident, and the drain's own log line is unaffected either way.
 *
 * Bucketed per Cairo day AND per exact set of stuck bricks, so a queue that stays stuck across the
 * day's 72 fires alerts once, while a DIFFERENT brick getting stuck still gets through instead of
 * being swallowed by an earlier key.
 */
export async function notifyBrickMoveFilesStuck(
  verdict: BrickMoveStuckVerdict,
  now: Date = new Date(),
): Promise<BrickMoveStuckAlertResult> {
  try {
    if (verdict.healthy) return { delivered: 0, reason: "healthy", skipped: true, stuck: 0 };

    const { recipients, warnings } = await resolveNotificationPersonRecipients(
      AUDIENCE_KEY,
      "Stuck brick-move queue alert recipients",
    );

    if (recipients.length === 0) {
      await writeAuditLog({
        actorLoginId: ACTOR,
        entityId: "sales.brick_move_queue_stuck",
        entityType: "notification",
        newValues: { bricks: verdict.bricks, failClosed: true, stuck: verdict.stuck.length, warnings },
        summary: "Stuck brick-move alert skipped — no active recipient resolved for the configured audience.",
      });
      return { delivered: 0, reason: "no recipients", skipped: true, stuck: verdict.stuck.length };
    }

    const message = buildBrickMoveStuckMessage(verdict);
    const idempotencyBase = `brick-move-queue-stuck:${cairoDayKey(now)}:${verdict.bricks.join(",")}`;
    const title = `Brick move not landing — ${verdict.stuck.length} sales file(s) stuck on ${verdict.bricks.join(", ")}`;

    let delivered = 0;
    await Promise.all(
      recipients.map(async (recipient) => {
        await createSystemNotification({
          actionUrl: "/sales/database-mapping?tab=bricks",
          actorId: ACTOR,
          // No email — see the file header. In-app + Telegram + push only.
          channels: ["in_app", "telegram", "push"],
          eventType: EVENT_TYPE,
          message,
          metadata: {
            bricks: verdict.bricks,
            idempotencyKey: `${idempotencyBase}:${recipient.hrId}`,
            stuck: verdict.stuck.length,
          },
          // module: "system" is the module actually enabled for Telegram in
          // notification_module_channel_policies — an unknown module string fails closed in
          // resolveTelegramGovernance, which would silently drop the alert.
          module: "system",
          priority: "high",
          recipientHrId: recipient.hrId,
          recipientUserId: recipient.userId,
          telegram: { ctaLabel: "Open Database Mapping", ctaUrl: "/sales/database-mapping?tab=bricks" },
          title,
        });
        delivered += 1;
      }),
    );

    await writeAuditLog({
      actorLoginId: ACTOR,
      entityId: "sales.brick_move_queue_stuck",
      entityType: "notification",
      newValues: { bricks: verdict.bricks, delivered, stuck: verdict.stuck.length, warnings },
      summary: `Stuck brick-move alert delivered to ${delivered} recipient(s) for ${verdict.bricks.join(", ")}.`,
    });

    return { delivered, skipped: false, stuck: verdict.stuck.length };
  } catch (error) {
    // Swallow: an alert about a stalled queue must never become the incident itself.
    logError("Stuck brick-move alert failed to dispatch", {
      error,
      labels: { event: "brick_move_queue_stuck_alert_failed" },
    });
    return {
      delivered: 0,
      reason: error instanceof Error ? error.message : "unknown error",
      skipped: true,
      stuck: verdict.stuck.length,
    };
  }
}
