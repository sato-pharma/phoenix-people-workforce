/**
 * One tablet, in full — everything the company's Headwind server holds about it, and what Phoenix has
 * done to it.
 *
 * WHY THIS IS NOT A FIXED LIST OF FIELDS. The facts a tablet reports arrive inside Headwind's `info`
 * blob, and what is in that blob depends on the agent version and on what the tablet's configuration
 * permits it to collect. A hand-written list of twelve fields would silently drop whatever this fleet
 * sends that is not on it — the opposite of the "everything, in Phoenix" the console is for. So the
 * reader PROMOTES the facts a person looks for first and then shows EVERY other scalar the agent
 * sent, with its key humanised. A field this file has never seen still appears, readably, the day the
 * agent starts sending it.
 *
 * 🔴 THE COMMAND HISTORY COMES FROM PHOENIX'S OWN AUDIT LOG, NOT FROM HEADWIND, AND THAT IS A
 * DELIBERATE DIFFERENCE FROM THE MANAGEENGINE PANEL. ManageEngine publishes a `/commandhistory`
 * endpoint; Headwind publishes nothing equivalent, and inventing a path would produce a panel that
 * reports an empty history as confidently as a real one. What Phoenix can stand behind is what
 * Phoenix itself did: every action issued here writes a required `headwind_device_command` row, so
 * this reads those. The panel says so in as many words, because "no actions from Phoenix" and
 * "nothing has ever happened to this tablet" are not the same sentence and must not look alike.
 *
 * NAMES, NEVER CODES (AGENTS.md §4). Keys become sentences (`batteryLevel` → "Battery level"),
 * booleans become Yes and No, epoch milliseconds become a Cairo date and time HERE (the panel prints a
 * fact's value as it arrives, so an ISO instant reached the page as raw UTC until 2026-10-22), and raw
 * identifiers a person cannot act on are dropped from the display entirely.
 *
 * NOTHING HERE WRITES.
 */

import { deviceActorNames } from "@/lib/devices/actor-names";
import { listHeadwindDevices } from "@/lib/devices/headwind/devices";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type RawRecord = Record<string, unknown>;

export type DeviceFact = { label: string; value: string };
export type DeviceFactSection = { title: string; facts: DeviceFact[] };

export type HeadwindDeviceDetail = {
  deviceNumber: string;
  /** The facts a person looks for first, already in reading order. */
  headline: DeviceFact[];
  /** Everything else the agent sent, grouped by the object it arrived in. */
  sections: DeviceFactSection[];
};

export type HeadwindCommandRecord = {
  /** The action, as a person would say it — the past tense the audit row was written with. */
  summary: string;
  /** Who pressed it. A name where the audit row holds one, never a bare id. */
  actor: string | null;
  issuedAt: string;
};

/** Identifiers are how a command finds the tablet, never something to read on a screen. */
const HIDDEN_KEY_PATTERN = /(^|[_.])(id|ids|udid|uuid|guid|identifier|token|key|secret|password)$/i;

/** Words that are read as themselves, not sentence-cased, when a key is turned into a label. */
const ACRONYMS: Readonly<Record<string, string>> = {
  api: "API",
  cpu: "CPU",
  gps: "GPS",
  imei: "IMEI",
  ip: "IP",
  mac: "MAC",
  mdm: "Headwind",
  os: "OS",
  ram: "RAM",
  sdk: "SDK",
  sim: "SIM",
  ssid: "Wi-Fi network",
  wifi: "Wi-Fi",
};

/** A key such as `batteryLevel` as a person would read it: "Battery level". */
export function humanizeHeadwindKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\s.]+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return key;
  const spelled = words.map((word) => ACRONYMS[word.toLowerCase()] ?? word.toLowerCase());
  const [first, ...rest] = spelled;
  const opener = ACRONYMS[words[0].toLowerCase()] ? first : first.charAt(0).toUpperCase() + first.slice(1);
  return [opener, ...rest].join(" ");
}

/**
 * Whether a key names a moment. `lastContactAt` and `locatedAt` are camelCase with no underscore, so
 * the `…At` ending is matched on its own — the old pattern missed both, which is why the Check-in
 * section printed raw UTC. `ts` and `…Ts` (the agent's `locationTs`, which `devices.ts` already reads
 * as a moment) are matched too, or "Everything the tablet reports" prints them as a 13-digit number.
 */
function isInstantKey(key: string): boolean {
  return /(time|date|_at|seen|stamp|update)/i.test(key) || /(At|Ts)$/.test(key) || key === "ts";
}

/** Whether a number is a millisecond epoch rather than a plain quantity. Both halves matter. */
function looksLikeEpochMs(key: string, value: number): boolean {
  if (!isInstantKey(key)) return false;
  return value > 1_000_000_000_000 && value < 4_000_000_000_000;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function formatValue(key: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    if (looksLikeEpochMs(key, value)) return cairoDateTime(new Date(value).toISOString());
    return Number.isInteger(value) ? value.toLocaleString("en-US") : String(value);
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    // The fleet read hands over its moments as ISO strings — Cairo time here, never the raw instant.
    if (isInstantKey(key) && ISO_INSTANT.test(text)) {
      const cairo = cairoDateTime(text);
      return cairo === "—" ? text : cairo;
    }
    return text;
  }
  return null;
}

/**
 * The `info` keys already surfaced in the headline or in the position section — excluded from the
 * "Everything the tablet reports" catch-all so a fact is not printed twice under two labels. The
 * candidate spellings match `normalizeDevice` in `devices.ts`; a spelling that fleet reader does not
 * promote still falls through to the catch-all, which is the safe direction.
 */
