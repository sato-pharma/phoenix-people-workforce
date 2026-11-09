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
import { TABLET_NO_FIX_LIMIT_HOURS } from "@/lib/devices/headwind/fleet-watch";

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
  /** Every provisioning step done — in custody, SIM recorded, screen ID, a location fix, launcher current. */
  fullySetUp: number;
};

/**
 * How far one tablet's PROVISIONING has got — the one-time setup that makes it reachable on its own.
 *
 * Each flag is a step the owner drives a tablet through before it is "fully set up"; `ready` is all
 * five together. `online` and `batteryLevel` are deliberately NOT here — a finished tablet can be
 * briefly off or flat, and calling that "not set up" would send someone chasing a step already done.
 */
export type TabletReadiness = {
  /** Confirmed into the custody register (a person added it) — `!unregistered`. */
  inCustody: boolean;
  /** A SIM or line is recorded, so the tablet stays online on its own and never waits for a rep's Wi-Fi. */
  simRecorded: boolean;
  /** A RustDesk screen ID has been reported, so the screen can be viewed remotely. */
  screenIdReported: boolean;
  /** The tablet has reported at least one position (0/0 is nulled upstream, so a fix here is real). */
  locationReported: boolean;
  /** Running the newest launcher the fleet reports, or no target to compare against yet. */
  launcherCurrent: boolean;
  /** All five provisioning steps above are done. */
  ready: boolean;
};

/**
 * A launcher version string as one comparable number, or null when there is nothing to parse.
 *
 * 🔴 WHY NOT STRING COMPARE. These are `6.<build>` versions, so 6.39 is newer than 6.9 (build 39 beats
 * build 9) — but "6.39" < "6.9" as strings, which would call the newer tablet behind. The version is
 * split into its numeric segments and each weighted by position, so the order comes out 6.48 > 6.39 >
 * 6.9. A large per-segment base keeps the segments from colliding; launcher builds never approach it.
 * The running version comes from the tablet's app list, not the server's target field (see `devices.ts`
 * `runningLauncherVersion`), so the comparison is honest.
 */
export function launcherRank(version: string | null): number | null {
  if (!version) return null;
  const segments = version.split(/[^0-9]+/).filter((part) => part.length > 0);
  if (segments.length === 0) return null;
  const BASE = 1_000_000;
  let rank = 0;
  for (let index = 0; index < 3; index += 1) {
    const value = index < segments.length ? Number(segments[index]) : 0;
    if (!Number.isFinite(value)) return null;
    rank = rank * BASE + Math.min(value, BASE - 1);
  }
  return rank;
}

/**
 * The newest launcher the fleet is on, as a rank — the target every tablet is measured against.
 *
 * Self-maintaining on purpose: "current" means "level with the newest tablet in the fleet", so no
 * hard-coded version constant can go stale as the launcher is updated. Null when no tablet reports a
 * version — then no tablet is flagged behind, because there is nothing to be behind.
 */
export function fleetLauncherTarget(rows: readonly RepHeadwindRow[]): number | null {
  let target: number | null = null;
  for (const row of rows) {
    const rank = launcherRank(row.launcherVersion);
    if (rank !== null && (target === null || rank > target)) target = rank;
  }
  return target;
}

/** One tablet's provisioning state. `launcherTarget` defaults to the whole fleet's newest if omitted elsewhere. */
export function tabletSetupReadiness(
  row: RepHeadwindRow,
  opts: { launcherTarget?: number | null } = {},
): TabletReadiness {
  const launcherTarget = opts.launcherTarget ?? null;
  const myRank = launcherRank(row.launcherVersion);
  const inCustody = !row.unregistered;
  const simRecorded = Boolean(row.simNumber || row.lineNumber);
  const screenIdReported = Boolean(row.rustDeskId);
  const locationReported = Number.isFinite(row.latitude) && Number.isFinite(row.longitude);
  // No target, or this tablet has not reported a version, cannot be read as "behind" — it reads current.
  const launcherCurrent = launcherTarget === null || myRank === null || myRank >= launcherTarget;
  return {
    inCustody,
    launcherCurrent,
    locationReported,
    ready: inCustody && simRecorded && screenIdReported && locationReported && launcherCurrent,
    screenIdReported,
    simRecorded,
  };
}

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
  /** When the position was taken — null when the tablet did not say. */
  recordedAt?: string | null;
  /**
   * A fleet pin whose position is older than `TABLET_NO_FIX_LIMIT_HOURS`, or carries no time at all.
   * 🔴 It is drawn faded and its tooltip says "old position" — a pin with no age reads as "is here now".
   */
  stale?: boolean;
};

/** The shape the movements read hands over — kept local so this file imports no server module. */
export type DashboardLocationFix = {
  latitude: number;
  longitude: number;
  recordedAt: string | null;
  firstRecordedAt?: string | null;
  reports?: number;
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
  let fullySetUp = 0;
  // The target is the fleet's own newest launcher, so each tablet's "current?" is measured once against
  // the same bar — computed here, before the loop, rather than re-derived per row.
  const launcherTarget = fleetLauncherTarget(rows);
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
    if (tabletSetupReadiness(row, { launcherTarget }).ready) fullySetUp += 1;
  }
  return { fullySetUp, lowBattery, notInRegister, online, reportingLocation, screenReady, total: rows.length };
}

/** One marker per tablet that has reported a position — labelled with its asset tag, holder in the tooltip. */
export function fleetRowsToPoints(rows: readonly RepHeadwindRow[], now: number = Date.now()): MapPoint[] {
  const points: MapPoint[] = [];
  const limitMs = TABLET_NO_FIX_LIMIT_HOURS * 3_600_000;
  for (const row of rows) {
    if (!Number.isFinite(row.latitude) || !Number.isFinite(row.longitude)) continue;
    const taken = row.locatedAt ? Date.parse(row.locatedAt) : Number.NaN;
    points.push({
      recordedAt: row.locatedAt,
      stale: !Number.isFinite(taken) || now - taken > limitMs,
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
 * 🔴 ONE SOURCE PER LINE, AND ONLY TIMED FIXES ON IT. The movements read hands back two sources that
 * are never blended — the history plugin's record and the position riding on each check-in — and a
 * line joining a plugin fix to a check-in fix draws a route nobody reported. So the trail is drawn from
 * the plugin's fixes when it has any, and from the check-ins otherwise. A fix with no time cannot be
 * placed in order: it used to sort FIRST (an empty string) and became stop 1; it is now left off the
 * line and stays in the list below the map.
 */
export function fixesToPoints(fixes: readonly DashboardLocationFix[]): MapPoint[] {
  const timed = fixes.filter(
    (fix) =>
      Number.isFinite(fix.latitude) &&
      Number.isFinite(fix.longitude) &&
      typeof fix.recordedAt === "string" &&
      Number.isFinite(Date.parse(fix.recordedAt)),
  );
  const source = timed.some((fix) => fix.source === "plugin") ? "plugin" : "check-in";
  const ordered = timed
    .filter((fix) => fix.source === source)
    .sort((left, right) => Date.parse(left.recordedAt as string) - Date.parse(right.recordedAt as string));
  return ordered.map((fix, index) => ({
    id: `${fix.source}:${fix.recordedAt}:${fix.latitude},${fix.longitude}`,
    label: String(index + 1),
    latitude: fix.latitude,
    longitude: fix.longitude,
    order: index + 1,
    recordedAt: fix.recordedAt,
    sublabel: fix.recordedAt,
  }));
}
