/**
 * Reading the Headwind fleet and matching it to Phoenix's custody register.
 *
 * The list comes from `POST /rest/private/devices/search` — a POST, not a GET, with the filter and
 * the page in the body. Each tablet is matched to a register entry exactly the way the ManageEngine
 * and Android Management views match it: by serial number, then by IMEI, both compared on digits
 * through the shared `device-identity` helpers, so "the same tablet" means one thing on every screen.
 *
 * 🔴 A HEADWIND DEVICE HAS TWO IDENTIFIERS AND THEY ARE NOT INTERCHANGEABLE. `id` is the row number
 * in the server's own database; `number` is the DEVICE NUMBER the agent enrolled under, and it is the
 * one every remote action is addressed to (`deviceNumbers` on `/rest/private/push`). Sending an `id`
 * where a number belongs reaches nothing at all and reports success, because the push endpoint
 * accepts a list and simply matches none of it. Both are carried here for that reason, and
 * `deviceNumber` is what commands use.
 *
 * DEFENSIVE FIELD READING, AND THE `info` BLOB. The searchable device row carries the enrolment
 * facts; everything the tablet itself reports — model, Android version, serial, battery, position —
 * arrives inside a nested `info` object which SOME BUILDS SEND AS A JSON STRING rather than an
 * object. It is parsed here once, and every field is read from a short candidate list rather than one
 * pinned spelling, so a server upgrade cannot silently blank a column. A value that does not map is
 * left null — a null reads as "not reported", which is true, while a guess would not be.
 */

import { normalizeImei, normalizeSerial, imeisMatch } from "@/lib/devices/device-identity";
import { callHeadwind, HeadwindRequestError } from "@/lib/devices/headwind/client";
import type { RegisterTablet } from "@/lib/devices/managed-tablets";

type RawRecord = Record<string, unknown>;

function pickString(record: RawRecord, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function pickNumber(record: RawRecord, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function pickBoolean(record: RawRecord, keys: readonly string[]): boolean | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
    if (typeof value === "string" && value.trim()) {
      const normalized = value.trim().toLowerCase();
      if (["1", "true", "enabled", "on", "yes"].includes(normalized)) return true;
      if (["0", "false", "disabled", "off", "no"].includes(normalized)) return false;
    }
  }
  return null;
}

/** The nested `info` the agent reports, parsed whether it arrived as an object or as a JSON string. */
function deviceInfo(record: RawRecord): RawRecord {
  for (const key of ["info", "deviceInfo", "details"] as const) {
    const value = record[key];
    if (value && typeof value === "object" && !Array.isArray(value)) return value as RawRecord;
    if (typeof value === "string" && value.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as RawRecord;
      } catch {
        // A malformed blob is not a reason to lose the whole device — the enrolment fields still read.
      }
    }
  }
  return {};
}

/**
 * The launcher version the tablet is RUNNING, out of its reported app list — not the enrolment target.
 *
 * The agent reports the packages it carries in `info.applications`; the launcher sits there under
 * `com.hmdm.launcher` with whatever version it is actually on. That is the honest answer to "is this
 * tablet up to date", where the record's top-level `launcherVersion` is only the version the server
 * WANTS it on (read `agentVersion`'s note). The package literal is `HEADWIND_AGENT_PACKAGE` from
 * `apps.ts`, written out here rather than imported because `apps.ts` imports this module and a value
 * cycle is not worth risking for one short, build-invariant string (its own note pins it to the
 * agent's `applicationId`).
 */
function runningLauncherVersion(info: RawRecord): string | null {
  const list = info.applications;
  if (!Array.isArray(list)) return null;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const record = item as RawRecord;
    const pkg = pickString(record, ["pkg", "packageName", "package", "id"]);
    if (pkg === "com.hmdm.launcher") return pickString(record, ["version", "versionName", "versionCode"]);
  }
  return null;
}

/** An epoch-ms or ISO timestamp as ISO, or null. Headwind sends `lastUpdate` in milliseconds. */
function isoTime(record: RawRecord, keys: readonly string[]): string | null {
  const ms = pickNumber(record, keys);
  if (ms !== null && ms > 0) {
    // A value in seconds rather than milliseconds would date to 1970; treat anything below the year
    // 2001 in ms as seconds rather than rendering an obviously wrong date on the console.
    const millis = ms < 1_000_000_000_000 ? ms * 1000 : ms;
    return new Date(millis).toISOString();
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
    }
  }
  return null;
}

