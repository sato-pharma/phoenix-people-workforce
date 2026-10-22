import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  getManageEngineAccessToken,
  isManageEngineConfigured,
  ManageEngineAuthThrottledError,
  ManageEngineNotConfiguredError,
  resetManageEngineTokenCache,
} from "../src/lib/devices/manageengine/auth.ts";
import {
  callManageEngine,
  ManageEngineRequestError,
} from "../src/lib/devices/manageengine/client.ts";
import {
  assertUploadableApk,
  getManageEngineDeviceApps,
  installManageEngineApp,
  isMissingEndpointStatus,
  MAX_APP_UPLOAD_BYTES,
  ManageEngineAppInputError,
  manageEngineAppCreateBody,
  manageEngineFileId,
  removeManageEngineApp,
} from "../src/lib/devices/manageengine/apps.ts";
import {
  batteryPercent,
  getManageEngineCommandHistory,
  getManageEngineDeviceDetail,
  humanizeKey,
  normalizeDeviceDetail,
  storageUsedPercent,
} from "../src/lib/devices/manageengine/detail.ts";
import {
  getManageEngineLocation,
  listManageEngineDevices,
  matchManageEngineToRegister,
  requestManageEngineLocation,
  type ManageEngineDevice,
} from "../src/lib/devices/manageengine/devices.ts";
import {
  isManageEngineCommandId,
  MANAGEENGINE_COMMANDS,
  ManageEngineCommandInputError,
} from "../src/lib/devices/manageengine/commands.ts";
import { manageEngineErrorResponse } from "../src/lib/devices/manageengine/http.ts";
import {
  ManageEngineEnrollmentInputError,
  parseManageEngineEnrollmentTemplate,
} from "../src/lib/devices/manageengine/enrollment.ts";
import {
  changeManageEngineProfile,
  getManageEngineProfileState,
  listManageEngineProfiles,
  ManageEngineProfileInputError,
  profileAssociationBody,
  profilePayloadLabel,
} from "../src/lib/devices/manageengine/profiles.ts";
import {
  buildRepTabletProfile,
  findRepTabletProfile,
  isPhoenixBuiltRepTabletProfile,
  PASSCODE_PAYLOAD_NAMES,
  REP_TABLET_PROFILE_ALIASES,
  REP_TABLET_PROFILE_GAPS,
  REP_TABLET_PROFILE_NAME,
  REP_TABLET_PROFILE_SETTINGS,
  refusedParameterName,
  repTabletProfilePayloadBodies,
  rulesForFields,
} from "../src/lib/devices/manageengine/rep-tablet-profile.ts";
import {
  manageEngineImeisToRecord,
  manageEngineTabletsToRegister,
} from "../src/lib/devices/manageengine/register-sync.ts";
import { REP_TABLET_RULES } from "../src/lib/devices/tablet-policy.ts";
import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";
import { stripComments } from "./support/comment-strip.ts";
import type { AuditLogInput } from "../src/lib/admin/audit.ts";
import type { RegisterTablet } from "../src/lib/devices/managed-tablets.ts";

/** Full env so `manageEngineAuthConfig` is satisfied — the three secrets plus the two hosts. */
const ENV = {
  MANAGEENGINE_MDM_CLIENT_ID: "1000.CLIENTID",
  MANAGEENGINE_MDM_CLIENT_SECRET: "clientsecret",
  MANAGEENGINE_MDM_REFRESH_TOKEN: "1000.REFRESH.TOKEN",
  MANAGEENGINE_MDM_ACCOUNTS_BASE: "https://accounts.zoho.com",
  MANAGEENGINE_MDM_API_BASE: "https://mdm.manageengine.com",
} as unknown as NodeJS.ProcessEnv;

type StubResponse = { status: number; body: unknown };

/**
 * A `fetch` stand-in that routes the Zoho token exchange and the MDM API apart by URL, records every
 * call, and answers each from a per-endpoint queue (last entry repeats). No network, no DB.
 */
function makeFetch(config: {
  token?: StubResponse[];
  api?: StubResponse[];
}): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const tokenQueue = [...(config.token ?? [{ status: 200, body: { access_token: "tok-1", expires_in: 3600 } }])];
  const apiQueue = [...(config.api ?? [])];

  function next(queue: StubResponse[], label: string): StubResponse {
    if (queue.length === 0) throw new Error(`stub fetch ran out of ${label} responses`);
    return queue.length === 1 ? queue[0] : queue.shift()!;
  }

  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ init, url });
    const picked = url.includes("/oauth/v2/token") ? next(tokenQueue, "token") : next(apiQueue, "api");
    return {
      json: async () => picked.body,
      ok: picked.status >= 200 && picked.status < 300,
      status: picked.status,
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return { calls, fetch: fetchImpl };
}

function register(overrides: Partial<RegisterTablet>): RegisterTablet {
  return {
    assetTag: "PHX-TAB-0001",
    category: "tablet",
    holderJobTitle: null,
    holderName: null,
    id: "reg-1",
    imei: null,
    manufacturer: null,
    model: null,
    serialNumber: null,
    status: "assigned",
    ...overrides,
  };
}

function runAuthTests() {
  resetManageEngineTokenCache();

  // Missing secrets → a NotConfigured error, and the configured probe reads false.
  assert.equal(isManageEngineConfigured({} as NodeJS.ProcessEnv), false, "no secrets means not configured");
  assert.equal(isManageEngineConfigured(ENV), true, "all three secrets means configured");

  // A Zoho `error` in the body is surfaced as NotConfigured, not a silent network-shaped failure.
  return (async () => {
    resetManageEngineTokenCache();
    const errored = makeFetch({ token: [{ status: 200, body: { error: "invalid_code" } }] });
    await assert.rejects(
      () => getManageEngineAccessToken(errored.fetch, ENV),
      (error: unknown) =>
        error instanceof ManageEngineNotConfiguredError && /invalid_code/.test((error as Error).message),
      "a Zoho error body becomes a NotConfigured error naming the code",
    );

    // Missing env → NotConfigured before any fetch.
    resetManageEngineTokenCache();
    const unused = makeFetch({});
    await assert.rejects(
      () => getManageEngineAccessToken(unused.fetch, {} as NodeJS.ProcessEnv),
      ManageEngineNotConfiguredError,
      "no secrets throws before minting",
    );
    assert.equal(unused.calls.length, 0, "a missing credential never calls Zoho");

    // A good exchange mints, caches, and does not re-call Zoho on the next ask.
    resetManageEngineTokenCache();
    const ok = makeFetch({ token: [{ status: 200, body: { access_token: "tok-abc", expires_in: 3600 } }] });
    assert.equal(await getManageEngineAccessToken(ok.fetch, ENV), "tok-abc", "the access token is returned");
    assert.equal(await getManageEngineAccessToken(ok.fetch, ENV), "tok-abc", "the second ask is served from cache");
    assert.equal(ok.calls.length, 1, "the cached token is reused — Zoho is called once");

    // Concurrent asks on a cold cache share ONE in-flight mint — the four cards that load together
    // must not each hit Zoho, which is what tripped its rate limit and showed "Access Denied".
    resetManageEngineTokenCache();
    const shared = makeFetch({ token: [{ status: 200, body: { access_token: "tok-shared", expires_in: 3600 } }] });
    const [first, second] = await Promise.all([
      getManageEngineAccessToken(shared.fetch, ENV),
      getManageEngineAccessToken(shared.fetch, ENV),
    ]);
    assert.equal(first, "tok-shared");
    assert.equal(second, "tok-shared");
    assert.equal(
      shared.calls.filter((call) => call.url.includes("/oauth/v2/token")).length,
      1,
      "two concurrent asks mint once, not twice",
    );

    // Zoho's throttle ("Access Denied") is transient, not a dead credential: a ThrottledError whose
    // message never tells the owner to re-generate the Self Client.
    resetManageEngineTokenCache();
    const throttled = makeFetch({ token: [{ status: 200, body: { error: "Access Denied" } }] });
    await assert.rejects(
      () => getManageEngineAccessToken(throttled.fetch, ENV),
      (error: unknown) =>
        error instanceof ManageEngineAuthThrottledError &&
        /rate-limited/i.test((error as Error).message) &&
        !/re-generate/i.test((error as Error).message),
      "Access Denied is surfaced as a transient throttle, never as a credential to re-generate",
    );
  })();
}

async function runClientTests() {
  // A 401 clears the token cache and retries once with a fresh token, then succeeds.
  resetManageEngineTokenCache();
  const retry = makeFetch({
    token: [
      { status: 200, body: { access_token: "tok-old", expires_in: 3600 } },
      { status: 200, body: { access_token: "tok-new", expires_in: 3600 } },
    ],
    api: [
      { status: 401, body: { error_description: "expired token" } },
      { status: 200, body: { ok: true } },
    ],
  });
  const body = await callManageEngine<{ ok: boolean }>("/api/v1/mdm/devices", {}, retry.fetch, ENV);
  assert.deepEqual(body, { ok: true }, "the retry after a 401 returns the good body");
  const apiCalls = retry.calls.filter((call) => !call.url.includes("/oauth/v2/token"));
  assert.equal(apiCalls.length, 2, "a 401 is retried exactly once");
  assert.equal(
    apiCalls[0].url,
    "https://mdm.manageengine.com/api/v1/mdm/devices",
    "the API base and path are joined without a trailing slash",
  );
  assert.equal(
    (apiCalls[1].init.headers as Record<string, string>).authorization,
    "Zoho-oauthtoken tok-new",
    "the retry carries the freshly minted token",
  );

  // A non-401 failure throws a ManageEngineRequestError carrying the status and ManageEngine's reason.
  resetManageEngineTokenCache();
  const failed = makeFetch({ api: [{ status: 404, body: { message: "no such device" } }] });
  await assert.rejects(
    () => callManageEngine("/api/v1/mdm/devices/x", {}, failed.fetch, ENV),
    (error: unknown) =>
      error instanceof ManageEngineRequestError &&
      error.status === 404 &&
      /no such device/.test((error as Error).message),
    "a 404 becomes a request error with the status and message",
  );
}

