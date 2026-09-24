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
 * is kept so a value that does not map is visible in one place. 🔴 The exact spellings are confirmed
 * against a live response before this ships — the candidate lists are the documented shape, not a
 * guarantee of this tenant's.
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
  const lostRaw = pickString(record, ["lost_mode_status", "is_lost_mode", "lostmode"]);
  const lostMode = lostRaw !== null && ["1", "true", "enabled", "on", "yes"].includes(lostRaw.toLowerCase());
  return {
    deviceId,
    enrollmentStatus: pickString(record, ["enrollment_status", "managed_status", "device_status"]),
    imei: pickString(record, ["imei", "imei_number", "imei1"]),
    isAndroid: platformLabel(record).isAndroid,
    lastContactAt: lastContactIso(record),
    lostMode,
    model: pickString(record, ["model", "model_name", "device_model"]),
    name: pickString(record, ["device_name", "name", "friendly_name"]) ?? deviceId,
    osVersion: pickString(record, ["os_version", "osversion", "product_version"]),
    platformLabel: platformLabel(record).label,
    serialNumber: pickString(record, ["serial_number", "serialnumber", "serial"]),
    userEmail: pickString(record, ["email_address", "user_email", "email"]),
    userName: pickString(record, ["user_name", "assigned_user", "username", "owner"]),
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
