import { writeAuditLog } from "@/lib/admin/audit";
import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import { createSystemNotification } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";

import type { BrickMoveNetSettleResult } from "./brick-move-net-settle";

/**
 * Tells a human that a brick move landed on the FILES but not on the NUMBERS.
 *
 * WHY THIS IS A THIRD ALERT and not a line in one of the other two. The drain can fail in three
 * independent ways and no one of them can see the others:
 *
 *   - the clock stops firing → the heartbeat register says so, and knows nothing about the queue;
 *   - the clock fires and the queue never empties → `brick-move-stuck-alert.ts`, which reads the
 *     queue and knows nothing about what the rebuilt files did to the stored net;
 *   - every file rebuilds, the queue reaches ZERO, and a period's split net is still the pre-move
 *     one → both of the above are perfectly happy. That is this file.
 *
 * The third is the one that actually happened, on 2026-10-13: 188 files of the مدينة قنا move all
 * reported rebuilt, the queue read 0, and 2 cells in August and 62 in September still carried
 * 74,741.23 EGP on the wrong area, with every Sales-vs-Target screen reading it and nothing
 * anywhere saying so. `settleBrickMoveNet` closes the common case. This alert covers the residue it
 * deliberately refuses to write.
 *
 * 🔴 ONLY THE RESIDUE THAT WILL NOT CLEAR ON ITS OWN. Two of the three leftovers page; the third
 * must not, or the alert fires on a healthy move and is muted by the first afternoon:
 *
 *   - a PUBLISHED month whose net predates the move — `phx_write_monthly_store_split_net` refuses
 *     it by design, so it can NEVER clear by itself. Re-stamping a month that has already gone out
 *     is the owner's decision and his screen, never a side effect of a brick move. Pages.
 *   - a settle that FAILED — the retry only comes on a later fire that rebuilds something, and once
 *     the queue is empty there is no such fire. So a failure can strand for ever. Pages.
 *   - a period left by the per-fire cap, with no failure — the very next fire takes it. Silent.
 *
 * DELIBERATELY NO EMAIL, the same as the stuck-queue alert: the owner's standing rule is that no
 * feature adds an outbound email. In-app, Telegram and push, on the `weekly_system_health_digest`
 * audience the other system alerts already use — no new key, no migration, and it can be retargeted
 * or silenced from /admin/notification-recipients.
 */

const AUDIENCE_KEY = "weekly_system_health_digest" as const;
const EVENT_TYPE = "brick_move_net_unsettled";
const ACTOR = "brick-move-drain";

export type BrickMoveNetResidueVerdict = {
  /** True when every period the move touched is settled, or is only waiting for the next fire. */
  healthy: boolean;
  /** Published months whose net predates the move. These can never settle themselves. */
  publishedPeriods: readonly string[];
  /** Periods still owed because the settle FAILED — not because the cap deferred them. */
  owedPeriods: readonly string[];
  /** Why the settle stopped, verbatim from the database where it came from there. */
  failure: string | null;
  /** Every period in this verdict, de-duplicated and sorted — the title and the alert key. */
  periods: readonly string[];
};

/** Cairo calendar day — the idempotency bucket. */
function cairoDayKey(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(now);
}

/** Pure — no IO, so the rule that decides whether to wake him is unit-testable without a database. */
export function assessUnsettledBrickMoveNet(
  result: Pick<BrickMoveNetSettleResult, "deferred" | "failure" | "skippedPublished">,
): BrickMoveNetResidueVerdict {
  const publishedPeriods = [...new Set(result.skippedPublished)].sort();
  // The cap alone is NOT residue — the next fire takes it. Only a failure strands a period.
  const owedPeriods = result.failure ? [...new Set(result.deferred)].sort() : [];
  const periods = [...new Set([...publishedPeriods, ...owedPeriods])].sort();

  return {
    failure: result.failure ?? null,
    healthy: periods.length === 0,
    owedPeriods,
    periods,
    publishedPeriods,
  };
}

