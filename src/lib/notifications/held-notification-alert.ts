import { writeAuditLog } from "@/lib/admin/audit";
import { logError } from "@/lib/observability/log";
import { createSystemNotification } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// Tells a Super Admin, promptly, that the Notification Confidence Gate HELD an automated email.
//
// Before this existed, a hold only wrote a logInfo line: the mail was never delivered and nothing
// surfaced anywhere. Proven in production — two recruitment CV notifications were held on
// 2026-07-24 17:54 Cairo and were still sitting undecided at /admin/notification-confidence ~22
// hours later. The gate had turned a loud mass-send problem into a silent non-delivery problem,
// which is just as damaging and much harder to notice.
//
// Deliberately IN-APP + TELEGRAM ONLY, never email: the gate lives inside sendPhoenixEmail, so
// alerting by email could re-enter the gate and recurse. Passing explicit `channels` short-circuits
// policy resolution in resolveBasePolicyChannels, so no email delivery is ever created here.
//
// Best-effort by contract: never throws, and never changes the hold decision. An alert failure must
// not turn a held send into a second, self-inflicted outage — the hold itself is already recorded
// durably in notification_send_reviews regardless of what happens in this file.

const NOTIFY_AUDIENCE_ROLES = ["Super Admin"] as const;

// One alert per (module, eventType) per hour. A mass-fan-out incident holds many sends in a burst;
// without this, the 92-employee shape would have produced 92 alerts and buried the signal.
const ALERT_THROTTLE_MINUTES = 60;

// Guard against the pathological case of the alert path itself being held and re-alerting.
const HELD_ALERT_EVENT_TYPE = "notification_held_for_review";

type NotifyRecipient = { hrId: string; userId: string | null };

export type HeldNotificationAlertInput = {
  confidencePercent: number;
  eventType: string | null;
  failedCheckNames: string[];
  module: string | null;
  reviewId: string | null;
  subject: string;
};

export type HeldNotificationAlertResult = {
  delivered: number;
  reason?: string;
  skipped: boolean;
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

async function resolveNotifyRecipients(): Promise<{ recipients: NotifyRecipient[]; warnings: string[] }> {
  const warnings: string[] = [];
  const recipients: NotifyRecipient[] = [];
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("app_auth_users")
      .select("login_id,hr_id,is_active")
      .in("role", NOTIFY_AUDIENCE_ROLES as unknown as string[])
      .eq("is_active", true);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ hr_id?: string | null; login_id?: string | null }>) {
      const hrId = cleanText(row.hr_id).toUpperCase();
      if (!hrId) continue;
      recipients.push({ hrId, userId: cleanText(row.login_id) || null });
    }
  } catch (error) {
    warnings.push(
      `Held-notification alert recipients unavailable: ${error instanceof Error ? error.message : "unknown error"}`.slice(0, 160),
    );
  }
  return { recipients, warnings };
}

/**
 * True when this (module, eventType) pair already had an EARLIER hold inside the throttle window,
 * meaning an alert has already gone out for this burst.
 *
 * The caller's own review row is already persisted by the time we run, so a single fresh hold sees
 * exactly one row in the window and alerts; the 2nd..Nth holds of a burst see more and stay quiet.
 * Fails OPEN (returns false → alert anyway): a throttle-query error must never suppress the first
 * warning about held mail. Worst case is a duplicate alert, which is strictly better than silence.
 */
async function alreadyAlertedRecently(module: string | null, eventType: string | null): Promise<boolean> {
  try {
    const since = new Date(Date.now() - ALERT_THROTTLE_MINUTES * 60_000).toISOString();
    let query = getSupabaseAdmin()
      .from("notification_send_reviews")
      .select("id", { count: "exact", head: true })
      .eq("status", "held")
      .gte("created_at", since);
    query = module ? query.eq("module", module) : query.is("module", null);
    query = eventType ? query.eq("event_type", eventType) : query.is("event_type", null);
    const { count, error } = await query;
    if (error) throw error;
    return (count ?? 0) > 1;
  } catch (error) {
    logError("Held-notification alert throttle check failed — alerting anyway (fail-open)", {
      error,
      labels: { event: "held_notification_alert_throttle_failed", eventType: eventType ?? "", module: module ?? "" },
    });
    return false;
  }
}

