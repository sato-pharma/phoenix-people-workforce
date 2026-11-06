/**
 * What is installed on one tablet, as the company's Headwind server sees it — and taking one off.
 *
 * WHERE THE LIST COMES FROM. The Headwind agent reports the packages it has in its `info` blob, so
 * the installed list arrives with the fleet read and costs no extra request. Some agent versions send
 * `pkg`, others `packageName`; some name the app, some only number its version. Each field is read
 * from a short candidate list and anything missing is left null rather than guessed.
 *
 * REMOVAL IS A PUSH MESSAGE, AND IT IS REAL. An earlier pass here said removal was "not published"
 * and would have to wait for the live server's API list. It never did: `uninstallApp` is one of the
 * seventeen names the Headwind agent declares, and its payload is a single key.
 *
 *   hmdm-android  app/src/main/java/com/hmdm/launcher/json/PushMessage.java   TYPE_UNINSTALL_APP
 *   hmdm-android  .../worker/PushNotificationProcessor.java                   payload.getString("pkg")
 *                                                                            → InstallUtils.silentUninstallApplication()
 *
 * Silent, because the agent is the device owner — no prompt reaches the rep, which is the point on a
 * kiosk tablet, and exactly why the route above this is Super Admin only and writes a required audit
 * row naming the tablet and the package.
 *
 * 🔴 INSTALLING IS STILL NOT DONE HERE, AND FOR A REASON THAT IS NOT "UNKNOWN". There is no
 * `installApp` message: on Headwind an app arrives because it is in the tablet's CONFIGURATION, so
 * installing means editing a configuration's app list and then nudging the tablet with
 * `configUpdated`. That is a different shape of work — it belongs in `configurations.ts`, not in a
 * second guess at a push name that does not exist.
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { callHeadwind } from "@/lib/devices/headwind/client";
import { resolveHeadwindActionTarget } from "@/lib/devices/headwind/commands";
import { searchHeadwindDevices } from "@/lib/devices/headwind/devices";

export class HeadwindAppInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeadwindAppInputError";
  }
}

/**
 * 🔴 THE ONE PACKAGE PHOENIX WILL NOT REMOVE, WHOEVER ASKS.
 *
 * `com.hmdm.launcher` IS the Headwind agent — the app that holds device-owner rights on the tablet
 * and is the only reason any of this console reaches it. Take it off and the tablet is not "an
 * unmanaged tablet"; it is a tablet that can never be managed again without a physical factory reset
 * and a re-enrolment by hand, on a device that is in a rep's bag in another governorate. Android
 * would very likely refuse the uninstall anyway, but "the platform probably stops it" is not a thing
 * to rely on when the cost of being wrong is a trip to Assuit.
 *
 * Confirmed from the agent's own `app/build.gradle`: `applicationId "com.hmdm.launcher"`, one
 * flavour, no suffix — the package does not vary by build.
 */
export const HEADWIND_AGENT_PACKAGE = "com.hmdm.launcher";

type RawRecord = Record<string, unknown>;

