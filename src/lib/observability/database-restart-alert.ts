// THE ALARM that tells the owner the production database restarted, within fifteen minutes.
//
// WHY IT EXISTS. Production Postgres crash-restarted on 2026-10-10 11:05:48 and again on
// 2026-10-12 19:04:50 Cairo. Nothing reported either one: /api/healthz answered 200 throughout
// (it does not touch the database), `app_error_events` held 17 rows in the whole hour and none of
// them a 5xx, and the GCP alerting layer that would have caught a 5xx spike died with its billing
// on 2026-08-01. The owner found both himself, the second one two days later. This closes that.
//
// THE JUDGEMENT IS IMPORTED, NEVER DUPLICATED — `database-restart.ts` is pure and holds the rule
// and the wording; this file is the IO around it.
//
// DELIBERATELY NO EMAIL, and do not "fix" that back. Two independent reasons, either sufficient:
// the owner's standing rule is that no feature may add an outbound email, and an alarm that can
// fire because the database is unreachable must not travel by a channel whose outbox lives in that
// same database. In-app + Telegram + push on the existing technical-health audience, so it can be
// retargeted or silenced from /admin/notification-recipients without a migration.
//
// NOT BUCKETED PER CAIRO DAY, unlike its two siblings on this clock — and that difference is the
// point. A stranded job and a dead share token are STANDING faults that would alert every fifteen
// minutes; a restart is a discrete event, and the idempotency key is the start time itself, so a
// second restart on the same day is a second message. Two in three days is exactly the pattern
// that matters, and a day bucket would have shown one of them.

import { writeAuditLog } from "@/lib/admin/audit";
import {
  assessDatabaseRestart,
  buildDatabaseRestartMessage,
  cairoTimestamp,
  shouldAlertOnRestart,
  type DatabaseRestartVerdict,
} from "@/lib/observability/database-restart";
import { logError, logInfo } from "@/lib/observability/log";
import { createSystemNotification } from "@/lib/notifications/system";
import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const AUDIENCE_KEY = "weekly_system_health_digest" as const;
const EVENT_TYPE = "database_restarted";
const ACTOR = "database-restart-watch";
const SCREEN_URL = "/admin/system-audit";

export type DatabaseRestartCheckResult = {
  delivered: number;
  reason?: string;
  skipped: boolean;
  verdict: DatabaseRestartVerdict | null;
};

/**
 * Ask the database whether it has restarted since the last check, and page a human if it has.
 *
 * Best-effort — never throws. It is composed into a sweep that has other work to do, and this is
 * the one check in that sweep most likely to be running while the database is still unhappy: an
 * alarm that can abort the run it lives in takes that run down with it.
 */
export async function runDatabaseRestartCheck(): Promise<DatabaseRestartCheckResult> {
  let verdict: DatabaseRestartVerdict | null = null;
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.rpc("note_database_restart");
    if (error) throw error;

    // A `returns table` RPC comes back as an array of one row through PostgREST.
    const row = (Array.isArray(data) ? data[0] : data) as
      | { current_start_at?: string | null; is_new?: boolean | null; previous_start_at?: string | null }
      | null
      | undefined;
    if (!row?.current_start_at) {
      return { delivered: 0, reason: "no start time returned", skipped: true, verdict: null };
    }

    const assessed = assessDatabaseRestart({
      currentStartAt: String(row.current_start_at),
      isNew: row.is_new === true,
      previousStartAt: row.previous_start_at ? String(row.previous_start_at) : null,
    });
    verdict = assessed;

    if (assessed.kind === "first-sighting") {
      // Said out loud rather than swallowed: it is the one state where the watch records something
      // and deliberately stays quiet, and a silent skip here is indistinguishable from a broken RPC.
      logInfo("Database restart watch: first sighting recorded, no alert", {
        labels: { event: "database_restart_first_sighting" },
      });
      return { delivered: 0, reason: "first sighting", skipped: true, verdict: assessed };
    }

    if (!shouldAlertOnRestart(assessed)) {
      return { delivered: 0, reason: "unchanged", skipped: true, verdict: assessed };
    }

    // logError, not logInfo: this must be findable in `railway logs` whether or not the
    // notification went out, for the same reason the stranded-job sweep logs its own findings.
    logError("The production database restarted", {
      error: new Error(
        `postmaster start moved to ${assessed.currentStartAt} from ${assessed.kind === "restarted" ? assessed.previousStartAt : "unknown"}`,
      ),
      labels: { event: "database_restarted" },
    });

    const { recipients, warnings } = await resolveNotificationPersonRecipients(
      AUDIENCE_KEY,
      "Database restart alert recipients",
    );
    if (recipients.length === 0) {
      await writeAuditLog({
        actorLoginId: ACTOR,
        entityId: "observability.database_restarted",
        entityType: "notification",
        newValues: { failClosed: true, startedAt: assessed.currentStartAt, warnings },
        summary: "Database restart alert skipped — no active recipient resolved for the configured audience.",
      });
      return { delivered: 0, reason: "no recipients", skipped: true, verdict: assessed };
    }

    const message = buildDatabaseRestartMessage(assessed);
    const title = `The production database restarted at ${cairoTimestamp(assessed.currentStartAt)}`;

    let delivered = 0;
    await Promise.all(
      recipients.map(async (recipient) => {
        await createSystemNotification({
          actionUrl: SCREEN_URL,
          actorId: ACTOR,
          // No email — see the file header. In-app + Telegram + push only.
          channels: ["in_app", "telegram", "push"],
          eventType: EVENT_TYPE,
          message,
          // Keyed by the start time, not by the day: a second restart is a second message.
          metadata: {
            idempotencyKey: `database-restarted:${assessed.currentStartAt}:${recipient.hrId}`,
            postmasterStartAt: assessed.currentStartAt,
          },
          // module: "system" is the module actually enabled for Telegram in
          // notification_module_channel_policies — an unknown module string fails closed in
          // resolveTelegramGovernance, which would silently drop the alert.
          module: "system",
          priority: "high",
          recipientHrId: recipient.hrId,
          recipientUserId: recipient.userId,
          telegram: { ctaLabel: "Open the System Audit", ctaUrl: SCREEN_URL },
          title,
        });
        delivered += 1;
      }),
    );

    await writeAuditLog({
      actorLoginId: ACTOR,
      entityId: "observability.database_restarted",
      entityType: "notification",
      newValues: {
        delivered,
        previousStartAt: assessed.kind === "restarted" ? assessed.previousStartAt : null,
        startedAt: assessed.currentStartAt,
        warnings,
      },
      summary: `Database restart alert delivered to ${delivered} recipient(s) for a restart at ${assessed.currentStartAt}.`,
    });

    return { delivered, skipped: false, verdict: assessed };
  } catch (error) {
    // Swallow: an alarm about the database must not become a second, self-inflicted outage — and
    // this check runs while the database may still be refusing connections.
    logError("Database restart check failed", {
      error,
      labels: { event: "database_restart_check_failed" },
    });
    return {
      delivered: 0,
      reason: error instanceof Error ? error.message : "unknown error",
      skipped: true,
      verdict,
    };
  }
}