export function buildHeldNotificationMessage(input: HeldNotificationAlertInput): string {
  const lines: string[] = [];
  lines.push("⏸️ An automated email was HELD and has NOT been sent.");
  lines.push("");
  lines.push(`Subject: ${input.subject}`.slice(0, 300));
  lines.push(`Source: ${input.module ?? "unknown"} / ${input.eventType ?? "unknown"}`);
  lines.push(`Confidence: ${input.confidencePercent}%`);
  if (input.failedCheckNames.length > 0) {
    lines.push(`Failed check(s): ${input.failedCheckNames.join(", ")}`);
  }
  lines.push("");
  lines.push("It stays undelivered until a Super Admin approves or discards it.");
  lines.push("Review → /admin/notification-confidence");
  return lines.join("\n");
}

/**
 * Best-effort alert that an automated email was held for review. Never throws.
 * Called from evaluateAndRecordNotificationSend's hold branch.
 */
export async function notifyNotificationHeld(input: HeldNotificationAlertInput): Promise<HeldNotificationAlertResult> {
  try {
    // Never alert about the alert (defensive; the alert is in-app/Telegram only, so it does not
    // pass through the email gate that could hold it in the first place).
    if (cleanText(input.eventType) === HELD_ALERT_EVENT_TYPE) {
      return { delivered: 0, reason: "self-referential", skipped: true };
    }

    if (await alreadyAlertedRecently(input.module, input.eventType)) {
      return { delivered: 0, reason: "throttled", skipped: true };
    }

    const { recipients, warnings } = await resolveNotifyRecipients();
    if (recipients.length === 0) {
      await writeAuditLog({
        actorLoginId: "confidence-gate",
        entityId: "notification.held_for_review",
        entityType: "notification",
        newValues: { failClosed: true, reviewId: input.reviewId, warnings },
        summary: "Held-notification alert skipped — no active Super Admin recipient resolved.",
      });
      return { delivered: 0, reason: "no recipients", skipped: true };
    }

    const message = buildHeldNotificationMessage(input);
    const idempotencyBase = `notification-held:${input.reviewId ?? `${input.module ?? "unknown"}:${input.eventType ?? "unknown"}`}`;

    let delivered = 0;
    await Promise.all(
      recipients.map(async (recipient) => {
        await createSystemNotification({
          actionUrl: "/admin/notification-confidence",
          actorId: "confidence-gate",
          // in_app + telegram ONLY — see the file header. Never add "email" here.
          channels: ["in_app", "telegram"],
          eventType: HELD_ALERT_EVENT_TYPE,
          message,
          metadata: {
            confidencePercent: input.confidencePercent,
            failedCheckNames: input.failedCheckNames,
            heldEventType: input.eventType,
            heldModule: input.module,
            idempotencyKey: `${idempotencyBase}:${recipient.hrId}`,
            reviewId: input.reviewId,
          },
          // module: "system" is the module actually enabled in notification_module_channel_policies
          // for Telegram — the same reason background-jobs-digest.ts and ireports360-sync-digest.ts
          // use it. An unknown module string fails closed in resolveTelegramGovernance.
          module: "system",
          priority: "high",
          recipientHrId: recipient.hrId,
          recipientUserId: recipient.userId,
          telegram: { ctaLabel: "Review held notifications", ctaUrl: "/admin/notification-confidence" },
          title: "Automated email held for review",
        });
        delivered += 1;
      }),
    );

    return { delivered, skipped: false };
  } catch (error) {
    // Swallow: a hold must never depend on the alert succeeding.
    logError("Held-notification alert failed to dispatch", {
      error,
      labels: { event: "held_notification_alert_failed", reviewId: input.reviewId ?? "" },
    });
    return { delivered: 0, reason: error instanceof Error ? error.message : "unknown error", skipped: true };
  }
}