async function runDeviceTests() {
  // Normalization across the documented key spellings, and a record with no id is dropped.
  resetManageEngineTokenCache();
  const listing = makeFetch({
    api: [
      {
        status: 200,
        body: {
          devices: [
            {
              device_id: "111",
              device_name: "Rep A tablet",
              model: "SM-X200",
              serial_number: "R52W1234ABC",
              imei: "356789012345678",
              platform_type: "2",
              os_version: "14",
              user_name: "Rep A",
              email_address: "repa@example.com",
              enrollment_status: "Managed",
              lost_mode_status: "1",
              last_contact_time: 1_700_000_000_000,
            },
            { device_name: "orphan with no id" },
          ],
        },
      },
    ],
  });
  const devices = await listManageEngineDevices(listing.fetch, ENV);
  assert.equal(devices.length, 1, "a record with no device id cannot be commanded, so it is dropped");
  const [device] = devices;
  assert.equal(device.deviceId, "111");
  assert.equal(device.serialNumber, "R52W1234ABC");
  assert.equal(device.imei, "356789012345678");
  assert.equal(device.isAndroid, true, "platform code 2 is Android");
  assert.equal(device.lostMode, true, "lost_mode_status 1 reads as lost mode on");
  assert.equal(device.lastContactAt, new Date(1_700_000_000_000).toISOString(), "epoch-ms last contact becomes ISO");
  assert.equal(device.enrollmentStatus, "Managed", "a status ManageEngine already sends as a word passes through unchanged");

  // The live tenant shape (confirmed 2026-09-24): imei is an ARRAY, is_lost_mode_enabled is a real
  // BOOLEAN, and the holder is a NESTED user object — a flat string read misses all three.
  resetManageEngineTokenCache();
  const liveShape = makeFetch({
    api: [
      {
        status: 200,
        body: {
          devices: [
            {
              device_id: "243158000000130009",
              device_name: "it.satopharma_TB328XU",
              product_name: "TB328XU",
              serial_number: "HA251XLS",
              imei: ["865569071549107"],
              platform_type: "android",
              os_version: "12",
              managed_status: "2",
              is_lost_mode_enabled: false,
              last_contact_time: "1700000000000",
              user: { user_name: "IT Satopharma", user_email: "it.satopharma@gmail.com", user_id: "9" },
            },
          ],
        },
      },
    ],
  });
  const [live] = await listManageEngineDevices(liveShape.fetch, ENV);
  assert.equal(live.imei, "865569071549107", "an imei array is read as its first element");
  assert.equal(live.lostMode, false, "a boolean is_lost_mode_enabled=false reads as lost mode off");
  assert.equal(live.userName, "IT Satopharma", "the holder name is read from the nested user object");
  assert.equal(live.userEmail, "it.satopharma@gmail.com", "the holder email is read from the nested user object");
  assert.equal(live.model, "TB328XU", "product_name is accepted as the model");
  assert.equal(live.isAndroid, true, "platform_type 'android' reads as Android");
  assert.equal(live.enrollmentStatus, "Managed", "the bare managed_status code '2' is shown as the word Managed, never the number");
  assert.equal(
    matchManageEngineToRegister(live, [register({ assetTag: "PHX-TAB-0002", imei: "865569071549107" })])?.assetTag,
    "PHX-TAB-0002",
    "the array-sourced imei still matches the register",
  );

  // Enrolment status never leaks a bare code: a removed device reads "Removed" (from is_removed),
  // and an unmapped numeric managed_status shows no badge rather than a number we cannot name.
  resetManageEngineTokenCache();
  const statuses = makeFetch({
    api: [
      {
        status: 200,
        body: {
          devices: [
            { device_id: "r1", managed_status: "3", is_removed: true },
            { device_id: "r2", managed_status: "99" },
          ],
        },
      },
    ],
  });
  const [removed, unknown] = await listManageEngineDevices(statuses.fetch, ENV);
  assert.equal(removed.enrollmentStatus, "Removed", "is_removed reads as Removed regardless of the code");
  assert.equal(unknown.enrollmentStatus, null, "an unmapped numeric status is hidden, never shown as the raw code");

  // Register matching: serial first, then IMEI, both on digits/case-insensitively.
  const bySerial: ManageEngineDevice = { ...device, imei: null };
  assert.equal(
    matchManageEngineToRegister(bySerial, [register({ serialNumber: "r52w-1234-abc" })])?.assetTag,
    "PHX-TAB-0001",
    "a device matches its register entry by serial, ignoring case and separators",
  );
  const byImei: ManageEngineDevice = { ...device, serialNumber: null };
  assert.equal(
    matchManageEngineToRegister(byImei, [register({ assetTag: "PHX-TAB-0002", imei: "35678901234567" })])?.assetTag,
    "PHX-TAB-0002",
    "with no serial it falls back to the IMEI match",
  );
  assert.equal(
    matchManageEngineToRegister(device, [register({ serialNumber: "OTHER", imei: "000000000000000" })]),
    null,
    "no serial or IMEI match returns null (the tablet shows as unregistered)",
  );

  // Location: the address list form is unwrapped, and lat/lng/address are read.
  resetManageEngineTokenCache();
  const located = makeFetch({
    api: [
      {
        status: 200,
        body: {
          locations: [
            { latitude: 30.05, longitude: 31.25, address: "Cairo", last_contact_time: 1_700_000_000_000 },
          ],
        },
      },
    ],
  });
  const location = await getManageEngineLocation("111", located.fetch, ENV);
  assert.equal(location.latitude, 30.05);
  assert.equal(location.longitude, 31.25);
  assert.equal(location.address, "Cairo");
  assert.equal(location.locatedAt, new Date(1_700_000_000_000).toISOString());
  // The read hits the live `/locations` endpoint, never the async `/locations_with_address` export
  // that answered 400 in production ("Mandatory parameter export_batch_id is not present").
  const locateUrl = located.calls.find((call) => !call.url.includes("/oauth/"))?.url ?? "";
  assert.ok(
    locateUrl.endsWith("/locations"),
    `the position is read from /locations, not ${locateUrl.split("/mdm/devices/")[1] ?? locateUrl}`,
  );
}

function runCommandCatalogTests() {
  // The allow-list is exactly these ids and nothing else.
  const ids = MANAGEENGINE_COMMANDS.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "command ids are unique");
  assert.equal(ids.length, 14, "fourteen remote actions");
  for (const expected of ["SCAN", "RING", "SHUTDOWN", "REMOTE_VIEW", "REMOTE_CONTROL", "PAUSE_KIOSK", "RESUME_KIOSK"]) {
    assert.equal(isManageEngineCommandId(expected), true, `${expected} is in the catalogue`);
  }
  for (const id of ids) assert.equal(isManageEngineCommandId(id), true, `${id} is a known command`);
  assert.equal(isManageEngineCommandId("DELETE_EVERYTHING"), false, "an unknown id is refused");
  assert.equal(isManageEngineCommandId(""), false, "an empty string is refused");
  assert.equal(isManageEngineCommandId(undefined), false, "a missing command is refused");

  // Exactly the two wipes are destructive, and each command names a distinct endpoint segment.
  const destructive = MANAGEENGINE_COMMANDS.filter((entry) => entry.destructive).map((entry) => entry.id);
  assert.deepEqual(destructive.sort(), ["COMPLETE_WIPE", "CORPORATE_WIPE"], "only the two wipes are destructive");
  const actions = MANAGEENGINE_COMMANDS.map((entry) => entry.action);
  assert.equal(new Set(actions).size, actions.length, "each command maps to a distinct action segment");
  for (const entry of MANAGEENGINE_COMMANDS) {
    assert.ok(/^[a-z_]+$/.test(entry.action), `${entry.id} action is a bare endpoint segment`);
    assert.ok(entry.pastTense.length > 0, `${entry.id} has audit past-tense text`);
  }
}

/**
 * The deep read of one tablet: the promoted headline, the humanising of keys and values, and the
 * rule that identifiers never reach the screen.
 */
async function runDeviceDetailTests() {
  assert.equal(humanizeKey("battery_level"), "Battery level", "a key becomes a sentence");
  assert.equal(humanizeKey("os_version"), "OS version", "an acronym stays an acronym");
  assert.equal(humanizeKey("wifi_mac"), "Wi-Fi MAC", "two acronyms in one key");

  assert.equal(batteryPercent(0.84), 84, "a fraction reads as a percentage");
  assert.equal(batteryPercent(84), 84, "a percentage reads as itself");
  assert.equal(batteryPercent(-1), null, "ManageEngine's not-known reads as nothing");
  assert.equal(batteryPercent("0.5"), 50, "a numeric string is read too");

  assert.equal(
    storageUsedPercent({ total_device_space: 64_000, used_device_space: 16_000 }),
    25,
    "used against total is a unit-free percentage",
  );
  assert.equal(
    storageUsedPercent({ available_device_space: 30, used_device_space: 10 }),
    25,
    "used and free stand in for a missing total",
  );
  assert.equal(storageUsedPercent({ used_device_space: 10 }), null, "one number alone says nothing");

  const detail = normalizeDeviceDetail("111", {
    battery_level: 0.42,
    device_id: "111",
    device_name: "it.satopharma_TB328XU",
    last_contact_time: 1_700_000_000_000,
    model: "TB328XU",
    network: { carrier: "Vodafone", is_roaming: false, wifi_ssid: "SATO-HQ" },
    os_version: "13",
    owned_by: "Corporate",
    security: { is_encrypted: true, is_passcode_present: true, is_rooted: false },
    total_device_space: 64_000,
    udid: "should-not-show",
    used_device_space: 16_000,
  });

  const headline = new Map(detail.headline.map((fact) => [fact.label, fact.value]));
  assert.equal(headline.get("Model"), "TB328XU", "the model is promoted");
  assert.equal(headline.get("Battery"), "42%", "the battery is promoted as a percentage");
  assert.equal(headline.get("Storage used"), "25% of the tablet", "storage is promoted unit-free");
  assert.equal(headline.get("Owned by"), "Corporate", "ownership is promoted");

  const flat = detail.sections.flatMap((section) => section.facts);
  const labels = flat.map((fact) => fact.label);
  assert.ok(!labels.includes("Udid"), "an identifier never reaches the screen");
  assert.ok(
    detail.sections.some((section) => section.title === "Security"),
    "a nested object becomes its own section",
  );
  const security = new Map(
    (detail.sections.find((section) => section.title === "Security")?.facts ?? []).map((fact) => [
      fact.label,
      fact.value,
    ]),
  );
  assert.equal(security.get("Is encrypted"), "Yes", "a boolean reads as Yes");
  assert.equal(security.get("Is rooted"), "No", "a boolean reads as No");
  const network = new Map(
    (detail.sections.find((section) => section.title === "Network")?.facts ?? []).map((fact) => [
      fact.label,
      fact.value,
    ]),
  );
  assert.equal(network.get("Wi-Fi network"), "SATO-HQ", "an ssid is named, not spelled out as a code");

  // An unmapped field still appears — that is the whole point of reading the payload rather than a list.
  const surprise = normalizeDeviceDetail("111", { device_id: "111", warranty_number: "W-9" });
  assert.deepEqual(
    surprise.sections.flatMap((section) => section.facts),
    [{ label: "Warranty number", value: "W-9" }],
    "a field this code has never seen still shows, humanised",
  );

  // The detail read unwraps a `device` envelope, and the history read names commands in words.
  resetManageEngineTokenCache();
  const wrapped = makeFetch({ api: [{ status: 200, body: { device: { model: "TB328XU", device_id: "111" } } }] });
  const fetched = await getManageEngineDeviceDetail("111", wrapped.fetch, ENV);
  assert.equal(fetched.headline[0]?.value, "TB328XU", "a wrapped payload is unwrapped");

  resetManageEngineTokenCache();
  const history = makeFetch({
    api: [
      {
        status: 200,
        body: {
          commands: [
            { added_time: 1_700_000_000_000, command_id: "c1", command_name: "corporate_wipe", command_status: 3 },
            { added_time: 1_700_000_900_000, command_id: "c2", command_name: "lock", command_status: "Sent" },
          ],
        },
      },
    ],
  });
  const commands = await getManageEngineCommandHistory("111", history.fetch, ENV);
  assert.equal(commands.length, 2, "both commands are read");
  assert.equal(commands[0].name, "Locked", "the newest command comes first, named in words");
  assert.equal(commands[1].name, "Removed company data", "an internal command name never reaches the screen");
  assert.equal(commands[0].status, "Sent", "a word status passes through");
  assert.equal(commands[1].status, "Done", "a numeric status is named");

  // The Locate button reads the last position the tablet reported, from `/locations` — a single
  // GET, no async `/locations_with_address` export (which returned 400 on both verbs in production).
  resetManageEngineTokenCache();
  const refreshed = makeFetch({
    api: [
      { status: 200, body: { locations: [{ latitude: 30.1, longitude: 31.3, address: "Giza" }] } },
    ],
  });
  const fresh = await requestManageEngineLocation("111", refreshed.fetch, ENV);
  assert.equal(fresh.latitude, 30.1, "the reported position is read back");
  assert.equal(fresh.longitude, 31.3);
  const apiCalls = refreshed.calls.filter((call) => !call.url.includes("/oauth/"));
  assert.deepEqual(
    apiCalls.map((call) => call.init.method ?? "GET"),
    ["GET"],
    "the position is a single read, not an export request",
  );
  assert.ok(
    (apiCalls[0]?.url ?? "").endsWith("/locations"),
    "the read hits /locations, never the /locations_with_address export",
  );
}

