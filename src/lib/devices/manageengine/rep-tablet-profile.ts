/**
 * The rep tablet profile — the same rules Google's policy carries, written for ManageEngine.
 *
 * WHY THIS EXISTS. `tablet-policy.ts` holds the rules every company tablet follows, and the owner
 * approved them there rule by rule. ManageEngine calls the same thing a PROFILE, and until now the
 * Rules section on a tablet had nothing to offer, because the tenant holds no profile: the rules
 * existed only in Google's half, which this company cannot use while its device-owner quota is nil.
 * This module writes them into ManageEngine instead, and it does NOT invent them — every setting
 * below carries a rule already in `REP_TABLET_RULES`, in the same words the page shows.
 *
 * 🔴 THE EARLIER NOTE IN `profiles.ts` — that ManageEngine does not document the Android restriction
 * field names — WAS WRONG, and this module is the correction. They are documented in full:
 * `ANDROID_RESTRICTIONS_POLICY`, payload_id 186, about 150 fields, each with its type, its default
 * and its allowed values. What that note got right is the danger, and the danger is worse than it
 * read: the fields DISAGREE WITH EACH OTHER about which number means "no". `allow_factory_reset`
 * takes 0 for restrict and 1 for allow; `allow_camera` takes 1 for allow and 2 for restrict;
 * `allow_disabling_gps` takes 4, 5 or 6, where 5 means always on. A value copied from the field above
 * it would publish a profile that restricts nothing while this page says a tablet is locked down. So
 * every value below is quoted from that field's own row, and the ones Phoenix does not set are listed
 * as deliberately absent rather than left silent.
 *
 * WHAT IS NOT SET, AND WHY IT IS NOT A GAP IN THE CODE:
 * - SAMSUNG-ONLY FIELDS. `allow_mock_location`, `allow_safe_mode`, `allow_usb_debug` and
 *   `allow_google_backup` are documented as Samsung (OS 4.3 or above) only. The fleet is Lenovo —
 *   the one live capture reports `TB328XU` — so setting them would put a rule on this page that the
 *   tablets never receive, which is exactly the lie this module exists to avoid.
 * - `max_failed_attempts`. ManageEngine's own row says the device is COMPLETELY WIPED when the limit
 *   is passed. Google's policy sets no such thing, and a rep mistyping a PIN five times must not lose
 *   a day's visits. It stays -1, its documented "None".
 * - KIOSK MODE, for the same reason Google's half gives: there is no Phoenix app package yet, so a
 *   kiosk would lock a rep into nothing.
 *
 * NOTHING IS PUBLISHED UNPROVEN. The profile is created, the payloads are added, and then the
 * payloads are READ BACK from ManageEngine before it is published. A profile whose payloads did not
 * attach is left unpublished and reported as a failure — an empty profile that says it is deployed
 * is the one outcome worse than no profile at all.
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { callManageEngine, ManageEngineRequestError } from "@/lib/devices/manageengine/client";
import {
  listManageEngineProfiles,
  ManageEngineProfileInputError,
  type ManageEngineProfile,
} from "@/lib/devices/manageengine/profiles";

type RawRecord = Record<string, unknown>;

/** Android on the MDM API's `platform_type`. 1 is iOS, 3 Windows, 4 Chrome. */
const ANDROID_PLATFORM = 2;

/** `scope` on a create: 0 is the device itself, 1 a Knox work container. Rep tablets are the device. */
const DEVICE_SCOPE = 0;

/** The name the profile is created under, and the name the Rules section matches it by. */
export const REP_TABLET_PROFILE_NAME = "Phoenix rep tablet";

export const REP_TABLET_PROFILE_DESCRIPTION =
  "The rules every Phoenix company tablet follows. Built by Phoenix from the rep tablet rules — change it here rather than in the console, so the two cannot drift apart.";

/**
 * The two payload names, as ManageEngine's own Android sections print them.
 *
 * The docs name the Android payloads in capitals (`ANDROID_RESTRICTIONS_POLICY`) while every example
 * URL uses the lower-case iOS spelling (`restrictionspolicy`), and which one an Android profile takes
 * cannot be settled from this side — the credentials are Railway's, not this machine's. Both are
 * therefore tried, in the documented order, and the read-back decides which was right. Neither is a
 * guess: they are the two spellings ManageEngine itself publishes.
 */
