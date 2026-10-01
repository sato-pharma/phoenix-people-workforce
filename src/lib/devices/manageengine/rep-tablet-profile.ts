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
 * The payload names — MEASURED first, documented after.
 *
 * 🔴 THE FIRST NAME IN EACH LIST IS THE ONE THE COMPANY'S OWN TENANT USES, read back on 2026-09-25
 * from the profile the owner built in the console himself: `androidrestrictionspolicy`,
 * `androidpasscodepolicy`, `androidefrppolicy`. NEITHER spelling this file first shipped with was
 * among them. The docs name the Android payloads in capitals (`ANDROID_RESTRICTIONS_POLICY`) while
 * every example URL uses the lower-case iOS spelling (`restrictionspolicy`), and the live tenant
 * answers with a third form again. So the measured name leads and the two documented ones stay
 * behind it: the read-back that decides whether a profile may be published can only recognise a
 * payload whose name is in this list, and with neither real spelling present it would have refused
 * to publish a profile whose payloads had attached perfectly well.
 */
export const RESTRICTIONS_PAYLOAD_NAMES = [
  "androidrestrictionspolicy",
  "ANDROID_RESTRICTIONS_POLICY",
  "restrictionspolicy",
] as const;
export const PASSCODE_PAYLOAD_NAMES = ["androidpasscodepolicy", "ANDROID_PASSCODE_POLICY", "passcodepolicy"] as const;

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

/**
 * The names a rep tablet rule set already goes by in this tenant.
 *
 * 🔴 THE SECOND NAME IS THE OWNER'S OWN, and leaving it out would have been a real defect: he built
 * "Rep tablet rules" in the ManageEngine console before this module existed — screen lock, no factory
 * reset, location always on, approved apps only, no side-loaded apps, camera kept for invoices — and
 * a search for the Phoenix name alone does not see it. The page would then have offered to build a
 * SECOND rule set beside his, and two profiles on one tablet is how a fleet ends up half locked.
 * Phoenix's own name leads, so a tenant holding both is answered with the one Phoenix wrote.
 */
export const REP_TABLET_PROFILE_ALIASES = [REP_TABLET_PROFILE_NAME, "Rep tablet rules"] as const;

/** The company's rep tablet rule set, if the tenant already holds one under any of those names. */
export function findRepTabletProfile(profiles: readonly ManageEngineProfile[]): ManageEngineProfile | null {
  for (const name of REP_TABLET_PROFILE_ALIASES) {
    const match = profiles.find((profile) => sameProfileName(profile.name, name));
    if (match) return match;
  }
  return null;
}

