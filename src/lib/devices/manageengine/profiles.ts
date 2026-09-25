/**
 * The RULES on a rep tablet — what a tablet is allowed to do — read and changed from Phoenix.
 *
 * WHAT GOOGLE'S HALF DID, AND WHAT THE EQUIVALENT IS HERE. On the Android Management API the rules
 * are a POLICY Phoenix itself writes (`tablet-policy.ts`), pushed to every enrolled tablet, with the
 * page showing which tablets have fallen behind the current version. ManageEngine calls the same
 * thing a PROFILE, and this module drives which tablet carries which of them.
 *
 * 🔴 AN EARLIER VERSION OF THIS COMMENT SAID MANAGEENGINE DOES NOT DOCUMENT THE ANDROID RESTRICTION
 * FIELD NAMES, AND THAT WAS WRONG. They are documented in full — `ANDROID_RESTRICTIONS_POLICY`,
 * payload_id 186 — and `rep-tablet-profile.ts` now builds the company's own profile from them. What
 * that note got right is the danger: the fields disagree about which number means "no", so a value
 * copied from a neighbouring field publishes a profile that restricts nothing while this page says a
 * tablet is locked down. That is why every value there is quoted from its own documented row, and why
 * a profile is never published until its payloads have been read back.
 *
 * WHAT THIS MODULE DOES. Reads the company's Android profiles, reads which of them a tablet is
 * carrying (and whether ManageEngine has actually applied it), and puts one on or takes one off —
 * each write audited by asset tag, because it changes what a tablet in the field permits. BUILDING
 * the rep tablet profile lives next door, in `rep-tablet-profile.ts`; the two are separate because
 * creating the rules and deciding who follows them are separate acts.
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { callManageEngine } from "@/lib/devices/manageengine/client";
import {
  listManageEngineDevices,
  matchManageEngineToRegister,
  type ManageEngineDevice,
} from "@/lib/devices/manageengine/devices";
import { getDeviceRegisterData } from "@/lib/devices/service";

type RawRecord = Record<string, unknown>;

export class ManageEngineProfileInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManageEngineProfileInputError";
  }
}

/** Android on the MDM API's `platform_type`. 1 is iOS, 3 Windows, 4 Chrome. */
const ANDROID_PLATFORM = 2;

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

/**
 * What a profile actually restricts, in the owner's words rather than ManageEngine's key names.
 *
 * `payloads` is the one part of a profile the API does name plainly — a list of the policy kinds it
 * carries. Rendering `restrictionspolicy` on a screen would be a code, which this system never shows;
 * an unmapped name is title-cased instead of hidden, so a payload nobody has mapped yet still reads
 * as words and this map can be extended when a new one is seen.
 */
const PAYLOAD_LABELS: Readonly<Record<string, string>> = {
  appconfigpolicy: "App settings",
  applockpolicy: "Kiosk mode",
  browserpolicy: "Browser",
  certificatepolicy: "Certificates",
  emailpolicy: "Email",
  exchangepolicy: "Exchange mail",
  geofencingpolicy: "Geofencing",
  passcodepolicy: "Screen lock",
  restrictionspolicy: "What the tablet may do",
  vpnpolicy: "VPN",
  wifipolicy: "Wi-Fi",
};

export function profilePayloadLabel(payload: string): string {
  const key = payload.trim().toLowerCase();
  if (PAYLOAD_LABELS[key]) return PAYLOAD_LABELS[key];
  const stripped = key.replace(/policy$/, "").replace(/[_-]+/g, " ").trim();
  if (!stripped) return payload.trim();
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function payloadNames(record: RawRecord): string[] {
  const value = record.payloads;
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object") return pickString(item as RawRecord, ["payload_name", "name", "type"]) ?? "";
      return "";
    })
    .filter((name): name is string => Boolean(name));
}

export type ManageEngineProfile = {
  /** What an association is aimed at, and a React key. Always a string on the wire. */
  profileId: string;
  name: string;
  description: string | null;
  /** The kinds of rules it carries, in words. */
  payloads: string[];
};

export type ManageEngineDeviceProfile = ManageEngineProfile & {
  /** ManageEngine's own word for whether the tablet has taken it — "Applied", "Failed", … */
  status: string | null;
  appliedAt: string | null;
};

