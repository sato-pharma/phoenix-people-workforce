/**
 * One tablet, in full — everything ManageEngine holds about it, and what has been done to it.
 *
 * WHY THIS IS NOT A FIXED LIST OF FIELDS. `GET /api/v1/mdm/devices/{id}` answers with a different
 * set of keys per platform, per enrolment type and per agent version: this tenant's Android tablets
 * carry `battery_level`, `used_device_space`, `owned_by`, and nested `os`, `network` and `security`
 * objects, while the documentation also shows warranty, cellular and Mac-only members. A hand-written
 * list of twelve fields would silently drop whatever the tenant sends that is not on it — which is
 * the opposite of the "everything, in Phoenix" the console is for.
 *
 * So the reader PROMOTES the facts a person looks for first (who holds it, how full it is, how
 * charged, what it runs, whether it is encrypted and locked) and then shows EVERY other scalar
 * ManageEngine sent, with its key humanised. A field this file has never seen still appears, under a
 * readable label, the day ManageEngine starts sending it.
 *
 * NAMES, NEVER CODES (AGENTS.md §4). Keys become sentences (`battery_level` → "Battery level"),
 * booleans become Yes and No, epoch milliseconds become Cairo local time, and the raw identifiers a
 * person cannot act on — `*_id`, `udid`, `uuid` — are dropped from the display entirely. They are
 * still what the commands travel on; they are simply not something to read on a screen.
 *
 * NOTHING HERE WRITES. Reading a device's detail and its command history are both GETs; the actions
 * live in `commands.ts` and the app changes in `apps.ts`, each with its own audit row.
 */

import { callManageEngine } from "@/lib/devices/manageengine/client";

type RawRecord = Record<string, unknown>;

export type DeviceFact = {
  label: string;
  value: string;
};

export type DeviceFactSection = {
  title: string;
  facts: DeviceFact[];
};

export type ManageEngineDeviceDetail = {
  deviceId: string;
  /** The facts a person looks for first, already in reading order. */
  headline: DeviceFact[];
  /** Everything else ManageEngine sent, grouped by the object it arrived in. */
  sections: DeviceFactSection[];
};

export type ManageEngineCommandRecord = {
  commandId: string | null;
  /** The action, as a person would say it — "Locked", never `lock`. */
  name: string;
  status: string | null;
  remarks: string | null;
  issuedAt: string | null;
};

/** Identifiers are how a command finds the tablet, never something to read on a screen. */
const HIDDEN_KEY_PATTERN = /(^|_)(id|ids|udid|uuid|guid|identifier|token|key|secret|password)$/i;

/**
 * Keys whose value is one of ManageEngine's own numbered enums.
 *
 * "Platform type 2" and "Managed status 2" are codes, and AGENTS.md §4 says names, never codes. The
 * honest answer is not to guess at a meaning the vendor has not published: these are dropped, and
 * the facts they stand for are already on the screen in words — the fleet row names the platform and
 * says whether the tablet is managed, and the headline names who owns it.
 */
const VENDOR_CODE_KEYS: ReadonlySet<string> = new Set([
  "agent_type",
  "cellular_technology",
  "efrp_status",
  "hardware_encryption_caps",
  "managed_status",
  "model_type",
  "notification_service_type",
  "platform_type",
  "provisioning_mode",
  "purchase_type",
]);

/**
 * Nested objects that describe ManageEngine's OWN configuration rather than the tablet.
 *
 * `privacy_settings` and `location_settings` arrive as two dozen bare 0/1/2 flags — what the MDM is
 * permitted to collect, decided in the ManageEngine console, not anything about the device in the
 * rep's hands. Shown here they were two screens of unreadable codes on a page whose whole purpose is
 * to answer "what is going on with this tablet".
 */
const SETTINGS_OBJECT_KEYS: ReadonlySet<string> = new Set(["privacy_settings", "location_settings"]);

/** What ManageEngine sends instead of leaving a field out: nothing worth a row on the screen. */
const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set(["--", "-", "---", "n/a", "na", "null", "undefined", "none"]);

