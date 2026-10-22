/**
 * The pure arithmetic behind the Tablet Dashboard — fleet counts and map points.
 *
 * WHY IT IS A PLAIN `.ts` AND NOT PART OF THE COMPONENT. The dashboard's overview tiles and its map
 * are React, but the rules that turn fleet rows into counts and into map markers are ordinary data
 * work with one right answer, so they live here where `tests/headwind-bridge.test.ts` can exercise
 * them without a browser or React in the test runner. The components import these; they never
 * re-implement them.
 *
 * NOTHING HERE READS THE NETWORK. It is given the fleet the page already read, and it only counts and
 * reshapes. `import type` keeps `RepHeadwindRow` a compile-time name, so importing this file pulls no
 * server module into a client bundle or a unit test.
 */

import type { RepHeadwindRow } from "@/lib/devices/headwind/fleet";

/** A tablet's last check-in older than this reads as "not online now", never as lost. */
export const DASHBOARD_ONLINE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** At or below this, and not on the charger, a tablet is flagged low — a field rep's dead tablet is a lost day. */
export const DASHBOARD_LOW_BATTERY = 20;

/** The fleet overview, every figure derived from the rows the page already holds — no extra read. */
export type FleetSummary = {
  total: number;
  /** Checked in within the last day. */
  online: number;
  /** Carrying a last-known position. */
  reportingLocation: number;
  /** Set up for a remote screen session (has a RustDesk ID). */
  screenReady: number;
  /** At or below 20% and off the charger. */
  lowBattery: number;
  /** Managed by the server but not confirmed into the custody register yet. */
  notInRegister: number;
};

/** One marker on the map — a tablet's last-known position, or one stop on a single tablet's trail. */
export type MapPoint = {
  id: string;
  latitude: number;
  longitude: number;
  /** What the marker is labelled with: a tablet's asset tag, or a trail stop's number. */
  label: string;
  /** A second line for the marker's tooltip — the holder, or the time of a trail stop. */
  sublabel: string | null;
  /** The stop's order on a trail (1-based); null for a fleet marker. */
  order: number | null;
};

/** The shape the movements read hands over — kept local so this file imports no server module. */
export type DashboardLocationFix = {
  latitude: number;
  longitude: number;
  recordedAt: string | null;
  batteryLevel: number | null;
  source: "check-in" | "plugin";
};

/** Every figure on the overview strip, counted from the fleet rows. `now` is injectable for tests. */
export function summarizeFleet(rows: readonly RepHeadwindRow[], now: number = Date.now()): FleetSummary {
  let online = 0;
  let reportingLocation = 0;
  let screenReady = 0;
  let lowBattery = 0;
  let notInRegister = 0;
  for (const row of rows) {
    if (row.lastContactAt) {
      const seen = Date.parse(row.lastContactAt);
      if (Number.isFinite(seen) && now - seen <= DASHBOARD_ONLINE_WINDOW_MS) online += 1;
    }
    if (Number.isFinite(row.latitude) && Number.isFinite(row.longitude)) reportingLocation += 1;
    if (row.rustDeskId) screenReady += 1;
    if (row.batteryLevel !== null && row.batteryLevel <= DASHBOARD_LOW_BATTERY && row.batteryCharging !== true) {
      lowBattery += 1;
    }
    if (row.unregistered) notInRegister += 1;
  }
  return { lowBattery, notInRegister, online, reportingLocation, screenReady, total: rows.length };
}

/** One marker per tablet that has reported a position — labelled with its asset tag, holder in the tooltip. */
export function fleetRowsToPoints(rows: readonly RepHeadwindRow[]): MapPoint[] {
  const points: MapPoint[] = [];
  for (const row of rows) {
    if (!Number.isFinite(row.latitude) || !Number.isFinite(row.longitude)) continue;
    points.push({
      id: row.deviceNumber,
      label: row.assetTag ?? row.name ?? row.deviceNumber,
      latitude: row.latitude as number,
      longitude: row.longitude as number,
      order: null,
      // A tablet nobody holds yet still belongs on the map — say which it is rather than leave it blank.
      sublabel: row.holderName ?? (row.unregistered ? "Not in the custody register" : null),
    });
  }
  return points;
}

/**
 * One tablet's fixes as a numbered trail, oldest first.
 *
 * The movements read hands the fixes back newest-first; a trail reads in time order, so they are
 * sorted ascending here and numbered from 1. A fix with no coordinates is dropped — it cannot be
 * drawn — and a fix with no time still takes its place in the order it arrived.
 */
export function fixesToPoints(fixes: readonly DashboardLocationFix[]): MapPoint[] {
  const usable = fixes.filter((fix) => Number.isFinite(fix.latitude) && Number.isFinite(fix.longitude));
  const ordered = usable
    .slice()
    .sort((left, right) => String(left.recordedAt ?? "").localeCompare(String(right.recordedAt ?? "")));
  return ordered.map((fix, index) => ({
    id: `${fix.source}:${fix.recordedAt ?? index}:${fix.latitude},${fix.longitude}`,
    label: String(index + 1),
    latitude: fix.latitude,
    longitude: fix.longitude,
    order: index + 1,
    sublabel: fix.recordedAt,
  }));
}