/** A ManageEngine timestamp — epoch milliseconds on these endpoints — as ISO, or null. */
function isoTime(record: RawRecord, keys: readonly string[]): string | null {
  const ms = pickNumber(record, keys);
  if (ms !== null && ms > 0) return new Date(ms).toISOString();
  const text = pickString(record, keys);
  if (text) {
    const parsed = Date.parse(text);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

function normalizeProfile(record: RawRecord): ManageEngineProfile | null {
  const profileId = pickString(record, ["profile_id", "profileid", "id"]);
  if (!profileId) return null;
  return {
    description: pickString(record, ["profile_description", "description"]),
    name: pickString(record, ["profile_name", "name"]) ?? profileId,
    payloads: payloadNames(record).map(profilePayloadLabel),
    profileId,
  };
}

function isAndroidProfile(record: RawRecord): boolean {
  const platform = pickNumber(record, ["platform_type", "platform"]);
  if (platform !== null) return platform === ANDROID_PLATFORM;
  const text = pickString(record, ["platform_type", "platform", "platform_name"]);
  return text !== null && text.toLowerCase().includes("android");
}

function profilesArray(payload: RawRecord): RawRecord[] {
  for (const key of ["profiles", "profile_list", "mdm_profiles"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value as RawRecord[];
  }
  return [];
}

/**
 * The company's own Android profiles — the rule sets a rep tablet can be put on.
 *
 * Android only: a tablet cannot carry an iOS profile, and offering one on the tablet's own screen
 * would be an action that can only fail.
 */
export async function listManageEngineProfiles(
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ManageEngineProfile[]> {
  const payload = await callManageEngine<RawRecord>("/api/v1/mdm/profiles", {}, fetchImpl, env);
  return profilesArray(payload)
    .filter((record) => isAndroidProfile(record))
    .map((record) => normalizeProfile(record))
    .filter((profile): profile is ManageEngineProfile => profile !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** The profiles one tablet is carrying, with ManageEngine's own word on whether it took them. */
export async function getManageEngineDeviceProfiles(
  deviceId: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ManageEngineDeviceProfile[]> {
  const payload = await callManageEngine<RawRecord>(
    `/api/v1/mdm/devices/${encodeURIComponent(deviceId)}/profiles`,
    {},
    fetchImpl,
    env,
  );
  return profilesArray(payload)
    .map((record) => {
      const profile = normalizeProfile(record);
      if (!profile) return null;
      return {
        ...profile,
        appliedAt: isoTime(record, ["applied_time", "association_time", "last_modified_time"]),
        status: pickString(record, ["status", "profile_status", "association_status"]),
      } satisfies ManageEngineDeviceProfile;
    })
    .filter((profile): profile is ManageEngineDeviceProfile => profile !== null);
}

/**
 * What the Rules section shows for one tablet: what it carries, and what else it could be put on.
 *
 * One read of the company's profiles and one of the tablet's, so a profile already on the tablet is
 * never offered again as something to add.
 */
export type ManageEngineProfileState = {
  applied: ManageEngineDeviceProfile[];
  available: ManageEngineProfile[];
  /** The company's profile list could not be read; what the tablet carries still shows. */
  catalogueError: boolean;
};

export async function getManageEngineProfileState(
  deviceId: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ManageEngineProfileState> {
  const [applied, catalogue] = await Promise.all([
    getManageEngineDeviceProfiles(deviceId, fetchImpl, env),
    listManageEngineProfiles(fetchImpl, env).catch(() => null),
  ]);
  const carried = new Set(applied.map((profile) => profile.profileId));
  return {
    applied,
    available: (catalogue ?? []).filter((profile) => !carried.has(profile.profileId)),
    catalogueError: catalogue === null,
  };
}

export type ManageEngineProfileChange = { assetTag: string | null; message: string };

/**
 * Put a profile on a tablet, or take one off.
 *
 * 🔴 EITHER WAY THIS CHANGES WHAT A TABLET IN A REP'S HANDS IS ALLOWED TO DO. The tablet is resolved
 * from the live fleet first, so the change cannot land on one that is gone and the audit row names
 * the real tablet by its custody asset tag; the profile is resolved from the company's own list, so
 * an id that is not one of ours is refused before anything is sent.
 *
 * ManageEngine answers both calls `204 No Content`: taking the profile is a queued instruction, and
 * whether the tablet has taken it is what the applied status says on the next read — which is why
 * the message below says it is on its way, never that it is done.
 */
export async function changeManageEngineProfile(
  input: { deviceId: string; profileId: string; action: "associate" | "disassociate" },
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ManageEngineProfileChange> {
  const deviceId = input.deviceId.trim();
  if (!deviceId) throw new ManageEngineProfileInputError("Say which tablet to change.");
  const profileId = input.profileId.trim();
  if (!profileId) throw new ManageEngineProfileInputError("Say which rules to put on the tablet.");
  if (input.action !== "associate" && input.action !== "disassociate") {
    throw new ManageEngineProfileInputError("Unknown change — expected putting rules on a tablet or taking them off.");
  }

  const [devices, profiles, register] = await Promise.all([
    listManageEngineDevices(fetchImpl, env),
    listManageEngineProfiles(fetchImpl, env),
    getDeviceRegisterData().catch(() => ({ devices: [] as Awaited<ReturnType<typeof getDeviceRegisterData>>["devices"] })),
  ]);

  const device: ManageEngineDevice | undefined = devices.find((candidate) => candidate.deviceId === deviceId);
  if (!device) {
    throw new ManageEngineProfileInputError(
      "That tablet is not in the ManageEngine fleet any more. Reload the page and try again from its row.",
    );
  }
  const profile = profiles.find((candidate) => candidate.profileId === profileId);
  if (!profile) {
    throw new ManageEngineProfileInputError(
      "Those rules are not one of the company's Android profiles. Reload the page and pick one from the list.",
    );
  }

  const assetTag = matchManageEngineToRegister(device, register.devices)?.assetTag ?? null;
  const subject = assetTag ?? device.name;

  await callManageEngine(
    `/api/v1/mdm/devices/${encodeURIComponent(deviceId)}/profiles`,
    {
      body: JSON.stringify({ profile_ids: [Number.isFinite(Number(profileId)) ? Number(profileId) : profileId] }),
      method: input.action === "associate" ? "POST" : "DELETE",
    },
    fetchImpl,
    env,
  );

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: deviceId,
    entityType: "manageengine_device_profile",
    newValues: { action: input.action, assetTag, deviceName: device.name, profileName: profile.name },
    oldValues: null,
    summary:
      input.action === "associate"
        ? `Put the rules "${profile.name}" on ${subject}`
        : `Took the rules "${profile.name}" off ${subject}`,
  });

  return {
    assetTag,
    message:
      input.action === "associate"
        ? `"${profile.name}" is on its way to ${subject}. It applies when the tablet next reports in.`
        : `"${profile.name}" is being taken off ${subject}. It clears when the tablet next reports in.`,
  };
}