/**
 * A resource key such as `dc.mdm.db.agent.enroll.agent_enroll_finished` — a code, not a sentence.
 *
 * It must START with a letter, which is what keeps a version number out: `agent_version` arrives as
 * "26.09.01", three dotted segments like the code above and a fact worth reading.
 */
const RESOURCE_CODE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){2,}$/;

/** Words that are read as themselves, not sentence-cased, when a key is turned into a label. */
const ACRONYMS: Readonly<Record<string, string>> = {
  aeui: "Android Enterprise",
  apn: "APN",
  dep: "DEP",
  gps: "GPS",
  iccid: "ICCID",
  imei: "IMEI",
  imsi: "IMSI",
  ios: "iOS",
  ip: "IP",
  mac: "MAC",
  mdm: "ManageEngine",
  meid: "MEID",
  os: "OS",
  ram: "RAM",
  sdk: "SDK",
  sim: "SIM",
  vpn: "VPN",
  wifi: "Wi-Fi",
};

/**
 * Whole keys that read badly word by word.
 *
 * `wifi_ssid` through the word-by-word path becomes "Wi-Fi SSID" — two pieces of jargon where the
 * thing being named is simply the Wi-Fi network. Checked before the humaniser, never after.
 */
const KEY_LABELS: Readonly<Record<string, string>> = {
  ssid: "Wi-Fi network",
  wifi_ssid: "Wi-Fi network",
};

/** A key such as `battery_level` as a person would read it: "Battery level". */
export function humanizeKey(key: string): string {
  const whole = KEY_LABELS[key.trim().toLowerCase()];
  if (whole) return whole;
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\s]+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return key;
  const spelled = words.map((word) => ACRONYMS[word.toLowerCase()] ?? word.toLowerCase());
  const [first, ...rest] = spelled;
  const opener = ACRONYMS[words[0].toLowerCase()] ? first : first.charAt(0).toUpperCase() + first.slice(1);
  return [opener, ...rest].join(" ");
}

/**
 * Whether a number is a millisecond epoch rather than a plain quantity.
 *
 * Both halves matter: a key that talks about time, AND a value in the window a real timestamp falls
 * in. `battery_level` is never a date whatever its value, and `1` is never a date whatever its key.
 */
function looksLikeEpochMs(key: string, value: number): boolean {
  if (!/(time|date|_at|seen|stamp)/i.test(key)) return false;
  return value > 1_000_000_000_000 && value < 4_000_000_000_000;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString("en-US") : String(value);
}

/** A key that names a moment, whatever the value turns out to be. */
function namesAMoment(key: string): boolean {
  return /(time|date|_at|seen|stamp)/i.test(key);
}

/**
 * A size with the unit ManageEngine measured it in.
 *
 * Both are the vendor's own units and neither is labelled in the payload: storage arrives in
 * gigabytes (`device_capacity: 51.17` on a 64 GB tablet) and memory in megabytes
 * (`total_ram_memory: 3539.391` on a 4 GB tablet). Unlabelled they read as bare numbers, which is
 * how "46.52" ended up on the screen meaning 46 and a half gigabytes free.
 */
function sizeUnit(key: string): "GB" | "MB" | null {
  if (/(ram|memory)/i.test(key)) return "MB";
  if (/(capacity|space|storage)/i.test(key)) return "GB";
  return null;
}

/** A key whose value is a measured quantity — a moment, a size or a sum of money. */
function isQuantitative(key: string): boolean {
  return namesAMoment(key) || sizeUnit(key) !== null || /price|cost|amount/i.test(key);
}

/**
 * A battery reading as a percentage, whichever way ManageEngine sends it.
 *
 * Some agents report `0.84`, others `84`. A value at or below 1 is read as a fraction; anything
 * above as a percentage already. Returns null when it is neither.
 */
export function batteryPercent(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(number) || number < 0) return null;
  if (number <= 1) return Math.round(number * 100);
  if (number <= 100) return Math.round(number);
  return null;
}

/**
 * A value as a sentence, or null when there is nothing worth showing.
 *
 * A timestamp is left as ISO here and turned into Cairo local time by the screen, which is where
 * every other time in Phoenix is formatted.
 */
