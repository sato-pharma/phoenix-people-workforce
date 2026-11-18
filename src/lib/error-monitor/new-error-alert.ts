// The new-error Telegram's IO (owner, 17 Nov 2026). The rules — what "new" means, production only, the wording,
// the per-process memory and the flood cap — are pure, in new-error-alert-rules.ts.
//
// Reached two ways, both fire-and-forget and never awaited by a request: logAppError (service.ts) after an
// app_error_events row is written, and the process-health reporter when a page server freezes past the line.
//
// The technical-health audience, on the same path as the database alarms (db-host-alert.ts), retargeted or
// silenced from /admin/notification-recipients. Telegram only, never email: it is an alarm built for him, and
// operator-watch-channel-guard.ts stops the failed-Telegram fallback from turning it into one.
//
// ONCE PER ERROR, EVER. The idempotency key is the error's signature and the recipient, so a redeploy, a second
// process or a repeat in an hour cannot send the same error twice; the in-process memory only saves the read.

import { createSystemNotification } from "@/lib/notifications/system";
import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import { logWarning } from "@/lib/observability/log";
import {
  createNewErrorAlertSlots,
  newErrorAlertRefusal,
  newErrorAlertText,
  newErrorSignature,
  releaseNewErrorAlertSlot,
  rememberNewErrorSignature,
  takeNewErrorAlertSlot,
  type NewErrorReport,
} from "@/lib/error-monitor/new-error-alert-rules";

const AUDIENCE_KEY = "weekly_system_health_digest" as const;
const ACTOR = "error-monitor";
const SCREEN_URL = "/admin/system-audit";

const seen = new Set<string>();
const slots = createNewErrorAlertSlots();

/**
 * Never throws. Its own failure is a WARNING, never `logError`: an error line writes an app_error_events row,
 * and writing a row is what calls this.
 */
export async function alertNewError(report: NewErrorReport): Promise<void> {
  let signature: string | null = null;
  let takenInWindow: number | null = null;
  try {
    if (newErrorAlertRefusal({ appEnv: process.env.APP_ENV, message: report.message })) return;
    signature = newErrorSignature(report);
    if (!rememberNewErrorSignature(seen, signature)) return;
    if (!takeNewErrorAlertSlot(slots, Date.now())) {
      // Forgotten again, so the next occurrence after the window gets its turn: a genuinely new error that was only
      // held back is not lost for the life of this process. (The database key still keeps it to once, ever.)
      seen.delete(signature);
      logWarning("New-error alert held back: too many new errors in ten minutes — read the System Audit", {
        labels: { event: "new_error_alert_capped", signature },
      });
      return;
    }
    takenInWindow = slots.windowStartedAt;

    const { recipients } = await resolveNotificationPersonRecipients(AUDIENCE_KEY, "New error alert recipients");
    if (recipients.length === 0) {
      releaseNewErrorAlertSlot(slots, takenInWindow);
      return;
    }

    const { message, title } = newErrorAlertText(report);
    const results = await Promise.all(
      recipients.map((recipient) =>
        createSystemNotification({
          actionUrl: SCREEN_URL,
          actorId: ACTOR,
          // Telegram only — see the file header.
          channels: ["telegram"],
          eventType: "new_app_error",
          message,
          metadata: { idempotencyKey: `new-app-error:${signature}:${recipient.hrId}` },
          // "system" is the module enabled for Telegram; an unknown module fails closed and drops the alarm.
          module: "system",
          priority: "high",
          recipientHrId: recipient.hrId,
          recipientUserId: recipient.userId,
          telegram: { ctaLabel: "Open the System Audit", ctaUrl: SCREEN_URL },
          title,
        }),
      ),
    );
    // Nothing went out when every delivery was skipped (already told for this error, or nobody reachable): the slot is
    // given back, so ten known errors recurring after a deploy cannot use the whole window and cap a new one. The
    // signature stays remembered — the database already knows it.
    if (results.every((result) => result.deliveries.every((delivery) => delivery.status === "skipped"))) {
      releaseNewErrorAlertSlot(slots, takenInWindow);
    }
  } catch (error) {
    // A failed read or send is retried by the next occurrence, not lost for the life of this process.
    if (signature) seen.delete(signature);
    if (takenInWindow !== null) releaseNewErrorAlertSlot(slots, takenInWindow);
    logWarning("New-error alert failed (the error itself is recorded on the System Audit)", {
      error,
      labels: { event: "new_error_alert_failed" },
    });
  }
}
