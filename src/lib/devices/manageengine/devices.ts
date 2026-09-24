/**
 * Reading the ManageEngine fleet and matching it to Phoenix's custody register.
 *
 * The list comes from `GET /api/v1/mdm/devices`; each tablet is matched to a register entry the same
 * way the Android Management view matches — by serial number, then by IMEI, both compared on digits
 * through the shared `device-identity` helpers so "the same tablet" means one thing on every screen.
 *
 * DEFENSIVE FIELD READING. ManageEngine's device JSON uses different key spellings across versions
 * and platforms (`device_id`/`resource_id`/`udid`, `device_name`/`model`, `last_contact_time` in ms).
 * Rather than pin one spelling, each field is read from a small list of candidates and the raw record
 * is kept so a value that does not map is visible in one place. The candidate lists were CONFIRMED
 * against this tenant's live `GET /api/v1/mdm/devices` response on 2026-09-24, which showed three
 * shapes a flat string read misses: `imei` arrives as an ARRAY (`["8655…"]`), `is_lost_mode_enabled`
 * is a real BOOLEAN, and the holder is a NESTED `user` object (`{ user_name, user_email }`). The
 * readers below handle those alongside the documented flat spellings.
 */

import { normalizeImei, normalizeSerial, imeisMatch } from "@/lib/devices/device-identity";
import { callManageEngine } from "@/lib/devices/manageengine/client";
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

/** Like {@link pickString}, but also reads the FIRST usable element when the value is an array —
 * this tenant returns `imei` as `["865569071549107"]`, while the docs show a bare string. */
function pickStringOrFirst(record: RawRecord, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) return item.trim();
        if (typeof item === "number" && Number.isFinite(item)) return String(item);
      }
      continue;
    }
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** A flag that ManageEngine sends as a real boolean (`is_lost_mode_enabled`) on some records and as a
 * "1"/"0" or "true"/"false" string on others. Returns null when no candidate key is present. */
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

/** The nested `user` object ManageEngine attaches to a device (`{ user_name, user_email, … }`), or null. */
function nestedUser(record: RawRecord): RawRecord | null {
  const user = record.user;
  return user && typeof user === "object" && !Array.isArray(user) ? (user as RawRecord) : null;
}

/**
 * A human enrolment status, never the raw code ManageEngine sends.
 *
 * This tenant's live `GET /api/v1/mdm/devices` returns `managed_status` as a bare integer STRING
 * ("2") with no text sibling, so rendering it verbatim printed "2" on the console — an owner
 * names-never-codes violation. `2` is the managed/enrolled state (confirmed against the live device,
 * which is enrolled, responding to commands and recently seen); a removed device is flagged by the
 * separate `is_removed` boolean. Any value that is already a word (some tenants/versions send one) is
 * passed through. An unmapped bare code returns null — the badge is hidden rather than showing a
 * number or a label we cannot stand behind, and this map is extended when a new live value is seen.
 */
const MANAGED_STATUS_LABELS: Readonly<Record<string, string>> = { "2": "Managed" };

function enrollmentLabel(record: RawRecord): string | null {
  if (pickBoolean(record, ["is_removed"]) === true) return "Removed";
  const status = pickString(record, ["enrollment_status", "managed_status", "device_status"]);
  if (status === null) return null;
  if (!/^\d+$/.test(status)) return status;
  return MANAGED_STATUS_LABELS[status] ?? null;
}

/** ManageEngine reports platform as a code; 2 is Android on the MDM API. */
function platformLabel(record: RawRecord): { label: string; isAndroid: boolean } {
  const raw = pickString(record, ["platform_type", "platform", "os_name", "device_platform"]);
  if (raw === null) return { isAndroid: false, label: "Unknown platform" };
  const normalized = raw.toLowerCase();
  if (normalized === "2" || normalized.includes("android")) return { isAndroid: true, label: "Android" };
  if (normalized === "1" || normalized.includes("ios")) return { isAndroid: false, label: "iOS" };
  if (normalized === "3" || normalized.includes("windows")) return { isAndroid: false, label: "Windows" };
  return { isAndroid: false, label: raw };
}

