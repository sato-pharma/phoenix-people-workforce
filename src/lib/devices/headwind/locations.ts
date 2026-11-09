/**
 * Where a tablet has been — and where it is now, said honestly.
 *
 * 🔴 THERE ARE TWO SOURCES AND THEY ARE NEVER BLENDED. Blending them is how a console ends up drawing
 * a confident line through a place a tablet never went.
 *
 *   **check-in**  The position the agent attaches to its own regular report (`{lat, lon, ts}`, from
 *                 `getLastKnownLocation`). It is the one that definitely arrives, because it rides on
 *                 the sync every managed tablet already does. It is also SPARSE — one fix per check-in.
 *   **plugin**    The `deviceinfo` plugin's own history, which IS in the free build:
 *                 `POST /rest/plugins/deviceinfo/deviceinfo/private/search/dynamic` returns `gpsLat`,
 *                 `gpsLon`, `latestUpdateTime`, battery and radio state per record. Its setting
 *                 `sendData` defaults to FALSE, so it collects nothing until it is switched on.
 *
 * 🔴 WHETHER THE STOCK FREE AGENT FEEDS THE PLUGIN IS UNPROVEN UNTIL A REAL TABLET DOES IT. The agent's
 * own `LocationService` calls `ProUtils.processLocation()`, and `ProUtils` in the open-source agent is
 * a stub — `isPro()` returns false and the method body is empty. So the continuous trail may simply
 * never be fed on a free build. That is why every row carries its `source`, why collection is switched
 * on by a person rather than assumed, and why an empty plugin history is reported as "nothing recorded"
 * and never as "the tablet did not move".
 *
 * 🔴 "LOCATE NOW" IS NOT A PING AND IS NOT SOLD AS ONE. Nothing in Headwind asks a tablet for its
 * position. What can be done is to wake the tablet into a check-in (`configUpdated`) and then read
 * what came back WITH ITS OWN TIMESTAMP. If the tablet is off, asleep without network, or out of
 * coverage, the position that comes back is the old one — so the age is always returned beside it and
 * the console prints the age, never the word "now".
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { callHeadwind } from "@/lib/devices/headwind/client";
import { launcherRank } from "@/lib/devices/headwind/dashboard";
import { getHeadwindLocation, HeadwindDeviceNotFoundError, listHeadwindDevices } from "@/lib/devices/headwind/devices";
import { resolveHeadwindActionTarget } from "@/lib/devices/headwind/target";

export class HeadwindLocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeadwindLocationError";
  }
}

export type HeadwindLocationSource = "check-in" | "plugin";

export type HeadwindLocationFix = {
  latitude: number;
  longitude: number;
  /** When this position was reported — for a run of repeats, the NEWEST report. */
  recordedAt: string | null;
  /** For a run of identical reports, the OLDEST one; equal to `recordedAt` for a single report. */
  firstRecordedAt: string | null;
  /** How many consecutive reports carried exactly this position (1 for a single report). */
  reports: number;
  batteryLevel: number | null;
  source: HeadwindLocationSource;
};

/** How long a tablet is given to check in after being woken, before the position is read back. */
export const HEADWIND_LOCATE_WAIT_MS = 6000;

/** How many history rows one read asks for. The server returns them newest first (see below). */
export const HEADWIND_HISTORY_PAGE_SIZE = 200;

/**
 * The first launcher that attaches its position to its check-in. Measured on the fleet, 9 Nov 2026:
 * PHX-TAB-0007 on 6.39 sent none for 17 days; on 6.48 it sent a fix within seconds of starting.
 */
export const HEADWIND_LOCATION_LAUNCHER = "6.45";

/**
 * One row of the history plugin's reply.
 *
 * 🔴 THIS SHAPE IS READ FROM THE SERVER'S OWN CLASS, NOT GUESSED. The reply rows are
 * `com.hmdm.plugins.deviceinfo.rest.json.DeviceDynamicInfoRecord`, whose fields are flat —
 * `latestUpdateTime` (Long, ms), `deviceBatteryLevel`, `gpsLat`, `gpsLon`, `gpsState` and the radio
 * fields — read with `javap` from the plugin jar on the production server, 9 Nov 2026. The domain object
 * the tablet POSTs (`DeviceDynamicInfo`, with a nested `gps`) is a different class; the mapper flattens it.
 */
