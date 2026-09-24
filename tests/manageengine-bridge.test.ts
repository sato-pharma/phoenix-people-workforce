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
  getManageEngineLocation,
  listManageEngineDevices,
  matchManageEngineToRegister,
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
  // The allow-list is exactly the seven ids and nothing else.
  const ids = MANAGEENGINE_COMMANDS.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "command ids are unique");
  assert.equal(ids.length, 7, "seven remote actions");
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

function runErrorMappingTests() {
  const status = (error: unknown) => (manageEngineErrorResponse(error, "fallback") as { status: number }).status;
  assert.equal(status(new Error("forbidden: nope")), 403, "a forbidden error maps to 403");
  assert.equal(status(new ManageEngineNotConfiguredError("set the secrets")), 400, "not configured maps to 400");
  assert.equal(status(new ManageEngineCommandInputError("bad input")), 400, "an input error maps to 400");
  assert.equal(status(new ManageEngineRequestError(502, "upstream")), 502, "a ManageEngine request error maps to 502");
  assert.equal(status(new Error("something else")), 500, "an unknown error maps to 500");
}

export async function runManageEngineBridgeTests() {
  await runAuthTests();
  await runClientTests();
  await runDeviceTests();
  runCommandCatalogTests();
  runErrorMappingTests();
}