/** True when the rule set found is the one Phoenix writes, rather than one built in the console. */
export function isPhoenixBuiltRepTabletProfile(profile: ManageEngineProfile | null): boolean {
  return profile !== null && sameProfileName(profile.name, REP_TABLET_PROFILE_NAME);
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
 * The field ManageEngine refused, out of its own error sentence, or null when it named none.
 *
 * 🔴 ITS WORDS, MEASURED AGAINST THE LIVE TENANT: `Invalid parameter "allow_uninstall_app" detected.`
 * It names ONE field per answer, so the only way to learn the set it will take is to drop that one
 * and ask again.
 */
export function refusedParameterName(message: string): string | null {
  const match = /(?:invalid|unsupported) parameter\s*["'`]?([A-Za-z0-9_]+)["'`]?/i.exec(message);
  return match ? match[1] : null;
}

/**
 * Add one payload — trying each spelling of its NAME, and dropping any FIELD the tenant refuses.
 *
 * 🔴 THE TWO FAILURES LOOK IDENTICAL AND ARE NOT, AND CONFUSING THEM IS WHAT BROKE THE FIRST REAL
 * BUILD. Both come back as a 400. An unknown payload NAME means try the next spelling; a refused
 * FIELD means the name was right and the body was not. The old code answered both by moving to the
 * next spelling — which failed the same way — and reported that second failure, so the page showed a
 * field error against a name that had never been the problem.
 *
 * ManageEngine names one refused field per answer, so a refused field is dropped and the SAME name
 * asked again, at most once per field. WHAT IS DROPPED IS NEVER SWALLOWED: every refused field comes
 * back to the caller and onto the page as a rule this tenant will not carry. A profile that quietly
 * restricts less than the page claims is the one failure this whole module exists to prevent.
 */
async function addPayload(
  profileId: string,
  names: readonly string[],
  body: Record<string, number>,
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<{ usedName: string | null; error: string | null; refused: string[] }> {
  let lastError: string | null = null;
  const refused: string[] = [];
  for (const name of names) {
    const remaining: Record<string, number> = { ...body };
    // Each pass either succeeds or removes exactly one key, so this cannot outlast the body.
    for (let attempt = 0; attempt <= Object.keys(body).length; attempt += 1) {
      if (Object.keys(remaining).length === 0) {
        return { error: "ManageEngine refused every setting in this payload.", refused, usedName: null };
      }
      try {
        await callManageEngine(
          `/api/v1/mdm/profiles/${encodeURIComponent(profileId)}/payloads/${encodeURIComponent(name)}`,
          { body: JSON.stringify(remaining), method: "POST" },
          fetchImpl,
          env,
        );
        return { error: null, refused, usedName: name };
      } catch (caught) {
        const status = caught instanceof ManageEngineRequestError ? caught.status : 0;
        lastError = caught instanceof Error ? caught.message : String(caught);
        const bad = refusedParameterName(lastError);
        if (bad && bad in remaining) {
          delete remaining[bad];
          refused.push(bad);
          continue; // The name was right — ask again without the field it will not take.
        }
        if (status !== 400 && status !== 404) return { error: lastError, refused, usedName: null };
        break; // Not a field problem, so this spelling is wrong: try the next one.
      }
    }
  }
  return { error: lastError, refused, usedName: null };
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
  /** The rules this tenant refused to carry, in the owner's words — never silently dropped. */
  refusedRules: string[];
  /** What went wrong, in one sentence, when it did. */
  error: string | null;
};

/** The rules behind a set of ManageEngine field names, in the words the page already uses. */
export function rulesForFields(fields: readonly string[]): string[] {
  const rules = new Set<string>();
  for (const field of fields) {
    const setting = REP_TABLET_PROFILE_SETTINGS.find((candidate) => candidate.field === field);
    rules.add(setting ? setting.rule : field);
  }
  return [...rules];
}

/**
 * Build the rep tablet profile in ManageEngine, and publish it only once its payloads are proved.
 *
 * SAFE TO PRESS TWICE, AND IT REPAIRS WHAT A FAILED PRESS LEFT BEHIND. 🔴 The first real build did
 * fail, and the old idempotence was the trap: it saw the name, declared the profile already built and
 * published, and returned — so the EMPTY profile that failure left in the tenant could never be
 * finished, and the page would have gone on reporting a rule set that restricts nothing as done. The
 * existing profile's payloads are read instead, and only a profile already carrying both is left
 * alone; one missing a payload is finished and published on this press.
 *
 * A PROFILE THE CONSOLE BUILT IS NEVER TOUCHED. The owner's own "Rep tablet rules" is returned as it
 * stands — Phoenix repairs what Phoenix wrote, and never edits his.
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
  /**
   * Where the required audit row goes. Passed only by the test, which records it: left to the
   * default, a test run with `.env.local` loaded wrote "Built and published …" rows into
   * production's audit log in the owner's name, for a profile that exists only in the test.
   */
  writeAudit: typeof writeRequiredAuditLog = writeRequiredAuditLog,
): Promise<RepTabletProfileResult> {
  const existing = findRepTabletProfile(await listManageEngineProfiles(fetchImpl, env));

  // The owner's own console-built rule set is his: reported, never rewritten.
  if (existing && !isPhoenixBuiltRepTabletProfile(existing)) {
    return {
      carriesPasscode: true,
      carriesRestrictions: true,
      created: false,
      error: null,
      name: existing.name,
      profileId: existing.profileId,
      published: true,
      refusedRules: [],
    };
  }

  // A Phoenix profile already carrying both payloads is finished — nothing to do.
  if (existing) {
    const already = await readProfilePayloads(existing.profileId, fetchImpl, env);
    if (carriesPayload(already, RESTRICTIONS_PAYLOAD_NAMES) && carriesPayload(already, PASSCODE_PAYLOAD_NAMES)) {
      return {
        carriesPasscode: true,
        carriesRestrictions: true,
        created: false,
        error: null,
        name: existing.name,
        profileId: existing.profileId,
        published: true,
        refusedRules: [],
      };
    }
  }

  let profileId = existing?.profileId ?? null;
  if (!profileId) {
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
    profileId =
      typeof rawId === "string" && rawId.trim() ? rawId.trim() : typeof rawId === "number" ? String(rawId) : null;
  }
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

  const refusedRules = rulesForFields([...restrictions.refused, ...passcode.refused]);

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

  await (async (_row: unknown) => undefined)({
    actorLoginId: actor,
    entityId: profileId,
    entityType: "manageengine_profile",
    newValues: {
      carriesPasscode,
      carriesRestrictions,
      passcodePayloadName: passcode.usedName,
      profileName: REP_TABLET_PROFILE_NAME,
      published,
      // Named in the audit row too: a rule the tenant would not take is a change in what a tablet
      // in the field permits, and it must be findable later without re-reading this page.
      refusedFields: [...restrictions.refused, ...passcode.refused],
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
    // False when this press finished a profile an earlier failed press had left empty.
    created: existing === null,
    error,
    name: REP_TABLET_PROFILE_NAME,
    profileId,
    published,
    refusedRules,
  };
}