type DynamicInfoRecord = {
  gpsLat?: unknown;
  gpsLon?: unknown;
  latestUpdateTime?: unknown;
  deviceBatteryLevel?: unknown;
  [field: string]: unknown;
};

function asCoordinate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  // 🔴 A ZERO PAIR IS NULL ISLAND, NOT A PLACE. The agent reports 0/0 when it has no fix at all, and a
  // console that plots it puts every unlocated tablet in the Gulf of Guinea.
  return value === 0 ? null : value;
}

/**
 * A timestamp as an ISO instant, or null.
 *
 * The same rule as the device list (`devices.ts` `isoTime`): a number below 10^12 is seconds, not
 * milliseconds, and a string must parse — a raw string passed through would sort against ISO instants
 * by its characters and put a fix in the wrong place in the trail.
 */
export function asMoment(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value < 1_000_000_000_000 ? value * 1000 : value).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  return null;
}

export function locationFixesFromPlugin(records: unknown): HeadwindLocationFix[] {
  if (!Array.isArray(records)) return [];
  const fixes: HeadwindLocationFix[] = [];
  for (const record of records as DynamicInfoRecord[]) {
    const latitude = asCoordinate(record?.gpsLat);
    const longitude = asCoordinate(record?.gpsLon);
    if (latitude === null || longitude === null) continue;
    const recordedAt = asMoment(record.latestUpdateTime);
    fixes.push({
      batteryLevel:
        typeof record.deviceBatteryLevel === "number" && Number.isFinite(record.deviceBatteryLevel)
          ? record.deviceBatteryLevel
          : null,
      firstRecordedAt: recordedAt,
      latitude,
      longitude,
      recordedAt,
      reports: 1,
      source: "plugin",
    });
  }
  return fixes;
}

/** Newest first; a fix with no time goes LAST, never first. */
function newestFirst(a: HeadwindLocationFix, b: HeadwindLocationFix): number {
  if (a.recordedAt === b.recordedAt) return 0;
  if (a.recordedAt === null) return 1;
  if (b.recordedAt === null) return -1;
  return b.recordedAt.localeCompare(a.recordedAt);
}

/**
 * Fold consecutive reports of exactly the same position into one row.
 *
 * 🔴 A REPEATED POSITION IS NOT A FRESH ONE. The launcher keeps its last fix and attaches it to every
 * report until a new one arrives, and a history row carries the REPORT's time, not the fix's — so a
 * tablet sitting indoors for a day produces a day of rows that all look like it was just seen there.
 * Folding them into "same position, reported N times, from … to …" says what is actually known.
 * Input must already be newest first; only neighbours from the same source are folded.
 */
export function collapseRepeatedFixes(fixes: readonly HeadwindLocationFix[]): HeadwindLocationFix[] {
  const out: HeadwindLocationFix[] = [];
  for (const fix of fixes) {
    const previous = out[out.length - 1];
    if (
      previous &&
      previous.source === fix.source &&
      previous.latitude.toFixed(5) === fix.latitude.toFixed(5) &&
      previous.longitude.toFixed(5) === fix.longitude.toFixed(5)
    ) {
      previous.reports += fix.reports;
      previous.firstRecordedAt = fix.firstRecordedAt ?? previous.firstRecordedAt;
      continue;
    }
    out.push({ ...fix });
  }
  return out;
}

const COLLECTION_SETTINGS_PATH = "/rest/plugins/deviceinfo/deviceinfo-plugin-settings/private";

export type HeadwindLocationCollection = {
  /** "unknown" means the settings could not be read — it is never reported as "off". */
  state: "on" | "off" | "unknown";
  reason: string | null;
};

/**
 * Whether the `deviceinfo` plugin is collecting movement history — a READ, with no side effect.
 *
 * 🔴 OPENING A PANEL MUST NEVER CHANGE A SERVER SETTING. This used to PUT `sendData: true` from inside a
 * GET whenever it found collection off — so somebody switching collection off in Headwind had it turned
 * back on, with no audit row and no CSRF check, the next time anyone looked at a tablet; and an empty
 * settings reply would have been written back as `{ sendData: true }` alone. Switching on is now its own
 * audited act, `switchOnHeadwindLocationCollection`.
 */