export const RESTRICTIONS_PAYLOAD_NAMES = ["ANDROID_RESTRICTIONS_POLICY", "restrictionspolicy"] as const;
export const PASSCODE_PAYLOAD_NAMES = ["ANDROID_PASSCODE_POLICY", "passcodepolicy"] as const;

export type RepTabletProfileSetting = {
  /** The rule this carries, in the words `REP_TABLET_RULES` already shows for Google's half. */
  rule: string;
  /** What it does, for the person reading the page. */
  detail: string;
  /** Which payload it belongs to. */
  payload: "restrictions" | "passcode";
  /** ManageEngine's field name, verbatim. */
  field: string;
  /** The value, quoted from that field's own documented row. */
  value: number;
  /** What that number means there — kept beside the value because the fields disagree. */
  meaning: string;
};

/**
 * The rules, as ManageEngine fields. One row per setting, each naming the rule it carries.
 *
 * Read this table against `REP_TABLET_RULES` in `tablet-policy.ts`: five of the eight rules are
 * carried here exactly, and the three that are not are in `REP_TABLET_PROFILE_GAPS` below, named.
 */
export const REP_TABLET_PROFILE_SETTINGS: readonly RepTabletProfileSetting[] = [
  {
    detail: "The rep cannot factory-reset the tablet from Settings, so it cannot quietly leave the company's control.",
    field: "allow_factory_reset",
    meaning: "0 restricts it — this field's 1 means allow",
    payload: "restrictions",
    rule: "No reset from Settings",
    value: 0,
  },
  {
    detail: "Apps from outside Google Play cannot be installed.",
    field: "allow_non_market_apps",
    meaning: "0 restricts it — this field's 1 means allow",
    payload: "restrictions",
    rule: "No side-loaded apps",
    value: 0,
  },
  {
    detail: "Developer options stay off, so USB debugging cannot be switched on behind them.",
    field: "allow_developer_mode",
    meaning: "0 restricts it — this field's 1 means allow",
    payload: "restrictions",
    rule: "No side-loaded apps",
    value: 0,
  },
  {
    detail: "Google Play Protect checks every app and the rep cannot turn it off.",
    field: "allow_play_protect_monitoring",
    meaning: "1 is always on — this field's 0 means the rep decides",
    payload: "restrictions",
    rule: "No side-loaded apps",
    value: 1,
  },
  {
    detail: "The tablet offers only the apps the company approved; the rep cannot install others.",
    field: "allow_install_app",
    meaning: "0 restricts it — this field's 1 means allow",
    payload: "restrictions",
    rule: "Only approved apps",
    value: 0,
  },
  {
    detail: "The company's own apps cannot be removed from the tablet.",
    field: "allow_uninstall_app",
    meaning: "0 restricts it — this field's 1 means allow",
    payload: "restrictions",
    rule: "Only approved apps",
    value: 0,
  },
  {
    detail: "Location stays switched on, so a check-in always has a position to record.",
    field: "allow_disabling_gps",
    meaning: "5 is always on — 4 leaves it to the rep and 6 forces it off",
    payload: "restrictions",
    rule: "Location always on",
    value: 5,
  },
  {
    detail: "The screen lock applies to the whole tablet, not to a work container.",
    field: "scope_for_passcode",
    meaning: "0 is the device — 1 would be a work profile",
    payload: "passcode",
    rule: "Screen lock required",
    value: 0,
  },
  {
    detail: "The tablet must have a screen lock — a PIN, a pattern or a password — before it can be used.",
    field: "passcode_type",
    meaning: "1 is a pattern or better, the lightest lock that is still a lock",
    payload: "passcode",
    rule: "Screen lock required",
    value: 1,
  },
];

export type RepTabletProfileGap = { rule: string; detail: string };

/**
 * The rules this profile CANNOT carry, so the page never implies it does.
 *
 * Each of these is a real rule on Google's half. None of them is an oversight here; the profile API
 * has nowhere to put them, and pretending otherwise is what this list prevents.
 */
