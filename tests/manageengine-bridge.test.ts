import assert from "node:assert/strict";

import {
  getManageEngineAccessToken,
  isManageEngineConfigured,
  ManageEngineNotConfiguredError,
  resetManageEngineTokenCache,
} from "../src/lib/devices/manageengine/auth.ts";
import {
  callManageEngine,
  ManageEngineRequestError,
} from "../src/lib/devices/manageengine/client.ts";
import {
  getManageEngineDeviceApps,
  installManageEngineApp,
  ManageEngineAppInputError,
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
  assert.equal(commands[1].status, "Acknowledged", "a numeric status is named");

  // A fresh locate asks first, then reads — and a refused request still returns the older position.
  resetManageEngineTokenCache();
  const refreshed = makeFetch({
    api: [
      { status: 403, body: { error_description: "no licence for that" } },
      { status: 200, body: { locations: [{ latitude: 30.1, longitude: 31.3, address: "Giza" }] } },
    ],
  });
  const fresh = await requestManageEngineLocation("111", refreshed.fetch, ENV);
  assert.equal(fresh.address, "Giza", "a refused request still falls through to the last known position");
  const methods = refreshed.calls.filter((call) => !call.url.includes("/oauth/")).map((call) => call.init.method ?? "GET");
  assert.deepEqual(methods, ["POST", "GET"], "the position is requested, then read");
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

function runErrorMappingTests() {
  const status = (error: unknown) => (manageEngineErrorResponse(error, "fallback") as { status: number }).status;
  assert.equal(status(new Error("forbidden: nope")), 403, "a forbidden error maps to 403");
  assert.equal(status(new ManageEngineNotConfiguredError("set the secrets")), 400, "not configured maps to 400");
  assert.equal(status(new ManageEngineCommandInputError("bad input")), 400, "an input error maps to 400");
  assert.equal(status(new ManageEngineAppInputError("no app")), 400, "an app input error maps to 400");
  assert.equal(status(new ManageEngineRequestError(502, "upstream")), 502, "a ManageEngine request error maps to 502");
  assert.equal(status(new Error("something else")), 500, "an unknown error maps to 500");
}

export async function runManageEngineBridgeTests() {
  await runAuthTests();
  await runClientTests();
  await runDeviceTests();
  await runDeviceDetailTests();
  await runDeviceAppsTests();
  runCommandCatalogTests();
  runErrorMappingTests();
}
