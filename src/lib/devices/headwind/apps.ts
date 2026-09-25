/**
 * What is installed on one tablet, as the company's Headwind server sees it.
 *
 * 🔴 THIS READS; IT DOES NOT YET SEND OR REMOVE, AND THAT IS A DECISION, NOT AN OVERSIGHT. Headwind
 * Community installs and removes apps SILENTLY — it is one of the features that made it the right
 * server for this fleet — but it does so by changing the tablet's CONFIGURATION in the web panel, and
 * the REST paths for editing a configuration's app list are not published. Writing a guess at them
 * would produce a "Send app" button that answers 200 and installs nothing, which on a custody console
 * is worse than no button. The read below is built on the device record, which certainly exists, and
 * the sending half is filled in from the server's own API list once the server is up.
 *
 * WHERE THE LIST COMES FROM. The Headwind agent reports the packages it has in its `info` blob, so
 * the installed list arrives with the fleet read and costs no extra request. Some agent versions send
 * `pkg`, others `packageName`; some name the app, some only number its version. Each field is read
 * from a short candidate list and anything missing is left null rather than guessed.
 */

import { callHeadwind } from "@/lib/devices/headwind/client";

export class HeadwindAppInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeadwindAppInputError";
  }
}

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
      isRemoteScreenApp: packageName === remoteScreenPackage,
      name: pickString(record, ["name", "label", "title"]) ?? packageName,
      packageName,
      version: pickString(record, ["version", "versionName", "versionCode"]),
    });
  }
  return out.sort((left, right) => left.name.localeCompare(right.name));
}

type SearchResponse = RawRecord & { items?: unknown; devices?: unknown };

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

  const payload = await callHeadwind<SearchResponse>(
    "/rest/private/devices/search",
    { body: JSON.stringify({ pageNum: 1, pageSize: 1000, value: number }), method: "POST" },
    fetchImpl,
    env,
  );
  const items = Array.isArray(payload) ? (payload as RawRecord[]) : Array.isArray(payload.items) ? (payload.items as RawRecord[]) : [];
  const record = items.find((entry) => pickString(entry, ["number", "deviceNumber"]) === number) ?? null;
  const installed = record ? installedAppsFromInfo(record.info ?? record.deviceInfo, remoteScreenPackage) : [];

  return { installed, remoteScreenAppPresent: installed.some((app) => app.isRemoteScreenApp) };
}