export type HeadwindDevice = {
  /** The device NUMBER — what a remote action is addressed to. Never the database id. */
  deviceNumber: string;
  /** The server's own row id, for the reads that take one. */
  deviceId: string;
  /** What the console shows: the description the admin typed, else the device number. */
  name: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  imei: string | null;
  phone: string | null;
  osVersion: string | null;
  /** The Headwind configuration the tablet runs — its rules, its kiosk and its app list. */
  configurationName: string | null;
  configurationId: string | null;
  /** Battery charge as a percentage, where the agent reported one. */
  batteryLevel: number | null;
  batteryCharging: boolean | null;
  /** The Headwind agent's own version — a tablet far behind the fleet is worth seeing. */
  agentVersion: string | null;
  /**
   * The launcher version the tablet is ACTUALLY running, read from its reported app list.
   *
   * 🔴 THIS IS NOT `agentVersion`. `agentVersion` comes from the record's top-level `launcherVersion`,
   * which is the version the server WANTS the tablet on (the enrolment/target field) — it read 6.48
   * for a tablet that went silent before 6.48 shipped. The running version is in `info.applications`
   * under `com.hmdm.launcher`, and can be older than the target until the tablet checks in and updates.
   */
  launcherVersion: string | null;
  lastContactAt: string | null;
  /** Position from the tablet's own last report, where location is switched on for it. */
  latitude: number | null;
  longitude: number | null;
  locatedAt: string | null;
  /**
   * The tablet's RustDesk ID, out of Headwind's FIRST free-text admin field.
   *
   * 🔴 IT LIVES IN HEADWIND ON PURPOSE, NOT IN A PHOENIX TABLE. Headwind gives each device three
   * custom fields; keeping the ID in the first one means one place to look and nothing to keep in
   * step when a tablet is re-enrolled or replaced. Empty reads as "no screen session set up yet".
   */
  rustDeskId: string | null;
  /** Headwind has no "removed" state — a device is enrolled or it is not in the list at all. */
  enrollmentStatus: string | null;
  /**
   * Everything the agent itself reported, exactly as it arrived (parsed if it came as a JSON string).
   *
   * 🔴 THE PROMOTED FIELDS ABOVE ARE READ OUT OF THIS SAME BLOB. It is carried whole so the detail
   * read can show the long tail a hand-written field list would drop — the day the agent sends a new
   * fact, it appears, without a code change. It is server-to-server only and never reaches a browser
   * as-is; the detail reader humanises it and drops identifiers before anything is shown.
   */
  info: Record<string, unknown>;
  /** Kept for the register matcher's sake: every Headwind-managed device is Android. */
  isAndroid: boolean;
  platformLabel: string;
};

