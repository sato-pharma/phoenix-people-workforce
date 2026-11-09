import { buildFleetWatchMessage, type FleetWatchVerdict } from "@/lib/devices/headwind/fleet-watch";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { hrIdsForRoles } from "@/lib/recruitment/inbound/recruitment-notify";

/**
 * Tells the Super Admin, and nobody else, about a tablet to look at (owner, 2026-11-03). In-app, Telegram
 * and push, never email. A rep or a manager never receives this: reps see no sign of the fleet's tracking.
 *
 * Keyed per Cairo day and per set of tablets, so a standing fault says it once a day while a NEW tablet still
 * gets through. A tablet that never reported a location, the unregistered count and the count of tablets that
 * never sent their hardware report are keyed on the Cairo month instead, so they speak when they change, repeat
 * once a month rather than daily, and a count that comes back to an earlier number is not silent for good.
 */

const ACTION_URL = "/devices/tablets/dashboard";

export type FleetWatchAlertResult = { reason?: string; skipped: boolean };

function isDailyFault(fault: FleetWatchVerdict["faults"][number]): boolean {
  return fault.kind !== "never_fixed";
}

function cairoDayKey(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
}

export function fleetWatchIdempotencyKey(
  verdict: Pick<FleetWatchVerdict, "faults" | "unregistered"> & Partial<Pick<FleetWatchVerdict, "awaitingHardwareReport">>,
  cairoDay: string,
): string {
  const tablets = verdict.faults.map((fault) => `${fault.deviceNumber}:${fault.kind}`).sort();
  const period = verdict.faults.some(isDailyFault) ? cairoDay : cairoDay.slice(0, 7);
  // Only when there is one, so the key a fleet with none already sent under is unchanged.
  const awaiting = verdict.awaitingHardwareReport ? `,awaiting-${verdict.awaitingHardwareReport}` : "";
  return `tablet-fleet-watch:${period}:${tablets.map((tablet) => `${tablet},`).join("")}unregistered-${verdict.unregistered}${awaiting}`;
}

/** How many different tablets the faults name — one tablet can carry two (a launcher behind and no fix). */
export function fleetWatchTabletCount(verdict: Pick<FleetWatchVerdict, "faults">): number {
  return new Set(verdict.faults.map((fault) => fault.deviceNumber)).size;
}

/** Best-effort, never throws. A lost alert comes back as a reason, and the route turns that into a failed run. */
export async function notifyTabletFleet(verdict: FleetWatchVerdict): Promise<FleetWatchAlertResult> {
  try {
    if (verdict.faults.length === 0 && verdict.unregistered === 0 && verdict.awaitingHardwareReport === 0) {
      return { reason: "healthy", skipped: true };
    }
    const recipients = await hrIdsForRoles(["Super Admin"]);
    if (recipients.length === 0) return { reason: "no recipients", skipped: true };

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
        priority: verdict.faults.some(isDailyFault) ? "high" : "normal",
        telegram: { ctaLabel: "Open the Tablet Dashboard", ctaUrl: ACTION_URL },
        title:
          verdict.faults.length > 0
            ? `${fleetWatchTabletCount(verdict)} tablet(s) to look at`
            : `${verdict.unregistered + verdict.awaitingHardwareReport} tablet(s) not in the register`,
      },
      recipients,
    );
    return { skipped: false };
  } catch (error) {
    logError("Tablet fleet watch alert failed to dispatch", {
      error,
      labels: { event: "tablet_fleet_watch_alert_failed" },
    });
    return { reason: error instanceof Error ? error.message : "unknown error", skipped: true };
  }
}