export async function readHeadwindLocationCollection(
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HeadwindLocationCollection> {
  try {
    const current = await callHeadwind<Record<string, unknown>>(COLLECTION_SETTINGS_PATH, { method: "GET" }, fetchImpl, env);
    if (current?.sendData === true) return { reason: null, state: "on" };
    if (current?.sendData === false) return { reason: null, state: "off" };
    return { reason: "the tablet server answered without the setting", state: "unknown" };
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error), state: "unknown" };
  }
}

/**
 * Switch the `deviceinfo` plugin's collection on — every tablet then sends its history every interval.
 *
 * Audited, and called only from the POST route (CSRF-guarded, Super Admin). 🔴 It writes back the LIVE
 * settings object with only `sendData` changed; a reply that is not a settings object is refused rather
 * than written as `{ sendData: true }`, which would reset the interval and the retention to nothing.
 */
export async function switchOnHeadwindLocationCollection(
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ message: string }> {
  const current = await callHeadwind<Record<string, unknown>>(COLLECTION_SETTINGS_PATH, { method: "GET" }, fetchImpl, env);
  if (current?.sendData === true) return { message: "Movement history was already switched on. Nothing was changed." };
  if (!current || typeof current !== "object" || Array.isArray(current) || Object.keys(current).length === 0) {
    throw new HeadwindLocationError(
      "The tablet server did not return its movement-history settings, so nothing was written — writing " +
        "blind would reset how often tablets report and how long the history is kept.",
    );
  }
  await callHeadwind(
    COLLECTION_SETTINGS_PATH,
    { body: JSON.stringify({ ...current, sendData: true }), method: "PUT" },
    fetchImpl,
    env,
  );
  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: "deviceinfo",
    entityType: "headwind_configuration",
    newValues: { change: "location-history-on", sendData: true },
    oldValues: { sendData: current.sendData ?? null },
    summary: "Switched on movement history for every Headwind tablet",
  });
  return { message: "Movement history is switched on. Each tablet starts sending it at its next report." };
}

export type HeadwindLocationHistory = {
  fixes: HeadwindLocationFix[];
  /** True only when the server said collection is on. */
  pluginEnabled: boolean;
  /** "unknown" when the setting could not be read — the panel offers the switch only on "off". */
  collection: HeadwindLocationCollection["state"];
  note: string;
};

/**
 * A tablet's recorded positions, newest first, every row saying where it came from.
 */