function normalizeDevice(record: RawRecord, configurationNames: Map<string, string> = new Map()): HeadwindDevice | null {
  const info = deviceInfo(record);
  const deviceNumber = pickString(record, ["number", "deviceNumber", "deviceId"]);
  if (!deviceNumber) return null;

  const location = info.location && typeof info.location === "object" ? (info.location as RawRecord) : {};
  const rawLatitude = pickNumber(info, ["lat", "latitude"]) ?? pickNumber(location, ["lat", "latitude"]);
  const rawLongitude = pickNumber(info, ["lon", "lng", "longitude"]) ?? pickNumber(location, ["lon", "lng", "longitude"]);
  // 🔴 A ZERO IS NULL ISLAND, NOT A PLACE — the same rule the history plugin's rows already follow
  // (`locations.ts`). Without it a check-in carrying 0/0 put a pin in the Gulf of Guinea, ticked the
  // "Location" setup chip and showed in the detail panel as if the tablet had been found.
  const hasFix = rawLatitude !== null && rawLongitude !== null && rawLatitude !== 0 && rawLongitude !== 0;

  return {
    agentVersion: pickString(record, ["launcherVersion", "agentVersion"]) ?? pickString(info, ["launcherVersion", "version"]),
    batteryCharging: pickBoolean(info, ["batteryCharging", "charging", "isCharging"]),
    batteryLevel: pickNumber(info, ["batteryLevel", "battery"]),
    configurationId: pickString(record, ["configurationId", "configId"]),
    // 🔴 THE NAME IS NOT ON THE DEVICE RECORD, IT IS IN THE REPLY'S SIBLING MAP. A row in the live list
    // carries only `configurationId, description, groups, id, lastUpdate, number, statusCode` — so every
    // tablet read "no rules" on the fleet page while sitting on `Rep tablets`, because the name lives in
    // `data.configurations[<id>].name`, beside the devices rather than inside them.
    configurationName:
      pickString(record, ["configName", "configurationName", "configuration"]) ??
      configurationNames.get(pickString(record, ["configurationId", "configId"]) ?? "") ??
      null,
    deviceId: pickString(record, ["id"]) ?? deviceNumber,
    deviceNumber,
    // 🔴 "Enrolled" IS A FACT HERE, NOT A DEFAULT. Headwind's device list holds only devices whose
    // agent has enrolled; there is no removed/pending state to render, and the server's `statusCode`
    // is a colour hint for its own console, not an enrolment state. So the word is written plainly
    // rather than read from a field that does not mean it — the column exists to match the other two
    // bridges, which do have states worth showing.
    enrollmentStatus: "Enrolled",
    imei: pickString(record, ["imei"]) ?? pickString(info, ["imei", "imei1"]),
    info,
    isAndroid: true,
    lastContactAt: isoTime(record, ["lastUpdate", "lastContact", "lastSeen"]),
    launcherVersion: runningLauncherVersion(info),
    latitude: hasFix ? rawLatitude : null,
    locatedAt: hasFix ? (isoTime(location, ["ts", "time", "timestamp"]) ?? isoTime(info, ["locationTs"])) : null,
    longitude: hasFix ? rawLongitude : null,
    manufacturer: pickString(info, ["manufacturer", "brand", "vendor"]),
    model: pickString(info, ["model", "deviceModel"]) ?? pickString(record, ["model"]),
    name: pickString(record, ["description", "name"]) ?? deviceNumber,
    osVersion: pickString(info, ["androidVersion", "osVersion", "sdkVersion"]),
    phone: pickString(record, ["phone", "phoneNumber"]),
    platformLabel: "Android",
    rustDeskId: pickString(record, ["custom1"]),
    serialNumber: pickString(info, ["serial", "serialNumber"]) ?? pickString(record, ["serial", "serialNumber"]),
  };
}

type SearchResponse = RawRecord & { items?: unknown; devices?: unknown };

/**
 * The device rows out of whatever shape `POST /rest/private/devices/search` answers with.
 *
 * 🔴 THE LIVE SERVER NESTS THE PAGE, AND READING ONLY THE FLAT SHAPES REPORTED AN EMPTY FLEET
 * (production, 2026-09-26). Headwind answers
 * `{"data":{"configurations":{…},"devices":{"items":[…],"totalItemsCount":2}}}` — the page of devices
 * sits under `devices`, beside a map of the configurations those devices use — and `callHeadwind`
 * unwraps only the envelope's `data`. Every reader looked for `data.items` first and `data.devices` as
 * an ARRAY second; both missed, so the fleet fell through to `[]` and the tablets page said there were
 * no tablets while the server held two device rows. Nothing contradicted it either: an empty fleet and
 * an unread reply look exactly alike. The flat shapes are kept, so a build that answers the page
 * directly is not broken by the fix.
 *
 * 🔴 AND A SHAPE IT CANNOT READ NOW SAYS SO (2026-10-22). Falling through to `[]` is exactly how that
 * outage stayed silent: the next unknown shape would again read as "no tablets", "no apps" or "that
 * tablet is not in the fleet any more". Only two things are an empty fleet — no reply body at all, and
 * a page that says `totalItemsCount: 0` — and everything else this cannot place throws, so the screen
 * shows an error rather than a confident empty list.
 */
export function deviceRecordsFromSearch(payload: unknown): RawRecord[] {
  if (Array.isArray(payload)) return payload as RawRecord[];
  if (payload === null || payload === undefined) return [];
  if (typeof payload !== "object") throw unreadableSearch();
  const record = payload as SearchResponse;
  for (const key of ["items", "devices"] as const) {
    const value = record[key];
    if (Array.isArray(value)) return value as RawRecord[];
  }
  const page = record.devices;
  if (page && typeof page === "object") {
    const items = (page as SearchResponse).items;
    if (Array.isArray(items)) return items as RawRecord[];
    if ((page as RawRecord).totalItemsCount === 0) return [];
  }
  if (record.totalItemsCount === 0) return [];
  throw unreadableSearch();
}

