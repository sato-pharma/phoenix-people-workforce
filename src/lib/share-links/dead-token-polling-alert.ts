// THE ALARM that tells the owner a dead sheet link is still being read, once a day.
//
// The judgement lives in `dead-token-polling.ts` and is imported, never duplicated — that file's
// header has the account of the two months of silence this exists to end. The counter it judges is
// written by `refusal-counter.ts`, from inside the three share-token guards.
//
// DELIBERATELY NO EMAIL, and do not "fix" that back. The owner's standing rule is that no feature
// may add an outbound email, and the same reasoning as `job-heartbeat-alert.ts` and
// `cv-lifecycle-link-expiry-alert.ts` applies: this is a system-health alarm, and an alarm that
// travels by a channel it might be reporting broken is not an alarm. In-app + Telegram + push on
// the existing technical-health audience, so it can be retargeted or silenced from
// /admin/notification-recipients without a migration.
//
// FEED LINKS ONLY, and that is what makes the message's claim true rather than merely likely. A
// feed token is never typed by a person — it exists to sit inside a spreadsheet's refresh trigger —
// so a revoked one being read ten times in a day IS a running script. A revoked `live` link is a
// human surface behind a passcode, where the same count could just be somebody's stale bookmark,
// and saying "a second copy of that sheet exists" about that would be a guess.

import { writeAuditLog } from "@/lib/admin/audit";
import { createSystemNotification } from "@/lib/notifications/system";
import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import { logError } from "@/lib/observability/log";
import {
  DEAD_TOKEN_POLL_WINDOW_MS,
  assessDeadTokenPolling,
  buildDeadTokenPollMessage,
  summariseDeadTokenAlarmDeliveries,
  type DeadTokenPollJudgeableLink,
  type DeadTokenPollVerdict,
} from "@/lib/share-links/dead-token-polling";
import { SHARE_LINK_FEEDS } from "@/lib/share-links/feeds";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const AUDIENCE_KEY = "weekly_system_health_digest" as const;
const EVENT_TYPE = "share_link_dead_token_polled";
const ACTOR = "share-link-dead-token-poll";

export type DeadTokenPollingRunResult = {
  delivered: number;
  reason?: string;
  skipped: boolean;
  verdict: DeadTokenPollVerdict | null;
};

/** Cairo calendar day — the idempotency bucket, so a standing fault alerts once a day. */
function cairoDayKey(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
}

/**
 * Read the three feed tables, judge them, and page a human if a dead token is still being read.
 *
 * The SQL narrows only by the two things that bound the query cheaply — a feed surface, and a
 * refusal inside the judgement's own window — and every other decision is left to
 * `assessDeadTokenPolling`. Splitting it that way is deliberate: a threshold duplicated in a
 * `.gte()` here would be a second copy of the rule, and the first time the two disagreed the alert
 * and its own unit tests would be answering different questions.
 *
 * Reads the tables directly rather than through the three `list…ShareLinks` services, which assert
 * a permission against an `AccessContext` a cron job does not have. Six columns are selected, and
 * `token` is not among them, so a live token cannot reach a log line or a notification body from
 * here even by accident.
 *
 * Best-effort — never throws. It is composed into a sweep that has other work to do, and an alarm
 * that can abort the run it lives in takes that run down with it.
 */
