import { writeAuditLog } from "@/lib/admin/audit";
import { getInactiveUsers, type InactiveUser } from "@/lib/activity/service";
import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import { createSystemNotification } from "@/lib/notifications/system";
import { cairoDate } from "@/lib/format/cairo-datetime";
import { logError } from "@/lib/observability/log";

/**
 * Tells a human, once a day, which colleagues have not signed in to Phoenix for a week or more.
 *
 * What this replaces: the same list was computed on the FIVE-MINUTE notification cron — about 288
 * times a day, re-reading up to 60,000 session rows each time — and then written to the server log
 * as five names and an ellipsis. Nobody received it, nobody read it, and the names it dropped were
 * dropped in the one way the owner's standing rules forbid outright (never truncate with an
 * ellipsis). Owner's decision, 2026-09-26, asked as a multiple choice: daily, in-app and on his
 * Telegram, never email.
 *
 * Deliberately no email channel — his standing rule for internal notices of this kind, and the
 * reason the audience key is its own (`activity_inactivity_digest`) rather than borrowed from an
 * email-carrying digest.
 *
 * Best-effort: never throws. A digest that fails must not take the daily cron down with it.
 */

const AUDIENCE_KEY = "activity_inactivity_digest" as const;
const EVENT_TYPE = "activity_inactivity_digest";
const INACTIVE_AFTER_DAYS = 7;

export type InactiveUserDigestResult = {
  delivered: number;
  inactiveCount: number;
  reason?: string;
  skipped: boolean;
};

/** Cairo calendar day — the idempotency bucket, so one digest per day even if the cron runs twice. */
function cairoDayKey(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
}

/** "19 Aug 2026" in Cairo, or the words for someone who has never signed in at all. */
function describeLastSeen(user: InactiveUser): string {
  if (!user.lastSeenIso) return "has never signed in";
  return `last signed in ${cairoDate(user.lastSeenIso)} (${user.daysSinceSeen} days ago)`;
}

/**
 * Pure message builder — no IO, so it is unit-testable without a database.
 *
 * EVERY name, never a count with an ellipsis behind it: the code this replaces printed
 * "…" after five names, which is exactly the thing the owner's rules forbid. Names, never
 * HR codes. Cairo dates, never raw UTC.
 */
export function buildInactiveUserDigestMessage(users: InactiveUser[]): string {
  const neverSignedIn = users.filter((user) => !user.lastSeenIso);
  const lapsed = users.filter((user) => user.lastSeenIso);
  const lines: string[] = [
    `${users.length} colleague${users.length === 1 ? " has" : "s have"} not used Phoenix for ${INACTIVE_AFTER_DAYS} days or more.`,
  ];

  if (lapsed.length) {
    lines.push("", "Stopped signing in:");
    for (const user of lapsed) {
      lines.push(`• ${user.name} — ${user.role} — ${describeLastSeen(user)}`);
    }
  }

  if (neverSignedIn.length) {
    lines.push("", "Never signed in at all:");
    for (const user of neverSignedIn) {
      lines.push(`• ${user.name} — ${user.role}`);
    }
  }

  lines.push(
    "",
    "Someone who works entirely outside Phoenix is not a problem by itself — this is a list to look at, not a verdict.",
  );
  return lines.join("\n");
}

export async function notifyInactiveUsers(): Promise<InactiveUserDigestResult> {
  try {
    const users = await getInactiveUsers(INACTIVE_AFTER_DAYS);
    // Nothing to say: send nothing at all, rather than a daily "all clear" nobody asked for.
    if (users.length === 0) return { delivered: 0, inactiveCount: 0, reason: "nobody inactive", skipped: true };

    const { recipients, warnings } = await resolveNotificationPersonRecipients(
      AUDIENCE_KEY,
      "Inactive-colleague digest recipients",
    );

    if (recipients.length === 0) {
      // Fail CLOSED and leave a trace: a digest that resolves nobody is a silent hole, and the
      // whole point of this change is that the previous version was silent.
      await writeAuditLog({
        actorLoginId: "activity-inactivity-cron",
        entityId: "activity.inactivity_digest",
        entityType: "notification",
        newValues: { failClosed: true, inactiveCount: users.length, warnings },
        summary: "Inactive-colleague digest skipped — no active recipient resolved for the configured audience.",
      });
      return { delivered: 0, inactiveCount: users.length, reason: "no recipients", skipped: true };
    }

    const message = buildInactiveUserDigestMessage(users);
    // Per-recipient suffix: two recipients on one key would collide on a single notification row.
    const idempotencyBase = `activity-inactivity-digest:${cairoDayKey()}`;

    let delivered = 0;
    await Promise.all(
      recipients.map(async (recipient) => {
        await createSystemNotification({
          actionUrl: "/admin/activity-control",
          actorId: "activity-inactivity-cron",
          // No email — the owner's standing rule for this notice. In-app + Telegram only.
          channels: ["in_app", "telegram"],
          eventType: EVENT_TYPE,
          message,
          metadata: {
            idempotencyKey: `${idempotencyBase}:${recipient.hrId}`,
            inactiveCount: users.length,
          },
          // module: "system" is the module actually enabled for Telegram in
          // notification_module_channel_policies — an unknown module string fails closed in
          // resolveTelegramGovernance, which would silently drop the Telegram half.
          module: "system",
          priority: "normal",
          recipientHrId: recipient.hrId,
          recipientUserId: recipient.userId,
          telegram: { ctaLabel: "Open Activity Control", ctaUrl: "/admin/activity-control" },
          title: `${users.length} colleague${users.length === 1 ? "" : "s"} have not used Phoenix in ${INACTIVE_AFTER_DAYS}+ days`,
        });
        delivered += 1;
      }),
    );

    await writeAuditLog({
      actorLoginId: "activity-inactivity-cron",
      entityId: "activity.inactivity_digest",
      entityType: "notification",
      newValues: { delivered, inactiveCount: users.length, warnings },
      summary: `Inactive-colleague digest delivered to ${delivered} recipient(s) — ${users.length} inactive.`,
    });

    return { delivered, inactiveCount: users.length, skipped: false };
  } catch (error) {
    logError("Inactive-colleague digest failed to dispatch", {
      error,
      labels: { event: "activity_inactivity_digest_failed" },
    });
    return {
      delivered: 0,
      inactiveCount: 0,
      reason: error instanceof Error ? error.message : "unknown error",
      skipped: true,
    };
  }
}