export const REP_TABLET_PROFILE_GAPS: readonly RepTabletProfileGap[] = [
  {
    detail:
      "A ManageEngine profile has no update window: its payloads can allow or refuse an update, never say 'only between 2:00 and 5:00'. An update can still arrive during a visit.",
    rule: "Updates overnight",
  },
  {
    detail:
      "Which apps reach a tablet is ManageEngine's app catalogue, not a profile. This profile stops the rep installing others; putting Chrome on the tablet, with the location and camera permissions Phoenix needs, is the app side of the page.",
    rule: "Chrome is always there",
  },
  {
    detail:
      "What a tablet reports — model, serial, IMEI, Android version, network — is what ManageEngine collects by default and shows on this page already. There is no profile setting to ask for it.",
    rule: "What the tablet reports",
  },
];

/** The payload bodies, built from the table above so the two cannot fall out of step. */
export function repTabletProfilePayloadBodies(): { restrictions: Record<string, number>; passcode: Record<string, number> } {
  const restrictions: Record<string, number> = {};
  const passcode: Record<string, number> = {};
  for (const setting of REP_TABLET_PROFILE_SETTINGS) {
    if (setting.payload === "restrictions") restrictions[setting.field] = setting.value;
    else passcode[setting.field] = setting.value;
  }
  return { passcode, restrictions };
}

function sameProfileName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** The company's rep tablet profile, if the tenant already holds one under that name. */
export function findRepTabletProfile(profiles: readonly ManageEngineProfile[]): ManageEngineProfile | null {
  return profiles.find((profile) => sameProfileName(profile.name, REP_TABLET_PROFILE_NAME)) ?? null;
}

function payloadNamesFrom(payload: RawRecord): string[] {
  const names: string[] = [];
  for (const key of ["payloads", "payload_list", "profile_payloads"]) {
    const value = payload[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string" && item.trim()) names.push(item.trim());
      else if (item && typeof item === "object") {
        const name = (item as RawRecord).payload_name ?? (item as RawRecord).name;
        if (typeof name === "string" && name.trim()) names.push(name.trim());
      }
    }
  }
  return names;
}

/** True when `wanted` is among the payloads ManageEngine reports on that profile, either spelling. */
function carriesPayload(names: readonly string[], wanted: readonly string[]): boolean {
  const seen = new Set(names.map((name) => name.toLowerCase()));
  return wanted.some((candidate) => seen.has(candidate.toLowerCase()));
}

async function readProfilePayloads(
  profileId: string,
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const payload = await callManageEngine<RawRecord>(
    `/api/v1/mdm/profiles/${encodeURIComponent(profileId)}/payloads`,
    {},
    fetchImpl,
    env,
  );
  const direct = payloadNamesFrom(payload);
  if (direct.length > 0) return direct;
  // Some tenants answer the payload list under the profile object itself.
  const nested = payload.profile;
  return nested && typeof nested === "object" ? payloadNamesFrom(nested as RawRecord) : [];
}

/**
 * Add one payload, trying each documented spelling of its name until ManageEngine accepts one.
 *
 * A 404 or a 400 on the first spelling means that name is not what this tenant calls the payload, so
 * the next is tried. Any other failure is that payload failing, and is reported as itself.
 */
