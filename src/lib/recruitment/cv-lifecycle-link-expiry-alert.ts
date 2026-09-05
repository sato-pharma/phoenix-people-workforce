// THE ALARM that pushes the CV-lifecycle feed-token verdict at a person, once a day.
//
// The judgement itself lives in `cv-lifecycle-link-expiry.ts` and is imported, never duplicated —
// see that file's header for why the split exists and why the screen reads the same function.
//
// DELIBERATELY NO EMAIL, and do not "fix" that back. The owner's standing rule is that no feature
// may add an outbound email, and the same reasoning as `job-heartbeat-alert.ts` applies here: this
// is a system-health alarm, and an alarm that travels by the channel it might be reporting broken
// is not an alarm. In-app + Telegram + push, on the existing technical-health audience, so the
// owner can retarget or silence it from /admin/notification-recipients without a migration.
//
// WHY A WARNING AND NOT AUTOMATIC ROTATION. Direct orders and marketing both rotate their sheet
// tokens on a weekly cron (`sheet-token-rotation.ts`), which is strictly better than warning a
// human. That path needs the sheet to accept a PUSH — a deployed Apps Script web app plus a
// WEBHOOK_SECRET script property — and `docs/cv-lifecycle-live-sheet.gs` has neither: it is
// pull-only, FEED_URL in Script Properties, no `doPost`. Rotation therefore cannot be built from
// this side alone, and shipping half of it would revoke a live token the sheet could never replace.
// The warning is what can be delivered without touching the owner's spreadsheet; rotation is the
// follow-up, and it starts in the .gs file.

import { writeAuditLog } from "@/lib/admin/audit";
import { createSystemNotification } from "@/lib/notifications/system";
import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import { logError } from "@/lib/observability/log";
import {
  assessCvLifecycleLinkExpiry,
  buildCvLifecycleLinkExpiryMessage,
  type CvLifecycleLinkExpiryVerdict,
} from "@/lib/recruitment/cv-lifecycle-link-expiry";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const AUDIENCE_KEY = "weekly_system_health_digest" as const;
const EVENT_TYPE = "cv_lifecycle_link_expiring";
const ACTOR = "cv-lifecycle-link-expiry";
const SCREEN_URL = "/recruitment/cv-lifecycle-sheet";

export type CvLifecycleLinkExpiryRunResult = {
  delivered: number;
  reason?: string;
  skipped: boolean;
  verdict: CvLifecycleLinkExpiryVerdict | null;
};

/** Cairo calendar day — the idempotency bucket, so a standing warning alerts once a day. */
function cairoDayKey(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
}

/**
 * Read the links, judge them, and page a human if the feed is about to go dark.
 *
 * Reads the table directly rather than through `listCvLifecycleShareLinks`, which asserts a
 * permission against an `AccessContext` a cron job does not have. Only the four columns the
 * judgement needs are selected, so a token cannot reach a log line or a notification body from
 * here even by accident.
 *
 * Best-effort — never throws. It is composed into the daily recruitment run beside two other checks
 * that swallow their own errors for the same reason: a warning that can abort the run it lives in
 * takes the interview reminders down with it.
 */
export async function runCvLifecycleLinkExpiryCheck(): Promise<CvLifecycleLinkExpiryRunResult> {
  let verdict: CvLifecycleLinkExpiryVerdict | null = null;
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("ats_cv_lifecycle_share_links")
      .select("id,label,expires_at,revoked_at")
      .order("expires_at", { ascending: true })
      .limit(100);
    if (error) throw error;

    // Bound to a `const` and used through it for the rest of this block. `verdict` is a mutable
    // `let` because the catch below has to report whatever was reached before the throw — and
    // TypeScript widens a mutable binding back to its declared type inside a CLOSURE, so
    // `verdict.expired` in the `recipients.map` callback is `possibly null` however thoroughly it
    // was narrowed out here. That is a real compile error, not a lint preference: it failed the
    // required typecheck job on this PR's first head. Do not collapse the two back into one.
    const assessed = assessCvLifecycleLinkExpiry(
      ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
        expiresAt: String(row.expires_at ?? ""),
        id: String(row.id ?? ""),
        label: row.label ? String(row.label) : null,
        revokedAt: row.revoked_at ? String(row.revoked_at) : null,
      })),
      Date.now(),
    );
    verdict = assessed;

    if (assessed.healthy) return { delivered: 0, reason: "healthy", skipped: true, verdict: assessed };

    const { recipients, warnings } = await resolveNotificationPersonRecipients(
      AUDIENCE_KEY,
      "CV-lifecycle sheet link expiry recipients",
    );
    if (recipients.length === 0) {
      await writeAuditLog({
        actorLoginId: ACTOR,
        entityId: "recruitment.cv_lifecycle_link_expiring",
        entityType: "notification",
        newValues: { failClosed: true, warnings },
        summary: "CV-lifecycle link expiry warning skipped — no active recipient resolved.",
      });
      return { delivered: 0, reason: "no recipients", skipped: true, verdict: assessed };
    }

    const message = buildCvLifecycleLinkExpiryMessage(assessed);
    const dead = assessed.expired.length > 0;
    const title = dead
      ? "Live CV sheet has stopped updating"
      : `Live CV sheet link expires in ${assessed.expiringSoon[0]?.daysLeft ?? 0} day(s)`;
    // Bucketed per Cairo day AND per the exact set of link ids, so a link that stays inside the
    // window warns once a day while a NEWLY expiring one still gets through rather than being
    // swallowed by an earlier key.
    const affected = [...assessed.expired, ...assessed.expiringSoon].map((link) => link.id).sort();
    const idempotencyBase = `cv-lifecycle-link-expiring:${cairoDayKey()}:${affected.join(",")}`;

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
          metadata: { affectedLinkIds: affected, idempotencyKey: `${idempotencyBase}:${recipient.hrId}` },
          // `system`, not `recruitment`: this is the module enabled for Telegram in
          // notification_module_channel_policies, and an unknown module string fails CLOSED in
          // resolveTelegramGovernance — which would silently drop the one alert that exists to
          // break a silence.
          module: "system",
          priority: dead ? "high" : "normal",
          recipientHrId: recipient.hrId,
          recipientUserId: recipient.userId,
          telegram: { ctaLabel: "Open CV sheet links", ctaUrl: SCREEN_URL },
          title,
        });
        delivered += 1;
      }),
    );

    await writeAuditLog({
      actorLoginId: ACTOR,
      entityId: "recruitment.cv_lifecycle_link_expiring",
      entityType: "notification",
      newValues: { affected, delivered, warnings },
      summary: `CV-lifecycle link expiry warning delivered to ${delivered} recipient(s).`,
    });

    return { delivered, skipped: false, verdict: assessed };
  } catch (error) {
    // Swallow: a warning about a feed going quiet must not become a second, self-inflicted outage.
    logError("CV-lifecycle link expiry check failed", {
      error,
      labels: { event: "cv_lifecycle_link_expiry_check_failed" },
    });
    return {
      delivered: 0,
      reason: error instanceof Error ? error.message : "unknown error",
      skipped: true,
      verdict,
    };
  }
}