function unreadableSearch(): HeadwindRequestError {
  return new HeadwindRequestError(
    502,
    "The company tablet server answered the device list in a shape Phoenix cannot read, so Phoenix stopped rather than reading it as no tablets at all. Try again in a minute; if it keeps happening, the server was probably upgraded.",
  );
}

/**
 * The body for a `PUT /rest/private/devices` that changes one field of a device the search returned.
 *
 * 🔴 THE ROUND-TRIP STAYS OPAQUE — the server replaces the device wholesale, so the whole record goes
 * back with one field changed, or the tablet loses every group it was in. But the record the search
 * hands back carries `info` as an OBJECT, and the PUT deserializer wants `info` as a JSON STRING:
 * sending the object back verbatim answers 400 `Cannot deserialize instance of java.lang.String out of
 * START_OBJECT … Device["info"]`. So `info` is stringified on the way out when it arrived as an object;
 * a string (some builds already send one) is left untouched. Both `PUT /rest/private/devices` callers —
 * the remote-screen-ID write and the configuration move — go through here so neither can regress.
 */
export function deviceWriteBody(device: RawRecord, patch: RawRecord): RawRecord {
  const body: RawRecord = { ...device, ...patch };
  if (body.info && typeof body.info === "object") body.info = JSON.stringify(body.info);
  return body;
}

/**
 * The configuration names the same reply carries beside the devices, by configuration id.
 *
 * 🔴 A DEVICE ROW DOES NOT NAME ITS OWN CONFIGURATION. The live list hands back
 * `configurationId, description, groups, id, lastUpdate, number, statusCode` and nothing else, with the
 * names in a sibling map — `data.configurations["3"] = {id, name, applications, files}`. Read only the
 * device, and every tablet on the fleet page shows no rules at all.
 */
export function configurationNamesFromSearch(payload: unknown): Map<string, string> {
  const names = new Map<string, string>();
  if (!payload || typeof payload !== "object") return names;
  const map = (payload as RawRecord).configurations;
  if (!map || typeof map !== "object" || Array.isArray(map)) return names;
  for (const [key, value] of Object.entries(map as RawRecord)) {
    if (!value || typeof value !== "object") continue;
    const name = pickString(value as RawRecord, ["name"]);
    const id = pickString(value as RawRecord, ["id"]) ?? key;
    if (!name) continue;
    names.set(key, name);
    names.set(id, name);
  }
  return names;
}

/** Device rows asked for in one search request. A full page is the signal that another may follow. */
const SEARCH_PAGE_SIZE = 1000;

/** The row's own id, else its device number, else its whole text: what makes a row "the same row" across pages. */
function searchRowKey(record: RawRecord): string {
  return pickString(record, ["id"]) ?? pickString(record, ["number", "deviceNumber"]) ?? JSON.stringify(record);
}

/**
 * Every device row a search finds, page by page, with the configuration names the replies carry.
 *
 * 🔴 ONE PAGE IS NOT THE FLEET. Headwind's search is paged, and reading only the first page would quietly
 * stop listing tablets once a page fills — a missing tablet on a custody console is worse than a slow one.
 * The next page is asked for only while a FULL page came back, so a fleet or a match list under a page is
 * still one request. A page that adds no row not already seen ends the walk, so a server that ignores
 * `pageNum` can never loop it. Each reply's configuration map covers its own devices only, so they merge.
 */