/** Pure message builder, in the owner's own terms: what is wrong, what it costs, what to do. */
export function buildBrickMoveNetUnsettledMessage(verdict: BrickMoveNetResidueVerdict): string {
  const lines = [
    "🛑 A brick move landed on the files but not on the numbers.",
    "",
    "Every sales file was rebuilt, so the queue reads clear — but the stored store-split net that",
    "Sales vs Target, achievement and the Business Review divide by is still the one from BEFORE the",
    "move for the period(s) below. Those screens are showing the money on the old area, with nothing",
    "on the page saying so.",
    "",
  ];

  if (verdict.publishedPeriods.length > 0) {
    lines.push(
      `Published month(s) — left untouched on purpose: ${verdict.publishedPeriods.join(", ")}`,
      "  A published closing is frozen, so this cannot fix itself and nothing will retry it.",
      "  Unpublish the month on Monthly Closing and re-publish it to restate those figures — that is",
      "  your decision, not the drain's.",
      "",
    );
  }

  if (verdict.owedPeriods.length > 0) {
    lines.push(
      `Could not be settled: ${verdict.owedPeriods.join(", ")}`,
      `  Reason: ${verdict.failure ?? "unknown"}`,
      "  The retry only comes with the next file rebuild, and the queue is now empty — so this will",
      "  not clear on its own.",
      "",
    );
  }

  lines.push("The log line `brick_move_net_unsettled` carries the full period list.");
  return lines.join("\n");
}

export type BrickMoveNetAlertResult = {
  delivered: number;
  periods: number;
  reason?: string;
  skipped: boolean;
};

/**
 * Best-effort — NEVER throws. An alert about numbers left wrong must not turn a drain that did its
 * work into a second, self-inflicted failure; the route's own log line is unaffected either way.
 *
 * Bucketed per Cairo day AND per exact period set, so one unsettled month does not page on all 72
 * of the day's fires while a DIFFERENT month going unsettled still gets through.
 */
export async function notifyBrickMoveNetUnsettled(
  verdict: BrickMoveNetResidueVerdict,
  now: Date = new Date(),
): Promise<BrickMoveNetAlertResult> {
  try {
    if (verdict.healthy) return { delivered: 0, periods: 0, reason: "healthy", skipped: true };

    const { recipients, warnings } = await resolveNotificationPersonRecipients(
      AUDIENCE_KEY,
      "Unsettled brick-move net alert recipients",
    );

    if (recipients.length === 0) {
      await writeAuditLog({
        actorLoginId: ACTOR,
        entityId: "sales.brick_move_net_unsettled",
        entityType: "notification",
        newValues: { failClosed: true, periods: verdict.periods, warnings },
        summary:
          "Unsettled brick-move net alert skipped — no active recipient resolved for the configured audience.",
      });
      return { delivered: 0, periods: verdict.periods.length, reason: "no recipients", skipped: true };
    }

    const message = buildBrickMoveNetUnsettledMessage(verdict);
    const idempotencyBase = `brick-move-net-unsettled:${cairoDayKey(now)}:${verdict.periods.join(",")}`;
    const title = `Brick move not in the numbers — ${verdict.periods.join(", ")} still on the pre-move split`;

    let delivered = 0;
    await Promise.all(
      recipients.map(async (recipient) => {
        await createSystemNotification({
          actionUrl: "/sales/monthly-closing",
          actorId: ACTOR,
          // No email — see the file header. In-app + Telegram + push only.
          channels: ["in_app", "telegram", "push"],
          eventType: EVENT_TYPE,
          message,
          metadata: {
            idempotencyKey: `${idempotencyBase}:${recipient.hrId}`,
            owedPeriods: verdict.owedPeriods,
            publishedPeriods: verdict.publishedPeriods,
          },
          // module: "system" is the module actually enabled for Telegram in
          // notification_module_channel_policies — an unknown module string fails closed in
          // resolveTelegramGovernance, which would silently drop the alert.
          module: "system",
          priority: "high",
          recipientHrId: recipient.hrId,
          recipientUserId: recipient.userId,
          telegram: { ctaLabel: "Open Monthly Closing", ctaUrl: "/sales/monthly-closing" },
          title,
        });
        delivered += 1;
      }),
    );

    await writeAuditLog({
      actorLoginId: ACTOR,
      entityId: "sales.brick_move_net_unsettled",
      entityType: "notification",
      newValues: {
        delivered,
        owedPeriods: verdict.owedPeriods,
        publishedPeriods: verdict.publishedPeriods,
        warnings,
      },
      summary: `Unsettled brick-move net alert delivered to ${delivered} recipient(s) for ${verdict.periods.join(", ")}.`,
    });

    return { delivered, periods: verdict.periods.length, skipped: false };
  } catch (error) {
    // Swallow: an alert about numbers left wrong must never become the incident itself.
    logError("Unsettled brick-move net alert failed to dispatch", {
      error,
      labels: { event: "brick_move_net_unsettled_alert_failed" },
    });
    return {
      delivered: 0,
      periods: verdict.periods.length,
      reason: error instanceof Error ? error.message : "unknown error",
      skipped: true,
    };
  }
}