const PROMOTED_INFO_KEYS: ReadonlySet<string> = new Set([
  "manufacturer", "brand", "vendor",
  "model", "deviceModel",
  "androidVersion", "osVersion", "sdkVersion",
  "batteryLevel", "battery",
  "batteryCharging", "charging", "isCharging",
  "serial", "serialNumber",
  "imei", "imei1",
  "launcherVersion", "version",
  "lat", "latitude", "lon", "lng", "longitude", "location",
]);

/** The scalar facts inside one object, humanised, with identifiers and empty values dropped. */
function factsFrom(record: RawRecord): DeviceFact[] {
  const facts: DeviceFact[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (HIDDEN_KEY_PATTERN.test(key)) continue;
    const formatted = formatValue(key, value);
    if (formatted === null) continue;
    facts.push({ label: humanizeHeadwindKey(key), value: formatted });
  }
  return facts.sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * Everything Headwind holds about one tablet.
 *
 * 🔴 IT READS THE FLEET LIST RATHER THAN A PER-DEVICE ENDPOINT, ON PURPOSE. Headwind's search result
 * already carries the whole device record including the agent's `info` blob, and no per-device read
 * is published — so this uses the endpoint that certainly exists rather than one that might. The
 * fleet is a hundred tablets at its largest, which is one small request.
 */
export async function getHeadwindDeviceDetail(
  deviceNumber: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HeadwindDeviceDetail> {
  const devices = await listHeadwindDevices(fetchImpl, env);
  const device = devices.find((candidate) => candidate.deviceNumber === deviceNumber);
  if (!device) {
    return { deviceNumber, headline: [], sections: [] };
  }

  const headline: DeviceFact[] = [];
  const push = (label: string, value: string | number | null) => {
    if (value === null || value === "") return;
    headline.push({ label, value: String(value) });
  };
  push("Model", [device.manufacturer, device.model].filter(Boolean).join(" ") || null);
  push("Android version", device.osVersion);
  push("Battery", device.batteryLevel === null ? null : `${device.batteryLevel}%${device.batteryCharging ? " · charging" : ""}`);
  push("Serial number", device.serialNumber);
  push("IMEI", device.imei);
  push("Phone number", device.phone);
  push("Rules it runs", device.configurationName);
  push("Headwind agent", device.agentVersion);
  push("Remote screen ID", device.rustDeskId);

  const sections: DeviceFactSection[] = [];
  const position =
    device.latitude !== null && device.longitude !== null
      ? [{ label: "Last position", value: `${device.latitude}, ${device.longitude}` }]
      : [];
  if (position.length > 0) sections.push({ facts: position, title: "Where it was last seen" });

  const everythingElse = factsFrom({
    lastContactAt: device.lastContactAt,
    locatedAt: device.locatedAt,
  } satisfies RawRecord);
  if (everythingElse.length > 0) sections.push({ facts: everythingElse, title: "Check-in" });

  // 🔴 EVERYTHING THE AGENT SENT THAT IS NOT ALREADY ABOVE. The promoted facts are dropped so nothing
  // reads twice; `factsFrom` then humanises the rest, turns epoch millis into Cairo time, and drops
  // identifiers and nested objects. A fact this file has never seen appears here the day the agent
  // starts sending it — which is the whole reason the blob is carried through rather than a fixed list.
  const reported = Object.fromEntries(
    Object.entries(device.info).filter(([key]) => !PROMOTED_INFO_KEYS.has(key)),
  );
  const everythingReported = factsFrom(reported);
  if (everythingReported.length > 0) {
    sections.push({ facts: everythingReported, title: "Everything the tablet reports" });
  }

  return { deviceNumber, headline, sections };
}

/** How many of Phoenix's own actions on one tablet the panel lists, newest first. */
export const HEADWIND_HISTORY_LIMIT = 50;

export type HeadwindCommandHistory = {
  commands: HeadwindCommandRecord[];
  /** More actions exist than are listed — the panel says so rather than letting 50 read as "all". */
  more: boolean;
};

/**
 * What Phoenix has done to this tablet — read from Phoenix's own required audit rows.
 *
 * See the header: this is deliberately NOT a claim about everything that has ever happened to the
 * tablet, only about what was done from here. The panel labels it that way.
 *
 * One row past the limit is read so the panel can say there are older actions, and the actor column —
 * an HR id — is turned into a name through `deviceActorNames`, never printed as the code.
 */
export async function getHeadwindCommandHistory(deviceNumber: string): Promise<HeadwindCommandHistory> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("audit_logs")
    .select("summary, actor_login_id, created_at")
    .eq("entity_type", "headwind_device_command")
    .eq("entity_id", deviceNumber)
    .order("created_at", { ascending: false })
    .limit(HEADWIND_HISTORY_LIMIT + 1);
  if (error) throw new Error(`Could not read what has been done to this tablet: ${error.message}`);

  const rows = (data ?? []).slice(0, HEADWIND_HISTORY_LIMIT);
  const nameOf = await deviceActorNames(rows.map((row) => (typeof row.actor_login_id === "string" ? row.actor_login_id : null)));
  return {
    commands: rows.map((row) => ({
      actor: nameOf(typeof row.actor_login_id === "string" ? row.actor_login_id : null),
      issuedAt: String(row.created_at),
      summary: String(row.summary ?? ""),
    })),
    more: (data ?? []).length > HEADWIND_HISTORY_LIMIT,
  };
}