/**
 * The detail panel in the owner's own words — measured against the payload production really sent.
 *
 * Every shape below was read off PHX-TAB-0002 on the live tenant on 25 September 2026, the first time
 * the panel was opened, and every assertion here failed then: epochs printed as thirteen digits,
 * sizes as bare decimals, vendor enums as numbers, ManageEngine's "--" as a value, and the command
 * remarks with their HTML tags showing. AGENTS.md §4: names, never codes.
 */
async function runDeviceDetailPlainWordsTests() {
  const detail = normalizeDeviceDetail("999", {
    added_time: "1790189748534",
    agent_version: "26.09.01",
    available_device_capacity: 46.52,
    device_capacity: 51.17,
    eas_device_identifier: "ba6e95686dc422e1",
    imei: "865569071549107",
    location_settings: { location_radius: 0, tracking_status: 1 },
    managed_status: 2,
    manufacturer: "Lenovo",
    os_name: "S",
    os_version: "12",
    owned_by: "1",
    platform_type: "2",
    privacy_settings: { fetch_location: 0, fetch_wifi_ssid: 2 },
    processor_core_count: 8,
    purchase_price: "0.0",
    remarks: "dc.mdm.db.agent.enroll.agent_enroll_finished",
    total_ram_memory: 3539.391,
    warranty_expiration_date: "0",
    warranty_number: "--",
  });

  const headline = new Map(detail.headline.map((fact) => [fact.label, fact.value]));
  assert.equal(headline.get("Operating system"), "Android 12", "the platform is a word, never a letter or a code");
  assert.equal(headline.has("Owned by"), false, "ownership as a bare number is not shown at all");

  const facts = new Map(detail.sections.flatMap((section) => section.facts).map((fact) => [fact.label, fact.value]));
  assert.equal(facts.get("Added time"), new Date(1_790_189_748_534).toISOString(), "an epoch sent as a STRING is a moment");
  assert.equal(facts.get("Device capacity"), "51.2 GB", "storage carries the unit ManageEngine measured it in");
  assert.equal(facts.get("Available device capacity"), "46.5 GB", "so does the free space");
  assert.equal(facts.get("Total RAM memory"), "3539.4 MB", "memory is megabytes, not a bare decimal");
  assert.equal(facts.get("IMEI"), "865569071549107", "an IMEI keeps every digit, ungrouped");
  assert.equal(facts.get("Agent version"), "26.09.01", "a version is not mistaken for a resource code");
  assert.equal(facts.get("Processor core count"), "8", "a real count is still a number");
  assert.equal(facts.get("Manufacturer"), "Lenovo", "a plain fact is untouched");

  for (const gone of [
    ["Managed status", "a vendor enum"],
    ["Platform type", "a vendor enum"],
    ["EAS device identifier", "an identifier"],
    ["Warranty number", "ManageEngine's -- placeholder"],
    ["Warranty expiration date", "a date sent as zero"],
    ["Purchase price", "a price sent as zero"],
    ["Remarks", "a resource key"],
    ["OS name", "Android's one-letter release code"],
  ] as const) {
    assert.equal(facts.has(gone[0]), false, `${gone[1]} never reaches the screen`);
  }

  const titles = detail.sections.map((section) => section.title);
  assert.ok(!titles.includes("Privacy settings"), "ManageEngine's own collection settings are not tablet facts");
  assert.ok(!titles.includes("Location settings"), "nor are its location settings");

  // The history's remarks are HTML. They must arrive as words, with the markup left behind.
  resetManageEngineTokenCache();
  const marked = makeFetch({
    api: [
      {
        status: 200,
        body: {
          commands: [
            {
              added_time: 1_790_000_000_000,
              command_id: "c9",
              command_name: "corporate_wipe",
              command_status: "1",
              remarks:
                '<label class="eventlogbold">Corporate Wipe</label> command for <label class="eventlogbold">it.satopharma_TB328XU</label> is initiated from server',
            },
          ],
        },
      },
    ],
  });
  const [wipe] = await getManageEngineCommandHistory("111", marked.fetch, ENV);
  assert.equal(
    wipe.remarks,
    "Corporate Wipe command for it.satopharma_TB328XU is initiated from server",
    "a remark arrives as words, never with its tags showing",
  );
  assert.ok(!(wipe.remarks ?? "").includes("<"), "no markup survives into the screen");
  assert.equal(wipe.status, "Waiting for the tablet", "a status sent as a STRING of digits is named");
}

/** The apps on a tablet, the company repository, and which of the two an app came from. */
async function runDeviceAppsTests() {
  resetManageEngineTokenCache();
  const stub = makeFetch({
    api: [
      {
        status: 200,
        body: {
          apps: [
            {
              app_id: "a1",
              app_name: "Phoenix",
              app_version: "1.4",
              identifier: "com.google.enterprise.webapp.phoenix",
              release_label_details: { release_label_id: "L1", release_label_name: "Production" },
            },
            { app_id: "x9", app_name: "Candy Crush", identifier: "com.king.candycrushsaga" },
          ],
        },
      },
      {
        status: 200,
        body: {
          apps: [
            {
              app_id: "a1",
              app_name: "Phoenix",
              identifier: "com.google.enterprise.webapp.phoenix",
              release_label_details: { release_label_id: "L1" },
            },
            { app_id: "a2", app_name: "Chrome", identifier: "com.android.chrome" },
          ],
        },
      },
    ],
  });

  const state = await getManageEngineDeviceApps("111", stub.fetch, ENV);
  assert.deepEqual(
    state.installed.map((app) => `${app.name}:${app.managed}`),
    ["Candy Crush:false", "Phoenix:true"],
    "an app in the repository is company-sent; one that is not was installed by the rep",
  );
  assert.equal(state.installed[1].releaseLabelId, "L1", "the release label rides along for a re-install");
  assert.deepEqual(
    state.available.map((app) => app.name),
    ["Chrome"],
    "only repository apps the tablet does not have are offered",
  );
  assert.equal(state.repositoryError, false, "the repository read succeeded");

  // The repository failing leaves the installed list readable, and says so.
  resetManageEngineTokenCache();
  const halfDown = makeFetch({
    api: [
      { status: 200, body: { apps: [{ app_id: "a1", app_name: "Phoenix" }] } },
      { status: 500, body: { message: "repository down" } },
    ],
  });
  const degraded = await getManageEngineDeviceApps("111", halfDown.fetch, ENV);
  assert.equal(degraded.repositoryError, true, "a failed repository read is reported, not thrown");
  assert.equal(degraded.installed.length, 1, "the installed list still shows");
  assert.equal(degraded.available.length, 0, "nothing is offered when the repository is unknown");

  // Neither change is attempted without both ids — these throw before anything reaches ManageEngine.
  await assert.rejects(
    () => installManageEngineApp({ appId: "a1", deviceId: "" }, "B-10", stub.fetch, ENV),
    ManageEngineAppInputError,
    "an install with no tablet is refused",
  );
  await assert.rejects(
    () => removeManageEngineApp({ appId: "", deviceId: "111" }, "B-10", stub.fetch, ENV),
    ManageEngineAppInputError,
    "a removal with no app is refused",
  );
}

// ---------------------------------------------------------------------------------------------
// Adding an APK to the company app repository
// ---------------------------------------------------------------------------------------------

/**
 * WHAT THIS PINS, AND WHY EACH ONE IS HERE RATHER THAN LEFT TO A HUMAN.
 *
 * 🔴 THE CONTENT-TYPE. `callManageEngine` stamps `application/json` on anything with a body — which
 * is right for every other call in the bridge and fatal for this one. A multipart body's boundary is
 * written by `fetch` into the content-type, and overwriting it hands ManageEngine a body it cannot
 * parse. The failure would look like ManageEngine refusing the file, so nobody would look here.
 *
 * THE FALLBACK IS NARROW ON PURPOSE. ManageEngine documents `/emsapi/files` as the endpoint and the
 * older `/api/v1/mdm/files` as deprecated — but the deprecation is dated against an On-Premises
 * build and this tenant is Cloud, so only the tenant can say which it serves. Retrying on a 404 is
 * right; retrying on a refusal would upload the file twice and hide the reason.
 *
 * THE CREATE BODY IS ASSERTED KEY BY KEY because every one of its values is a decision: Enterprise
 * over a store type, both device sizes, and NO release label — ManageEngine's own documentation says
 * a label-less app lands in the default stable channel, which is the wanted behaviour.
 */