function formatValue(key: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    if (value === -1) return null; // ManageEngine's "not known" for a numeric field.
    if (looksLikeEpochMs(key, value)) return new Date(value).toISOString();
    // A date or a price that came back as zero is a field nobody filled in, not the year 1970 and
    // not a tablet that cost nothing. `warranty_expiration_date: 0` was reaching the screen as "0".
    if (value === 0 && (namesAMoment(key) || /price|cost|amount/i.test(key))) return null;
    const unit = sizeUnit(key);
    return unit ? `${formatNumber(Math.round(value * 10) / 10)} ${unit}` : formatNumber(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "-1") return null;
    if (PLACEHOLDER_VALUES.has(trimmed.toLowerCase())) return null;
    // ManageEngine sends plenty of numbers as strings, epochs among them — `added_time` arrives as
    // "1790189748682", which printed as thirteen raw digits. A numeric string goes back through the
    // number path ONLY where the key says it is a quantity: an IMEI is fifteen digits and must stay
    // exactly as it is, never grouped into "865,569,071,549,107".
    if (/^-?\d+(\.\d+)?$/.test(trimmed) && isQuantitative(key)) return formatValue(key, Number(trimmed));
    if (RESOURCE_CODE_PATTERN.test(trimmed)) return null; // A vendor resource key, not a sentence.
    // Android's own release letter — "S" for 12. The headline says "Android 12"; a row reading
    // "OS name: S" adds nothing a person can use.
    if (/(^|_)os_name$/i.test(key) && trimmed.length <= 2) return null;
    return trimmed;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => (typeof item === "object" && item !== null ? null : formatValue(key, item)))
      .filter((item): item is string => item !== null);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  return null;
}

/** Every scalar in one object, humanised, with identifiers and empty values dropped. */
function factsFrom(record: RawRecord, skipKeys: ReadonlySet<string> = new Set()): DeviceFact[] {
  const facts: DeviceFact[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (skipKeys.has(key)) continue;
    if (HIDDEN_KEY_PATTERN.test(key)) continue;
    if (VENDOR_CODE_KEYS.has(key.toLowerCase())) continue;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) continue;
    const formatted = formatValue(key, value);
    if (formatted === null) continue;
    facts.push({ label: humanizeKey(key), value: formatted });
  }
  return facts;
}

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

function nested(record: RawRecord, key: string): RawRecord | null {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RawRecord) : null;
}

/**
 * How full the tablet is, as a percentage — unit-free, so it is right whether ManageEngine counts in
 * megabytes or in bytes.
 *
 * The raw numbers are shown too, under their own labels; this is the line a person can act on
 * without knowing the unit.
 */
export function storageUsedPercent(record: RawRecord): number | null {
  const used = pickNumber(record, ["used_device_space", "used_space", "device_space_used"]);
  const total = pickNumber(record, ["total_device_space", "total_space", "device_capacity"]);
  const free = pickNumber(record, ["available_device_space", "free_device_space", "available_space"]);
  const capacity = total ?? (used !== null && free !== null ? used + free : null);
  if (used === null || capacity === null || capacity <= 0) return null;
  const percent = Math.round((used / capacity) * 100);
  return percent >= 0 && percent <= 100 ? percent : null;
}

const HEADLINE_SOURCE_KEYS = [
  "device_name",
  "model",
  "model_name",
  "os_version",
  "owned_by",
  "battery_level",
  "used_device_space",
  "total_device_space",
  "available_device_space",
  "last_contact_time",
] as const;

/**
 * The platform as a person says it — "Android", never "S" and never "2".
 *
 * ManageEngine answers `os_name` with Android's own one-letter release code ("S" for 12), which read
 * on the screen as "Operating system: S 12". `platform_type` carries the same fact as a number, and
 * the fleet table already turns that number into a word; this reads it the same way so the two
 * surfaces cannot disagree. An unrecognised value is shown as it came rather than guessed at.
 */