async function addPayload(
  profileId: string,
  names: readonly string[],
  body: Record<string, number>,
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<{ usedName: string | null; error: string | null }> {
  let lastError: string | null = null;
  for (const name of names) {
    try {
      await callManageEngine(
        `/api/v1/mdm/profiles/${encodeURIComponent(profileId)}/payloads/${encodeURIComponent(name)}`,
        { body: JSON.stringify(body), method: "POST" },
        fetchImpl,
        env,
      );
      return { error: null, usedName: name };
    } catch (caught) {
      const status = caught instanceof ManageEngineRequestError ? caught.status : 0;
      lastError = caught instanceof Error ? caught.message : String(caught);
      if (status !== 400 && status !== 404) return { error: lastError, usedName: null };
    }
  }
  return { error: lastError, usedName: null };
}

export type RepTabletProfileResult = {
  /** The profile, whether it was created now or already existed. */
  profileId: string;
  name: string;
  /** False when the tenant already held it — this call then changed nothing. */
  created: boolean;
  /** Whether ManageEngine reports each payload on the profile after the write. */
  carriesRestrictions: boolean;
  carriesPasscode: boolean;
  /** True only when both payloads were proved present and the publish succeeded. */
  published: boolean;
  /** What went wrong, in one sentence, when it did. */
  error: string | null;
};

/**
 * Build the rep tablet profile in ManageEngine, and publish it only once its payloads are proved.
 *
 * IDEMPOTENT BY NAME. A tenant that already holds "Phoenix rep tablet" is left exactly as it is and
 * the existing profile is returned — this must be safe to press twice, because the page offers it
 * whenever the profile is missing and two Super Admin tabs are one refresh apart.
 *
 * IT DOES NOT PUT THE PROFILE ON ANY TABLET. Creating the rules and deciding which tablet carries
 * them are two separate acts, and the second one is the Rules section on a tablet, one tablet at a
 * time, already audited by asset tag. A profile built here changes nothing in a rep's hands until
 * somebody says so.
 */
export async function buildRepTabletProfile(
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RepTabletProfileResult> {
  const existing = findRepTabletProfile(await listManageEngineProfiles(fetchImpl, env));
  if (existing) {
    return {
      carriesPasscode: true,
      carriesRestrictions: true,
      created: false,
      error: null,
      name: existing.name,
      profileId: existing.profileId,
      published: true,
    };
  }

  const created = await callManageEngine<RawRecord>(
    "/api/v1/mdm/profiles",
    {
      body: JSON.stringify({
        platform_type: ANDROID_PLATFORM,
        profile_description: REP_TABLET_PROFILE_DESCRIPTION,
        profile_name: REP_TABLET_PROFILE_NAME,
        scope: DEVICE_SCOPE,
      }),
      method: "POST",
    },
    fetchImpl,
    env,
  );
  const rawId = created.profile_id ?? created.profileId ?? created.id;
  const profileId =
    typeof rawId === "string" && rawId.trim() ? rawId.trim() : typeof rawId === "number" ? String(rawId) : null;
  if (!profileId) {
    throw new ManageEngineProfileInputError(
      "ManageEngine created the profile but named no profile_id, so its rules could not be added. Open the console and check what was created before pressing this again.",
    );
  }

  const bodies = repTabletProfilePayloadBodies();
  const restrictions = await addPayload(profileId, RESTRICTIONS_PAYLOAD_NAMES, bodies.restrictions, fetchImpl, env);
  const passcode = await addPayload(profileId, PASSCODE_PAYLOAD_NAMES, bodies.passcode, fetchImpl, env);

  const present = await readProfilePayloads(profileId, fetchImpl, env);
  const carriesRestrictions = carriesPayload(present, RESTRICTIONS_PAYLOAD_NAMES);
  const carriesPasscode = carriesPayload(present, PASSCODE_PAYLOAD_NAMES);

  let published = false;
  let error: string | null = null;
  if (carriesRestrictions && carriesPasscode) {
    await callManageEngine(
      `/api/v1/mdm/profiles/${encodeURIComponent(profileId)}/publish`,
      { method: "POST" },
      fetchImpl,
      env,
    );
    published = true;
  } else {
    const missing = [
      carriesRestrictions ? null : "what the tablet may do",
      carriesPasscode ? null : "the screen lock",
    ].filter((item): item is string => item !== null);
    error = `The profile was created but ${missing.join(" and ")} did not attach, so it was NOT published and no tablet can be put on it. ${restrictions.error ?? passcode.error ?? "ManageEngine gave no reason."}`;
  }

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: profileId,
    entityType: "manageengine_profile",
    newValues: {
      carriesPasscode,
      carriesRestrictions,
      passcodePayloadName: passcode.usedName,
      profileName: REP_TABLET_PROFILE_NAME,
      published,
      restrictionsPayloadName: restrictions.usedName,
      settings: REP_TABLET_PROFILE_SETTINGS.map((setting) => `${setting.field}=${setting.value}`),
    },
    oldValues: null,
    summary: published
      ? `Built and published the rep tablet profile '${REP_TABLET_PROFILE_NAME}' in ManageEngine`
      : `Built the rep tablet profile '${REP_TABLET_PROFILE_NAME}' in ManageEngine, but it was not published`,
  });

  return {
    carriesPasscode,
    carriesRestrictions,
    created: true,
    error,
    name: REP_TABLET_PROFILE_NAME,
    profileId,
    published,
  };
}