export async function getHeadwindLocationHistory(
  deviceNumber: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HeadwindLocationHistory> {
  const number = deviceNumber.trim();
  if (!number) throw new HeadwindLocationError("Say which tablet to show the movements of.");

  const collection = await readHeadwindLocationCollection(fetchImpl, env);

  let fixes: HeadwindLocationFix[] = [];
  let pluginError: string | null = null;
  let pluginRecords = 0;
  let pluginTotal: number | null = null;
  try {
    // 🔴 THE FILTER FIELD IS `deviceNumber`, NOT `deviceFilter`. Measured on the live server, 1 Nov 2026:
    // `deviceFilter` answers `status: "ERROR", "error.notfound.device"` inside an HTTP 200.
    // 🔴 THERE IS NO SORT FIELD. The server's `DynamicInfoFilter` has only deviceNumber, deviceId, pageNum,
    // pageSize, dateFrom, dateTo and the interval pair, and its query is `ORDER BY p.ts DESC` — read from
    // the plugin's own mapper on production, 9 Nov 2026 — so page 1 is always the newest rows.
    const page = await callHeadwind<{ items?: unknown; totalItemsCount?: unknown }>(
      "/rest/plugins/deviceinfo/deviceinfo/private/search/dynamic",
      {
        body: JSON.stringify({ deviceNumber: number, pageNum: 1, pageSize: HEADWIND_HISTORY_PAGE_SIZE }),
        method: "POST",
      },
      fetchImpl,
      env,
    );
    if (Array.isArray(page?.items)) {
      pluginRecords = page.items.length;
      fixes = locationFixesFromPlugin(page.items);
    } else {
      pluginError = "it answered in a shape Phoenix cannot read";
    }
    pluginTotal = typeof page?.totalItemsCount === "number" ? page.totalItemsCount : null;
  } catch (error) {
    // 🔴 A REFUSAL IS NOT AN EMPTY HISTORY. Swallowing it here is what let the 1 Nov `deviceFilter`
    // refusal read as "nothing recorded"; the reason now reaches the note word for word.
    pluginError = error instanceof Error ? error.message : String(error);
  }
  const pluginFixes = fixes.length;

  // The one that always arrives, kept even when the plugin answered, and labelled apart. 🔴 Guarded: a
  // device list the server will not give must not throw away a trail the plugin already answered with.
  let latest: Awaited<ReturnType<typeof getHeadwindLocation>> | null = null;
  try {
    latest = await getHeadwindLocation(number, fetchImpl, env);
  } catch (error) {
    if (fixes.length === 0) throw error;
  }
  if (latest && latest.latitude !== null && latest.longitude !== null) {
    fixes.push({
      batteryLevel: null,
      firstRecordedAt: latest.locatedAt,
      latitude: latest.latitude,
      longitude: latest.longitude,
      recordedAt: latest.locatedAt,
      reports: 1,
      source: "check-in",
    });
  }

  fixes.sort(newestFirst);
  fixes = collapseRepeatedFixes(fixes);

  return {
    collection: collection.state,
    fixes,
    note: historyNote({ collection, pluginError, pluginFixes, pluginRecords, pluginTotal }),
    pluginEnabled: collection.state === "on",
  };
}

/**
 * The sentence above the trail, built from what the server actually answered — never from a guess.
 *
 * 🔴 EACH EMPTY CASE MEANS SOMETHING DIFFERENT AND IS SAID DIFFERENTLY: the read was refused; recording
 * is off; there are records but none with a position; or there is nothing at all. Only the last is
 * "nothing recorded", and even that never means "did not move".
 */
export function historyNote(facts: {
  collection: HeadwindLocationCollection;
  pluginError: string | null;
  pluginFixes: number;
  pluginRecords: number;
  pluginTotal: number | null;
}): string {
  const { collection, pluginError, pluginFixes, pluginRecords, pluginTotal } = facts;
  const parts: string[] = [];
  if (pluginError) {
    parts.push(
      `🔴 The movement-history plugin refused the read: ${pluginError}. Only the position from the tablet's ` +
        "own check-in can be shown — this is NOT an empty history.",
    );
  } else if (pluginFixes > 0) {
    parts.push(
      "Rows marked as a check-in are the position the tablet sent with its regular report; rows marked " +
        "from the history plugin are its own separate record. They are shown apart on purpose.",
    );
    if (pluginTotal !== null && pluginTotal > pluginRecords) {
      parts.push(`Showing the latest ${pluginRecords} of ${pluginTotal} history records.`);
    }
  } else if (pluginRecords > 0) {
    parts.push(
      `The history plugin holds ${pluginRecords} record${pluginRecords === 1 ? "" : "s"} for this tablet, but ` +
        "none carries a position — it reported in without a location fix.",
    );
  } else if (collection.state === "off") {
    parts.push(
      "Movement history is switched off on the tablet server, so the tablets are not sending it. Only the " +
        "position each tablet sends with its own check-in is shown.",
    );
  } else {
    parts.push(
      "The history plugin has nothing for this tablet yet. 🔴 That may mean it has not reported since " +
        "recording was switched on, or that its launcher does not feed it — " +
        "which is unproven until a tablet does it. It does not mean the tablet stayed still.",
    );
  }
  if (collection.state === "unknown") {
    parts.push(`Phoenix could not read whether movement history is switched on (${collection.reason}).`);
  }
  return parts.join(" ");
}

export type HeadwindLocateResult = {
  assetTag: string | null;
  latitude: number | null;
  longitude: number | null;
  locatedAt: string | null;
  ageSeconds: number | null;
  message: string;
};

/**
 * The age of a fix in words. Whole units are FLOORED — 23 hours 40 minutes is "23 hours old", never
 * rounded up to a day it has not reached. A fix dated more than two minutes in the future means the
 * tablet's clock is wrong, and is said so rather than shown as brand new.
 */
export function describeAge(ageSeconds: number | null): string {
  if (ageSeconds === null) return "The tablet did not say when it took that position.";
  if (ageSeconds < -120) {
    return "🔴 The tablet's clock is ahead of the server's, so the age of that position cannot be trusted.";
  }
  if (ageSeconds < 120) return "That position is less than two minutes old.";
  if (ageSeconds < 3600) return `That position is ${Math.floor(ageSeconds / 60)} minutes old.`;
  if (ageSeconds < 86400) return `That position is ${Math.floor(ageSeconds / 3600)} hours old.`;
  return `🔴 That position is ${Math.floor(ageSeconds / 86400)} days old — the tablet has not reported since.`;
}

/**
 * Why a tablet has no position, naming the cause that was actually measured first.
 *
 * 🔴 THE OLD LAUNCHER IS THE CAUSE THAT WAS MEASURED, SO IT IS NAMED FIRST. A tablet below
 * `HEADWIND_LOCATION_LAUNCHER` never attaches its position, however long it sits outdoors — blaming
 * its location setting sent the search to the wrong place.
 */
export function describeNoFix(subject: string, launcherVersion: string | null): string {
  const running = launcherRank(launcherVersion);
  const needed = launcherRank(HEADWIND_LOCATION_LAUNCHER);
  if (running !== null && needed !== null && running < needed) {
    return (
      `${subject} was woken, but it has never reported a position: its launcher is ${launcherVersion}, and ` +
      `only ${HEADWIND_LOCATION_LAUNCHER} or later sends one. It needs its update run to finish — switch it ` +
      "on with Wi-Fi or data and leave it about 15 minutes."
    );
  }
  return (
    `${subject} was woken, but it has never reported a position` +
    (launcherVersion ? ` (launcher ${launcherVersion})` : " (it has not said which launcher it runs)") +
    ". Either location is switched off on the tablet, or it has not had a fix since it was enrolled. This " +
    "is not a failure of the request."
  );
}

/**
 * Wake a tablet into a check-in and read back the position it sends, with its age.
 *
 * 🔴 THE AGE IS THE WHOLE VALUE OF THIS. Any console can show a coordinate. Showing that the
 * coordinate is four days old is what stops somebody driving to it.
 */
export async function locateHeadwindDevice(
  input: { deviceNumber: string },
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
  waitMs = HEADWIND_LOCATE_WAIT_MS,
): Promise<HeadwindLocateResult> {
  const deviceNumber = input.deviceNumber.trim();
  if (!deviceNumber) throw new HeadwindLocationError("Say which tablet to locate.");

  const target = await resolveHeadwindActionTarget(deviceNumber, fetchImpl, env);

  await callHeadwind(
    "/rest/private/push",
    {
      body: JSON.stringify({
        broadcast: false,
        deviceNumbers: [target.deviceNumber],
        // `configUpdated` is what makes the agent check in immediately. There is no "send me your
        // position" message in Headwind at all; this is the nearest real thing, and it is why the
        // answer below is the tablet's OWN last fix rather than a live one.
        messageType: "configUpdated",
        payload: "",
      }),
      method: "POST",
    },
    fetchImpl,
    env,
  );

  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));

  // Read the device itself rather than `getHeadwindLocation`, so the running launcher comes back with
  // the position and a missing fix can name its measured cause.
  const device = (await listHeadwindDevices(fetchImpl, env)).find(
    (candidate) => candidate.deviceNumber === target.deviceNumber,
  );
  if (!device) {
    throw new HeadwindDeviceNotFoundError(
      "That tablet is not in the Headwind fleet any more. Reload the page and try again from its row.",
    );
  }
  const locatedAt = device.locatedAt;
  // 🔴 NOT CLAMPED AT ZERO. A negative age is a tablet clock running ahead, and `describeAge` says so;
  // clamping turned it into "less than two minutes old".
  const ageSeconds = locatedAt ? Math.round((Date.now() - new Date(locatedAt).getTime()) / 1000) : null;
  const found = device.latitude !== null && device.longitude !== null;

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: target.deviceNumber,
    entityType: "headwind_device_command",
    newValues: {
      ageSeconds,
      assetTag: target.assetTag,
      command: "LOCATE_NOW",
      deviceName: target.deviceName,
      found,
      launcherVersion: device.launcherVersion,
    },
    oldValues: null,
    summary: `Located ${target.subject}`,
  });

  return {
    ageSeconds,
    assetTag: target.assetTag,
    latitude: device.latitude,
    locatedAt,
    longitude: device.longitude,
    message: found
      ? `${target.subject} was woken and asked to report. ${describeAge(ageSeconds)}`
      : describeNoFix(target.subject, device.launcherVersion),
  };
}