function platformWord(record: RawRecord, os: RawRecord | null): string | null {
  const named = pickString(record, ["platform_type_name"]);
  if (named) return named;
  const raw = pickString(record, ["platform_type", "platform", "device_platform"]);
  const normalized = raw?.toLowerCase() ?? "";
  if (normalized === "2" || normalized.includes("android")) return "Android";
  if (normalized === "1" || normalized.includes("ios")) return "iOS";
  if (normalized === "3" || normalized.includes("windows")) return "Windows";
  const osName = pickString(record, ["os_name"]) ?? (os ? pickString(os, ["os_name", "name"]) : null);
  // A one or two letter answer is Android's release letter, not the name of anything.
  if (osName && osName.length > 2) return osName;
  return raw && raw.length > 2 ? raw : null;
}

/**
 * The facts a person looks for first, in reading order: what it is, who owns it, how charged, how
 * full, and what it runs.
 */
function headlineFacts(record: RawRecord): DeviceFact[] {
  const facts: DeviceFact[] = [];
  const model = pickString(record, ["model", "model_name", "product_name"]);
  if (model) facts.push({ label: "Model", value: model });

  const os = nested(record, "os");
  const osVersion = pickString(record, ["os_version"]) ?? (os ? pickString(os, ["os_version", "version"]) : null);
  const platform = platformWord(record, os);
  if (platform || osVersion) {
    facts.push({ label: "Operating system", value: [platform, osVersion].filter(Boolean).join(" ") });
  }

  // Ownership is a word or it is nothing: ManageEngine also answers this as a bare 1 or 2, and the
  // row above already says in plain words who holds the tablet and that the company owns it.
  const ownedBy = pickString(record, ["owned_by", "ownership", "ownedby"]);
  if (ownedBy && !/^\d+$/.test(ownedBy)) facts.push({ label: "Owned by", value: ownedBy });

  const battery = batteryPercent(record.battery_level);
  if (battery !== null) facts.push({ label: "Battery", value: `${battery}%` });

  const storage = storageUsedPercent(record);
  if (storage !== null) facts.push({ label: "Storage used", value: `${storage}% of the tablet` });

  return facts;
}

/**
 * Turn the device-detail payload into a promoted headline plus every other scalar it carried.
 *
 * Exported so a test can assert on the shape without a network call, and so the route can hand the
 * page something already in reading order.
 */
export function normalizeDeviceDetail(deviceId: string, payload: RawRecord): ManageEngineDeviceDetail {
  const record = nested(payload, "device") ?? payload;
  const headline = headlineFacts(record);

  const sections: DeviceFactSection[] = [];
  const topLevel = factsFrom(record, new Set(HEADLINE_SOURCE_KEYS));
  if (topLevel.length > 0) sections.push({ facts: topLevel, title: "The tablet" });

  for (const [key, value] of Object.entries(record)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    if (SETTINGS_OBJECT_KEYS.has(key.toLowerCase())) continue;
    const facts = factsFrom(value as RawRecord);
    if (facts.length === 0) continue;
    sections.push({ facts, title: humanizeKey(key) });
  }

  return { deviceId, headline, sections };
}