async function runAppRepositoryUploadTests() {
  // A body that is not FormData still gets JSON on both request and response, as every other bridge
  // call relies on.
  resetManageEngineTokenCache();
  const jsonStub = makeFetch({ api: [{ status: 200, body: {} }] });
  await callManageEngine("/api/v1/mdm/apps", { body: "{}", method: "POST" }, jsonStub.fetch, ENV);
  const jsonHeaders = jsonStub.calls.at(-1)!.init.headers as Record<string, string>;
  assert.equal(jsonHeaders["content-type"], "application/json", "an ordinary body is still declared as JSON");
  assert.equal(jsonHeaders["accept"], "application/json", "an ordinary call still asks for JSON back");

  // 🔴 A multipart body carries NEITHER content-type NOR accept from the client. fetch writes the
  // real content-type (boundary and all), and `/emsapi/files` answers 406 Not Acceptable to an upload
  // that also sends `accept: application/json` — measured live 2026-09-25 — while returning the file
  // JSON perfectly well when Accept is absent.
  resetManageEngineTokenCache();
  const formStub = makeFetch({ api: [{ status: 200, body: { fileID: "9911" } }] });
  const form = new FormData();
  form.append("fileName", new Blob([new Uint8Array([1, 2, 3])]), "phoenix.apk");
  await callManageEngine("/emsapi/files", { body: form, method: "POST" }, formStub.fetch, ENV);
  const formCall = formStub.calls.at(-1)!;
  const formHeaders = formCall.init.headers as Record<string, string>;
  assert.equal(
    formHeaders["content-type"],
    undefined,
    "a multipart upload must not be stamped as JSON — the boundary fetch writes is the only thing that parses it",
  );
  assert.equal(
    formHeaders["accept"],
    undefined,
    "a multipart upload must not ask for JSON back — /emsapi/files answers 406 to an Accept: application/json upload",
  );
  assert.ok(formCall.init.body instanceof FormData, "the form itself reaches fetch, not a serialization of it");

  // Both spellings of the file id are read, because the two upload endpoints differ.
  assert.equal(manageEngineFileId({ fileID: "77" }), "77", "the /emsapi/files spelling is read");
  assert.equal(manageEngineFileId({ file_id: 88 }), "88", "the deprecated endpoint's spelling is read");
  // 🔴 /emsapi/files actually answers with an ARRAY of file records — the id is inside it, not on top.
  assert.equal(manageEngineFileId([{ fileID: "243158000000133170" }]), "243158000000133170", "the array /emsapi/files wraps the record in is unwrapped");
  assert.equal(manageEngineFileId([]), null, "an empty array is no file id, not a crash");
  assert.equal(manageEngineFileId(null), null, "no payload is no file id, not a crash");

  // The fallback fires only where the endpoint is absent — never on a refusal.
  for (const status of [404, 405, 501]) {
    assert.equal(isMissingEndpointStatus(status), true, `HTTP ${status} means the tenant does not serve that path`);
  }
  for (const status of [400, 401, 403, 406, 413, 500, 502]) {
    assert.equal(isMissingEndpointStatus(status), false, `HTTP ${status} is a real answer and is not retried elsewhere`);
  }

  // Nothing is uploaded that cannot become an app on a tablet.
  assert.throws(() => assertUploadableApk("", 10), ManageEngineAppInputError, "no file is refused");
  assert.throws(
    () => assertUploadableApk("phoenix.aab", 10),
    /\.aab is a Play Store upload/,
    "the Play Store bundle sitting beside the APK is refused by name",
  );
  assert.throws(() => assertUploadableApk("phoenix.apk", 0), /empty/, "an empty file is refused");
  assert.throws(
    () => assertUploadableApk("phoenix.apk", MAX_APP_UPLOAD_BYTES + 1),
    ManageEngineAppInputError,
    "a file past the carried size is refused before a byte is sent",
  );
  assert.doesNotThrow(() => assertUploadableApk("Phoenix-Workforce.APK", 42), "the extension check ignores case");

  // The create body — every value is a decision, so every value is pinned.
  const body = manageEngineAppCreateBody({
    appName: "Phoenix Workforce",
    fileId: "91273987129",
    appCategoryId: "243158000000134093",
  });
  assert.equal(
    body.app_type,
    2,
    "app_type is a 0-indexed enum — Enterprise is 2; a 3 is out of range and answers a misleading 500 COM0004",
  );
  assert.equal(body.platform_type, 2, "an APK is Android — the create call is rejected 400 without platform_type");
  assert.equal(body.supported_devices, 3, "both device sizes, so a phone in the fleet is not excluded");
  assert.equal(body.app_file, 91273987129, "a numeric file id is sent as a number, which is how ManageEngine types it");
  assert.equal(body.app_name, "Phoenix Workforce", "the name reaches ManageEngine as given");
  assert.equal(
    body.app_category_id,
    "243158000000134093",
    "app_category_id is Required — a create without it answers 500 COM0004, not a clear missing-field error",
  );
  assert.ok(
    !("release_label_id" in body),
    "no channel was chosen, so none is invented — ManageEngine puts a label-less app in the default stable channel",
  );
  assert.ok(!("description" in body), "an absent description is absent, not an empty string");

  const labelled = manageEngineAppCreateBody({
    appName: "Phoenix",
    appCategoryId: "243158000000134093",
    description: "  the field app  ",
    fileId: "abc-123",
    releaseLabelId: "12345",
  });
  assert.equal(labelled.release_label_id, 12345, "a chosen channel is sent, numerically");
  assert.equal(labelled.app_file, "abc-123", "a non-numeric file id is sent unchanged rather than coerced to NaN");
  assert.equal(labelled.description, "the field app", "the description is trimmed");

  // 🔴 ManageEngine's own ids are 18 digits, past 2^53 — coercing one to Number rounds its last
  // digits, so the create carries an app_file that points at no uploaded file and ManageEngine
  // answers a bare 500. An id outside the safe range is sent as the exact string it arrived as.
  const bigIds = manageEngineAppCreateBody({
    appName: "Phoenix Workforce",
    fileId: "243158000000134349",
    appCategoryId: "243158000000134093",
  });
  assert.equal(
    bigIds.app_file,
    "243158000000134349",
    "an 18-digit file id is sent as the exact string — Number('243158000000134349') rounds to 243158000000134340 and 500s the create",
  );
  assert.equal(
    bigIds.app_category_id,
    "243158000000134093",
    "an 18-digit category id is sent exactly, never rounded through Number",
  );
}

function runErrorMappingTests() {
  const status = (error: unknown) => (manageEngineErrorResponse(error, "fallback") as { status: number }).status;
  assert.equal(status(new Error("forbidden: nope")), 403, "a forbidden error maps to 403");
  assert.equal(status(new ManageEngineNotConfiguredError("set the secrets")), 400, "not configured maps to 400");
  assert.equal(status(new ManageEngineCommandInputError("bad input")), 400, "an input error maps to 400");
  assert.equal(status(new ManageEngineAppInputError("no app")), 400, "an app input error maps to 400");
  assert.equal(status(new ManageEngineRequestError(502, "upstream")), 502, "a ManageEngine request error maps to 502");
  assert.equal(status(new Error("something else")), 500, "an unknown error maps to 500");
}

// ---------------------------------------------------------------------------------------------
// The enrollment template — the QR a factory-fresh tablet scans
// ---------------------------------------------------------------------------------------------

/**
 * WHAT THIS PINS. ManageEngine's REST API has NO enrollment endpoint: their QR is made once in the
 * console as an enrollment TEMPLATE and is the same payload for every tablet enrolled through it.
 * Phoenix therefore HOLDS one instead of minting one, and everything below follows from that.
 *
 * 🔴 THE PAYLOAD IS A CREDENTIAL — anyone who scans it puts a tablet into the company's fleet. So
 * the page's ordinary load must never carry it, the audit row must never record it, and nothing may
 * log it. Those three are asserted on the source, because a leak of this kind is invisible in
 * behaviour: the feature works perfectly either way.
 *
 * NOTHING IS ADDED TO THE PAYLOAD. Google's token could carry the custody-register id; ManageEngine's
 * admin extras bundle is their agent's own, and a key Phoenix added is a key it did not expect. The
 * round trip below pins that the stored payload holds the same keys, and the bundle byte for byte.
 */

const COMPONENT_KEY = "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME";
const DOWNLOAD_KEY = "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION";
const CHECKSUM_KEY = "android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM";
const EXTRAS_KEY = "android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE";
const WIFI_KEY = "android.app.extra.PROVISIONING_WIFI_SSID";

const EXTRAS_BUNDLE = { enrollmentToken: "TEST-TEMPLATE-TOKEN-NOT-REAL", serverUrl: "https://mdm.manageengine.com" };

const TEMPLATE: Record<string, unknown> = {
  [COMPONENT_KEY]: "com.manageengine.mdm.android/com.manageengine.mdm.android.receiver.AgentDeviceAdminMonitor",
  [DOWNLOAD_KEY]: "https://mdm.manageengine.com/agent/MDMAgent.apk?token=TEST-NOT-REAL",
  [CHECKSUM_KEY]: "TEST-CHECKSUM-NOT-REAL",
  [EXTRAS_KEY]: EXTRAS_BUNDLE,
  [WIFI_KEY]: "Phoenix-Office",
};

