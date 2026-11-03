import { buildFleetWatchMessage, type FleetWatchVerdict } from "@/lib/devices/headwind/fleet-watch";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { hrIdsForRoles } from "@/lib/recruitment/inbound/recruitment-notify";

/**
 * Tells the Super Admin, and nobody else, about a tablet to look at (owner, 2026-11-03). In-app, Telegram
 * and push, never email. A rep or a manager never receives this: reps see no sign of the fleet's tracking.
 *
 * Keyed per Cairo day and per set of tablets, so a standing fault says it once a day while a NEW tablet still
 * gets through. The unregistered count is keyed on the count alone, so it speaks when it changes and does not
 * become a daily line of its own.
 */

const ACTION_URL = "/devices/tablets/dashboard";

export type FleetWatchAlertResult = { delivered: number; reason?: string; skipped: boolean };

function cairoDayKey(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
}

export function fleetWatchIdempotencyKey(verdict: Pick<FleetWatchVerdict, "faults" | "unregistered">, cairoDay: string): string {
  const tablets = verdict.faults.map((fault) => `${fault.deviceNumber}:${fault.kind}`).sort();
  return tablets.length > 0
    ? `tablet-fleet-watch:${cairoDay}:${tablets.join(",")}:unregistered-${verdict.unregistered}`
    : `tablet-fleet-watch:unregistered-${verdict.unregistered}`;
}

/** Best-effort, never throws. A lost alert comes back as a reason, and the route turns that into a failed run. */
export async function notifyTabletFleet(verdict: FleetWatchVerdict): Promise<FleetWatchAlertResult> {
  try {
    if (verdict.faults.length === 0 && verdict.unregistered === 0) {
      return { delivered: 0, reason: "healthy", skipped: true };
    }
    const recipients = await hrIdsForRoles(["Super Admin"]);
    if (recipients.length === 0) return { delivered: 0, reason: "no recipients", skipped: true };

    await createSystemNotificationForRecipients(
      {
        actionUrl: ACTION_URL,
        actorId: "tablet-fleet-watch",
        channels: ["in_app", "telegram", "push"],
        eventType: "tablet_fleet_watch",
        message: buildFleetWatchMessage(verdict),
        metadata: { idempotencyKey: fleetWatchIdempotencyKey(verdict, cairoDayKey()) },
        // `system` is the module enabled for Telegram; an unknown module string fails closed.
        module: "system",
        priority: verdict.faults.length > 0 ? "high" : "normal",
        telegram: { ctaLabel: "Open the Tablet Dashboard", ctaUrl: ACTION_URL },
        title: verdict.faults.length > 0 ? `${verdict.faults.length} tablet(s) to look at` : `${verdict.unregistered} tablet(s) not in the register`,
      },
      recipients,
    );
    return { delivered: recipients.length, skipped: false };
  } catch (error) {
    logError("Tablet fleet watch alert failed to dispatch", {
      error,
      labels: { event: "tablet_fleet_watch_alert_failed" },
    });
    return { delivered: 0, reason: error instanceof Error ? error.message : "unknown error", skipped: true };
  }
}