export async function runDeadTokenPollingCheck(): Promise<DeadTokenPollingRunResult> {
  let verdict: DeadTokenPollVerdict | null = null;
  try {
    const supabase = getSupabaseAdmin();
    const windowStart = new Date(Date.now() - DEAD_TOKEN_POLL_WINDOW_MS).toISOString();
    const candidates: DeadTokenPollJudgeableLink[] = [];

    for (const feed of SHARE_LINK_FEEDS) {
      const { data, error } = await supabase
        .from(feed.table)
        .select("id,label,expires_at,revoked_at,refused_count,last_refused_at")
        .eq("surface", "feed")
        .gte("last_refused_at", windowStart)
        .order("refused_count", { ascending: false })
        .limit(50);
      if (error) throw error;
      for (const row of (data ?? []) as Array<Record<string, unknown>>) {
        candidates.push({
          expiresAt: row.expires_at ? String(row.expires_at) : null,
          id: String(row.id ?? ""),
          label: row.label ? String(row.label) : null,
          lastRefusedAt: row.last_refused_at ? String(row.last_refused_at) : null,
          refusedCount: Number(row.refused_count ?? 0),
          revokedAt: row.revoked_at ? String(row.revoked_at) : null,
          sheet: feed.sheet,
        });
      }
    }

    // Bound to a `const` and read through it below. `verdict` stays a mutable `let` because the
    // catch has to report whatever was reached before the throw — and TypeScript widens a mutable
    // binding back to its declared type inside a CLOSURE, so `verdict.polled` in the
    // `recipients.map` callback would be `possibly null` however thoroughly it was narrowed here.
    // That is a real compile error, not a lint preference; the sibling CV alarm records the same
    // trap. Do not collapse the two back into one.
    const assessed = assessDeadTokenPolling(candidates, Date.now());
    verdict = assessed;

    if (assessed.healthy) return { delivered: 0, reason: "healthy", skipped: true, verdict: assessed };

    const { recipients, warnings } = await resolveNotificationPersonRecipients(
      AUDIENCE_KEY,
      "Dead share-link token polling recipients",
    );
    if (recipients.length === 0) {
      await writeAuditLog({
        actorLoginId: ACTOR,
        entityId: "share_links.dead_token_polled",
        entityType: "notification",
        newValues: { failClosed: true, warnings },
        summary: "Dead share-token polling alert skipped — no active recipient resolved.",
      });
      return { delivered: 0, reason: "no recipients", skipped: true, verdict: assessed };
    }

    const message = buildDeadTokenPollMessage(assessed);
    const sheets = [...new Set(assessed.polled.map((poll) => poll.sheet))];
    const title = sheets.length === 1
      ? `A dead ${sheets[0]} sheet link is still being read`
      : `${sheets.length} dead sheet links are still being read`;
    // The busiest finding's own screen, and nothing when that sheet has none — see `feeds.ts`.
    // With several sheets involved the message names them all; the button can only be one place,
    // so it goes where the loudest one is.
    const screenUrl = SHARE_LINK_FEEDS.find((feed) => feed.sheet === assessed.polled[0]?.sheet)?.screen ?? null;
    // Bucketed per Cairo day AND per the exact set of link ids, so a fault that persists alerts
    // once a day while a NEWLY dead token still gets through rather than being swallowed by an
    // earlier key. The sweep that calls this runs every 15 minutes; this is what keeps that from
    // becoming 96 messages.
    const affected = assessed.polled.map((poll) => poll.id).sort();
    const idempotencyBase = `share-link-dead-token-polled:${cairoDayKey()}:${affected.join(",")}`;

    const results = await Promise.all(
      recipients.map(async (recipient) => {
        const result = await createSystemNotification({
          actionUrl: screenUrl,
          actorId: ACTOR,
          // No email — see the file header. In-app + Telegram + push only.
          channels: ["in_app", "telegram", "push"],
          eventType: EVENT_TYPE,
          message,
          metadata: { affectedLinkIds: affected, idempotencyKey: `${idempotencyBase}:${recipient.hrId}` },
          // `system`, not the owning module: `system` is the one enabled for Telegram in
          // notification_module_channel_policies, and an unknown module string fails CLOSED in
          // resolveTelegramGovernance — which would silently drop the alert. The finding spans
          // three modules anyway, so no single module string would be right.
          module: "system",
          priority: "normal",
          recipientHrId: recipient.hrId,
          recipientUserId: recipient.userId,
          telegram: screenUrl ? { ctaLabel: "Open share links", ctaUrl: screenUrl } : undefined,
          title,
        });
        return result.deliveries;
      }),
    );

    // Count what really went out — see `summariseDeadTokenAlarmDeliveries`. A run where every
    // recipient was already alerted today writes NO audit row: it did nothing, and saying
    // "delivered" about it 95 times a day is what this replaced.
    const outcome = summariseDeadTokenAlarmDeliveries(results);
    const delivered = outcome.reached;
    if (outcome.reached === 0 && outcome.unreached === 0) {
      return { delivered: 0, reason: "already alerted today", skipped: true, verdict: assessed };
    }

    await writeAuditLog({
      actorLoginId: ACTOR,
      entityId: "share_links.dead_token_polled",
      entityType: "notification",
      newValues: {
        affected,
        delivered,
        polled: assessed.polled.map((poll) => ({
          deadForDays: poll.deadForDays,
          reason: poll.reason,
          refusals: poll.refusals,
          sheet: poll.sheet,
        })),
        repeats: outcome.repeats,
        unreached: outcome.unreached,
        warnings,
      },
      summary: outcome.unreached > 0
        ? `Dead share-token polling alert delivered to ${delivered} recipient(s); ${outcome.unreached} not reached.`
        : `Dead share-token polling alert delivered to ${delivered} recipient(s).`,
    });

    return { delivered, skipped: delivered === 0, verdict: assessed };
  } catch (error) {
    // Swallow: an alarm about a silence must not become a second, self-inflicted outage.
    logError("Dead share-token polling check failed", {
      error,
      labels: { event: "share_link_dead_token_check_failed" },
    });
    return {
      delivered: 0,
      reason: error instanceof Error ? error.message : "unknown error",
      skipped: true,
      verdict,
    };
  }
}
