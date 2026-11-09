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
import { launcherRank, TABLET_NO_FIX_LIMIT_HOURS } from "@/lib/devices/headwind/fleet-watch";

// One copy of the version arithmetic, shared with the fleet watch (it lives there to avoid an import cycle).
export { launcherRank };

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
  /** Of those, the ones that never sent their hardware report (no serial, no IMEI), so cannot be added yet. */
  awaitingHardwareReport: number;
  /** Every provisioning step done — in custody, SIM recorded, screen ID, a location fix, launcher current. */
  fullySetUp: number;
};

/**
 * Where a tablet's launcher stands against the fleet's target.
 *
 * 🔴 "not_reported" IS ITS OWN ANSWER, NEVER "current". A tablet whose app list names no launcher has
 * told us nothing; counting it current hid exactly the tablets that had stopped reporting.
 */
export type LauncherStanding = "current" | "behind" | "not_reported";

/**
 * How far one tablet's PROVISIONING has got — the one-time setup that makes it reachable on its own.
 *
 * Each flag is a step the owner drives a tablet through before it is "fully set up"; `ready` is all
 * five together. `online` and `batteryLevel` are deliberately NOT here — a finished tablet can be
 * briefly off or flat, and calling that "not set up" would send someone chasing a step already done.
 *
 * 🔴 NULL MEANS "THE REGISTER COULD NOT BE READ". Custody and the SIM come from the register; when it did
 * not answer, a tick on "In custody" and a cross on "SIM" were both invented. They read null, and a
 * tablet with an unknown step is never counted fully set up.
 */
export type TabletReadiness = {
  /** Confirmed into the custody register (a person added it). Null when the register could not be read. */
  inCustody: boolean | null;
  /** A SIM or line is recorded, so the tablet stays online on its own. Null when the register could not be read. */
  simRecorded: boolean | null;
  /** A RustDesk screen ID has been reported, so the screen can be viewed remotely. */
  screenIdReported: boolean;
  /** The tablet has reported at least one position (0/0 is nulled upstream, so a fix here is real). */
  locationReported: boolean;
  /** Running at least the fleet's target launcher. False when behind AND when the tablet reports none. */
  launcherCurrent: boolean;
  /** The launcher step in full — current, behind, or not reported by the tablet. */
  launcher: LauncherStanding;
  /** All five provisioning steps above are done. */
  ready: boolean;
};

/**
 * The launcher every tablet is measured against, as a rank: the HIGHER of the newest version any tablet
 * RUNS and the newest version the server WANTS a tablet on.
 *
 * 🔴 THE RUNNING VERSIONS ALONE TRUSTED A STALLED FLEET. "Current" used to mean "level with the newest
 * tablet", so when every tablet's update run stopped at the same dead install link (9 Nov 2026: 6.39 for
 * 17 days while the rules wanted 6.48) they were all level with each other and all read current. The
 * wanted version is the row's `agentVersion` — the device record's top-level `launcherVersion`, which is
 * the server's target (`devices.ts`), never the tablet's own word. Running stays in the bar so a tablet
 * updated ahead of a stale target still sets it. Null only when nobody reports either.
 */
export function fleetLauncherTarget(rows: readonly RepHeadwindRow[]): number | null {
  let target: number | null = null;
  for (const row of rows) {
    for (const version of [row.launcherVersion, row.agentVersion]) {
      const rank = launcherRank(version);
      if (rank !== null && (target === null || rank > target)) target = rank;
    }
  }
  return target;
}

/** One tablet's provisioning state, measured against `launcherTarget` (`fleetLauncherTarget` of the fleet). */
export function tabletSetupReadiness(
  row: RepHeadwindRow,
  opts: { launcherTarget?: number | null } = {},
): TabletReadiness {
  const launcherTarget = opts.launcherTarget ?? null;
  const myRank = launcherRank(row.launcherVersion);
  // The register answered for this row when it either matched it or said it does not know it; neither
  // is true of a row read while the register was down (`fleet.ts` leaves both unset then).
  const registerKnown = row.unregistered || row.registerDeviceId !== null;
  const inCustody = registerKnown ? !row.unregistered : null;
  const simRecorded = registerKnown ? Boolean(row.simNumber || row.lineNumber) : null;
  const screenIdReported = Boolean(row.rustDeskId);
  const locationReported = Number.isFinite(row.latitude) && Number.isFinite(row.longitude);
  // A tablet that reports no launcher is "not reported", never current. One that reports a version with
  // nothing to measure it against cannot be behind anything.
  const launcher: LauncherStanding =
    myRank === null ? "not_reported" : launcherTarget === null || myRank >= launcherTarget ? "current" : "behind";
  const launcherCurrent = launcher === "current";
  return {
    inCustody,
    launcher,
    launcherCurrent,
    locationReported,
    ready: inCustody === true && simRecorded === true && screenIdReported && locationReported && launcherCurrent,
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
  let awaitingHardwareReport = 0;
  let fullySetUp = 0;
  // One bar for every tablet's "current?" — computed here, before the loop, rather than re-derived per row.
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
    if (row.awaitingHardwareReport) awaitingHardwareReport += 1;
    if (tabletSetupReadiness(row, { launcherTarget }).ready) fullySetUp += 1;
  }
  return {
    awaitingHardwareReport,
    fullySetUp,
    lowBattery,
    notInRegister,
    online,
    reportingLocation,
    screenReady,
    total: rows.length,
  };
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