function pickString(record: RawRecord, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

export type HeadwindInstalledApp = {
  /** The Android package — what an install or removal would name. */
  packageName: string;
  /** The app's own name where the agent reports one; the package otherwise. */
  name: string;
  version: string | null;
  /** True when this package is the one the company's remote-screen sessions use. */
  isRemoteScreenApp: boolean;
  /**
   * True for the management agent itself — the one app that has no Remove button.
   *
   * 🔴 THE SERVER DECIDES THIS, NOT THE BROWSER. The console could compare the package name itself,
   * but then the refusal would live in two places and only one of them is the one that actually
   * stops the push. It is computed here, beside `removeHeadwindApp`'s refusal, so the button and the
   * guard can never drift apart.
   */
  isManagementApp: boolean;
};

/** The apps out of a device record's `info` blob, whatever shape this agent version sends. */
export function installedAppsFromInfo(info: unknown, remoteScreenPackage: string): HeadwindInstalledApp[] {
  const blob =
    typeof info === "string" && info.trim().startsWith("{")
      ? (() => {
          try {
            return JSON.parse(info) as unknown;
          } catch {
            return null;
          }
        })()
      : info;
  if (!blob || typeof blob !== "object") return [];
  const list = (blob as RawRecord).applications;
  if (!Array.isArray(list)) return [];

  const out: HeadwindInstalledApp[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const record = item as RawRecord;
    const packageName = pickString(record, ["pkg", "packageName", "package", "id"]);
    if (!packageName) continue;
    out.push({
      isManagementApp: packageName === HEADWIND_AGENT_PACKAGE,
      isRemoteScreenApp: packageName === remoteScreenPackage,
      name: pickString(record, ["name", "label", "title"]) ?? packageName,
      packageName,
      version: pickString(record, ["version", "versionName", "versionCode"]),
    });
  }
  return out.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The apps on one tablet.
 *
 * Reads the same device search the fleet reads — the installed list rides along in the device record,
 * so opening a tablet costs one request and never a second endpoint that might not exist.
 */
export async function getHeadwindDeviceApps(
  deviceNumber: string,
  remoteScreenPackage: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ installed: HeadwindInstalledApp[]; remoteScreenAppPresent: boolean }> {
  const number = deviceNumber.trim();
  if (!number) throw new HeadwindAppInputError("Say which tablet to read.");

  // 🔴 ONE SEARCH FOR THE FLEET AND THIS, BECAUSE THE LIVE REPLY NESTS THE PAGE — see
  // `deviceRecordsFromSearch`, which `searchHeadwindDevices` reads every page through. Reading
  // `payload.items` here answered "no apps installed" for every tablet, which is indistinguishable
  // from a tablet that has genuinely installed nothing.
  const { records } = await searchHeadwindDevices(number, fetchImpl, env);
  const record = records.find((entry) => pickString(entry, ["number", "deviceNumber"]) === number) ?? null;
  const installed = record ? installedAppsFromInfo(record.info ?? record.deviceInfo, remoteScreenPackage) : [];

  return { installed, remoteScreenAppPresent: installed.some((app) => app.isRemoteScreenApp) };
}

/**
 * Android package names: dot-separated segments, each starting with a letter, at least two of them.
 *
 * This is not a security boundary — the name is JSON-encoded into the payload and cannot escape it.
 * It is here so that a typo is REFUSED rather than pushed: `uninstallApp` on a package the tablet
 * does not have is a silent no-op that the push endpoint answers 200 to, so without this check a
 * mistyped package would report "removed" and remove nothing.
 */
export function isAndroidPackageName(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(value);
}

export type HeadwindAppRemovalResult = {
  packageName: string;
  assetTag: string | null;
  message: string;
};

/**
 * Take one app off one tablet, silently.
 *
 * Resolves the tablet against the live fleet first (so a removal cannot be aimed at one that has left
 * the fleet, and the audit names it by its custody asset tag), pushes `uninstallApp`, then writes the
 * required audit row.
 *
 * 🔴 THE REMOVAL IS NOT CONFIRMED BY THE 200. Headwind's push endpoint accepts the message and hands
 * it on; whether the package was there, and whether the tablet was awake to act on it, shows up only
 * in the app list at its next check-in. The sentence handed back says so rather than claiming the app
 * is gone — a custody console that reports a removal it did not witness is how a tablet gets written
 * off as clean while the app is still on it.
 */
export async function removeHeadwindApp(
  input: { deviceNumber: string; packageName: string },
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HeadwindAppRemovalResult> {
  const deviceNumber = input.deviceNumber.trim();
  if (!deviceNumber) throw new HeadwindAppInputError("Say which tablet to remove the app from.");

  const packageName = input.packageName.trim();
  if (!packageName) throw new HeadwindAppInputError("Say which app to remove.");
  if (!isAndroidPackageName(packageName)) {
    throw new HeadwindAppInputError(
      `'${packageName}' is not an Android package name. Remove an app from its row in the list, which ` +
        "carries the exact name the tablet knows it by.",
    );
  }
  if (packageName === HEADWIND_AGENT_PACKAGE) {
    throw new HeadwindAppInputError(
      "That is the management app itself. Removing it would cut the tablet off from the company server " +
        "for good — it could only be brought back by factory-resetting the tablet by hand and enrolling " +
        "it again. Use the full factory reset if the tablet is being retired.",
    );
  }

  const target = await resolveHeadwindActionTarget(deviceNumber, fetchImpl, env);

  await callHeadwind(
    "/rest/private/push",
    {
      body: JSON.stringify({
        broadcast: false,
        deviceNumbers: [target.deviceNumber],
        messageType: "uninstallApp",
        // 🔴 A STRING CONTAINING JSON, not a JSON object — Headwind's wire format, not a mistake to
        // "fix". The agent reads exactly one key out of it: `payload.getString("pkg")`.
        payload: JSON.stringify({ pkg: packageName }),
      }),
      method: "POST",
    },
    fetchImpl,
    env,
  );

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: target.deviceNumber,
    entityType: "headwind_device_command",
    newValues: { assetTag: target.assetTag, command: "REMOVE_APP", deviceName: target.deviceName, packageName },
    oldValues: null,
    summary: `Removed ${packageName} from ${target.subject}`,
  });

  return {
    assetTag: target.assetTag,
    message:
      `${target.subject} has been told to remove ${packageName}. Nothing is shown to the rep. The app ` +
      "list here refreshes at the tablet's next check-in — that is what confirms it is gone.",
    packageName,
  };
}
