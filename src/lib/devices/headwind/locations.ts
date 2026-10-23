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
 * never be fed on a free build. That is why every row carries its `source`, why the plugin is switched
 * on rather than assumed, and why an empty plugin history is reported as "nothing recorded" and never
 * as "the tablet did not move".
 *
 * 🔴 "LOCATE NOW" IS NOT A PING AND IS NOT SOLD AS ONE. Nothing in Headwind asks a tablet for its
 * position. What can be done is to wake the tablet into a check-in (`configUpdated`) and then read
 * what came back WITH ITS OWN TIMESTAMP. If the tablet is off, asleep without network, or out of
 * coverage, the position that comes back is the old one — so the age is always returned beside it and
 * the console prints the age, never the word "now".
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { callHeadwind } from "@/lib/devices/headwind/client";
import { getHeadwindLocation } from "@/lib/devices/headwind/devices";
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
  recordedAt: string | null;
  batteryLevel: number | null;
  source: HeadwindLocationSource;
};

/** How long a tablet is given to check in after being woken, before the position is read back. */
export const HEADWIND_LOCATE_WAIT_MS = 6000;

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

function asMoment(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }
  return typeof value === "string" && value.trim() ? value : null;
}

export function locationFixesFromPlugin(records: unknown): HeadwindLocationFix[] {
  if (!Array.isArray(records)) return [];
  const fixes: HeadwindLocationFix[] = [];
  for (const record of records as DynamicInfoRecord[]) {
    const latitude = asCoordinate(record?.gpsLat);
    const longitude = asCoordinate(record?.gpsLon);
    if (latitude === null || longitude === null) continue;
    fixes.push({
      batteryLevel:
        typeof record.deviceBatteryLevel === "number" && Number.isFinite(record.deviceBatteryLevel)
          ? record.deviceBatteryLevel
          : null,
      latitude,
      longitude,
      recordedAt: asMoment(record.latestUpdateTime),
      source: "plugin",
    });
  }
  return fixes;
}

/**
 * Switch the `deviceinfo` plugin's collection on.
 *
 * It defaults to off, so a fleet can run for months with an empty history and no sign of why. This is
 * idempotent and safe to call whenever the history is read.
 */
export async function enableHeadwindLocationCollection(
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ enabled: boolean }> {
  try {
    const current = await callHeadwind<Record<string, unknown>>(
      "/rest/plugins/deviceinfo/deviceinfo-plugin-settings/private",
      { method: "GET" },
      fetchImpl,
      env,
    );
    if (current?.sendData === true) return { enabled: true };
    await callHeadwind(
      "/rest/plugins/deviceinfo/deviceinfo-plugin-settings/private",
      { body: JSON.stringify({ ...(current ?? {}), sendData: true }), method: "PUT" },
      fetchImpl,
      env,
    );
    return { enabled: true };
  } catch {
    // 🔴 NOT FATAL AND NOT HIDDEN. If the plugin is not installed on this box the history simply stays
    // empty, and the caller reports that in words. Failing the whole read here would take the
    // check-in trail — the one that always works — down with it.
    return { enabled: false };
  }
}

export type HeadwindLocationHistory = {
  fixes: HeadwindLocationFix[];
  pluginEnabled: boolean;
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

  const { enabled } = await enableHeadwindLocationCollection(fetchImpl, env);

  let fixes: HeadwindLocationFix[] = [];
  try {
    const page = await callHeadwind<{ items?: unknown }>(
      "/rest/plugins/deviceinfo/deviceinfo/private/search/dynamic",
      {
        body: JSON.stringify({ deviceFilter: number, pageNum: 1, pageSize: 200, sortValue: "createTime" }),
        method: "POST",
      },
      fetchImpl,
      env,
    );
    fixes = locationFixesFromPlugin(page?.items);
  } catch {
    fixes = [];
  }

  // The one that always arrives, kept even when the plugin answered, and labelled apart. 🔴 Guarded like
  // the plugin read above: the device list now refuses a reply it cannot read rather than calling it
  // empty, and that refusal must not throw away a trail the plugin already answered with.
  let latest: Awaited<ReturnType<typeof getHeadwindLocation>> | null = null;
  try {
    latest = await getHeadwindLocation(number, fetchImpl, env);
  } catch (error) {
    if (fixes.length === 0) throw error;
  }
  if (latest && latest.latitude !== null && latest.longitude !== null) {
    fixes.push({
      batteryLevel: null,
      latitude: latest.latitude,
      longitude: latest.longitude,
      recordedAt: latest.locatedAt,
      source: "check-in",
    });
  }

  fixes.sort((a, b) => (b.recordedAt ?? "").localeCompare(a.recordedAt ?? ""));

  const pluginRows = fixes.filter((fix) => fix.source === "plugin").length;
  const note = !enabled
    ? "The movement-history plugin is not switched on for this server, so only the position each tablet " +
      "sends with its own check-in is shown."
    : pluginRows
      ? "Rows marked as a check-in are the position the tablet sent with its regular report; rows marked " +
        "from the history plugin are its own separate record. They are shown apart on purpose."
      : "Recording is switched on, but the history plugin has nothing for this tablet yet. 🔴 That may " +
        "mean it has not checked in since it was switched on, or it may mean the free agent does not " +
        "feed it at all — which is unproven until a tablet does it. It does not mean the tablet has " +
        "not moved.";

  return { fixes, note, pluginEnabled: enabled };
}

export type HeadwindLocateResult = {
  assetTag: string | null;
  latitude: number | null;
  longitude: number | null;
  locatedAt: string | null;
  ageSeconds: number | null;
  message: string;
};

function describeAge(ageSeconds: number | null): string {
  if (ageSeconds === null) return "The tablet did not say when it took that position.";
  if (ageSeconds < 120) return "That position is less than two minutes old.";
  if (ageSeconds < 3600) return `That position is ${Math.round(ageSeconds / 60)} minutes old.`;
  if (ageSeconds < 86400) return `That position is ${Math.round(ageSeconds / 3600)} hours old.`;
  return `🔴 That position is ${Math.round(ageSeconds / 86400)} days old — the tablet has not reported since.`;
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

  const location = await getHeadwindLocation(target.deviceNumber, fetchImpl, env);
  const locatedAt = location.locatedAt;
  const ageSeconds = locatedAt
    ? Math.max(0, Math.round((Date.now() - new Date(locatedAt).getTime()) / 1000))
    : null;

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: target.deviceNumber,
    entityType: "headwind_device_command",
    newValues: {
      ageSeconds,
      assetTag: target.assetTag,
      command: "LOCATE_NOW",
      deviceName: target.deviceName,
      found: location.latitude !== null,
    },
    oldValues: null,
    summary: `Located ${target.subject}`,
  });

  const found = location.latitude !== null && location.longitude !== null;
  return {
    ageSeconds,
    assetTag: target.assetTag,
    latitude: location.latitude,
    locatedAt,
    longitude: location.longitude,
    message: found
      ? `${target.subject} was woken and asked to report. ${describeAge(ageSeconds)}`
      : `${target.subject} was woken, but it has never reported a position. Either location is switched ` +
        "off in its set of rules, or it has not been outdoors with the tablet on since it was enrolled. " +
        "This is not a failure of the request.",
  };
}
