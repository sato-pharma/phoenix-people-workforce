"use client";

/**
 * The strip of figures across the top of the Tablet Dashboard — how many tablets, how many online,
 * how many reporting a position, how many ready for a remote screen, how many low on battery, and how
 * many a person has not confirmed into custody yet.
 *
 * Every figure is counted from the fleet the page already read (`summarizeFleet`) — no extra request.
 * The tiles are the shared `AdminStatCard`, in the same six-across grid the expense KPIs use, so the
 * look matches the rest of the admin shell (slate borders, square corners, 9px micro-labels).
 */

import { BatteryLow, CheckCircle2, MapPin, Monitor, Tablet, UserPlus, Wifi } from "lucide-react";

import { AdminStatCard } from "@/components/admin/admin-design-system";
import { summarizeFleet } from "@/lib/devices/headwind/dashboard";
import type { RepHeadwindRow } from "@/lib/devices/headwind/fleet";

export function TabletFleetOverview({ rows, registerError }: { rows: RepHeadwindRow[]; registerError: boolean }) {
  const summary = summarizeFleet(rows);
  const iconClass = "h-4 w-4";
  return (
    <section className="space-y-2">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7">
        <AdminStatCard
          description="Managed by the company server"
          icon={<Tablet className={iconClass} aria-hidden />}
          label="Tablets"
          size="compact"
          tone="blue"
          value={summary.total}
        />
        <AdminStatCard
          description="Every setup step done"
          icon={<CheckCircle2 className={iconClass} aria-hidden />}
          label="Fully set up"
          size="compact"
          tone="emerald"
          value={`${summary.fullySetUp} / ${summary.total}`}
        />
        <AdminStatCard
          description="Checked in within the last day"
          icon={<Wifi className={iconClass} aria-hidden />}
          label="Online now"
          size="compact"
          tone="emerald"
          value={summary.online}
        />
        <AdminStatCard
          description="Carrying a last-known position"
          icon={<MapPin className={iconClass} aria-hidden />}
          label="Reporting location"
          size="compact"
          tone="orange"
          value={summary.reportingLocation}
        />
        <AdminStatCard
          description="Set up for a remote screen"
          icon={<Monitor className={iconClass} aria-hidden />}
          label="Screen-ready"
          size="compact"
          tone="violet"
          value={summary.screenReady}
        />
        <AdminStatCard
          description="At or below 20%, off the charger"
          icon={<BatteryLow className={iconClass} aria-hidden />}
          label="Low battery"
          size="compact"
          tone="rose"
          value={summary.lowBattery}
        />
        <AdminStatCard
          description={registerError ? "Register could not be read" : "Not confirmed into custody yet"}
          icon={<UserPlus className={iconClass} aria-hidden />}
          label="Not in register"
          size="compact"
          tone="orange"
          value={registerError ? "—" : summary.notInRegister}
        />
      </div>
    </section>
  );
}