function runEnrollmentTemplateTests() {
  const { payload, facts } = parseManageEngineEnrollmentTemplate(`\n  ${JSON.stringify(TEMPLATE)}  \n`);
  assert.equal(facts.agentPackage, "com.manageengine.mdm.android", "the agent package is read out of the component name");
  assert.equal(
    facts.downloadHost,
    "mdm.manageengine.com",
    "the HOST only — the download URL carries a token in its query, and this line is shown on the page",
  );
  assert.equal(facts.hasChecksum, true);
  assert.equal(facts.joinsWifi, true);

  const stored = JSON.parse(payload) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(stored).sort(),
    Object.keys(TEMPLATE).sort(),
    "nothing is added to the payload and nothing is dropped — the agent reads the keys it chose, not keys Phoenix chose",
  );
  assert.deepEqual(stored[EXTRAS_KEY], EXTRAS_BUNDLE, "the admin extras bundle passes through untouched");

  // A template with neither a pinned signature nor a Wi-Fi network still saves; the two chips read
  // false. Refusing one would refuse a template ManageEngine itself produced.
  const bare = parseManageEngineEnrollmentTemplate(
    JSON.stringify({ [COMPONENT_KEY]: "com.example.agent/.Admin", [DOWNLOAD_KEY]: "https://example.test/a.apk" }),
  );
  assert.deepEqual(bare.facts, {
    agentPackage: "com.example.agent",
    downloadHost: "example.test",
    hasChecksum: false,
    joinsWifi: false,
  });
  assert.equal(
    parseManageEngineEnrollmentTemplate(JSON.stringify({ ...TEMPLATE, [CHECKSUM_KEY]: "   ", [WIFI_KEY]: "" })).facts.hasChecksum,
    false,
    "a blank checksum is no checksum",
  );

  const refused: Array<[string, string]> = [
    ["", "nothing pasted"],
    ["   \n  ", "whitespace"],
    ["MDM enrollment QR", "the words off the screen instead of the payload"],
    ["[1,2]", "a JSON array"],
    ["null", "JSON null"],
    ["\"a string\"", "a JSON string"],
    [JSON.stringify({ [DOWNLOAD_KEY]: "https://x.test/a.apk" }), "no component name, so no tablet knows what to install"],
    [
      JSON.stringify({ [COMPONENT_KEY]: "com.example.agent", [DOWNLOAD_KEY]: "https://x.test/a.apk" }),
      "a component name with no receiver after the slash",
    ],
    [JSON.stringify({ [COMPONENT_KEY]: "com.example.agent/.Admin" }), "no download location"],
    [
      JSON.stringify({ [COMPONENT_KEY]: "com.example.agent/.Admin", [DOWNLOAD_KEY]: "MDMAgent.apk" }),
      "a download location that is not a URL",
    ],
  ];
  for (const [raw, because] of refused) {
    assert.throws(
      () => parseManageEngineEnrollmentTemplate(raw),
      ManageEngineEnrollmentInputError,
      `refused, and in words: ${because}`,
    );
  }
}

function enrollmentSource(relative: string): string {
  return readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
}