/** Everything ManageEngine holds about one tablet. */
export async function getManageEngineDeviceDetail(
  deviceId: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ManageEngineDeviceDetail> {
  const payload = await callManageEngine<RawRecord>(
    `/api/v1/mdm/devices/${encodeURIComponent(deviceId)}`,
    {},
    fetchImpl,
    env,
  );
  return normalizeDeviceDetail(deviceId, payload ?? {});
}

/**
 * ManageEngine's own command names as a person would say them.
 *
 * The API answers `command_name` with its internal spelling (`corporate_wipe`), and the history is
 * exactly the screen where a raw code would be read as gibberish. An unmapped name falls back to the
 * humaniser rather than being hidden — a command Phoenix did not issue still belongs in the history.
 */
const COMMAND_NAME_LABELS: Readonly<Record<string, string>> = {
  clear_passcode: "Cleared the screen lock",
  complete_wipe: "Full factory reset",
  corporate_wipe: "Removed company data",
  disable_lost_mode: "Ended lost mode",
  enable_lost_mode: "Put in lost mode",
  fetch_location: "Asked for its position",
  lock: "Locked",
  pause_kiosk: "Paused kiosk mode",
  re_apply_kiosk: "Resumed kiosk mode",
  remote_alarm: "Rang the alarm",
  remote_control: "Remote control session",
  remote_debug: "Remote debug session",
  remote_view: "Remote view session",
  reset_passcode: "Reset the screen lock",
  restart: "Restarted",
  scan: "Asked it to report in",
  shutdown: "Shut down",
  unlock_user_account: "Unlocked the account",
};

export function commandLabel(name: string): string {
  const key = name.trim().toLowerCase();
  return COMMAND_NAME_LABELS[key] ?? humanizeKey(name);
}

/** The documented status codes; anything else is left unlabelled rather than guessed at. */
const COMMAND_STATUS_LABELS: Readonly<Record<string, string>> = {
  "1": "Waiting for the tablet",
  "2": "Sent to the tablet",
  "3": "Done",
  "4": "Failed",
};

function commandStatusLabel(value: unknown): string | null {
  // The status arrives as a STRING of digits, not a number — read as a word it printed as a bare
  // "1" beside every command in the history.
  if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    return COMMAND_STATUS_LABELS[trimmed] ?? (/^\d+$/.test(trimmed) ? null : humanizeKey(trimmed));
  }
  if (typeof value === "number" && Number.isFinite(value)) return COMMAND_STATUS_LABELS[String(value)] ?? null;
  return null;
}

/**
 * ManageEngine's remarks are HTML, not text.
 *
 * The command history answers with markup inside the sentence — `<label class="eventlogbold">Corporate
 * Wipe</label> command for …` — which reached the screen with its tags showing. React escapes what it
 * renders, correctly, so the fix belongs here: take the words out of the markup and leave the markup
 * behind. Nothing is rendered as HTML anywhere; this only ever produces plain text.
 */
function plainText(value: string): string {
  const withoutTags = value.replace(/<[^>]*>/g, " ");
  const decoded = withoutTags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'");
  return decoded.replace(/\s+/g, " ").trim();
}

/** A remark as plain words, or nothing at all when the markup was all there was. */
function remarkText(value: string | null): string | null {
  if (!value) return null;
  const text = plainText(value);
  return text ? text : null;
}

function commandIso(record: RawRecord): string | null {
  const ms = pickNumber(record, ["added_time", "command_time", "created_time"]);
  if (ms !== null && ms > 0) return new Date(ms).toISOString();
  const text = pickString(record, ["added_time_str", "command_time_str"]);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/**
 * What has been asked of this tablet, newest first — the answer to "did my wipe actually reach it".
 *
 * ManageEngine keeps the trail whoever issued the command, so this shows a command sent from the
 * ManageEngine console beside one sent from Phoenix. Phoenix's own audit log records only its own.
 */
export async function getManageEngineCommandHistory(
  deviceId: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ManageEngineCommandRecord[]> {
  const payload = await callManageEngine<RawRecord>(
    `/api/v1/mdm/devices/${encodeURIComponent(deviceId)}/commandhistory`,
    {},
    fetchImpl,
    env,
  );
  const list = Array.isArray(payload?.commands)
    ? (payload.commands as RawRecord[])
    : Array.isArray(payload?.command_history)
      ? (payload.command_history as RawRecord[])
      : [];

  return list
    .map((record) => {
      const name = pickString(record, ["command_name", "command", "name"]);
      if (!name) return null;
      return {
        commandId: pickString(record, ["command_id"]),
        issuedAt: commandIso(record),
        name: commandLabel(name),
        remarks: remarkText(pickString(record, ["remarks", "error_description", "description"])),
        status: commandStatusLabel(record.command_status ?? record.status),
      } satisfies ManageEngineCommandRecord;
    })
    .filter((entry): entry is ManageEngineCommandRecord => entry !== null)
    .sort((left, right) => (right.issuedAt ?? "").localeCompare(left.issuedAt ?? ""));
}