export async function searchHeadwindDevices(
  value: string,
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<{ configurationNames: Map<string, string>; records: RawRecord[] }> {
  const records: RawRecord[] = [];
  const configurationNames = new Map<string, string>();
  const seen = new Set<string>();
  for (let pageNum = 1; ; pageNum += 1) {
    const payload = await callHeadwind<SearchResponse>(
      "/rest/private/devices/search",
      { body: JSON.stringify({ pageNum, pageSize: SEARCH_PAGE_SIZE, value }), method: "POST" },
      fetchImpl,
      env,
    );
    for (const [key, name] of configurationNamesFromSearch(payload)) configurationNames.set(key, name);
    const page = deviceRecordsFromSearch(payload);
    const fresh = pageNum === 1 ? page : page.filter((record) => !seen.has(searchRowKey(record)));
    for (const record of fresh) seen.add(searchRowKey(record));
    records.push(...fresh);
    if (page.length < SEARCH_PAGE_SIZE || fresh.length === 0) return { configurationNames, records };
  }
}

/**
 * Every device the company's Headwind server manages, normalized.
 *
 * The owner expects about a hundred tablets, so this is normally one request; `searchHeadwindDevices`
 * walks on to the next page whenever a page comes back full, so the fleet is never a short list.
 */
export async function listHeadwindDevices(
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HeadwindDevice[]> {
  const { configurationNames, records } = await searchHeadwindDevices("", fetchImpl, env);
  return records
    .map((record) => normalizeDevice(record, configurationNames))
    .filter((device): device is HeadwindDevice => device !== null);
}

/**
 * The register entry a Headwind device belongs to, and HOW it was recognised.
 *
 * The how matters for exactly one decision: copying the IMEI the tablet reports onto its register
 * entry. An entry matched BY that IMEI already holds it, and an entry matched by nothing else has
 * not been confirmed by anything the tablet itself carries — only a SERIAL match says "this row is
 * certainly this tablet", which is the same bar the other two bridges set before they write an IMEI.
 */
export type HeadwindRegisterMatch = { entry: RegisterTablet; bySerial: boolean };

export function matchHeadwindToRegisterDetailed(
  device: HeadwindDevice,
  register: readonly RegisterTablet[],
): HeadwindRegisterMatch | null {
  const serial = normalizeSerial(device.serialNumber);
  if (serial) {
    const entry = register.find((candidate) => normalizeSerial(candidate.serialNumber) === serial);
    if (entry) return { bySerial: true, entry };
  }
  const imei = normalizeImei(device.imei);
  if (imei) {
    const entry = register.find((candidate) => {
      const registered = normalizeImei(candidate.imei);
      return registered !== null && imeisMatch(registered, imei);
    });
    if (entry) return { bySerial: false, entry };
  }
  return null;
}

/** The register entry a Headwind device belongs to, by serial then IMEI, or null. */
export function matchHeadwindToRegister(
  device: HeadwindDevice,
  register: readonly RegisterTablet[],
): RegisterTablet | null {
  return matchHeadwindToRegisterDetailed(device, register)?.entry ?? null;
}

export type HeadwindLocation = {
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  /** When the tablet TOOK the fix — never when it last checked in. Null when the tablet did not say. */
  locatedAt: string | null;
};

export class HeadwindDeviceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeadwindDeviceNotFoundError";
  }
}

/**
 * A tablet's last known position.
 *
 * 🔴 THIS IS A READ OF WHAT THE TABLET ALREADY REPORTED, NOT A LIVE PING. Headwind's agent sends its
 * position with its regular check-in when location is enabled in the tablet's configuration, and the
 * fleet read already carries it — so this reads the same list rather than inventing an endpoint. The
 * console shows the TIME beside the position, so an older fix reads as what it is. Headwind does not
 * reverse-geocode, so `address` is always null here and the screen shows coordinates; naming a street
 * we had not been told would be a fabricated fact.
 */
export async function getHeadwindLocation(
  deviceNumber: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HeadwindLocation> {
  const devices = await listHeadwindDevices(fetchImpl, env);
  const device = devices.find((candidate) => candidate.deviceNumber === deviceNumber);
  // 🔴 A NUMBER THAT IS NOT IN THE FLEET IS NOT "A TABLET WITH NO POSITION". Answering all-nulls made a
  // mistyped or removed tablet read exactly like a real one that had never been outdoors.
  if (!device) {
    throw new HeadwindDeviceNotFoundError(
      "That tablet is not in the Headwind fleet any more. Reload the page and try again from its row.",
    );
  }
  return {
    address: null,
    latitude: device.latitude,
    // 🔴 THE FIX TIME, NEVER THE CHECK-IN TIME. Falling back to `lastContactAt` dated an old position by
    // the tablet's latest check-in — right after a "Locate now" wake that made a days-old fix read as
    // "less than two minutes old", which is the one lie this read exists to prevent.
    locatedAt: device.locatedAt,
    longitude: device.longitude,
  };
}