function runEnrollmentDoorTests() {
  const approve = { action: "approve", resource: "company_devices" };
  const read = findAccessRegistryEntry("/api/devices/manageengine/enrollment", "GET");
  assert.equal(read?.pattern, "/api/devices/manageengine/enrollment", "the read has its own registry entry");
  assert.deepEqual(read?.permission, approve, "Super Admin only — the same door as the rest of Rep Tablets");
  const write = findAccessRegistryEntry("/api/devices/manageengine/enrollment", "POST");
  assert.deepEqual(write?.permission, approve);
  assert.equal(write?.csrf.required, true);
  assert.equal(write?.audit.required, true);
  assert.equal(write?.audit.classification, "mutation");

  const route = enrollmentSource("app/api/devices/manageengine/enrollment/route.ts");
  assert.match(route, /assertPermission\(access, "company_devices", "approve"\)/, "the route is the security boundary, not the page");
  assert.match(route, /const csrf = assertSameOriginMutation\(request\);\s*if \(csrf\) return csrf;/);
  assert.match(route, /"cache-control": "no-store"/, "neither the summary nor the payload is cached between Phoenix and the browser");
  assert.equal(
    (route.match(/readManageEngineEnrollmentQr\(\)/g) ?? []).length,
    1,
    "exactly one place hands the payload to a browser, and it is the explicit show",
  );
  assert.match(route, /payload\.show === true/, "the payload comes back only when a person asks for it");

  const moduleSource = enrollmentSource("src/lib/devices/manageengine/enrollment.ts");
  const summaryStart = moduleSource.indexOf("export async function getManageEngineEnrollmentSummary(");
  const summary = moduleSource.slice(summaryStart, moduleSource.indexOf("\nexport ", summaryStart + 1));
  assert.ok(summaryStart !== -1, "the page's ordinary load has its own function");
  assert.doesNotMatch(
    summary,
    /payload:|return row\b|\.\.\.row\b/,
    "the load the page does on every visit carries facts ABOUT the template, never the template",
  );

  const auditStart = moduleSource.indexOf("writeRequiredAuditLog({");
  const audit = moduleSource.slice(auditStart, moduleSource.indexOf("});", auditStart));
  assert.ok(auditStart !== -1, "saving a template writes a required audit row");
  assert.doesNotMatch(
    audit,
    /payload|qr_payload|input\.raw|\braw\b/,
    "the audit row records that the template changed and who changed it — never the template",
  );
  assert.match(audit, /entityType: "manageengine_enrollment_template"/);

  // What became of ManageEngine's half, and of Google's. ManageEngine enrolled first from 2026-09-25
  // (Google refused every scan at a device quota of zero); on 2026-10-22 the last rep tablet was in
  // Headwind as device owner, so its four lines came off the page as the owner set out on 2026-09-26.
  const page = enrollmentSource("app/(admin)/devices/tablets/page.tsx");
  assert.doesNotMatch(
    stripComments(page),
    /<ManageEngine(Enrollment|Fleet|RepTabletRules|AppRepository)\b/,
    "ManageEngine is OFF the tablets page (2026-10-22) — every rep tablet is in Headwind now",
  );
  // Taken off the page, NOT deleted — same as Google's console below.
  assert.match(
    enrollmentSource("src/components/devices/manageengine-fleet.tsx"),
    /export function ManageEngineFleet/,
    "the ManageEngine fleet component stays in the repo, whole",
  );
  // Read the RENDER, not the prose: the doc comment names `<RepTabletsConsole …/>` on purpose, as the
  // one line to re-add the day Google's quota lands, so the check must ignore comments or it trips on
  // its own restoration note.
  assert.doesNotMatch(
    stripComments(page),
    /<RepTabletsConsole/,
    "Google's console is OFF the page (owner, 2026-09-25) — it duplicated every ManageEngine card while Google holds zero tablets",
  );
  // Taken off the page, NOT deleted: the component and the routes it calls stay in the repo for the day approval lands.
  assert.match(
    enrollmentSource("src/components/devices/rep-tablets-console.tsx"),
    /export function RepTabletsConsole/,
    "the Google console component stays in the repo, whole",
  );

  // The free-trial split (owner asked, 2026-09-25): the two remote-troubleshooting features — and
  // ONLY those two — are marked as stopping when the trial falls back to the free edition, and the
  // page carries a colour key that says so. Screen sharing is ManageEngine's paid add-on; every other
  // action keeps working on the free edition.
  const fleet = enrollmentSource("src/components/devices/manageengine-fleet.tsx");
  assert.match(
    fleet,
    /\{\s*id:\s*"REMOTE_VIEW"[^}]*stopsAfterTrial:\s*true/,
    "View the screen is marked as stopping after the free trial (remote-troubleshooting add-on)",
  );
  assert.match(
    fleet,
    /\{\s*id:\s*"REMOTE_CONTROL"[^}]*stopsAfterTrial:\s*true/,
    "Take control is marked as stopping after the free trial (remote-troubleshooting add-on)",
  );
  assert.equal(
    (fleet.match(/stopsAfterTrial:\s*true/g) ?? []).length,
    2,
    "exactly the two screen-sharing features stop after the trial — nothing else is marked paid",
  );
  assert.doesNotMatch(
    fleet,
    /\{\s*id:\s*"LOCK"[^}]*stopsAfterTrial/,
    "Lock keeps working on the free edition — it is never marked paid",
  );
  assert.match(fleet, /After the free trial ends/, "the fleet shows a colour key for what stops after the trial");

  for (const file of [
    "src/lib/devices/manageengine/enrollment.ts",
    "app/api/devices/manageengine/enrollment/route.ts",
    "src/components/devices/manageengine-enrollment.tsx",
    "src/components/devices/qr-image.tsx",
  ]) {
    const text = enrollmentSource(file);
    assert.doesNotMatch(
      text,
      /\bconsole\.(log|info|warn|error|debug)\(/,
      `${file} logs nothing — an enrollment payload must never reach a log`,
    );
    assert.doesNotMatch(text, /localStorage|sessionStorage|indexedDB/, `${file} never stores the payload in the browser`);
  }

  const client = enrollmentSource("src/components/devices/manageengine-enrollment.tsx");
  assert.doesNotMatch(
    client,
    /dangerouslySetInnerHTML|innerHTML|appendChild|insertBefore/,
    "React draws the QR; nothing writes into the page behind it",
  );
  assert.match(client, /setRevealed\(null\)/, "Hide the code drops the payload out of the page");
  assert.doesNotMatch(
    client,
    /\brounded\b|rounded-|\btruncate\b|text-ellipsis|overflow-x-auto/,
    "square corners, no ellipsis, no sideways scroll",
  );

  // The QR drawing moved out of the Google console into one shared module; both paths draw the same
  // symbol, and the console must not have kept a second copy to drift from it.
  const qrImage = enrollmentSource("src/components/devices/qr-image.tsx");
  assert.match(qrImage, /qrSvgPath\(/, "the symbol is drawn from Phoenix's own encoder");
  assert.doesNotMatch(qrImage, /dangerouslySetInnerHTML|innerHTML|appendChild|insertBefore/);
  const googleHalf = enrollmentSource("src/components/devices/rep-tablets-console.tsx");
  assert.doesNotMatch(googleHalf, /function QrImage\(|function saveQrImage\(/, "one copy of the QR drawing, not two that can drift");
  assert.match(googleHalf, /from "@\/components\/devices\/qr-image"/, "Google's half draws with the shared one");
}

/**
 * The maker a self-registering tablet carries onto its custody-register entry.
 *
 * 🔴 `product_name` IS NOT IT, THOUGH THE DOCUMENTATION SAYS IT IS. ManageEngine's device API
 * documentation gives `"product_name": "samsung"`, but this tenant's live response (captured
 * 2026-09-24 and pinned in the device tests above) sends `"product_name": "TB328XU"` — a Lenovo
 * MODEL number. Live reality outranks the documented example: the maker is read only from a key that
 * cannot mean anything else, and this tenant naming none means a null maker, never a model number
 * filed as a maker for good on a register entry nobody will re-check.
 */
async function runManufacturerTests() {
  resetManageEngineTokenCache();
  const stub = makeFetch({
    api: [
      {
        status: 200,
        body: {
          devices: [
            { device_id: "me-1", device_name: "Tab A9", manufacturer: "Samsung", model: "SM-X115", platform_type: 2 },
            { device_id: "me-2", device_name: "it.satopharma_TB328XU", product_name: "TB328XU", platform_type: 2 },
          ],
        },
      },
    ],
  });
  const devices = await listManageEngineDevices(stub.fetch, ENV);

  assert.equal(devices[0].manufacturer, "Samsung", "a maker ManageEngine names is read");
  assert.equal(devices[0].model, "SM-X115", "beside the model");
  assert.equal(
    devices[1].manufacturer,
    null,
    "product_name is NEVER read as the maker — on this tenant it is a model number, whatever the docs example says",
  );
  assert.equal(devices[1].model, "TB328XU", "it stays a model candidate, which is what it holds here");
}

/** A device shaped the way the live tenant sends them, for the register-sync decisions. */
function meDevice(overrides: Partial<ManageEngineDevice>): ManageEngineDevice {
  return {
    deviceId: "me-1",
    enrollmentStatus: "Managed",
    imei: null,
    isAndroid: true,
    lastContactAt: null,
    lostMode: false,
    manufacturer: "samsung",
    model: "SM-X115",
    name: "Tab A9",
    osVersion: "14",
    platformLabel: "Android",
    serialNumber: null,
    userEmail: null,
    userName: null,
    ...overrides,
  };
}

/**
 * Everything Google's half did for an enrolled tablet, now done for a ManageEngine-enrolled one:
 * the tablet puts itself into the custody register, and the IMEI it reports fills an entry that
 * holds none.
 */
function runRegisterSyncTests() {
  const fresh = meDevice({ deviceId: "me-new", serialNumber: "R9XABCDEF", imei: "865569071549107" });

  // A managed Android tablet the register has never seen is added, with its maker and model.
  const toRegister = manageEngineTabletsToRegister([fresh], []);
  assert.equal(toRegister.length, 1, "an unregistered ManageEngine tablet is added to the custody register");
  assert.deepEqual(
    toRegister[0],
    { imei: "865569071549107", manufacturer: "samsung", model: "SM-X115", serialNumber: "R9XABCDEF" },
    "with the serial, IMEI, maker and model ManageEngine reports — the maker is not the model",
  );

  // Already in the register, by serial or by IMEI: nothing is added, so no tablet gets a second tag.
  assert.deepEqual(
    manageEngineTabletsToRegister([fresh], [register({ serialNumber: "r9xabcdef" })]),
    [],
    "a tablet the register already holds by serial is never added twice",
  );
  assert.deepEqual(
    manageEngineTabletsToRegister([fresh], [register({ imei: "86556907154910" })]),
    [],
    "nor one it holds by IMEI, compared on digits",
  );

  // What is not a rep tablet, and what cannot be told apart from the next one.
  assert.deepEqual(
    manageEngineTabletsToRegister([meDevice({ isAndroid: false, serialNumber: "IPAD1" })], []),
    [],
    "an iPad in the tenant is not a rep tablet",
  );
  assert.deepEqual(
    manageEngineTabletsToRegister([meDevice({ enrollmentStatus: "Removed", serialNumber: "GONE1" })], []),
    [],
    "a tablet ManageEngine has removed is not added",
  );
  assert.deepEqual(
    manageEngineTabletsToRegister([meDevice({ imei: null, serialNumber: null })], []),
    [],
    "a tablet reporting neither a serial nor an IMEI cannot be told apart from another one",
  );

  // Two ManageEngine records for one physical tablet make one entry, not two.
  assert.equal(
    manageEngineTabletsToRegister([fresh, meDevice({ deviceId: "me-dupe", serialNumber: "R9XABCDEF" })], []).length,
    1,
    "one tablet enrolled twice is one register entry",
  );

  // ── The IMEI copy ──────────────────────────────────────────────────────────────────────────────
  const entry = register({ assetTag: "PHX-TAB-0007", id: "reg-7", serialNumber: "R9XABCDEF" });

  assert.deepEqual(
    manageEngineImeisToRecord([fresh], [entry]),
    [{ assetTag: "PHX-TAB-0007", imei: "865569071549107", registerDeviceId: "reg-7" }],
    "the IMEI a serial-matched tablet reports fills an entry that holds none",
  );

  assert.deepEqual(
    manageEngineImeisToRecord([fresh], [{ ...entry, imei: "111111111111111" }]),
    [],
    "an IMEI somebody typed is never overwritten, even when the tablet reports a different one",
  );

  assert.deepEqual(
    manageEngineImeisToRecord(
      [meDevice({ deviceId: "me-imei-only", imei: "865569071549107", serialNumber: null })],
      [register({ id: "reg-8", imei: "865569071549107" })],
    ),
    [],
    "an entry matched BY that IMEI already holds it — nothing is copied (the serial check above it is belt and braces)",
  );

  assert.deepEqual(
    manageEngineImeisToRecord([fresh], [entry, register({ assetTag: "PHX-TAB-0009", id: "reg-9", imei: "865569071549107" })]),
    [],
    "an IMEI another entry already holds is refused — it would be on two tablets",
  );

  // Ties are held back rather than guessed, both ways round.
  assert.deepEqual(
    manageEngineImeisToRecord(
      [fresh, meDevice({ deviceId: "me-twin", imei: "490154203237518", serialNumber: "R9XABCDEF" })],
      [entry],
    ),
    [],
    "two tablets claiming one entry writes nothing at all",
  );
  assert.deepEqual(
    manageEngineImeisToRecord(
      [fresh, meDevice({ deviceId: "me-twin", imei: "865569071549107", serialNumber: "SECOND1" })],
      [entry, register({ assetTag: "PHX-TAB-0010", id: "reg-10", serialNumber: "SECOND1" })],
    ),
    [],
    "one IMEI reaching two entries writes nothing at all",
  );
}

/**
 * The rules a tablet carries — ManageEngine's profiles, the vendor's half of Google's policy.
 *
 * 🔴 PHOENIX NEVER WRITES A PROFILE'S CONTENTS. Their REST API does not document the Android
 * restriction payload's field names, and a guessed key would publish a profile that restricts
 * nothing while the screen says the tablet is locked down. These tests pin that the module reads the
 * company's own profiles and drives WHICH tablet carries WHICH of them, and nothing more.
 */
async function runProfileTests() {
  resetManageEngineTokenCache();

  // The catalogue: Android only, payloads in words, sorted by name.
  const catalogue = makeFetch({
    api: [
      {
        status: 200,
        body: {
          profiles: [
            { profile_id: 12, profile_name: "Rep tablet rules", platform_type: 2, payloads: ["restrictionspolicy", "passcodepolicy"] },
            { profile_id: 13, profile_name: "Alpha", platform_type: 2, payloads: ["applockpolicy"] },
            { profile_id: 20, profile_name: "iPad rules", platform_type: 1, payloads: ["restrictionspolicy"] },
          ],
        },
      },
    ],
  });
  const profiles = await listManageEngineProfiles(catalogue.fetch, ENV);
  assert.deepEqual(
    profiles.map((profile) => profile.name),
    ["Alpha", "Rep tablet rules"],
    "an iOS profile is left out — a tablet cannot carry one, and offering it could only fail",
  );
  assert.deepEqual(
    profiles[1].payloads,
    ["What the tablet may do", "Screen lock"],
    "what a profile restricts is shown in words, never as restrictionspolicy",
  );
  assert.equal(profiles[1].profileId, "12", "the id is a string on the wire whatever ManageEngine sends");
  assert.match(catalogue.calls.at(-1)!.url, /\/api\/v1\/mdm\/profiles$/, "the catalogue is the documented endpoint");

  // An unmapped payload still reads as words rather than a code.
  assert.equal(profilePayloadLabel("somethingnewpolicy"), "Somethingnew", "an unmapped payload is title-cased, never hidden");
  assert.equal(profilePayloadLabel("passcodepolicy"), "Screen lock");

  // One tablet: what it carries, and what else it could be put on.
  resetManageEngineTokenCache();
  const perDevice = makeFetch({
    api: [
      {
        status: 200,
        body: {
          profiles: [
            { profile_id: 12, profile_name: "Rep tablet rules", platform_type: 2, payloads: ["restrictionspolicy"], status: "Applied", applied_time: 1_758_000_000_000 },
          ],
        },
      },
      {
        status: 200,
        body: {
          profiles: [
            { profile_id: 12, profile_name: "Rep tablet rules", platform_type: 2, payloads: ["restrictionspolicy"] },
            { profile_id: 13, profile_name: "Alpha", platform_type: 2, payloads: ["applockpolicy"] },
          ],
        },
      },
    ],
  });
  const state = await getManageEngineProfileState("me-1", perDevice.fetch, ENV);
  assert.deepEqual(state.applied.map((profile) => profile.name), ["Rep tablet rules"]);
  assert.equal(state.applied[0].status, "Applied", "ManageEngine's own word on whether the tablet took it");

  // 🔴 AND THAT WORD IS NEVER A CODE. Measured on the live tenant while a profile landed on
  // PHX-TAB-0002: `status` read "18" on the way and "6" once applied, with the sentence itself in
  // `localized_remarks`. A page that prints 18 at somebody is telling them nothing.
  resetManageEngineTokenCache();
  const coded = makeFetch({
    api: [
      {
        status: 200,
        body: {
          profiles: [
            {
              profile_id: 12,
              profile_name: "Rep tablet rules",
              platform_type: 2,
              status: "6",
              localized_remarks: "Successfully applied the policy",
            },
            { profile_id: 13, profile_name: "Alpha", platform_type: 2, status: "18" },
            { profile_id: 14, profile_name: "Beta", platform_type: 2, status: "97" },
          ],
        },
      },
      { status: 500, body: { error_description: "catalogue down" } },
    ],
  });
  const worded = await getManageEngineProfileState("me-1", coded.fetch, ENV);
  assert.equal(
    worded.applied[0].status,
    "Successfully applied the policy",
    "ManageEngine's own sentence is preferred over its code",
  );
  assert.equal(worded.applied[1].status, "On its way to the tablet", "and a code with no sentence is put into words");
  assert.equal(
    worded.applied[2].status,
    null,
    "🔴 an unmapped code is answered with no status at all — never with the raw number",
  );
  for (const profile of worded.applied) {
    assert.ok(profile.status === null || !/^\d+$/.test(profile.status), `a bare code never reaches the page (${profile.name})`);
  }
  assert.equal(state.applied[0].appliedAt, new Date(1_758_000_000_000).toISOString(), "and when, as an instant the page shows in Cairo time");
  assert.deepEqual(
    state.available.map((profile) => profile.name),
    ["Alpha"],
    "a rule set already on the tablet is never offered again as something to add",
  );
  assert.equal(state.catalogueError, false);
  assert.ok(
    perDevice.calls.some((call) => /\/api\/v1\/mdm\/devices\/me-1\/profiles$/.test(call.url)),
    "the tablet's own profiles come from the documented per-device endpoint",
  );

  // The catalogue failing does not blank what the tablet is carrying.
  resetManageEngineTokenCache();
  const halfDown = makeFetch({
    api: [
      { status: 200, body: { profiles: [{ profile_id: 12, profile_name: "Rep tablet rules", platform_type: 2 }] } },
      { status: 500, body: { error_description: "profiles unavailable" } },
    ],
  });
  const degraded = await getManageEngineProfileState("me-1", halfDown.fetch, ENV);
  assert.equal(degraded.catalogueError, true, "the catalogue being down is said plainly");
  assert.equal(degraded.applied.length, 1, "and what the tablet carries still shows");

  // 🔴 AN 18-DIGIT PROFILE ID SURVIVES THE REQUEST BODY WHOLE. This is a real failure, not a
  // hypothetical: the first live association answered `404 Unknown id(s) - [Profile Id
  // :243158000000124380]` because the body coerced the id through `Number`, and JavaScript stops
  // being exact at 16 digits — ...389 went out as ...380 and no tablet could be put on any rules.
  assert.equal(
    profileAssociationBody("243158000000124389"),
    '{"profile_ids":[243158000000124389]}',
    "every digit of a ManageEngine id reaches the API — the one that failed live ended 389, not 380",
  );
  assert.ok(
    !profileAssociationBody("243158000000124389").includes("243158000000124380"),
    "the rounded id that ManageEngine refused can never be what goes out",
  );
  assert.equal(
    profileAssociationBody("12"),
    '{"profile_ids":[12]}',
    "a short id is still sent as a JSON number, which is what the API takes",
  );
  assert.equal(
    profileAssociationBody("not-an-id"),
    '{"profile_ids":["not-an-id"]}',
    "anything that is not digits is quoted, so ManageEngine refuses it rather than this code mangling it",
  );
  const profilesSource = enrollmentSource("src/lib/devices/manageengine/profiles.ts");
  assert.doesNotMatch(
    profilesSource,
    /Number\(profileId\)/,
    "the profile id never goes through Number again — that rounding is what broke the live association",
  );
  assert.match(
    profilesSource,
    /body: profileAssociationBody\(profileId\)/,
    "and the association body is built by the helper the assertions above pin",
  );

  // Nothing is sent on a change that names no tablet, no rules, or an action that is not one of two.
  for (const [input, why] of [
    [{ action: "associate" as const, deviceId: "", profileId: "12" }, "no tablet"],
    [{ action: "associate" as const, deviceId: "me-1", profileId: "" }, "no rules"],
    [{ action: "publish" as unknown as "associate", deviceId: "me-1", profileId: "12" }, "an action that is not one of the two"],
  ]) {
    resetManageEngineTokenCache();
    const untouched = makeFetch({});
    await assert.rejects(
      () => changeManageEngineProfile(input as Parameters<typeof changeManageEngineProfile>[0], "B-10", untouched.fetch, ENV),
      ManageEngineProfileInputError,
      `a change with ${why} is refused in words`,
    );
    assert.equal(untouched.calls.length, 0, `a change with ${why} reaches neither Zoho nor ManageEngine`);
  }
}

/** The two new doors, and what the code that walks through them must not do. */
function runParityDoorTests() {
  const approve = { action: "approve", resource: "company_devices" };
  for (const [pattern, methods] of [
    ["/api/devices/manageengine/imei", ["POST"]],
    ["/api/devices/manageengine/profiles", ["GET", "POST"]],
    // Reading the company app repository, and adding an APK to it. The upload reaches no tablet, but
    // it writes into the company's fleet configuration, so it stands behind the same door as the rest.
    ["/api/devices/manageengine/apps", ["GET", "POST"]],
    ["/api/devices/manageengine/apps/upload", ["POST"]],
  ] as const) {
    for (const method of methods) {
      const entry = findAccessRegistryEntry(pattern, method);
      assert.equal(entry?.pattern, pattern, `${method} ${pattern} has its own access-registry entry`);
      assert.deepEqual(entry?.permission, approve, `${pattern} is Super Admin only — the rest of Rep Tablets' door`);
      if (method === "POST") {
        assert.equal(entry?.csrf.required, true, `${pattern} is same-origin only`);
        assert.equal(entry?.audit.required, true, `${pattern} writes a REQUIRED audit row`);
        assert.equal(entry?.audit.classification, "mutation");
      }
    }
  }

  // 🔴 The IMEI copy takes NOTHING from the browser: which entries are written, and with which IMEI,
  // is decided on the server from the live fleet and the register.
  const imeiRoute = enrollmentSource("app/api/devices/manageengine/imei/route.ts");
  assert.doesNotMatch(imeiRoute, /request\.json\(/, "the IMEI copy reads no body — the browser cannot choose what is written");
  assert.match(imeiRoute, /listManageEngineDevices\(\)/, "it reads the fleet again on the server");
  assert.match(imeiRoute, /assertSameOriginMutation/);

  // The register write says where the number came from. A row reading "reports to Google" about a
  // number ManageEngine read would be a false record of a value's origin.
  const registerService = enrollmentSource("src/lib/devices/service.ts");
  assert.match(
    registerService,
    /reports to \$\{REPORTED_IMEI_SOURCE_NAMES\[source\]\}/,
    "the audit row names the console that reported the IMEI",
  );
  const sync = enrollmentSource("src/lib/devices/manageengine/register-sync.ts");
  assert.match(sync, /source: "manageengine"/, "and the ManageEngine path passes its own");

  // 🔴 THE ASSOCIATION MODULE never authors a profile's contents. Building the company's rules lives
  // in rep-tablet-profile.ts, and the two stay apart so that changing WHO follows a rule set can
  // never quietly change WHAT it says. (An earlier version of this comment said the restriction keys
  // were undocumented. They are not — see rep-tablet-profile.ts — but the separation is still why
  // this assertion is here.)
  const profiles = enrollmentSource("src/lib/devices/manageengine/profiles.ts");
  assert.doesNotMatch(
    profiles,
    /restrictionspolicy["']\s*:|payloaditems|\/profiles["'],\s*\{\s*body/,
    "association never writes a profile's contents — only which tablet carries which of the company's own",
  );
  assert.match(profiles, /devices\/\$\{encodeURIComponent\(deviceId\)\}\/profiles/, "it associates against the device endpoint");
  assert.match(profiles, /entityType: "manageengine_device_profile"/, "and every change is an audited act on a real tablet");

  // One register write path, whichever console noticed the tablet first.
  const autoRegister = enrollmentSource("src/lib/devices/tablet-auto-register.ts");
  assert.match(autoRegister, /manageengine:/, "ManageEngine is a door into the same register entry, with its own note");
  assert.match(sync, /registerTablet\(facts, "manageengine"/, "through the same registerTablet the Google half calls");
  assert.doesNotMatch(sync, /createDevice\(/, "never a second way of creating a register entry that could drift");
}

/**
 * The company's rep tablet profile — the rules Phoenix writes into ManageEngine.
 *
 * 🔴 THE VALUES ARE THE WHOLE TEST. ManageEngine's restriction fields disagree about which number
 * means "no": `allow_factory_reset` restricts with 0, `allow_camera` restricts with 2, and
 * `allow_disabling_gps` wants 5 for always-on out of 4/5/6. A value copied from the field above it
 * publishes a profile that restricts NOTHING while the page says the tablet is locked down, and
 * nobody would see it until a rep factory-reset a tablet. Each one below is pinned to its own
 * documented row.
 */
async function runRepTabletProfileTests() {
  const bodies = repTabletProfilePayloadBodies();

  assert.equal(bodies.restrictions.allow_factory_reset, 0, "0 restricts a factory reset — 1 would ALLOW it");
  assert.equal(bodies.restrictions.allow_non_market_apps, 0, "0 restricts side-loading — 1 would ALLOW it");
  assert.equal(bodies.restrictions.allow_developer_mode, 0, "0 restricts developer mode — 1 would ALLOW it");
  assert.equal(bodies.restrictions.allow_install_app, 0, "0 stops the rep installing unapproved apps");
  assert.equal(bodies.restrictions.allow_uninstall_app, 0, "0 stops the company's apps being removed");
  assert.equal(
    bodies.restrictions.allow_play_protect_monitoring,
    1,
    "this field is the other way round: 1 is always on, 0 leaves Play Protect to the rep",
  );
  assert.equal(
    bodies.restrictions.allow_disabling_gps,
    5,
    "location takes 4, 5 or 6 — 5 is always on, 6 would force it OFF and 4 would leave it to the rep",
  );
  assert.equal(bodies.passcode.scope_for_passcode, 0, "the screen lock covers the device, not a work container");
  assert.equal(bodies.passcode.passcode_type, 1, "1 is a pattern or better — the lightest thing that is still a lock");

  // 🔴 Any value here WIPES the tablet when a rep mistypes his PIN. Google's policy sets none, and
  // neither does this. Its absence is the rule.
  assert.equal(
    "max_failed_attempts" in bodies.passcode,
    false,
    "max_failed_attempts is never sent — ManageEngine's own row says the device is completely wiped",
  );

  // Samsung-only fields would put a rule on the page that a Lenovo tablet never receives.
  for (const field of ["allow_mock_location", "allow_safe_mode", "allow_usb_debug", "allow_google_backup"]) {
    assert.equal(field in bodies.restrictions, false, `${field} is Samsung-only — the fleet is Lenovo, so it is not sent`);
  }

  // Nothing here is invented: every rule carried, and every rule declared uncarryable, is one of the
  // eight the owner already approved on Google's half.
  const approved = new Set(REP_TABLET_RULES.map((rule) => rule.title));
  for (const setting of REP_TABLET_PROFILE_SETTINGS) {
    assert.ok(approved.has(setting.rule), `'${setting.rule}' is one of the rep tablet rules, not a new rule`);
  }
  for (const gap of REP_TABLET_PROFILE_GAPS) {
    assert.ok(approved.has(gap.rule), `'${gap.rule}' is a rule that exists, honestly reported as uncarryable`);
  }
  const covered = new Set([
    ...REP_TABLET_PROFILE_SETTINGS.map((setting) => setting.rule),
    ...REP_TABLET_PROFILE_GAPS.map((gap) => gap.rule),
  ]);
  assert.equal(
    covered.size,
    approved.size,
    "every rule on Google's half is either carried or named as a gap — none is silently dropped",
  );

  // The profile is matched by name, whatever case the console shows it in.
  assert.equal(
    findRepTabletProfile([{ description: null, name: " phoenix REP tablet ", payloads: [], profileId: "9" }])?.profileId,
    "9",
    "the company's profile is found however it was capitalised",
  );
  // 🔴 AND THE OWNER'S OWN NAME IS ONE OF THEM. He built "Rep tablet rules" in the ManageEngine
  // console before this module existed; matching only the Phoenix name does not see it, so the page
  // would have offered to build a SECOND rule set beside his, and two profiles on one tablet is how
  // a fleet ends up half locked.
  const ownBuild = findRepTabletProfile([{ description: null, name: "Rep tablet rules", payloads: [], profileId: "9" }]);
  assert.equal(ownBuild?.profileId, "9", "the rule set the owner built in the console is found, not built over");
  assert.equal(
    isPhoenixBuiltRepTabletProfile(ownBuild),
    false,
    "and it is reported as the console's, so the page never claims Phoenix's own values are what it restricts",
  );
  assert.equal(
    isPhoenixBuiltRepTabletProfile({ description: null, name: "Phoenix rep tablet", payloads: [], profileId: "9" }),
    true,
  );
  assert.equal(
    findRepTabletProfile([{ description: null, name: "Alpha", payloads: [], profileId: "9" }]),
    null,
    "an unrelated profile is still not mistaken for the company's rules",
  );
  assert.equal(REP_TABLET_PROFILE_ALIASES[0], REP_TABLET_PROFILE_NAME, "Phoenix's own name leads, so a tenant holding both answers with the one Phoenix wrote");

  // 🔴 THE PAYLOAD NAMES ARE MEASURED, NOT GUESSED. The live tenant answers `androidpasscodepolicy`
  // — neither documented spelling — and the read-back that gates publishing recognises only names in
  // this list, so without the measured one it would refuse a profile that had attached correctly.
  assert.equal(
    PASSCODE_PAYLOAD_NAMES[0],
    "androidpasscodepolicy",
    "the spelling the company's own tenant uses leads the list",
  );
  assert.equal(profilePayloadLabel("androidrestrictionspolicy"), "What the tablet may do", "and it reads as words on the page, never as a code");
  assert.equal(profilePayloadLabel("androidefrppolicy"), "Factory reset protection");

  // Pressing build twice is safe: a profile already carrying both payloads is left alone.
  resetManageEngineTokenCache();
  const already = makeFetch({
    api: [
      {
        status: 200,
        body: { profiles: [{ profile_id: 44, profile_name: REP_TABLET_PROFILE_NAME, platform_type: 2 }] },
      },
      { status: 200, body: { payloads: ["androidrestrictionspolicy", "androidpasscodepolicy"] } },
    ],
  });
  const alreadyAudit: AuditLogInput[] = [];
  const second = await buildRepTabletProfile("B-10", already.fetch, ENV, async (row) => {
    alreadyAudit.push(row);
  });
  assert.equal(alreadyAudit.length, 0, "a press that changes nothing records nothing");
  assert.equal(second.created, false, "a tenant that already holds the profile is not given a second one");
  assert.equal(second.profileId, "44");
  assert.equal(
    already.calls.filter((call) => call.init.method === "POST" && !call.url.includes("/oauth/")).length,
    0,
    "and nothing at all is written on that path",
  );

  // 🔴 A PROFILE AN EARLIER FAILED PRESS LEFT EMPTY IS FINISHED, NOT DECLARED DONE. This is the exact
  // state the live tenant was left in: "Phoenix rep tablet" created, zero payloads, never published.
  // Matching on the name alone and returning `published: true` would have stranded it there forever.
  resetManageEngineTokenCache();
  const leftover = makeFetch({
    api: [
      {
        status: 200,
        body: { profiles: [{ profile_id: 44, profile_name: REP_TABLET_PROFILE_NAME, platform_type: 2 }] },
      },
      { status: 200, body: { payloads: [] } }, // the empty leftover
      { status: 200, body: {} }, // restrictions payload attaches
      { status: 200, body: {} }, // passcode payload attaches
      { status: 200, body: { payloads: ["androidrestrictionspolicy", "androidpasscodepolicy"] } }, // read back
      { status: 200, body: {} }, // publish
    ],
  });
  // A completed build ends in a REQUIRED audit row, and here it goes to a recorder — never to the real
  // audit log. Until 2026-10-01 these two builds instead expected the audit write to FAIL ("there is
  // no database here"), which held only where no Supabase key is set. A local run loads `.env.local`,
  // which is production, and there the write succeeded: production's audit_logs holds eight "Built
  // and published" rows in the owner's name for profile 44 — this fixture's id.
  const leftoverAudit: AuditLogInput[] = [];
  const repaired = await buildRepTabletProfile("B-10", leftover.fetch, ENV, async (row) => {
    leftoverAudit.push(row);
  });
  assert.equal(repaired.published, true, "the repair runs the whole way through and publishes");
  assert.deepEqual(
    leftoverAudit.map((row) => ({ entityId: row.entityId, entityType: row.entityType, summary: row.summary })),
    [
      {
        entityId: "44",
        entityType: "manageengine_profile",
        summary: `Built and published the rep tablet profile '${REP_TABLET_PROFILE_NAME}' in ManageEngine`,
      },
    ],
    "and it ends in exactly one audit row, handed to the writer the build was given — never the real audit log",
  );
  assert.equal(
    leftover.calls.some((call) => /\/profiles$/.test(call.url) && call.init.method === "POST"),
    false,
    "🔴 no SECOND profile is created beside the empty one already there",
  );
  assert.ok(
    leftover.calls.some((call) => call.url.includes("/profiles/44/payloads/androidrestrictionspolicy")),
    "the missing payload is attached to the profile that already exists",
  );
  assert.ok(
    leftover.calls.some((call) => call.url.includes("/profiles/44/publish") && call.init.method === "POST"),
    "and the finished profile is published, rather than left unpublished for good",
  );

  // 🔴 A FIELD THE TENANT REFUSES IS DROPPED AND NAMED — never swallowed, and never mistaken for a
  // wrong payload NAME. The live build died here: ManageEngine answered `Invalid parameter
  // "allow_uninstall_app" detected.` and the old code read that as the wrong spelling, moved to the
  // next one, failed identically, and reported a field error against a name that was never at fault.
  assert.equal(refusedParameterName('Invalid parameter "allow_uninstall_app" detected.'), "allow_uninstall_app");
  assert.equal(refusedParameterName("Unsupported parameter payloaditem detected in the request."), "payloaditem");
  assert.equal(refusedParameterName("Something else went wrong."), null, "an error naming no field names none");
  assert.deepEqual(
    rulesForFields(["allow_uninstall_app"]),
    ["Only approved apps"],
    "and a refused field is reported as the RULE it carried, in the words the page already uses",
  );

  resetManageEngineTokenCache();
  const fussy = makeFetch({
    api: [
      { status: 200, body: { profiles: [] } },
      { status: 200, body: { profile_id: "243158000000134296" } },
      { status: 400, body: { error_description: 'Invalid parameter "allow_uninstall_app" detected.' } },
      { status: 200, body: {} }, // accepted once that field is gone
      { status: 200, body: {} }, // passcode
      { status: 200, body: { payloads: ["androidrestrictionspolicy", "androidpasscodepolicy"] } },
      { status: 200, body: {} }, // publish
    ],
  });
  const fussyAudit: AuditLogInput[] = [];
  const despiteRefusal = await buildRepTabletProfile("B-10", fussy.fetch, ENV, async (row) => {
    fussyAudit.push(row);
  });
  assert.equal(despiteRefusal.published, true, "a refused field does not abort the build");
  assert.equal(fussyAudit.length, 1, "it runs on to its one audit row");
  assert.deepEqual(
    (fussyAudit[0].newValues as { refusedFields?: unknown } | null | undefined)?.refusedFields,
    ["allow_uninstall_app"],
    "and the field the tenant refused is named in that row, findable later without re-reading the page",
  );
  assert.ok(
    fussy.calls.some((call) => call.url.includes("/publish") && call.init.method === "POST"),
    "the rules the tenant DID take are still published, rather than thrown away over one refusal",
  );
  const retried = fussy.calls.filter((call) => call.url.includes("/payloads/androidrestrictionspolicy"));
  assert.equal(retried.length, 2, "the SAME payload name is asked again — the name was never the problem");
  assert.ok(
    !String(retried[1].init.body).includes("allow_uninstall_app"),
    "and the retry drops only the field ManageEngine named",
  );
  assert.ok(
    String(retried[1].init.body).includes("allow_install_app"),
    "every other rule survives the retry — one refused field does not cost the rest",
  );
  assert.match(
    enrollmentSource("src/lib/devices/manageengine/rep-tablet-profile.ts"),
    /refusedRules,?\n/,
    "and the refused rules are returned to the page, never left in the log alone",
  );

  // Source-level guarantees the flow above cannot be asked to prove without writing to ManageEngine.
  const source = enrollmentSource("src/lib/devices/manageengine/rep-tablet-profile.ts");
  assert.match(source, /platform_type: ANDROID_PLATFORM/, "the profile is created for Android, not iOS");
  assert.match(source, /readProfilePayloads\(profileId/, "the payloads are READ BACK from ManageEngine after the write");
  assert.match(
    source,
    /if \(carriesRestrictions && carriesPasscode\) \{[\s\S]{0,200}\/publish/,
    "🔴 and the profile is published ONLY once both payloads are proved present",
  );
  assert.match(source, /entityType: "manageengine_profile"/, "building the rules is its own audited act");
  assert.doesNotMatch(
    source,
    /devices\/\$\{[^}]*\}\/profiles|associate/,
    "building the rules never puts them on a tablet — that is a separate, separately audited act",
  );

  // The route takes nothing from the browser, and is Super Admin only on both verbs.
  const route = enrollmentSource("app/api/devices/manageengine/rep-tablet-profile/route.ts");
  assert.doesNotMatch(route, /request\.json\(/, "the browser can ask for the company's rules and never say what is in them");
  assert.match(route, /assertSameOriginMutation/, "and the build is same-origin only");
  for (const method of ["GET", "POST"] as const) {
    const entry = findAccessRegistryEntry("/api/devices/manageengine/rep-tablet-profile", method);
    assert.deepEqual(
      entry?.permission,
      { action: "approve", resource: "company_devices" },
      `${method} on the rep tablet profile is Super Admin only`,
    );
    if (method === "POST") {
      assert.equal(entry?.csrf.required, true);
      assert.equal(entry?.audit.required, true, "building the company's rules writes a REQUIRED audit row");
    }
  }
}

export async function runManageEngineBridgeTests() {
  await runAuthTests();
  await runClientTests();
  await runDeviceTests();
  await runDeviceDetailTests();
  await runDeviceDetailPlainWordsTests();
  await runDeviceAppsTests();
  await runAppRepositoryUploadTests();
  runCommandCatalogTests();
  runErrorMappingTests();
  runEnrollmentTemplateTests();
  runEnrollmentDoorTests();
  await runManufacturerTests();
  runRegisterSyncTests();
  await runProfileTests();
  await runRepTabletProfileTests();
  runParityDoorTests();
}