/** A last-contact time as ISO, from either an epoch-ms number or an ISO/string field. */
function lastContactIso(record: RawRecord): string | null {
  const ms = pickNumber(record, ["last_contact_time", "last_contact_time_millis", "lastcontacttime"]);
  if (ms !== null && ms > 0) return new Date(ms).toISOString();
  const text = pickString(record, ["last_contact_time_str", "last_seen", "last_contact"]);
  if (text) {
    const parsed = Date.parse(text);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

export type ManageEngineDevice = {
  /** The id every remote-command path is built from: `/api/v1/mdm/devices/{deviceId}/…` */
  deviceId: string;
  name: string;
  model: string | null;
  serialNumber: string | null;
  imei: string | null;
  platformLabel: string;
  isAndroid: boolean;
  osVersion: string | null;
  userName: string | null;
  userEmail: string | null;
  enrollmentStatus: string | null;
  lostMode: boolean;
  lastContactAt: string | null;
};

function normalizeDevice(record: RawRecord): ManageEngineDevice | null {
  const deviceId = pickString(record, ["device_id", "resource_id", "udid", "id"]);
  if (!deviceId) return null;
  const lostMode =
    pickBoolean(record, ["is_lost_mode_enabled", "lost_mode_status", "is_lost_mode", "lostmode"]) ?? false;
  const user = nestedUser(record);
  return {
    deviceId,
    enrollmentStatus: enrollmentLabel(record),
    imei: pickStringOrFirst(record, ["imei", "imei_number", "imei1"]),
    isAndroid: platformLabel(record).isAndroid,
    lastContactAt: lastContactIso(record),
    lostMode,
    model: pickString(record, ["model", "model_name", "device_model", "product_name"]),
    name: pickString(record, ["device_name", "name", "friendly_name"]) ?? deviceId,
    osVersion: pickString(record, ["os_version", "osversion", "product_version"]),
    platformLabel: platformLabel(record).label,
    serialNumber: pickString(record, ["serial_number", "serialnumber", "serial"]),
    userEmail:
      pickString(record, ["email_address", "user_email", "email"]) ??
      (user ? pickString(user, ["user_email", "email_address", "email"]) : null),
    userName:
      pickString(record, ["user_name", "assigned_user", "username", "owner"]) ??
      (user ? pickString(user, ["user_name", "username", "name"]) : null),
  };
}

type ListResponse = RawRecord & {
  devices?: unknown;
  mdm_devices?: unknown;
  mdmdevices?: unknown;
};

function devicesArray(payload: ListResponse): RawRecord[] {
  for (const key of ["devices", "mdm_devices", "mdmdevices"] as const) {
    const value = payload[key];
    if (Array.isArray(value)) return value as RawRecord[];
  }
  return [];
}

/** Every device ManageEngine manages, normalized. */
export async function listManageEngineDevices(
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ManageEngineDevice[]> {
  const payload = await callManageEngine<ListResponse>("/api/v1/mdm/devices", {}, fetchImpl, env);
  return devicesArray(payload)
    .map((record) => normalizeDevice(record))
    .filter((device): device is ManageEngineDevice => device !== null);
}

/** The register entry a ManageEngine device belongs to, by serial then IMEI, or null. */
export function matchManageEngineToRegister(
  device: ManageEngineDevice,
  register: readonly RegisterTablet[],
): RegisterTablet | null {
  const serial = normalizeSerial(device.serialNumber);
  if (serial) {
    const entry = register.find((candidate) => normalizeSerial(candidate.serialNumber) === serial);
    if (entry) return entry;
  }
  const imei = normalizeImei(device.imei);
  if (imei) {
    const entry = register.find((candidate) => {
      const registered = normalizeImei(candidate.imei);
      return registered !== null && imeisMatch(registered, imei);
    });
    if (entry) return entry;
  }
  return null;
}

export type ManageEngineLocation = {
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  locatedAt: string | null;
};

/**
 * A device's last known position, with address where ManageEngine resolved one.
 *
 * Unlike the Android Management API — which reports a position only over a Pub/Sub channel while a
 * tablet is in lost mode — ManageEngine exposes it directly, so the Phoenix console can show where a
 * tablet was last seen on demand.
 */
export async function getManageEngineLocation(
  deviceId: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ManageEngineLocation> {
  const payload = await callManageEngine<RawRecord>(
    `/api/v1/mdm/devices/${encodeURIComponent(deviceId)}/locations_with_address`,
    {},
    fetchImpl,
    env,
  );
  const record = (Array.isArray(payload.locations) ? (payload.locations[0] as RawRecord) : payload) ?? {};
  return {
    address: pickString(record, ["address", "location_address", "formatted_address"]),
    latitude: pickNumber(record, ["latitude", "lat"]),
    locatedAt: lastContactIso(record),
    longitude: pickNumber(record, ["longitude", "lng", "lon"]),
  };
}
