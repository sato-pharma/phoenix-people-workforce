import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { POST as recordingUploadPost } from "../app/api/devices/recordings/upload/route.ts";
import {
  getHeadwindToken,
  headwindAccessHeaders,
  headwindPasswordHash,
  isHeadwindConfigured,
  HeadwindNotConfiguredError,
  resetHeadwindTokenCache,
} from "../src/lib/devices/headwind/auth.ts";
import {
  headwindActionCatalogue,
  headwindAddonBody,
  isHeadwindActionId,
  temporaryScreenLockPin,
  takeHeadwindAction,
  HEADWIND_ACTIONS,
  HEADWIND_MESSAGE_LIMIT,
  HeadwindActionError,
  PHOENIX_ALARM_INTENT,
  PHOENIX_APP_PACKAGE,
} from "../src/lib/devices/headwind/actions.ts";
import { callHeadwind, HeadwindRequestError } from "../src/lib/devices/headwind/client.ts";
import {
  headwindCommandCatalogue,
  headwindPendingReason,
  isHeadwindCommandId,
  isHeadwindCommandReady,
  issueHeadwindCommand,
  HEADWIND_COMMANDS,
  HEADWIND_MESSAGE_TYPES,
  HEADWIND_UNCONFIRMED_REASONS,
  HeadwindCommandInputError,
  HeadwindCommandUnconfirmedError,
} from "../src/lib/devices/headwind/commands.ts";
import {
  applicationLinkEntries,
  configurationBranding,
  configurationFiles,
  configurationSummary,
  configurationWriteBody,
  linkHeadwindApp,
  moveHeadwindDeviceToConfiguration,
  setHeadwindBranding,
  HEADWIND_DESKTOP_HEADER_VALUES,
  HEADWIND_DESKTOP_HEADERS,
  HEADWIND_ICON_SIZES,
  HeadwindConfigurationError,
  writeHeadwindAppLink,
} from "../src/lib/devices/headwind/configurations.ts";
import {
  fixesToPoints,
  fleetLauncherTarget,
  fleetRowsToPoints,
  launcherRank,
  summarizeFleet,
  tabletSetupReadiness,
  DASHBOARD_LOW_BATTERY,
  DASHBOARD_ONLINE_WINDOW_MS,
  type DashboardLocationFix,
} from "../src/lib/devices/headwind/dashboard.ts";
import type { RepHeadwindRow } from "../src/lib/devices/headwind/fleet.ts";
import {
  parseHeadwindEnrollmentTemplate,
  HeadwindEnrollmentError,
} from "../src/lib/devices/headwind/enrollment.ts";
import {
  getHeadwindLocationHistory,
  locationFixesFromPlugin,
  locateHeadwindDevice,
  HeadwindLocationError,
} from "../src/lib/devices/headwind/locations.ts";
import {
  clampRecordingDuration,
  hashRecordingToken,
  recordingSlotOpenDecision,
  recordingUploadDecision,
  recordingUploadLengthDecision,
  recordingUploadUrl,
  RECORDING_DEFAULT_SECONDS,
  RECORDING_MAX_BYTES,
  RECORDING_MAX_SECONDS,
  RECORDING_MIN_SECONDS,
  RECORDING_TOKEN_TTL_SECONDS,
  RECORDING_UPLOAD_ID_PARAM,
  RECORDING_UPLOAD_MAX_REQUEST_BYTES,
} from "../src/lib/devices/headwind/recordings.ts";
import {
  uploadHeadwindApp,
  HEADWIND_MAX_UPLOAD_BYTES,
  HeadwindUploadError,
} from "../src/lib/devices/headwind/uploads.ts";
import {
  consoleRolesFrom,
  consoleUsersFrom,
  createHeadwindConsoleUser,
  removeHeadwindConsoleUser,
  HEADWIND_MIN_PASSWORD,
  HeadwindUserError,
} from "../src/lib/devices/headwind/users.ts";
import {
  headwindWipeScope,
  wipeHeadwindDevice,
  HEADWIND_WIPE_APPS,
  HEADWIND_WIPE_FOLDERS,
  HeadwindWipeError,
} from "../src/lib/devices/headwind/wipe.ts";
import {
  configurationNamesFromSearch,
  deviceRecordsFromSearch,
  getHeadwindLocation,
  listHeadwindDevices,
  matchHeadwindToRegister,
  matchHeadwindToRegisterDetailed,
  type HeadwindDevice,
} from "../src/lib/devices/headwind/devices.ts";
import { headwindErrorResponse } from "../src/lib/devices/headwind/http.ts";
import { getHeadwindDeviceDetail } from "../src/lib/devices/headwind/detail.ts";
import { deviceActorNames, UNNAMED_DEVICE_ACTOR } from "../src/lib/devices/actor-names.ts";
import { cairoDateTime } from "../src/lib/format/cairo-datetime.ts";
import {
  normalizeRemoteScreenId,
  setHeadwindRemoteScreenId,
  HeadwindRemoteScreenIdError,
} from "../src/lib/devices/headwind/remote-screen-id.ts";
import {
  installedAppsFromInfo,
  isAndroidPackageName,
  removeHeadwindApp,
  HEADWIND_AGENT_PACKAGE,
  HeadwindAppInputError,
} from "../src/lib/devices/headwind/apps.ts";
import { headwindImeisToRecord, headwindTabletsToRegister } from "../src/lib/devices/headwind/register-sync.ts";
import { isRustDeskConfigured, rustDeskConfig, rustDeskPackageName, RustDeskNotConfiguredError } from "../src/lib/devices/rustdesk/config.ts";
import { rustDeskTarget } from "../src/lib/devices/rustdesk/session.ts";
import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";
import { stripComments, stripHashComments } from "./support/comment-strip.ts";
import type { RegisterTablet } from "../src/lib/devices/managed-tablets.ts";

/** Full env so `headwindAuthConfig` and the relay config are both satisfied. */
const ENV = {
  HEADWIND_MDM_BASE_URL: "https://mdm.test.local",
  HEADWIND_MDM_LOGIN: "phoenix",
  HEADWIND_MDM_PASSWORD: "a-real-password",
  RUSTDESK_RELAY_HOST: "relay.test.local",
  RUSTDESK_PUBLIC_KEY: "PUBLICKEYNOTASECRET=",
} as unknown as NodeJS.ProcessEnv;

type StubResponse = { status: number; body: unknown };

/**
 * A `fetch` stand-in that routes the JWT sign-in and the REST API apart by URL, records every call,
 * and answers each from a per-endpoint queue (last entry repeats). No network, no DB.
 *
 * A `body` that IS an `Error` is thrown out of `json()` rather than returned — that is how a reply
 * which is not JSON at all reaches the code under test. TWO different doors send one: a Cloudflare
 * Access sign-in page, and (measured 2026-09-26) Headwind's own Tomcat error page when it refuses a
 * sign-in. They are indistinguishable from here, which is why the code decides between them by
 * whether a service token is configured rather than by the shape of the reply.
 */
function makeFetch(config: { login?: StubResponse[]; api?: StubResponse[] }): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const loginQueue = [...(config.login ?? [{ body: { data: { authToken: "jwt-1" }, status: "OK" }, status: 200 }])];
  const apiQueue = [...(config.api ?? [])];

  function next(queue: StubResponse[], label: string): StubResponse {
    if (queue.length === 0) throw new Error(`stub fetch ran out of ${label} responses`);
    return queue.length === 1 ? queue[0] : queue.shift()!;
  }

  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ init, url });
    const picked = url.includes("/rest/public/jwt/login") ? next(loginQueue, "login") : next(apiQueue, "api");
    return {
      json: async () => {
        if (picked.body instanceof Error) throw picked.body;
        return picked.body;
      },
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
    lineNumber: null,
    manufacturer: null,
    model: null,
    serialNumber: null,
    simNumber: null,
    status: "assigned",
    ...overrides,
  };
}

function device(overrides: Partial<HeadwindDevice>): HeadwindDevice {
  return {
    agentVersion: null,
    batteryCharging: null,
    batteryLevel: null,
    configurationId: null,
    configurationName: null,
    deviceId: "1",
    deviceNumber: "PHX-TAB-0002",
    enrollmentStatus: "Enrolled",
    imei: null,
    info: {},
    isAndroid: true,
    lastContactAt: null,
    latitude: null,
    launcherVersion: null,
    locatedAt: null,
    longitude: null,
    manufacturer: null,
    model: null,
    name: "PHX-TAB-0002",
    osVersion: null,
    phone: null,
    platformLabel: "Android",
    rustDeskId: null,
    serialNumber: null,
    ...overrides,
  };
}

function repRow(overrides: Partial<RepHeadwindRow>): RepHeadwindRow {
  return {
    agentVersion: null,
    assetTag: null,
    assignmentId: null,
    batteryCharging: null,
    batteryLevel: null,
    configurationName: null,
    deviceNumber: "PHX-TAB-0002",
    enrollmentStatus: "Enrolled",
    holderJobTitle: null,
    holderName: null,
    imei: null,
    isAndroid: true,
    lastContactAt: null,
    latitude: null,
    launcherVersion: null,
    lineNumber: null,
    locatedAt: null,
    longitude: null,
    manufacturer: null,
    model: null,
    name: "PHX-TAB-0002",
    osVersion: null,
    placeholderName: null,
    platformLabel: "Android",
    registerDeviceId: null,
    registerStatus: null,
    rustDeskId: null,
    serialNumber: null,
    simNumber: null,
    unregistered: false,
    ...overrides,
  };
}

function source(relative: string): string {
  return readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
}

async function runAuthTests() {
  resetHeadwindTokenCache();

  assert.equal(isHeadwindConfigured({} as NodeJS.ProcessEnv), false, "no settings means not configured");
  assert.equal(isHeadwindConfigured(ENV), true, "address, login and password means configured");
  assert.equal(
    isHeadwindConfigured({ HEADWIND_MDM_BASE_URL: "   ", HEADWIND_MDM_LOGIN: "a", HEADWIND_MDM_PASSWORD: "b" } as unknown as NodeJS.ProcessEnv),
    false,
    "a blank address is no address — a bridge half-configured must not report itself ready",
  );

  await assert.rejects(
    () => getHeadwindToken(makeFetch({}).fetch, {} as NodeJS.ProcessEnv),
    HeadwindNotConfiguredError,
    "with nothing set, the bridge says what is missing instead of calling out",
  );

  // 🔴 THE PASSWORD IS SENT AS ITS MD5 HASH, NEVER AS ITSELF — Headwind's own wire format. A build
  // that "upgraded" this to SHA-256, or sent the plain password, would simply never sign in, and the
  // failure would read as a wrong credential rather than as a wrong format.
  // 🔴 AND THE HASH IS UPPER-CASE, which this pinned the wrong way round until 2026-09-26. The live
  // server's own console is the authoritative client: `login.controller.js` sends
  // `md5(password).toUpperCase()`, and `users.controller.js` writes a new password the same way — so the
  // hash in the server's column is upper-case hex. A lower-case hash matches it only if the comparison
  // is case-insensitive, which nothing has proven. The failure it would produce is the cruellest kind:
  // `errorCode=1`, "password wrong", against a password that is right.
  resetHeadwindTokenCache();
  const signIn = makeFetch({});
  assert.equal(await getHeadwindToken(signIn.fetch, ENV), "jwt-1", "the token comes out of the envelope's data");
  const sent = JSON.parse(String(signIn.calls[0].init.body)) as { login: string; password: string };
  assert.equal(sent.login, "phoenix");
  assert.equal(sent.password, createHash("md5").update("a-real-password", "utf8").digest("hex").toUpperCase());
  assert.match(sent.password, /^[0-9A-F]{32}$/, "upper-case hex, exactly as the console sends it");
  assert.notEqual(sent.password, "a-real-password", "the real password never leaves the module");
  assert.equal(headwindPasswordHash("a-real-password"), sent.password, "and the helper is what produced it");

  // Cached: a second ask makes no second sign-in.
  await getHeadwindToken(signIn.fetch, ENV);
  assert.equal(signIn.calls.length, 1, "the token is cached — a page with several cards signs in once");

  // Concurrent cold callers share ONE sign-in rather than racing several.
  resetHeadwindTokenCache();
  const cold = makeFetch({});
  await Promise.all([getHeadwindToken(cold.fetch, ENV), getHeadwindToken(cold.fetch, ENV), getHeadwindToken(cold.fetch, ENV)]);
  assert.equal(cold.calls.length, 1, "three cold callers mint once between them");

  // 🔴 THE SHAPE THIS SERVER ACTUALLY ANSWERS IN, AND THE ONE FAULT THAT COST A WHOLE NIGHT.
  // Measured against production on 2026-09-26 with the service's own injected variables:
  // `POST /rest/public/jwt/login` returns HTTP 200, application/json, `{ id_token: "<195 chars>" }` —
  // no `status`, no `message`, no `data`. `tokenFromLogin` did not look at `id_token`, so a sign-in
  // that SUCCEEDED was reported as "the Headwind server refused the Phoenix sign-in — check
  // HEADWIND_MDM_LOGIN and HEADWIND_MDM_PASSWORD". The account, the password, the hostname and the
  // hash form were each searched for a fault none of them had, while the server's own audit log
  // recorded every one of those attempts as errorCode=0. With id_token read, the token works:
  // GET /rest/private/users/roles answers 200 and lists Admin · User · Observer.
  resetHeadwindTokenCache();
  const bareIdToken = makeFetch({ login: [{ body: { id_token: "jwt-id-token" }, status: 200 }] });
  assert.equal(
    await getHeadwindToken(bareIdToken.fetch, ENV),
    "jwt-id-token",
    "a top-level id_token with no envelope at all is the token — this server's real shape",
  );
  resetHeadwindTokenCache();

  // Other token spellings some builds answer with, and a refusal.
  for (const body of [{ data: "jwt-bare" }, { token: "jwt-bare" }, { data: { jwt: "jwt-bare" } }]) {
    resetHeadwindTokenCache();
    assert.equal(
      await getHeadwindToken(makeFetch({ login: [{ body, status: 200 }] }).fetch, ENV),
      "jwt-bare",
      "a token under a different name is still found — a server upgrade must not silently break sign-in",
    );
  }
  resetHeadwindTokenCache();
  await assert.rejects(
    () => getHeadwindToken(makeFetch({ login: [{ body: { message: "Wrong password", status: "ERROR" }, status: 200 }] }).fetch, ENV),
    (error: unknown) =>
      error instanceof HeadwindNotConfiguredError && /Wrong password/.test(error.message) && /HEADWIND_MDM_LOGIN/.test(error.message),
    "a refusal names what the server said AND which settings to check",
  );
  resetHeadwindTokenCache();
}

async function runClientTests() {
  resetHeadwindTokenCache();

  // The happy path: bearer header, the base from env, and the envelope's `data` unwrapped.
  const ok = makeFetch({ api: [{ body: { data: { items: [{ number: "A" }] }, status: "OK" }, status: 200 }] });
  const payload = await callHeadwind<{ items: unknown[] }>("/rest/private/devices/search", { method: "POST" }, ok.fetch, ENV);
  assert.deepEqual(payload, { items: [{ number: "A" }] }, "callers receive the payload, not the wrapper");
  const apiCall = ok.calls.find((call) => call.url.includes("/rest/private/"))!;
  assert.equal(apiCall.url, "https://mdm.test.local/rest/private/devices/search");
  assert.equal((apiCall.init.headers as Record<string, string>).authorization, "Bearer jwt-1");

  // 🔴 THE ONE THAT MATTERS: Headwind can refuse inside an HTTP 200. Reading `response.ok` alone
  // would turn "that device does not exist" into a successful read of an empty fleet — a whole fleet
  // silently reporting zero tablets is the fabricated zero this repo's rules exist to stop.
  resetHeadwindTokenCache();
  const refused = makeFetch({ api: [{ body: { message: "No such device", status: "ERROR" }, status: 200 }] });
  await assert.rejects(
    () => callHeadwind("/rest/private/devices/search", { method: "POST" }, refused.fetch, ENV),
    (error: unknown) => error instanceof HeadwindRequestError && error.message === "No such device",
    "a refusal wearing a 200 is an error carrying the server's own sentence",
  );

  // A 401 clears the token and retries ONCE — and only once, so a genuinely wrong credential fails
  // fast instead of looping.
  resetHeadwindTokenCache();
  const expired = makeFetch({
    api: [
      { body: { message: "token expired", status: "ERROR" }, status: 401 },
      { body: { data: { ok: true }, status: "OK" }, status: 200 },
    ],
    login: [
      { body: { data: { authToken: "jwt-1" }, status: "OK" }, status: 200 },
      { body: { data: { authToken: "jwt-2" }, status: "OK" }, status: 200 },
    ],
  });
  assert.deepEqual(await callHeadwind("/rest/private/devices/search", {}, expired.fetch, ENV), { ok: true });
  assert.equal(expired.calls.filter((call) => call.url.includes("/jwt/login")).length, 2, "the token was minted again");
  assert.equal(
    (expired.calls.at(-1)!.init.headers as Record<string, string>).authorization,
    "Bearer jwt-2",
    "and the retry carried the NEW token, not the dead one",
  );

  // An expired session that arrives as a 200 is treated the same way — some builds answer that way.
  resetHeadwindTokenCache();
  const softExpired = makeFetch({
    api: [
      { body: { message: "Session token is invalid", status: "ERROR" }, status: 200 },
      { body: { data: { ok: true }, status: "OK" }, status: 200 },
    ],
    login: [
      { body: { data: { authToken: "jwt-1" }, status: "OK" }, status: 200 },
      { body: { data: { authToken: "jwt-2" }, status: "OK" }, status: 200 },
    ],
  });
  assert.deepEqual(await callHeadwind("/rest/private/devices/search", {}, softExpired.fetch, ENV), { ok: true });

  // But a 401 that keeps failing stops after one retry rather than looping.
  resetHeadwindTokenCache();
  const alwaysDead = makeFetch({ api: [{ body: { message: "Unauthorized" }, status: 401 }] });
  await assert.rejects(
    () => callHeadwind("/rest/private/devices/search", {}, alwaysDead.fetch, ENV),
    (error: unknown) => error instanceof HeadwindRequestError && error.status === 401,
  );
  assert.equal(alwaysDead.calls.filter((call) => call.url.includes("/rest/private/")).length, 2, "tried twice, never more");
  resetHeadwindTokenCache();

  // 🔴 A REQUEST THAT NEVER REACHED A SERVER USED TO SURFACE AS "fetch failed" AND NOTHING ELSE.
  // Every refusal above carries Headwind's own sentence, but a transport failure escaped `callHeadwind`
  // untouched and landed on the generic 500 branch of `headwindErrorResponse` — so the page named
  // neither the address it tried nor anything to do about it. A wrong base URL produces exactly that.
  const dead = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => callHeadwind("/rest/private/devices/search", {}, dead, ENV),
    (error: unknown) =>
      error instanceof HeadwindRequestError &&
      error.status === 502 &&
      error.message.includes("https://mdm.test.local") &&
      /never reached a server/.test(error.message),
    "a request that never reached a server is a 502 naming the address it tried, not an unexplained 500",
  );
  resetHeadwindTokenCache();

  // 🔴 AND THE PRIVATE-NETWORK ADDRESS GETS ITS OWN SENTENCE, because that is the one setting whose
  // only plausible failure is a name that does not resolve. Phoenix and the Headwind box are the same
  // Railway project, so HEADWIND_MDM_BASE_URL can be http://phoenix-headwind.railway.internal:8080 and
  // skip Cloudflare — and skip needing an Access service token at all. But that network is IPv6-only
  // and reachable from no laptop, so the failure has to say so itself rather than read as a dead server.
  await assert.rejects(
    () =>
      callHeadwind("/rest/private/devices/search", {}, dead, {
        ...ENV,
        HEADWIND_MDM_BASE_URL: "http://phoenix-headwind.railway.internal:8080",
      } as unknown as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof HeadwindRequestError &&
      /IPv6-only/.test(error.message) &&
      /same project and environment/.test(error.message) &&
      error.message.includes("https://mdm-console.satopharma.com"),
    "an unreachable railway.internal address explains the private network, that no laptop can reach it, and names the public fallback",
  );
  resetHeadwindTokenCache();

  // 🔴 AND A REFUSED SIGN-IN IS NOT A TRANSPORT FAILURE, WHICH IS EXACTLY WHAT PRODUCTION SHOWED THE
  // FIRST TIME THE CREDENTIALS WERE REAL (2026-09-26). `once()` mints the token inside the same `try`,
  // so a wrong login or password throws HeadwindNotConfiguredError from in there and was rewrapped as
  // "the request never reached a server … Check HEADWIND_MDM_BASE_URL first." The page printed the right
  // diagnosis and then contradicted it, ending on the one value that was correct — and the base URL is
  // the single hardest thing to re-derive, so that advice costs an evening. Headwind's own account of a
  // refusal must reach the page untouched.
  const refusedSignIn = makeFetch({ login: [{ body: new Error("<!doctype html> HTTP Status 401"), status: 401 }] });
  await assert.rejects(
    () => callHeadwind("/rest/private/devices/search", {}, refusedSignIn.fetch, ENV),
    (error: unknown) =>
      error instanceof HeadwindNotConfiguredError &&
      /HEADWIND_MDM_LOGIN and HEADWIND_MDM_PASSWORD/.test(error.message) &&
      !/never reached a server/.test(error.message) &&
      !/Check HEADWIND_MDM_BASE_URL first/.test(error.message),
    "a refused sign-in keeps naming the login and the password, and is never rewritten into an address, DNS or network fault",
  );
  resetHeadwindTokenCache();
}

async function runDeviceTests() {
  resetHeadwindTokenCache();

  // 🔴 `info` ARRIVES AS A JSON STRING ON SOME AGENT VERSIONS. Read as an object it would be dropped
  // whole, and a tablet would show no model, no battery, no serial and no position at all.
  const infoAsString = JSON.stringify({
    androidVersion: "13",
    batteryLevel: 84,
    imei: "865569071549107",
    location: { lat: 30.0444, lon: 31.2357, ts: 1_758_800_000_000 },
    manufacturer: "Lenovo",
    model: "TB328XU",
    serial: "HA1ABCDE",
  });
  const listed = makeFetch({
    api: [
      {
        body: {
          data: {
            items: [
              {
                configName: "Rep tablets",
                custom1: "123456789",
                description: "Alaa's tablet",
                id: 7,
                info: infoAsString,
                lastUpdate: 1_758_900_000_000,
                launcherVersion: "5.30",
                number: "PHX-TAB-0002",
              },
              // A record with no device number cannot be commanded and is dropped rather than shown.
              { description: "half a row", id: 8 },
            ],
          },
          status: "OK",
        },
        status: 200,
      },
    ],
  });

  const devices = await listHeadwindDevices(listed.fetch, ENV);
  assert.equal(devices.length, 1, "a row with no device number is dropped — nothing could be aimed at it");
  const [first] = devices;
  assert.equal(first.deviceNumber, "PHX-TAB-0002", "the NUMBER is what a command is addressed to");
  assert.equal(first.deviceId, "7", "and the row id is kept apart from it, never confused with it");
  assert.equal(first.name, "Alaa's tablet");
  assert.equal(first.model, "TB328XU");
  assert.equal(first.manufacturer, "Lenovo");
  assert.equal(first.serialNumber, "HA1ABCDE");
  assert.equal(first.imei, "865569071549107");
  assert.equal(first.osVersion, "13");
  assert.equal(first.batteryLevel, 84);
  assert.equal(first.configurationName, "Rep tablets");
  assert.equal(first.agentVersion, "5.30");
  assert.equal(first.rustDeskId, "123456789", "the screen-session id lives in Headwind's first custom field");
  assert.equal(first.latitude, 30.0444);
  assert.equal(first.longitude, 31.2357);
  assert.equal(first.lastContactAt, new Date(1_758_900_000_000).toISOString());
  assert.equal(first.enrollmentStatus, "Enrolled");

  // The search is a POST with the filter in the BODY — a GET reaches nothing here.
  const search = listed.calls.find((call) => call.url.includes("/rest/private/devices/search"))!;
  assert.equal(search.init.method, "POST");
  assert.ok(String(search.init.body).includes("pageSize"), "and it names a page size, so a growing fleet is not cut short");

  // 🔴 THE LIVE SERVER NESTS THE PAGE UNDER `devices`, AND THE FLAT-ONLY READ ANSWERED "no tablets"
  // AGAINST A SERVER HOLDING TWO (production, 2026-09-26). This is the envelope mdm.satopharma.com
  // actually answered with — the page of devices beside a map of the configurations they sit on. Every
  // fixture above uses the flat shape, which is why the bridge's own tests were green while the
  // tablets page was empty: a fixture that agrees with the guess proves the guess, not the server.
  resetHeadwindTokenCache();
  const nested = await listHeadwindDevices(
    makeFetch({
      api: [
        {
          body: {
            data: {
              configurations: { "3": { applications: [], files: [], id: 3, name: "Rep tablets" } },
              devices: {
                items: [{ configurationId: 3, id: 11, lastUpdate: 0, number: "PHX-TAB-0002" }],
                totalItemsCount: 2,
              },
            },
            status: "OK",
          },
          status: 200,
        },
      ],
    }).fetch,
    ENV,
  );
  assert.equal(nested.length, 1, "the fleet reads the page Headwind nests under `devices`");
  assert.equal(nested[0]?.deviceNumber, "PHX-TAB-0002", "and the tablet keeps its number through the nesting");
  // 🔴 AND THE RULES IT SITS ON COME FROM THE SIBLING MAP, NOT FROM THE DEVICE ROW. A live row carries
  // only `configurationId, description, groups, id, lastUpdate, number, statusCode`, so reading the
  // device alone showed every tablet with no configuration at all — measured against the live server,
  // where PHX-TAB-0002 sits on `Rep tablets` and read `null`.
  assert.equal(nested[0]?.configurationName, "Rep tablets", "the configuration's NAME is read from the reply's own map");
  assert.equal(nested[0]?.configurationId, "3");
  const names = configurationNamesFromSearch({ configurations: { "3": { applications: [], id: 3, name: "Rep tablets" } } });
  assert.equal(names.get("3"), "Rep tablets", "by the map's key");
  assert.equal(names.size, 1, "and the id and the key are the same entry when they agree");
  assert.equal(configurationNamesFromSearch({ configurations: [] }).size, 0, "an array is not a map of configurations");
  assert.equal(configurationNamesFromSearch(null).size, 0, "and nothing at all is no names");

  // The unwrapper on every shape it has to survive, so neither half of the fix can be dropped alone.
  assert.equal(deviceRecordsFromSearch({ devices: { items: [{ number: "A" }] } }).length, 1, "the live nested page");
  assert.equal(deviceRecordsFromSearch({ items: [{ number: "A" }] }).length, 1, "a flat page");
  assert.equal(deviceRecordsFromSearch({ devices: [{ number: "A" }] }).length, 1, "devices as a bare array");
  assert.equal(deviceRecordsFromSearch([{ number: "A" }]).length, 1, "the array on its own");
  assert.deepEqual(deviceRecordsFromSearch({ devices: { totalItemsCount: 0 } }), [], "a genuinely empty page");
  assert.deepEqual(deviceRecordsFromSearch(null), [], "and nothing at all");
  // 🔴 A SHAPE IT CANNOT PLACE IS AN ERROR, NEVER AN EMPTY FLEET — the 2026-09-26 outage read as "no
  // tablets" precisely because an unknown shape fell through to [].
  for (const unreadable of [{ devices: { page: 1 } }, { configurations: {} }, "nonsense"] as const) {
    assert.throws(() => deviceRecordsFromSearch(unreadable), HeadwindRequestError, `an unreadable reply (${JSON.stringify(unreadable)}) says so`);
  }

  // 🔴 AND THE OTHER TWO READERS OF THAT SEARCH GO THROUGH IT. Both had their own copy of the flat
  // read: one reported no installed apps for every tablet, the other refused every configuration move
  // with "that tablet is not in the Headwind fleet any more".
  for (const file of ["src/lib/devices/headwind/apps.ts", "src/lib/devices/headwind/configurations.ts"] as const) {
    const text = stripComments(source(file));
    assert.ok(text.includes("deviceRecordsFromSearch"), `${file} unwraps the device search through the shared reader`);
    assert.ok(!/payload\.items|found\?\.items|found\.items/.test(text), `${file} does not read the flat page itself`);
  }

  // A malformed info blob loses the blob, never the device.
  resetHeadwindTokenCache();
  const broken = await listHeadwindDevices(
    makeFetch({ api: [{ body: { data: { items: [{ info: "{not json", number: "B" }] }, status: "OK" }, status: 200 }] }).fetch,
    ENV,
  );
  assert.equal(broken.length, 1, "the tablet still appears");
  assert.equal(broken[0].model, null, "with its unreadable facts simply absent");

  // The position read answers honestly for a tablet that has never reported one.
  resetHeadwindTokenCache();
  const noFix = await getHeadwindLocation(
    "C",
    makeFetch({ api: [{ body: { data: { items: [{ number: "C" }] }, status: "OK" }, status: 200 }] }).fetch,
    ENV,
  );
  assert.deepEqual(noFix, { address: null, latitude: null, locatedAt: null, longitude: null });

  // 🔴 An unreadable device list must not throw away a movement trail the plugin already answered with —
  // and the refusal it raises no longer claims "nothing was changed", since it can follow a write.
  resetHeadwindTokenCache();
  const trail = await getHeadwindLocationHistory(
    "D",
    makeFetch({
      api: [
        { body: { data: { sendData: true }, status: "OK" }, status: 200 },
        {
          body: { data: { items: [{ gpsLat: 30.05, gpsLon: 31.24, latestUpdateTime: 1_760_000_000_000 }] }, status: "OK" },
          status: 200,
        },
        { body: { data: { someFutureShape: true }, status: "OK" }, status: 200 },
      ],
    }).fetch,
    ENV,
  );
  assert.equal(trail.fixes.length, 1, "the plugin's fix survives an unreadable device list");
  assert.equal(trail.fixes[0].source, "plugin");
  resetHeadwindTokenCache();
  await assert.rejects(
    getHeadwindLocationHistory(
      "D",
      makeFetch({
        api: [
          { body: { data: { sendData: true }, status: "OK" }, status: 200 },
          { body: { data: { items: [] }, status: "OK" }, status: 200 },
          { body: { data: { someFutureShape: true }, status: "OK" }, status: 200 },
        ],
      }).fetch,
      ENV,
    ),
    (error: Error) => /cannot read/.test(error.message) && !/Nothing was changed/.test(error.message),
    "with no trail at all, the unreadable list is still reported, without claiming nothing changed",
  );
  resetHeadwindTokenCache();
}

function runMatcherTests() {
  const bySerial = register({ id: "reg-serial", serialNumber: "ha1abcde" });
  const byImei = register({ assetTag: "PHX-TAB-0009", id: "reg-imei", imei: "35-123456-789012-3" });

  assert.equal(
    matchHeadwindToRegister(device({ serialNumber: "HA1ABCDE" }), [bySerial, byImei])?.id,
    "reg-serial",
    "the serial matches whatever its casing",
  );
  assert.equal(
    matchHeadwindToRegister(device({ imei: "351234567890123" }), [byImei])?.id,
    "reg-imei",
    "and an IMEI matches through the punctuation somebody typed",
  );
  assert.equal(matchHeadwindToRegister(device({}), [bySerial, byImei]), null, "a tablet carrying neither matches nothing");

  const detailed = matchHeadwindToRegisterDetailed(device({ imei: "351234567890123" }), [byImei]);
  assert.equal(detailed?.bySerial, false, "an IMEI match says so — it is a weaker claim than a serial");
}

function runRegisterSyncTests() {
  const known = register({ id: "reg-1", serialNumber: "HA1ABCDE" });

  // A tablet the register has never seen is offered up; one it knows is not offered twice.
  const missing = headwindTabletsToRegister(
    [device({ deviceNumber: "A", manufacturer: "Lenovo", model: "TB328XU", serialNumber: "NEW-SERIAL" }), device({ serialNumber: "HA1ABCDE" })],
    [known],
  );
  assert.equal(missing.length, 1);
  assert.deepEqual(missing[0], { imei: null, manufacturer: "Lenovo", model: "TB328XU", serialNumber: "NEW-SERIAL" });

  // A tablet carrying neither a serial nor an IMEI is refused — nothing would tell it from the next.
  assert.deepEqual(headwindTabletsToRegister([device({ deviceNumber: "Z" })], []), []);

  // Two devices reporting one serial are added ONCE.
  assert.equal(
    headwindTabletsToRegister([device({ deviceNumber: "A", serialNumber: "SAME" }), device({ deviceNumber: "B", serialNumber: "same" })], []).length,
    1,
  );

  // The IMEI copy: only onto an entry the tablet's own SERIAL confirmed, and never over one a person
  // typed.
  const empty = register({ assetTag: "PHX-TAB-0002", id: "reg-empty", imei: null, serialNumber: "HA1ABCDE" });
  assert.deepEqual(headwindImeisToRecord([device({ imei: "351234567890123", serialNumber: "HA1ABCDE" })], [empty]), [
    { assetTag: "PHX-TAB-0002", imei: "351234567890123", registerDeviceId: "reg-empty" },
  ]);

  const typed = register({ id: "reg-typed", imei: "999999999999999", serialNumber: "HA1ABCDE" });
  assert.deepEqual(
    headwindImeisToRecord([device({ imei: "351234567890123", serialNumber: "HA1ABCDE" })], [typed]),
    [],
    "a number a person typed is never overwritten, even when the tablet disagrees",
  );

  const elsewhere = register({ id: "reg-other", imei: "351234567890123", serialNumber: "OTHER" });
  assert.deepEqual(
    headwindImeisToRecord([device({ imei: "351234567890123", serialNumber: "HA1ABCDE" })], [empty, elsewhere]),
    [],
    "an IMEI another entry already holds is held back rather than duplicated",
  );

  // A tie — two tablets claiming one entry — writes nothing at all rather than guessing.
  const twins = [
    device({ deviceNumber: "A", imei: "351234567890123", serialNumber: "HA1ABCDE" }),
    device({ deviceNumber: "B", imei: "351234567890999", serialNumber: "HA1ABCDE" }),
  ];
  assert.deepEqual(headwindImeisToRecord(twins, [empty]), [], "a tie is held back, never resolved by guessing");
}

async function runCommandTests() {
  // 🔴 EVERY NAME HERE IS READ OFF HEADWIND'S OWN AGENT SOURCE, AND NONE IS A GUESS. The agent's
  // `PushMessage.java` declares the literal strings it accepts and `PushNotificationProcessor.java`
  // says what each one does, both public. A name outside that set produces a button that answers 200
  // and reaches no tablet — worse than no button on a custody console — so the exact set is pinned.
  assert.equal(HEADWIND_MESSAGE_TYPES.APPLY_SETTINGS, "configUpdated", "TYPE_CONFIG_UPDATED: re-read your whole configuration");
  assert.equal(HEADWIND_MESSAGE_TYPES.WAKE_REMOTE_APP, "runApp", "TYPE_RUN_APP: start this package");
  assert.equal(HEADWIND_MESSAGE_TYPES.REBOOT, "reboot", "TYPE_REBOOT → Utils.reboot() → dpm.reboot()");
  assert.equal(HEADWIND_MESSAGE_TYPES.PAUSE_KIOSK, "exitKiosk", "TYPE_EXIT_KIOSK, a TEMPORARY exit");
  assert.equal(
    HEADWIND_MESSAGE_TYPES.RESUME_KIOSK,
    "configUpdated",
    "there is no enterKiosk — the temporary exit ends when the agent re-reads its configuration, so resuming IS the config update",
  );

  // 🔴 EVERY NAME MUST BE ONE THE AGENT ACTUALLY ACCEPTS. This is the guard against a plausible-looking
  // invention: `lockDevice`, `factoryReset` and `locate` all read like real names and are not in the
  // agent's dispatcher at all.
  const AGENT_ACCEPTS = new Set([
    "configUpdating", "configUpdated", "runApp", "broadcast", "uninstallApp", "deleteFile", "purgeDir",
    "deleteDir", "permissiveMode", "runCommand", "reboot", "exitKiosk", "clearDownloadHistory", "intent",
    "grantPermissions", "adminPanel", "clearAppData",
  ]);
  for (const [id, wire] of Object.entries(HEADWIND_MESSAGE_TYPES)) {
    if (wire === null) continue;
    assert.ok(AGENT_ACCEPTS.has(wire), `${id} sends "${wire}", which Headwind's agent does not accept — see PushMessage.java`);
  }

  const notPushed = Object.entries(HEADWIND_MESSAGE_TYPES)
    .filter(([, value]) => value === null)
    .map(([id]) => id)
    .sort();
  assert.deepEqual(
    notPushed,
    ["FACTORY_RESET", "LOCATE_NOW", "LOCK"],
    "🔴 a null here means CARRIED ANOTHER WAY, never 'not built' — lock and factory reset are fields of the configuration the agent DOWNLOADS, and a position rides on the check-in report. None of the three is a push message, and inventing a name for one would answer 200 and reach no tablet",
  );

  // Every action in the catalogue has a line in the map, and vice versa: an action with no line would
  // crash at the press, and a line with no action would be dead.
  assert.deepEqual(
    HEADWIND_COMMANDS.map((command) => command.id).sort(),
    Object.keys(HEADWIND_MESSAGE_TYPES).sort(),
    "the catalogue and the wire-name map name the same actions",
  );
  assert.equal(HEADWIND_COMMANDS.filter((command) => command.destructive).length, 1, "exactly one action erases a tablet");

  assert.equal(isHeadwindCommandId("REBOOT"), true);
  assert.equal(isHeadwindCommandId("LOST_MODE"), false, "an action this bridge does not have is refused, never passed through");
  assert.equal(isHeadwindCommandReady("APPLY_SETTINGS"), true);
  assert.equal(isHeadwindCommandReady("REBOOT"), true, "restart is live: the agent's own source names it");

  // 🔴 THE CORRECTION OF 2026-09-25, PINNED SO IT CANNOT QUIETLY REVERT. These three were greyed on the
  // tablet panel for a reason that was wrong about WHERE the gap is. The free AGENT has always
  // implemented lock, the lock message and the factory reset (`hmdm-android` 6.39, `c9221a1f`); it is
  // the open-source SERVER that has nowhere to write the instruction — and a server we own can be
  // extended. Reading a `null` wire name as "not ready" is exactly the regression that would grey all
  // three again, so readiness and the wire-name map are pinned apart.
  for (const id of ["LOCK", "FACTORY_RESET", "LOCATE_NOW"] as const) {
    assert.equal(HEADWIND_MESSAGE_TYPES[id], null, `${id} is genuinely not a push message`);
    assert.equal(isHeadwindCommandReady(id), true, `${id} is carried by another module — not refused`);
    assert.equal(headwindPendingReason(id), null, `${id} therefore carries no refusal sentence either`);
  }
  assert.deepEqual(
    HEADWIND_UNCONFIRMED_REASONS,
    {},
    "and nothing is hard-coded as a limit of the product any more — the one thing that can still stop these is a box built without the add-on, which is decided against the LIVE box in actions.ts rather than asserted here",
  );

  const catalogue = headwindCommandCatalogue();
  assert.equal(catalogue.length, HEADWIND_COMMANDS.length, "the console is told about every action");
  assert.equal(
    catalogue.filter((entry) => entry.ready).length,
    HEADWIND_COMMANDS.length,
    "🔴 and every one of them can be carried — the owner's ruling, 2026-09-25, was that a dead button is not an acceptable answer",
  );

  // The invariant outlives the current set, which is why it stays a loop: an action that refuses must
  // say why, and one that works must never carry a refusal sentence beside it.
  for (const entry of catalogue) {
    assert.equal(
      entry.pendingReason === null,
      entry.ready,
      `${entry.id}: an action that refuses must say why, and one that works must not carry a refusal`,
    );
  }

  const untouched = makeFetch({ api: [{ body: { status: "OK" }, status: 200 }] });
  await assert.rejects(
    () => issueHeadwindCommand({ command: "APPLY_SETTINGS", deviceNumber: "   " }, "B-10", untouched.fetch, ENV),
    HeadwindCommandInputError,
    "a command with no tablet named is refused before anything else happens",
  );
  assert.equal(untouched.calls.length, 0, "and nothing at all was sent — no sign-in, no push");

  // 🔴 THE DELEGATION IS REAL, NOT A LABEL. `LOCK` is one of the buttons already on the tablet panel, so
  // the correction had to reach THAT button rather than only a new one beside it. Here the box answers
  // 404 for the add-on, and the refusal that comes back is the add-on's own sentence — which is how a
  // console that has not been rebuilt says what would make the button work instead of greying it.
  const noAddon = makeFetch({
    api: [
      { body: { data: { items: [{ id: 7, number: "PHX-TAB-0002" }] }, status: "OK" }, status: 200 },
      { body: { message: "not found", status: "ERROR" }, status: 404 },
    ],
  });
  await assert.rejects(
    () => issueHeadwindCommand({ command: "LOCK", deviceNumber: "PHX-TAB-0002" }, "B-10", noAddon.fetch, ENV),
    (error: unknown) =>
      error instanceof HeadwindActionError &&
      /add-on/.test(error.message) &&
      /tablets themselves already know how to do this/.test(error.message),
    "a box without the add-on refuses in words that name the fix — and blames the server, not the tablet",
  );
  assert.ok(
    noAddon.calls.some((call) => call.url.includes("/rest/plugins/phoenix-actions/private/status")),
    "and it ASKED the box rather than assuming either way",
  );

  // The wire shape is pinned at the source, because sending it for real needs the database.
  const commands = stripComments(source("src/lib/devices/headwind/commands.ts"));
  assert.match(commands, /"\/rest\/private\/push"/, "every action goes down the one push endpoint");
  assert.match(commands, /deviceNumbers: \[target\.deviceNumber\]/, "addressed by device NUMBER — an id would reach nothing and report success");
  assert.doesNotMatch(commands, /deviceNumbers: \[[^\]]*deviceId/, "and never by the server's row id");
  assert.match(commands, /payload: payloadFor\(/, "the payload is built by the one function that knows it must be a STRING");
  assert.match(commands, /entityType: "headwind_device_command"/, "and every action that lands writes a required audit row");

  // 🔴 THE ORDER INSIDE `issueHeadwindCommand` IS THE WHOLE CORRECTION. Delegation is decided BEFORE the
  // null-wire-name check; the other way round, all three would refuse again while the code still read as
  // though it delegated — a regression no message string would reveal.
  assert.ok(
    commands.indexOf("const delegate = DELEGATED[def.id]") < commands.indexOf("if (messageType === null)"),
    "the delegation is decided before the null check, not after it",
  );
  assert.match(commands, /await locateHeadwindDevice\(/, "LOCATE_NOW goes to locations.ts, which returns the position WITH ITS AGE");
  assert.match(commands, /await takeHeadwindAction\(/, "LOCK and FACTORY_RESET go to actions.ts, which asks the live box about the add-on");

  // The refusal machinery is KEPT although nothing uses it today — the next action Phoenix cannot send
  // has to be listed and explained, and deleting this is how a future `null` becomes a silent no-op.
  assert.match(commands, /if \(messageType === null\)/, "the guard for an unsendable action survives");
  assert.match(commands, /throw new HeadwindCommandUnconfirmedError/, "and it throws rather than reporting a success");
}

function runAppsTests() {
  const info = JSON.stringify({
    applications: [
      { name: "RustDesk", pkg: "com.carriez.flutter_hbb", version: "1.2.3" },
      { packageName: "com.phoenix.reps" },
      { name: "Headwind MDM", pkg: HEADWIND_AGENT_PACKAGE },
      { name: "no package at all" },
    ],
  });
  const apps = installedAppsFromInfo(info, rustDeskPackageName(ENV));
  assert.equal(apps.length, 3, "an app with no package cannot be acted on and is dropped");
  const rustdesk = apps.find((app) => app.packageName === "com.carriez.flutter_hbb")!;
  assert.equal(rustdesk.isRemoteScreenApp, true, "the screen-sharing app is marked so a tablet missing it is obvious");
  assert.equal(apps.find((app) => app.packageName === "com.phoenix.reps")!.name, "com.phoenix.reps", "an unnamed app reads as its package, never as blank");
  assert.deepEqual(installedAppsFromInfo("{not json", "x"), [], "an unreadable blob is an empty list, never a throw");
  assert.deepEqual(installedAppsFromInfo({ applications: "nope" }, "x"), []);

  // 🔴 THE SERVER MARKS THE MANAGEMENT APP, NOT THE BROWSER. The console hides the Remove button on
  // whatever this flag says, so if it were computed in the component the button and the guard that
  // actually stops the push could drift apart — and the drift would only show the day somebody
  // removed the agent from a tablet in a rep's bag.
  assert.equal(
    apps.find((app) => app.packageName === HEADWIND_AGENT_PACKAGE)!.isManagementApp,
    true,
    "the agent that manages the tablet is marked by the server",
  );
  assert.equal(rustdesk.isManagementApp, false, "and nothing else is");

  assert.equal(HEADWIND_AGENT_PACKAGE, "com.hmdm.launcher", "the agent's own applicationId, one flavour, no suffix");
  assert.equal(isAndroidPackageName("com.carriez.flutter_hbb"), true);
  assert.equal(isAndroidPackageName("nodots"), false, "a package name has at least two segments");
  assert.equal(isAndroidPackageName("9lives.app"), false, "a segment starts with a letter");
  assert.equal(isAndroidPackageName("com.a b"), false, "and carries no spaces");
}

/**
 * Taking one app off one tablet.
 *
 * 🔴 THIS WAS REPORTED AS BLOCKED ON A SERVER THAT DID NOT EXIST, AND IT NEVER WAS. `uninstallApp` is
 * one of the seventeen names Headwind's own agent declares, and its payload is a single `pkg` key —
 * readable in public the whole time. The tests below pin the wire shape against that source.
 */
async function runAppRemovalTests() {
  // 🔴 THE MANAGEMENT APP IS REFUSED BEFORE ANYTHING IS SENT. Removing the agent does not produce an
  // unmanaged tablet; it produces a tablet that can never be managed again without a factory reset by
  // hand, on a device in a rep's bag in another governorate.
  const untouched = makeFetch({ api: [{ body: { status: "OK" }, status: 200 }] });
  await assert.rejects(
    () => removeHeadwindApp({ deviceNumber: "PHX-TAB-0002", packageName: HEADWIND_AGENT_PACKAGE }, "B-10", untouched.fetch, ENV),
    HeadwindAppInputError,
    "the app that manages the tablet is never removed",
  );
  await assert.rejects(
    () => removeHeadwindApp({ deviceNumber: "PHX-TAB-0002", packageName: "not a package" }, "B-10", untouched.fetch, ENV),
    HeadwindAppInputError,
    "and a typo is refused rather than pushed — uninstallApp on a package the tablet lacks is a silent 200",
  );
  await assert.rejects(
    () => removeHeadwindApp({ deviceNumber: "  ", packageName: "com.phoenix.reps" }, "B-10", untouched.fetch, ENV),
    HeadwindAppInputError,
    "and a removal with no tablet named",
  );
  assert.equal(untouched.calls.length, 0, "none of those reached the network at all — not even a sign-in");

  // 🔴 THE WIRE SHAPE, AGAINST THE AGENT'S OWN DISPATCHER. `payload.getString("pkg")` is what the
  // agent reads, and the payload is a STRING containing JSON, not a JSON object.
  const sent = makeFetch({
    api: [
      { body: { data: { items: [{ id: 7, number: "PHX-TAB-0002" }] }, status: "OK" }, status: 200 },
      { body: { status: "OK" }, status: 200 },
    ],
  });
  // 🔴 ONE SENTENCE FOR "THAT TABLET IS GONE", WHICHEVER ACTION ASKED. The resolver is shared with the
  // remote actions, so a removal and a restart cannot come to disagree about what a missing tablet is;
  // both map to 400 in `headwindErrorResponse`.
  await assert.rejects(
    () => removeHeadwindApp({ deviceNumber: "PHX-TAB-0003", packageName: "com.phoenix.reps" }, "B-10", sent.fetch, ENV),
    HeadwindCommandInputError,
    "a tablet that has left the fleet cannot be acted on — the removal is resolved against the LIVE list",
  );

  // The push itself needs the custody register, so its exact body is pinned at the source instead.
  const apps = stripComments(source("src/lib/devices/headwind/apps.ts"));
  assert.match(apps, /messageType: "uninstallApp"/, "TYPE_UNINSTALL_APP — the agent's own name for it");
  assert.match(apps, /payload: JSON\.stringify\(\{ pkg: packageName \}\)/, "a STRING containing JSON, keyed `pkg`, which is the one key the agent reads");
  assert.match(apps, /deviceNumbers: \[target\.deviceNumber\]/, "addressed by device NUMBER, never by the server's row id");
  assert.match(apps, /entityType: "headwind_device_command"/, "and a silent removal writes a REQUIRED audit row");
  assert.match(apps, /packageName \}/, "which names the package, so the audit says what was taken off");

  // 🔴 THE ROUTE MAY NOT BECOME A SECOND INSTALL PATH BY GUESSWORK. There is no `installApp` message
  // on this server: an app arrives because it is in the tablet's configuration. A name invented here
  // would answer 200 and install nothing.
  assert.doesNotMatch(apps, /messageType: "installApp"/, "there is no installApp message to send");

  const route = stripComments(source("app/api/devices/headwind/apps/route.ts"));
  assert.match(route, /assertPermission\(access, "company_devices", "approve"\)/, "Super Admin only, on the route");
  assert.match(route, /const csrf = assertSameOriginMutation\(request\);\s*if \(csrf\) return csrf;/);
  assert.doesNotMatch(route, /export async function GET/, "reading the app list stays on the fleet route — this one only removes");
}

/**
 * Phase 1 — the corporate wipe.
 *
 * 🔴 THE LIST IS THE OWNER'S OWN ANSWER AND IS NOT A SETTING. He was asked both questions in writing on
 * 2026-09-25 and chose the camera roll over the option that would have spared it, knowing field photos
 * live there. A later pass that "improves" this into a form the console can aim is the regression these
 * assertions exist to stop — a wipe that can be aimed is a wipe that can be mis-aimed.
 */
async function runCorporateWipeTests() {
  const scope = headwindWipeScope();
  assert.deepEqual(scope.apps, ["the Phoenix app", "Chrome"], "the apps he chose, in the order they are sent");
  assert.deepEqual(
    scope.folders,
    ["Downloads", "the camera roll, including field photos"],
    "🔴 and the camera roll says out loud that it takes field photos — the second press has to name what goes, because nothing on the tablet will",
  );

  // 🔴 THE MANAGEMENT AGENT IS NOT IN THE LIST AND MUST NEVER BE. `clearAppData` on `com.hmdm.launcher`
  // empties the agent's own store — its server address, its device number, its enrolment — leaving a
  // tablet that is still device-owned by an app that no longer knows where home is. That is
  // unrecoverable without physically holding the tablet, in a rep's bag in another governorate.
  assert.ok(
    !HEADWIND_WIPE_APPS.some((app) => app.packageName === HEADWIND_AGENT_PACKAGE),
    "the agent that manages the tablet is never one of the apps cleared",
  );
  assert.equal(HEADWIND_WIPE_APPS.length + HEADWIND_WIPE_FOLDERS.length, 4, "four instructions, one per item");

  const untouched = makeFetch({ api: [{ body: { status: "OK" }, status: 200 }] });
  await assert.rejects(
    () => wipeHeadwindDevice({ deviceNumber: "   " }, "B-10", untouched.fetch, ENV),
    (error: unknown) => error instanceof HeadwindWipeError && error.partial === false,
    "a wipe with no tablet named never left Phoenix, so it is not reported as a half-finished one",
  );
  assert.equal(untouched.calls.length, 0, "and nothing was sent — not even a sign-in");

  const gone = makeFetch({ api: [{ body: { data: { items: [] }, status: "OK" }, status: 200 }] });
  await assert.rejects(
    () => wipeHeadwindDevice({ deviceNumber: "PHX-TAB-0002" }, "B-10", gone.fetch, ENV),
    HeadwindCommandInputError,
    "a tablet that has left the fleet cannot be wiped — resolved against the LIVE list, same as every other action",
  );

  // The push itself writes an audit row, so the wire shape is pinned at the source instead.
  const wipe = stripComments(source("src/lib/devices/headwind/wipe.ts"));
  assert.match(wipe, /messageType: "clearAppData"/, "TYPE_CLEAR_APP_DATA — the agent's own name");
  assert.match(wipe, /JSON\.stringify\(\{ pkg: app\.packageName \}\)/, "keyed `pkg`, which is the one key the agent reads");
  assert.match(wipe, /messageType: "purgeDir"/, "and the folders go down purgeDir");
  // 🔴 THE STRING "1", NOT `true`. The agent tests it with `"1".equals(payload.getString("recursive"))`,
  // so a boolean there reads as "not 1" — and the purge then quietly skips every subdirectory while
  // still answering 200. A wipe that reports success and leaves the photos is the worst outcome here.
  assert.match(wipe, /recursive: "1"/, "recursive is the STRING 1");
  assert.doesNotMatch(wipe, /recursive: true/, "never the boolean, which the agent reads as 'no'");
  assert.doesNotMatch(wipe, /\/sdcard|\/storage\//, "paths are relative to the tablet's own external storage, as the agent resolves them");
  assert.doesNotMatch(wipe, /com\.hmdm\.launcher/, "and the agent's package appears nowhere in the sent list");
  assert.match(wipe, /entityType: "headwind_device_command"/, "a silent wipe writes a REQUIRED audit row");
  assert.match(wipe, /completed: false/, "and a half-finished one is audited as half-finished, with what was already sent");

  const route = stripComments(source("app/api/devices/headwind/wipe/route.ts"));
  assert.match(route, /assertPermission\(access, "company_devices", "approve"\)/, "Super Admin only");
  assert.match(route, /const csrf = assertSameOriginMutation\(request\);\s*if \(csrf\) return csrf;/);
  // 🔴 THE SCOPE IS NOT A PARAMETER. If the browser could name the apps and folders, the owner's answer
  // would become a default rather than the rule, and the two-press confirmation would be naming a list
  // it does not control.
  assert.doesNotMatch(route, /body\.(apps|folders|packages|paths)/, "the browser cannot choose what a wipe erases");
}

/** Phase 2 and Phase 4 — sets of tablet rules, and what the home screen looks like. */
async function runConfigurationTests() {
  const summary = configurationSummary({ devicesCount: 12, id: 4, kioskMode: true, name: "  Reps  " } as never);
  assert.deepEqual(summary, { description: null, deviceCount: 12, id: 4, kioskMode: true, name: "Reps" });
  const unnamed = configurationSummary({ id: 9, name: "" } as never);
  assert.equal(unnamed.name, "Configuration 9", "a set of rules with no name is still identifiable, never blank");
  assert.equal(unnamed.kioskMode, false, "and kiosk is only true when the server says true — never undefined-as-on");
  assert.equal(configurationSummary({ deviceCount: 3, id: 1, name: "x" } as never).deviceCount, 3, "either spelling of the count is read");

  const branding = configurationBranding({
    backgroundColor: "#0A527D",
    desktopHeader: "Phoenix",
    iconSize: "LARGE",
    id: 4,
    kioskMode: true,
    mainAppId: 17,
    name: "Reps",
  } as never);
  assert.equal(branding.mainAppId, 17, "🔴 mainAppId is the server's APP ID, not a package name — a package string there silently names no app");
  assert.equal(branding.iconSize, "LARGE");
  assert.equal(branding.textColor, null, "and a field the server did not send reads as unset, never as an empty string");

  const untouched = makeFetch({ api: [{ body: { status: "OK" }, status: 200 }] });
  for (const [input, because] of [
    [{ backgroundColor: "navy", configurationId: 4 }, "a colour word is not a hex colour"],
    [{ configurationId: 4, textColor: "#FFF" }, "and three digits is not six — the launcher would ignore it"],
    [{ configurationId: 4, iconSize: "HUGE" }, "an icon size the launcher does not understand is refused rather than sent and ignored"],
    [{ configurationId: 4, desktopHeader: "TOP" }, "the title says WHAT it shows — a position like TOP is not one of Headwind's kinds"],
    [{ configurationId: 4 }, "and a form where nothing changed sends nothing to a hundred tablets"],
    [{ configurationId: "4" as never, desktopHeader: "x" }, "a set of rules has to be named by its id"],
  ] as const) {
    await assert.rejects(
      () => setHeadwindBranding(input as never, "B-10", untouched.fetch, ENV),
      HeadwindConfigurationError,
      because,
    );
  }
  await assert.rejects(
    () => linkHeadwindApp({ action: 5 as never, applicationId: 1, configurationId: 4 }, "B-10", untouched.fetch, ENV),
    HeadwindConfigurationError,
    "an app is installed, hidden or removed — a fourth number is refused, not passed through",
  );
  await assert.rejects(
    () => moveHeadwindDeviceToConfiguration({ configurationId: 4, deviceNumber: " " }, "B-10", untouched.fetch, ENV),
    HeadwindConfigurationError,
    "and a move with no tablet named",
  );
  assert.equal(untouched.calls.length, 0, "every one of those was refused before the network");

  // 🔴 AN ENTRY WITH NO `id` IS A NEW LINK ROW. Measured on production 2026-10-23: setting Telegram (84),
  // WPS Office (85) and WhatsApp (86) to install on "Rep tablets" (3) left each app on those rules TWICE
  // — the old remove link (1002-1004) beside a new install link (1012-1014). So the app's links are read
  // first, the existing link's id is sent, a duplicate pair is collapsed onto its lowest id (the others
  // sent with action 0, which deletes them), and only a pair with no link goes without an id.
  //
  // BREAK-TEST: make applicationLinkEntries `return [entry]` unconditionally and the first deepEqual
  // fires with no `id` where 1002 was expected.
  async function linkThrough(links: unknown) {
    const stub = makeFetch({
      api: [
        { body: { data: links, status: "OK" }, status: 200 },
        { body: { status: "OK" }, status: 200 },
      ],
    });
    const result = await writeHeadwindAppLink({ action: 1, applicationId: 84, configurationId: 3 }, stub.fetch, ENV);
    const api = stub.calls.filter((call) => !call.url.includes("/rest/public/jwt/login"));
    return { api, result };
  }
  const otherRules = { action: 1, applicationId: 84, configurationId: 5, id: 2001 };
  const notOnRules = { action: 0, applicationId: 84, configurationId: 4, id: null };

  const updated = await linkThrough([notOnRules, { action: 2, applicationId: 84, configurationId: 3, id: 1002, remove: true, showIcon: true }, otherRules]);
  assert.equal(updated.api.length, 2, "one read of the app's links, then one write");
  assert.equal(updated.api[0].init.method, "GET");
  assert.ok(updated.api[0].url.endsWith("/rest/private/applications/configurations/84"), "the links are read for THIS app");
  assert.equal(updated.api[1].init.method, "POST");
  assert.ok(updated.api[1].url.endsWith("/rest/private/applications/configurations"));
  assert.deepEqual(
    JSON.parse(String(updated.api[1].init.body)),
    {
      applicationId: 84,
      configurations: [{ action: 1, applicationId: 84, configurationId: 3, id: 1002, remove: false, showIcon: true }],
    },
    "🔴 the existing link's id is sent, so Headwind UPDATES it instead of adding a second link — and only this configuration's link is touched",
  );
  assert.deepEqual(updated.result, { linkId: 1002, removedDuplicateIds: [] });

  const collapsed = await linkThrough([
    { action: 1, applicationId: 84, configurationId: 3, id: 1012 },
    otherRules,
    { action: 2, applicationId: 84, configurationId: 3, id: 1002 },
  ]);
  assert.deepEqual(
    JSON.parse(String(collapsed.api[1].init.body)).configurations,
    [
      { action: 1, applicationId: 84, configurationId: 3, id: 1002, remove: false, showIcon: true },
      { action: 0, applicationId: 84, configurationId: 3, id: 1012, remove: false, showIcon: true },
    ],
    "🔴 a pair already carrying two links keeps the LOWEST id and sends every other with action 0, which deletes it",
  );
  assert.deepEqual(collapsed.result, { linkId: 1002, removedDuplicateIds: [1012] });

  const fresh = await linkThrough([notOnRules, otherRules]);
  const freshEntries = JSON.parse(String(fresh.api[1].init.body)).configurations as Array<Record<string, unknown>>;
  assert.deepEqual(
    freshEntries,
    [{ action: 1, applicationId: 84, configurationId: 3, remove: false, showIcon: true }],
    "an app on NO link for those rules is sent without an id — that is the one case a new link is right",
  );
  assert.equal("id" in freshEntries[0], false, "and the id is absent, not null");
  assert.deepEqual(fresh.result, { linkId: null, removedDuplicateIds: [] });

  assert.deepEqual(
    applicationLinkEntries({ action: 2, applicationId: 84, configurationId: 3, showIcon: false }, [{ configurationId: 3, id: 1002 }]),
    [{ action: 2, applicationId: 84, configurationId: 3, id: 1002, remove: false, showIcon: false }],
    "the requested action and the link's own showIcon ride on the updated link",
  );
  for (const unreadable of [null, { status: "OK" }, "error"]) {
    const stub = makeFetch({ api: [{ body: { data: unreadable, status: "OK" }, status: 200 }] });
    await assert.rejects(
      () => writeHeadwindAppLink({ action: 1, applicationId: 84, configurationId: 3 }, stub.fetch, ENV),
      HeadwindConfigurationError,
      "🔴 a link read that is not a list REFUSES the write — sending without an id would duplicate the link",
    );
    assert.equal(
      stub.calls.filter((call) => call.init.method === "POST" && !call.url.includes("/rest/public/jwt/login")).length,
      0,
      "and nothing was posted",
    );
  }

  const configs = stripComments(source("src/lib/devices/headwind/configurations.ts"));
  // 🔴 THE OPAQUE ROUND-TRIP. `PUT /rest/private/configurations` WIPES AND RE-INSERTS the configuration's
  // applications, settings and files. A hand-built body — even a correct-looking one — therefore empties
  // the app list of every tablet carrying those rules. The only safe write is the server's own object
  // with one field changed.
  assert.match(configs, /return \{ \.\.\.current, \.\.\.patch, applications \}/, "the whole object is read back and returned with one field changed");
  assert.match(
    configs,
    /`\/rest\/private\/configurations\/applications\/\$\{configurationId\}`/,
    "🔴 and the app links come from their own read — the by-id read never carries them",
  );
  assert.match(configs, /const next = configurationWriteBody\(current, links, patch\)/, "the PUT body is built by the pure function pinned below");

  // 🔴 THE BY-ID READ ANSWERS `applications: []` ON EVERY CONFIGURATION (read on production 2026-10-22,
  // and `getConfigurationByIdFull` upstream never fills it), and the PUT deletes every link before it
  // re-inserts the ones it is sent. So a body built from that read alone took every app off every
  // tablet on those rules. The links are read from their own endpoint and the ones ON the configuration
  // (action 1 install, 2 remove — never 0) go back, exactly as the console's own save sends them.
  //
  // BREAK-TEST: make configurationWriteBody return `{ ...current, ...patch }` and the first assertion
  // fires with `[]` where `[79, 84]` was expected.
  const rules = { applications: [], files: [{ id: 5 }], id: 3, name: "Rep tablets", password: "plain", restrictions: "no_factory_reset" };
  const written = configurationWriteBody(
    rules as never,
    [
      { action: 1, id: 79, pkg: "com.carriez.flutter_hbb" },
      { action: 0, id: 12, pkg: "not.on.these.rules" },
      { action: 2, id: 84, pkg: "org.telegram.messenger.web" },
      { action: 1, pkg: "no.id" },
      null,
    ],
    { desktopHeader: "Phoenix" },
  );
  assert.deepEqual(
    (written.applications as Array<{ id: number }>).map((app) => app.id),
    [79, 84],
    "every app ON the rules goes back, install and remove alike — and only those",
  );
  assert.equal(written.desktopHeader, "Phoenix", "the patched field is changed");
  assert.equal(written.restrictions, "no_factory_reset", "every other field rides through untouched");
  assert.deepEqual(written.files, [{ id: 5 }], "and the file list the by-id read DOES carry is kept");
  assert.equal(written.password, "plain", "the tablet password is carried through as the server holds it");
  for (const unreadable of [null, { status: "OK" }, "error"]) {
    assert.throws(
      () => configurationWriteBody(rules as never, unreadable, { desktopHeader: "Phoenix" }),
      HeadwindConfigurationError,
      "🔴 an app-link read that is not a list REFUSES the save — sending it anyway would empty every tablet",
    );
  }
  assert.match(configs, /"\/rest\/private\/applications\/configurations"/, "attaching ONE app uses the surgical endpoint, which rewrites nothing else");
  assert.match(configs, /"\/rest\/private\/web-ui-files\/configurations"/, "and so does attaching one file");
  // 🔴 BOTH OF THESE FAIL AS AN HTTP 200 WHEN OMITTED, so nothing but the container's own log says why.
  // Measured on production 2026-09-28 adding the Phoenix mdm APK: registering without `type` throws
  // `PSQLException: null value in column "type" of relation "applications" violates not-null
  // constraint`, and linking without `showIcon`/`remove` throws a bare `NullPointerException` — both
  // surfacing only as `{"status":"ERROR","message":"error.internal.server"}` under a 200.
  assert.match(configs, /showIcon: input\.showIcon !== false/, "the link entry carries showIcon — without it Headwind NPEs and answers a 200");
  assert.match(configs, /remove: false/, "and remove, for the same reason");
  const uploads = stripComments(source("src/lib/devices/headwind/uploads.ts"));
  assert.match(uploads, /type: "app"/, "registering an APK sends type — the applications table has NOT NULL on it");
  // 🔴 A CONFIGURATION OBJECT CARRIES A PLAINTEXT PASSWORD — the Swagger's "MD5 hash" is wrong, the hash
  // is computed at device-sync time from a plaintext column. So the object must never be logged, and
  // never put in an audit row whole.
  assert.doesNotMatch(configs, /console\.(log|info|warn|error|debug)/, "the configuration object is never logged — it carries a plaintext password");
  assert.doesNotMatch(configs, /newValues: \{[^}]*current/, "and never written into an audit row whole");
  assert.match(configs, /HEADWIND_ICON_SIZES/, "the icon sizes are the three the launcher understands");
  // What the title shows is Headwind's own enum (DesktopHeader.java), and the console offers it as a
  // choice — never a free-text box with "TOP" in it, which wrote a value the enum cannot hold.
  assert.deepEqual([...HEADWIND_DESKTOP_HEADERS], ["NO_HEADER", "DEVICE_ID", "DESCRIPTION", "TEMPLATE"]);
  const settingsUi = stripComments(source("src/components/devices/headwind-server-settings.tsx"));
  for (const kind of HEADWIND_DESKTOP_HEADERS) {
    assert.ok(settingsUi.includes(`value: "${kind}"`), `the console offers ${kind} as a choice`);
  }
  assert.doesNotMatch(settingsUi, /placeholder="TOP"/, "and the title is no longer a free-text position");
  // 🔴 A CUSTOM KIND SET IN THE HEADWIND CONSOLE IS SHOWN AND ACCEPTED BACK. The form sends its whole
  // shape, so refusing CUSTOM1..3 refused every save of those rules over a title nobody touched.
  for (const custom of ["CUSTOM1", "CUSTOM2", "CUSTOM3"]) {
    assert.ok(HEADWIND_DESKTOP_HEADER_VALUES.includes(custom), `${custom} is a value the server accepts back`);
  }
  assert.match(configs, /!HEADWIND_DESKTOP_HEADER_VALUES\.includes\(input\.desktopHeader\)/, "the branding check reads every value the enum can hold");
  assert.match(settingsUi, /titleKindLabel\(form\.desktopHeader\)/, "and the dropdown shows a current value it does not offer, rather than a blank");
  // A blank select CLEARS the setting (the route reads "" as null), so it never says it leaves it alone.
  assert.doesNotMatch(settingsUi, /Leave it as the tablet has it/, "a clearing option is not labelled as leaving it");
  assert.deepEqual([...HEADWIND_ICON_SIZES], ["SMALL", "MEDIUM", "LARGE"]);
  assert.match(configs, /kioskMode/, "the key is kioskMode — `kiosk` is the plausible-looking name the server ignores");
}

/** Phase 3 — sending an APK or a file up, then putting it in a set of rules. */
async function runUploadTests() {
  assert.equal(HEADWIND_MAX_UPLOAD_BYTES, 300 * 1024 * 1024, "300 MB — what fits inside the route's own 300-second ceiling");

  const untouched = makeFetch({ api: [{ body: { status: "OK" }, status: 200 }] });
  await assert.rejects(
    () => uploadHeadwindApp({ file: null }, "B-10", untouched.fetch, ENV),
    HeadwindUploadError,
    "no file chosen",
  );
  await assert.rejects(
    () => uploadHeadwindApp({ file: new File([], "empty.apk") }, "B-10", untouched.fetch, ENV),
    HeadwindUploadError,
    "and a zero-byte file, which uploads fine and installs nothing",
  );
  // 🔴 AN .AAB IS THE MISTAKE THAT LOOKS RIGHT. It is what Google Play builds from, it sits beside the
  // APK in every build output, and a tablet cannot install one. Refusing it here costs a sentence;
  // letting it through costs a fleet-wide install that silently reaches nothing.
  await assert.rejects(
    () => uploadHeadwindApp({ file: new File(["x"], "phoenix.aab") }, "B-10", untouched.fetch, ENV),
    (error: unknown) => error instanceof HeadwindUploadError && /\.apk/.test(error.message) && /aab/i.test(error.message),
    "a bundle is refused by name, and the sentence says why it cannot work",
  );

  const big = new File(["x"], "huge.apk");
  Object.defineProperty(big, "size", { value: HEADWIND_MAX_UPLOAD_BYTES + 1 });
  await assert.rejects(
    () => uploadHeadwindApp({ file: big }, "B-10", untouched.fetch, ENV),
    (error: unknown) => error instanceof HeadwindUploadError && /300 MB/.test(error.message),
    "and a file too large to finish is refused before it half-writes itself onto the server",
  );
  assert.equal(untouched.calls.length, 0, "none of those reached the network");

  const uploads = stripComments(source("src/lib/devices/headwind/uploads.ts"));
  // 🔴 THE ENDPOINT IS `/rest/private/web-ui-files`. There is no `/rest/upload` — that is the name the
  // documentation suggests and the server does not serve.
  assert.match(uploads, /"\/rest\/private\/web-ui-files"/, "the bytes go to the web-ui-files endpoint");
  assert.doesNotMatch(uploads, /"\/rest\/upload"/, "never /rest/upload, which does not exist");
  assert.match(uploads, /form\.append\("file", file, file\.name\)/, "multipart field `file`, as the server reads it");
  // 🔴 `FormData` IS HANDED TO `callHeadwind` UNTOUCHED. Writing a content type by hand drops the
  // multipart boundary, and the upload then fails with a shape error rather than a useful one.
  assert.doesNotMatch(uploads, /multipart\/form-data/, "the content type is never written by hand — the boundary would be lost");
  assert.match(uploads, /"\/rest\/private\/applications\/android"/, "then the APK is registered as an application");
  assert.match(uploads, /filePath/, "by the serverPath the upload handed back");

  const route = stripComments(source("app/api/devices/headwind/upload/route.ts"));
  assert.match(route, /export const maxDuration = 300/, "a multipart route gets its own ceiling, like the ManageEngine one");
  assert.match(route, /assertPermission\(access, "company_devices", "approve"\)/, "Super Admin only");
  assert.match(route, /const csrf = assertSameOriginMutation\(request\);\s*if \(csrf\) return csrf;/);
}

/** Phase 5 — where a tablet is, and where it has been. */
async function runLocationTests() {
  assert.deepEqual(locationFixesFromPlugin(null), [], "nothing recorded is an empty list, never a throw");
  assert.deepEqual(locationFixesFromPlugin("not a page"), [], "and a reply of the wrong shape is read as empty too");

  const when = 1758800000000;
  const fixes = locationFixesFromPlugin([
    { deviceBatteryLevel: 61, gpsLat: 30.06, gpsLon: 31.24, latestUpdateTime: when },
    // 🔴 NULL ISLAND IS NOT A PLACE. The agent reports 0/0 when it has no fix at all, and a console that
    // plots it puts every unlocated tablet in the Gulf of Guinea — a map that looks broken rather than
    // one that says nothing is known.
    { gpsLat: 0, gpsLon: 0, latestUpdateTime: when },
    { gpsLat: 30.1, gpsLon: null },
    { gpsLat: "30.2", gpsLon: "31.3" },
  ]);
  assert.equal(fixes.length, 1, "one real fix — the zero pair, the half pair and the strings are all dropped");
  assert.equal(fixes[0].source, "plugin", "🔴 and it says where it came from, because the two sources are never blended");
  assert.equal(fixes[0].batteryLevel, 61);
  assert.equal(fixes[0].recordedAt, new Date(when).toISOString(), "the tablet's own moment, kept as an instant rather than a number");

  const untouched = makeFetch({ api: [{ body: { status: "OK" }, status: 200 }] });
  await assert.rejects(
    () => locateHeadwindDevice({ deviceNumber: "  " }, "B-10", untouched.fetch, ENV, 0),
    HeadwindLocationError,
    "a locate with no tablet named",
  );
  assert.equal(untouched.calls.length, 0);

  const gone = makeFetch({ api: [{ body: { data: { items: [] }, status: "OK" }, status: 200 }] });
  await assert.rejects(
    () => locateHeadwindDevice({ deviceNumber: "PHX-TAB-0002" }, "B-10", gone.fetch, ENV, 0),
    HeadwindCommandInputError,
    "and a tablet that has left the fleet",
  );

  const locations = stripComments(source("src/lib/devices/headwind/locations.ts"));
  // 🔴 "LOCATE NOW" IS NOT A PING AND IS NOT SOLD AS ONE. Nothing in Headwind asks a tablet for its
  // position. What can be done is wake it into a check-in and read back what it sent, WITH ITS AGE.
  assert.match(locations, /messageType: "configUpdated"/, "the tablet is woken into a check-in — the nearest real thing to a ping");
  assert.doesNotMatch(locations, /messageType: "locate"/, "there is no locate message, and inventing one answers 200 and reaches nothing");
  assert.match(locations, /ageSeconds/, "🔴 the age travels with the position — showing a four-day-old fix as 'now' is what sends somebody driving to it");
  assert.match(locations, /source: "check-in"/, "the fix that always arrives is labelled");
  assert.match(locations, /source: "plugin"/, "and the plugin's own trail is labelled apart");
  assert.match(locations, /"\/rest\/plugins\/deviceinfo\/deviceinfo\/private\/search\/dynamic"/, "the deviceinfo history endpoint");
  assert.match(locations, /sendData: true/, "🔴 which collects nothing until it is switched on — it defaults to FALSE");
  // 🔴 THE HISTORY IS ASKED FOR BY `deviceNumber`. The live server answers `deviceFilter` with
  // "error.notfound.device" inside an HTTP 200 (measured 1 Nov 2026), and the read's catch turned that
  // into an empty trail — so the movements panel could never show a fix, whatever the tablet sent.
  assert.match(locations, /deviceNumber: number, pageNum: 1/, "the deviceinfo history is filtered by deviceNumber");
  assert.doesNotMatch(locations, /deviceFilter/, "🔴 never deviceFilter — the server refuses it and the refusal reads as an empty trail");
  // 🔴 AN EMPTY HISTORY IS "NOTHING RECORDED", NEVER "THE TABLET DID NOT MOVE". Whether the stock free
  // agent feeds this plugin at all is unproven until a real tablet does it — `ProUtils` is a stub in the
  // open-source agent — so the note must say so rather than imply a tablet stayed still.
  assert.match(locations, /unproven until a tablet does it/, "and the note says plainly that an empty trail may mean the free agent never feeds it");
  assert.doesNotMatch(locations, /has not moved"/, "it never reports an empty history as a tablet that did not move");
}

/**
 * Phases 6 and 7 — lock, lost mode, factory reset, screen-lock reset, the alarm, the message, and the
 * one action that does not exist for anyone.
 */
async function runCustodyActionTests() {
  assert.equal(isHeadwindActionId("LOCK"), true);
  assert.equal(isHeadwindActionId("SHUTDOWN"), false, "a near-miss name is refused, never passed through");

  const impossible = HEADWIND_ACTIONS.filter((action) => action.carrier === "impossible");
  assert.deepEqual(impossible.map((action) => action.id), ["SHUT_DOWN"], "exactly one action is impossible, and it is named");

  // With the add-on on the box, everything except shut down can be carried.
  const withAddon = makeFetch({ api: [{ body: { data: { ready: true }, status: "OK" }, status: 200 }] });
  const ready = await headwindActionCatalogue(withAddon.fetch, ENV);
  assert.equal(ready.length, HEADWIND_ACTIONS.length, "every action is listed, including the one that cannot work");
  assert.equal(
    ready.filter((action) => action.available).length,
    HEADWIND_ACTIONS.length - 1,
    "all but shut down are available on a box that has the add-on",
  );
  const shutDown = ready.find((action) => action.id === "SHUT_DOWN")!;
  assert.equal(shutDown.available, false);
  // 🔴 REPORTED AS IMPOSSIBLE, IN WORDS, AND NEVER AS "NOT YET". `PowerManager.shutdown()` is a
  // signature-level permission — granted only to an app signed with the tablet manufacturer's own key.
  // No MDM has it on stock Android at any price. A sentence that reads like a pending feature would have
  // the owner waiting for something that is never coming, and restart is NOT a substitute: a stolen
  // tablet that restarts comes back on.
  assert.match(String(shutDown.unavailableReason), /not possible/i, "shut down says it is not possible");
  assert.doesNotMatch(String(shutDown.unavailableReason), /yet|soon|pending/i, "and never that it is coming");
  assert.match(String(shutDown.unavailableReason), /manufacturer/i, "and says whose permission it needs, so it is not re-asked every quarter");

  // Without it, the four add-on actions refuse — and the two the Phoenix app carries are UNAFFECTED,
  // which is the whole reason the alarm and the message were built on our own app instead.
  const withoutAddon = makeFetch({ api: [{ body: { message: "no such plugin", status: "ERROR" }, status: 404 }] });
  const degraded = await headwindActionCatalogue(withoutAddon.fetch, ENV);
  for (const action of degraded) {
    const expected = action.carrier === "phoenix-app";
    assert.equal(action.available, expected, `${action.id}: ${action.carrier} actions do not depend on the add-on`);
    if (action.carrier === "add-on") {
      assert.match(String(action.unavailableReason), /add-on/, `${action.id} names the add-on`);
      assert.match(
        String(action.unavailableReason),
        /tablets themselves already know how to do this/,
        `${action.id} says the gap is in the server, not the tablet — the correction this whole build turns on`,
      );
    }
  }

  const untouched = makeFetch({ api: [{ body: { status: "OK" }, status: 200 }] });
  await assert.rejects(
    () => takeHeadwindAction({ action: "SHUT_DOWN", deviceNumber: "PHX-TAB-0002" }, "B-10", untouched.fetch, ENV),
    HeadwindActionError,
    "shut down refuses before any network call, and permanently",
  );
  await assert.rejects(
    () => takeHeadwindAction({ action: "LOST_MODE_ON", deviceNumber: "PHX-TAB-0002" }, "B-10", untouched.fetch, ENV),
    (error: unknown) => error instanceof HeadwindActionError && /phone number|return the tablet/.test(error.message),
    "lost mode with no words would lock a tablet showing nothing — refused, and the sentence says what to type",
  );
  await assert.rejects(
    () =>
      takeHeadwindAction(
        { action: "SHOW_MESSAGE", deviceNumber: "PHX-TAB-0002", message: "x".repeat(HEADWIND_MESSAGE_LIMIT + 1) },
        "B-10",
        untouched.fetch,
        ENV,
      ),
    (error: unknown) => error instanceof HeadwindActionError && String(HEADWIND_MESSAGE_LIMIT).length > 0 && /characters/.test(error.message),
    "and words that would run off a 7-inch screen are refused with the count, not silently cut",
  );
  await assert.rejects(
    () => takeHeadwindAction({ action: "NUKE", deviceNumber: "PHX-TAB-0002" }, "B-10", untouched.fetch, ENV),
    HeadwindActionError,
    "an action that does not exist",
  );
  assert.equal(untouched.calls.length, 0, "none of those reached the network");

  // 🔴 THE SCREEN-LOCK RESET CARRIES THE NEW PIN (fixed 2026-10-22). The agent's `passwordReset` is the
  // new password itself; the add-on reads it from `password`, and `passwordReset: true` alone reached
  // the tablet as null — the reset did nothing while the row read as sent.
  //
  // BREAK-TEST: put back `return { deviceNumber, passwordReset: true }` and the deepEqual fires with
  // the password missing.
  assert.deepEqual(
    headwindAddonBody("RESET_SCREEN_LOCK", "PHX-TAB-0007", null, "604193"),
    { deviceNumber: "PHX-TAB-0007", password: "604193", passwordReset: true },
    "the reset sends the PIN where the add-on reads it",
  );
  assert.throws(
    () => headwindAddonBody("RESET_SCREEN_LOCK", "PHX-TAB-0007", null, null),
    HeadwindActionError,
    "and a reset with no PIN is refused rather than sent to be ignored",
  );
  assert.deepEqual(headwindAddonBody("LOCK", "PHX-TAB-0007", null), { deviceNumber: "PHX-TAB-0007", lock: true }, "the other actions are unchanged");
  const draws = [111111, 123456, 987654, 42, 604193];
  assert.equal(
    temporaryScreenLockPin(() => draws.shift() as number),
    "000042",
    "a repeated digit and a straight run are skipped, and a short number is padded to six digits",
  );
  assert.match(temporaryScreenLockPin(), /^\d{6}$/, "the real PIN is six digits");
  assert.throws(() => temporaryScreenLockPin(() => 0), HeadwindActionError, "a source that only gives 000000 ends in a refusal, never a weak PIN");

  const actions = stripComments(source("src/lib/devices/headwind/actions.ts"));
  // 🔴 NOT HEADWIND'S MESSAGING PLUGIN, WHICH IS THE OBVIOUS ANSWER AND IS A DEAD END.
  // `POST /rest/plugins/messaging/private/send` exists in the free build and sends push type
  // `textMessage` — for which the stock agent has NO handler. It falls to the default branch and is
  // re-broadcast to plugins, so the message reaches the tablet and nothing draws it.
  assert.doesNotMatch(actions, /textMessage|plugins\/messaging/, "the messaging plugin is never used — the agent has no handler for it");
  assert.match(actions, /messageType: "intent"/, "our own words reach our own app through the intent push");
  assert.match(actions, /pkg: PHOENIX_APP_PACKAGE/, "aimed at the Phoenix app by package");
  assert.match(actions, /"\/rest\/plugins\/phoenix-actions\/private"/, "and the four custody actions go to the add-on on our own box");
  assert.match(actions, /status\?\.ready === true/, "🔴 which is ASKED, never assumed — a box rebuilt without it answers 404");
  assert.match(actions, /entityType: "headwind_device_command"/, "every act writes a REQUIRED audit row");
  assert.match(actions, /message,/, "and the words themselves are kept in it — they are the point of the act, not a credential");

  // 🔴 THE INTENT NAMES ARE A CONTRACT WITH THE ANDROID BUILD, NOT A STRING THAT CAN BE TIDIED. Change
  // one here without rebuilding and redistributing the APK and the button reports "sent" while the
  // tablet does nothing — the exact failure the whole no-dead-buttons ruling exists to avoid. So the
  // server's two names are pinned against the plugin that registers them.
  assert.equal(PHOENIX_ALARM_INTENT, `${PHOENIX_APP_PACKAGE}.DEVICE_ALARM`);
  const plugin = stripComments(source("mobile/plugins/with-phoenix-device-actions.js"));
  assert.ok(plugin.includes(`const PACKAGE = "${PHOENIX_APP_PACKAGE}"`), "the plugin builds its actions from the same package name");
  assert.ok(plugin.includes("${PACKAGE}.DEVICE_ALARM"), "and registers the alarm action the server sends");
  assert.ok(plugin.includes("${PACKAGE}.DEVICE_MESSAGE"), "and the message action");
  // 🔴 TWO MANIFEST FLAGS ARE LOAD-BEARING, AND BOTH FAIL SILENTLY. An activity that is not exported
  // cannot be started by the Headwind agent at all — a different app — and one without
  // CATEGORY_DEFAULT is not matched by an implicit action. Either way the push answers 200 and the
  // tablet does nothing, which is the exact shape of failure the no-dead-buttons ruling is about.
  assert.ok(plugin.includes('"android:exported": "true"'), "the activity is exported, or the agent cannot start it");
  assert.ok(
    plugin.includes('"android.intent.category.DEFAULT"'),
    "and carries CATEGORY_DEFAULT, or an implicit action does not match it",
  );
  assert.match(plugin, /AudioManager\.STREAM_ALARM/, "the alarm plays on the ALARM stream, so it is heard with the ringer down");

  // A plugin file that exists but is not registered does nothing at all, and nothing else would say so.
  const appJson = source("mobile/app.json");
  assert.match(appJson, /with-phoenix-device-actions/, "and the plugin is registered in app.json, or it never runs");
}

/** Phase 8 — the enrollment code the owner pastes once. */
function runEnrollmentTests() {
  const payload = {
    "android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE": {
      "com.hmdm.BASE_URL": "https://mdm-console.satopharma.com",
      "com.hmdm.CONFIG": "Reps",
      "com.hmdm.SERVER_PROJECT": "",
    },
    "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME": "com.hmdm.launcher/.AdminReceiver",
    "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION": "https://mdm.satopharma.com/files/hmdm.apk",
    "android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM": "gJD2YwtOiWJHkSMkkIfLRlj-quNqG1fb6v100QmzM9w=",
  };

  const parsed = parseHeadwindEnrollmentTemplate(`\n  ${JSON.stringify(payload)}  \n`);
  assert.deepEqual(parsed.facts, {
    agentPackage: "com.hmdm.launcher",
    configurationName: "Reps",
    downloadHost: "mdm.satopharma.com",
    hasChecksum: true,
    joinsWifi: false,
    serverHost: "mdm-console.satopharma.com",
  });
  // Stored RE-SERIALISED: what goes in the row is known-parseable JSON rather than whatever the
  // clipboard carried, and the extras bundle inside is copied through untouched.
  assert.deepEqual(JSON.parse(parsed.payload), payload, "same keys, same values, normalised whitespace");

  for (const [raw, pattern, because] of [
    ["", /Paste the enrollment code/, "nothing pasted"],
    ["hello", /Copy the whole JSON text/, "something that is not JSON at all"],
    ["[]", /single JSON object/, "a list rather than an object"],
    [JSON.stringify({ a: 1 }), /PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME/, "no component name, so no tablet would know what to install"],
    [
      JSON.stringify({ "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME": "com.hmdm.launcher/.AdminReceiver" }),
      /no download location/,
      "and no download location, so a factory-fresh tablet would have nothing to fetch",
    ],
  ] as const) {
    assert.throws(
      () => parseHeadwindEnrollmentTemplate(raw),
      (error: unknown) => error instanceof HeadwindEnrollmentError && pattern.test(error.message),
      because,
    );
  }

  // 🔴 THE ONE THAT MATTERS MOST: A MANAGEENGINE CODE IS A VALID ANDROID PROVISIONING PAYLOAD. It has a
  // component name and a download location, so every structural check passes — and a tablet enrolled
  // with it joins the system being retired, silently, while the card reports success. The `com.hmdm.*`
  // extras bundle is the only thing that tells the two apart.
  const foreign = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  foreign["android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE"] = { "com.manageengine.SERVER": "https://mdm.manageengine.com" };
  assert.throws(
    () => parseHeadwindEnrollmentTemplate(JSON.stringify(foreign)),
    (error: unknown) =>
      error instanceof HeadwindEnrollmentError && /com\.hmdm\.BASE_URL/.test(error.message) && /ManageEngine/.test(error.message),
    "a code for the other system is refused by name, not saved as a Headwind one",
  );

  const enrollment = stripComments(source("src/lib/devices/headwind/enrollment.ts"));
  // 🔴 THE PAYLOAD IS A CREDENTIAL — anyone who scans it puts a tablet into the company's fleet with the
  // agent as device owner. It never reaches an audit row, a log or the ordinary page load.
  assert.doesNotMatch(enrollment, /newValues: \{[^}]*payload/, "the payload is never written into an audit row");
  assert.doesNotMatch(enrollment, /console\.(log|info|warn|error|debug)/, "and never logged");
  assert.match(enrollment, /revealed: true/, "looking at it is itself audited");
  assert.match(enrollment, /getHeadwindEnrollmentSummary/, "the page load reads facts about the code, not the code");

  const route = stripComments(source("app/api/devices/headwind/enrollment/route.ts"));
  assert.match(route, /assertPermission\(access, "company_devices", "approve"\)/, "Super Admin only");
  // 🔴 THE PAGE LOAD MUST NOT CARRY THE CODE. Anyone who scans it enrols a tablet into the company's
  // fleet with the agent as device owner, so it is handed out only when a person explicitly asks —
  // which is also what makes the reveal worth an audit row. Sliced to the GET body on purpose: a
  // whole-file search matches the import and the POST and proves nothing.
  const getBody = route.slice(
    route.indexOf("export async function GET"),
    route.indexOf("export async function POST"),
  );
  assert.ok(getBody.length > 0, "the enrollment route has both a GET and a POST, in that order");
  assert.doesNotMatch(getBody, /(reveal|read)HeadwindEnrollmentQr/, "the page load reads facts about the code, never the code itself");
  assert.match(route, /payload\.show === true/, "and the code comes back only on an explicit ask");
}

/** Phase 9 — console logins, which are free and uncapped on our own server. */
async function runConsoleUserTests() {
  const roles = consoleRolesFrom([
    { id: 2, name: "Admin" },
    { id: 1, name: "Zed" },
    { id: "x", name: "not a row" },
    { id: 3 },
  ]);
  assert.deepEqual(roles, [{ id: 2, name: "Admin" }, { id: 1, name: "Zed" }], "rows without a number id or a name are dropped, and the rest sort by name");

  const users = consoleUsersFrom(
    [
      { email: "   ", id: 5, login: "zoe", name: "Zoe", userRoleId: 2 },
      { id: 6, login: "amir", userRoleId: 99 },
      { id: 7 },
      { login: "noid" },
      { enabled: false, id: 8, login: "off" },
    ],
    roles,
  );
  assert.deepEqual(users.map((user) => user.login), ["amir", "off", "zoe"], "a row with no login or no id is not a person");
  assert.equal(users[2].roleName, "Admin", "a role id is resolved to the name a person reads");
  assert.equal(users[0].roleName, null, "🔴 and a role the server did not list reads as unknown, never as the first one in the list");
  assert.equal(users[2].email, null, "a blank email is absent, not an empty string");
  assert.equal(users[1].enabled, false, "a login switched off says so");
  assert.equal(users[0].enabled, true, "and one with no flag at all is in use — absent means in use, not off");

  const untouched = makeFetch({ api: [{ body: { status: "OK" }, status: 200 }] });
  for (const [input, because] of [
    [{ login: "  ", password: "a-long-enough-password", roleId: 2 }, "no login name"],
    [{ login: "omar gawish", password: "a-long-enough-password", roleId: 2 }, "a space in a login, which the server would take and nobody could type"],
    [{ login: "omar", password: "a-long-enough-password", roleId: 1.5 }, "a role that is not a role"],
    [{ login: "omar", password: "short", roleId: 2 }, "and a password this login could wipe a fleet with"],
  ] as const) {
    await assert.rejects(
      () => createHeadwindConsoleUser(input as never, "B-10", untouched.fetch, ENV),
      HeadwindUserError,
      because,
    );
  }
  await assert.rejects(
    () => removeHeadwindConsoleUser({ login: "omar", userId: Number.NaN }, "B-10", untouched.fetch, ENV),
    HeadwindUserError,
    "and a removal with no login named",
  );
  assert.equal(untouched.calls.length, 0, "every refusal happened before the network");
  assert.ok(HEADWIND_MIN_PASSWORD >= 12, "the minimum is set by what this login can do, not by habit");

  const usersSource = stripComments(source("src/lib/devices/headwind/users.ts"));
  assert.match(usersSource, /newPassword: input\.password/, "the password goes up to the server, plaintext over HTTPS — the server's own contract");
  // 🔴 AND IT STOPS THERE. Never in the audit row, never in the returned message, never in a log.
  assert.doesNotMatch(usersSource, /newValues: \{[^}]*[Pp]assword/, "it is never written into an audit row");
  assert.doesNotMatch(usersSource, /message:[\s\S]{0,200}input\.password/, "nor into the sentence handed back to the browser");
  assert.doesNotMatch(usersSource, /console\.(log|info|warn|error|debug)/, "nor logged");
  assert.match(usersSource, /"\/rest\/private\/roles"/, "roles come from the server, never a hard-coded list that drifts");
}

function runRemoteScreenTests() {
  // 🔴 EMPTY IS A WORKING CONFIGURATION, NOT A MISSING ONE — the owner's decision, 2026-09-25. This
  // asserted `false` until that day, which is what kept the screen buttons greyed out until somebody
  // rented a box. RustDesk is NaCl end-to-end encrypted, so its public relay carries ciphertext it
  // cannot read; self-hosting buys ownership, not secrecy. If this line ever reads `false` again,
  // remote screen has silently gone back to needing a server nobody agreed to pay for.
  assert.equal(isRustDeskConfigured({} as NodeJS.ProcessEnv), true, "no settings at all means RustDesk's public relay, and it works");
  assert.equal(isRustDeskConfigured(ENV), true);
  assert.equal(rustDeskPackageName(ENV), "com.carriez.flutter_hbb", "RustDesk's Android package keeps its Flutter project id — this looks wrong and is right");

  const publicRelay = rustDeskConfig({} as NodeJS.ProcessEnv);
  assert.equal(publicRelay.relayMode, "public");
  assert.equal(publicRelay.relayHost, null, "there is no single public host to name, so none is invented");
  assert.equal(publicRelay.publicKey, null, "and no key, because there is no private relay to verify");
  assert.match(publicRelay.relayLabel, /public relay/i, "but the console always has a phrase to print");

  const own = rustDeskConfig(ENV);
  assert.equal(own.relayMode, "self-hosted");
  assert.equal(own.relayLabel, "relay.test.local", "on the company's own relay the label IS the host");

  // 🔴 HALF A SELF-HOSTED RELAY IS THE ONE THING STILL REFUSED. A client pointed at a private relay
  // it cannot verify does not fail loudly — it quietly connects elsewhere, and a fleet everyone
  // believes is on the company's own relay while it is not is worse than either honest answer.
  // `as unknown as` and not a plain cast: this repo's ProcessEnv requires NODE_ENV, so a one-key
  // literal is not assignable to it. The point of these two is precisely that they are PARTIAL.
  const hostOnly = { RUSTDESK_RELAY_HOST: "relay.test.local" } as unknown as NodeJS.ProcessEnv;
  const keyOnly = { RUSTDESK_PUBLIC_KEY: "PUBLICKEYNOTASECRET=" } as unknown as NodeJS.ProcessEnv;
  assert.throws(() => rustDeskConfig(hostOnly), RustDeskNotConfiguredError, "a host with no key is refused");
  assert.throws(() => rustDeskConfig(keyOnly), RustDeskNotConfiguredError, "and a key with no host");
  assert.equal(isRustDeskConfigured(hostOnly), false, "so the console turns the buttons off rather than guessing");
  assert.equal(isRustDeskConfigured(keyOnly), false);
  assert.throws(() => rustDeskTarget({ mode: "view", rustDeskId: "1" }, hostOnly), RustDeskNotConfiguredError);

  // A tablet with no ID yet gets a sentence saying what to do, not an error.
  const notReady = rustDeskTarget({ mode: "control", rustDeskId: null }, ENV);
  assert.equal(notReady.target, null);
  assert.match(String(notReady.reason), /RustDesk ID/, "and it says in plain words where the ID comes from");

  // The same tablet, with nothing configured at all, still opens — through the public relay.
  const onPublic = rustDeskTarget({ mode: "view", rustDeskId: "123456789" }, {} as NodeJS.ProcessEnv);
  assert.equal(onPublic.reason, null, "no box, no settings, and the session still opens");
  assert.equal(onPublic.target?.relayMode, "public");
  assert.match(String(onPublic.target?.relayLabel), /public relay/i);

  const ready = rustDeskTarget({ mode: "control", rustDeskId: "123 456 789" }, ENV);
  assert.equal(ready.reason, null);
  assert.equal(ready.target?.connectUrl, "rustdesk://connect/123%20456%20789", "a value somebody typed is encoded, never pasted into a link raw");
  assert.equal(ready.target?.relayHost, "relay.test.local");
  assert.equal(ready.target?.relayLabel, "relay.test.local");

  // 🔴 THE CONSOLE READS `relayLabel`, NEVER `relayHost` — the host is null on the public relay, and
  // a toast built from it reads "through null" for every tablet in the fleet.
  const fleetUi = stripComments(source("src/components/devices/headwind-fleet.tsx"));
  assert.doesNotMatch(fleetUi, /target!?\.relayHost/, "the fleet page never prints the raw relay host");
  assert.match(fleetUi, /target!\.relayLabel/, "it prints the label, which is never null");

  // 🔴 NO SECRET IN THE LINK. RustDesk's scheme accepts a password in the query string and it must
  // never be used: a URL is logged by browsers, proxies and anything that touches it, and a tablet's
  // access password in a log is a tablet anybody can drive.
  assert.doesNotMatch(String(ready.target?.connectUrl), /password|key=|\?/, "the connect link names the tablet and nothing else");
  const session = stripComments(source("src/lib/devices/rustdesk/session.ts"));
  assert.doesNotMatch(session, /password/i, "and the module has no notion of a password to leak");
}

function runErrorMappingTests() {
  const cases: Array<[unknown, number, string]> = [
    [new HeadwindNotConfiguredError("not connected"), 400, "a missing credential is a SETUP state, not a failure"],
    [new RustDeskNotConfiguredError("half a relay"), 400, "so is a half-configured relay"],
    [new HeadwindCommandUnconfirmedError("not connected yet"), 501, "an action Phoenix cannot name is neither the person's fault nor the tablet's"],
    [new HeadwindCommandInputError("say which tablet"), 400, "a mistake in what was sent"],
    [new HeadwindRequestError(500, "the server said no"), 502, "the far end refusing"],
    [new HeadwindAppInputError("say which tablet"), 400, "and an app read with no tablet named"],
    [new HeadwindWipeError("say which tablet"), 400, "a wipe that never left Phoenix is the caller's own mistake"],
    [new HeadwindActionError("say which tablet"), 400, "so is an action with nothing named"],
    [new HeadwindConfigurationError("not a colour"), 400, "and a colour that is not a colour"],
    [new HeadwindUploadError("that is not an APK"), 400, "and a file that cannot be installed"],
    [new HeadwindLocationError("say which tablet"), 400, "and a locate with no tablet"],
    [new HeadwindUserError("password too short"), 400, "and a login that would not be safe"],
    [new HeadwindEnrollmentError("paste the code"), 400, "and an enrollment code that is not one"],
    [new Error("something else"), 500, "anything else"],
  ];
  for (const [error, status, because] of cases) {
    assert.equal(headwindErrorResponse(error, "fallback").status, status, because);
  }

  // 🔴 A HALF-FINISHED WIPE IS NOT A 400, AND THE DIFFERENCE IS THE POINT OF THE `partial` FLAG. A 400
  // says the person asked for something impossible; here instructions ARE already on their way to a
  // tablet and the far end stopped answering. Reading that as the person's mistake is how a log at 4am
  // tells the wrong story about a tablet somebody still has.
  const partial = headwindErrorResponse(new HeadwindWipeError("2 of 4 sent", true), "fallback");
  assert.equal(partial.status, 502, "a wipe that got part-way is the far end's failure, not the caller's");
}

function runDoorTests() {
  const approve = { action: "approve", resource: "company_devices" };
  for (const [pattern, methods] of [
    ["/api/devices/headwind", ["GET", "POST"]],
    ["/api/devices/headwind/imei", ["POST"]],
    ["/api/devices/headwind/apps", ["POST"]],
    // 🔴 EVERY DOOR ADDED FOR THE FULL BUILD, ON THE SAME LOCK. Between them these erase a tablet's
    // data, factory-reset it, change what a hundred tablets run, hand out a provisioning credential and
    // create logins that can do all of that again from outside Phoenix. A route missing from the
    // registry is not refused by anything — `system-navigation.ts` hiding a tile is UX, not a boundary.
    ["/api/devices/headwind/wipe", ["GET", "POST"]],
    ["/api/devices/headwind/configurations", ["GET", "POST"]],
    ["/api/devices/headwind/upload", ["POST"]],
    ["/api/devices/headwind/actions", ["GET", "POST"]],
    ["/api/devices/headwind/enrollment", ["GET", "POST"]],
    ["/api/devices/headwind/users", ["GET", "POST"]],
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

  const route = stripComments(source("app/api/devices/headwind/route.ts"));
  assert.match(route, /assertPermission\(access, "company_devices", "approve"\)/, "the route is the security boundary, not the page");
  assert.match(route, /const csrf = assertSameOriginMutation\(request\);\s*if \(csrf\) return csrf;/);

  const imeiRoute = stripComments(source("app/api/devices/headwind/imei/route.ts"));
  assert.doesNotMatch(imeiRoute, /request\.json\(/, "the IMEI copy reads no body — the browser cannot choose what is written");
  assert.match(imeiRoute, /listHeadwindDevices\(\)/, "it reads the fleet again on the server");

  // The register write says where the number came from: a row reading "reports to Google" about a
  // number Headwind read would be a false record of a value's origin.
  assert.match(
    stripComments(source("src/lib/devices/headwind/register-sync.ts")),
    /source: "headwind"/,
    "the audit row names the console that reported the IMEI",
  );
  assert.match(
    stripComments(source("src/lib/devices/headwind/register-sync.ts")),
    /registerTablet\(facts, "headwind"/,
    "and a tablet that adds itself goes through the SAME door the other two bridges use, never a second write path",
  );
  assert.doesNotMatch(
    stripComments(source("src/lib/devices/headwind/register-sync.ts")),
    /createDevice\(/,
    "never straight into the register — that is the one write path a parity test pins",
  );
}

async function runDeviceDetailTests() {
  resetHeadwindTokenCache();
  // 🔴 THE CHECK-IN TIMES READ IN CAIRO, NEVER AS THE RAW INSTANT. The fleet read hands the detail its
  // two moments as ISO strings under camelCase keys (`lastContactAt`, `locatedAt`) — no underscore, so
  // the old key pattern missed both and the panel printed `2025-09-26T15:20:00.000Z` to a person in
  // Cairo (measured on PHX-TAB-0008, 2026-10-22).
  const listed = makeFetch({
    api: [
      {
        body: {
          data: {
            items: [
              {
                id: 9,
                info: {
                  // Promoted facts — these belong in the headline, not in the catch-all section below.
                  androidVersion: "13",
                  batteryLevel: 84,
                  location: { lat: 30.0444, lon: 31.2357, ts: 1_758_800_000_000 },
                  model: "TB328XU",
                  // The long tail — facts no hand-written list would carry, and the whole reason the blob is shown.
                  freeStorageMb: 20480,
                  ringerMode: "silent",
                  ssid: "Sato-Field",
                  udid: "internal-7",
                },
                lastUpdate: 1_758_900_000_000,
                number: "PHX-TAB-0008",
              },
            ],
          },
          status: "OK",
        },
        status: 200,
      },
    ],
  });
  const detail = await getHeadwindDeviceDetail("PHX-TAB-0008", listed.fetch, ENV);
  const checkIn = detail.sections.find((section) => section.title === "Check-in");
  assert.ok(checkIn, "the Check-in section is there");
  const lastContact = checkIn.facts.find((fact) => fact.label === "Last contact at");
  const located = checkIn.facts.find((fact) => fact.label === "Located at");
  assert.equal(lastContact?.value, cairoDateTime("2025-09-26T15:20:00.000Z"), "last contact reads as a Cairo date and time");
  assert.match(lastContact?.value ?? "", /18:20$/, "15:20 UTC is 18:20 in Cairo that day — the hour moved, it was not merely reformatted");
  assert.equal(located?.value, cairoDateTime("2025-09-25T11:33:20.000Z"), "and so does the moment the position was taken");
  for (const fact of checkIn.facts) {
    assert.doesNotMatch(fact.value, /\d{4}-\d{2}-\d{2}T\d{2}:/, `${fact.label} never reaches the page as a raw ISO instant`);
  }

  // 🔴 EVERYTHING THE AGENT SENT APPEARS, AND A FACT ALREADY PROMOTED IS NOT PRINTED TWICE. The whole
  // point of carrying the blob (rather than a fixed list) is that a fact this code has never seen still
  // shows the day the agent sends it — so the catch-all must carry the long tail while the promoted
  // facts stay only in the headline.
  // BREAK-TEST: drop `info` from the returned device in devices.ts (or drop the section in detail.ts) and
  // the section-present assertion fires; drop `batteryLevel` from PROMOTED_INFO_KEYS and the
  // no-duplicate assertion fires with "Battery level" showing in the section.
  const reported = detail.sections.find((section) => section.title === "Everything the tablet reports");
  assert.ok(reported, "the catch-all section carries what the agent reported beyond the promoted facts");
  const reportedLabels = reported.facts.map((fact) => fact.label);
  assert.ok(reportedLabels.includes("Free storage mb"), "a fact no hand-written list would carry still appears");
  assert.ok(reportedLabels.includes("Ringer mode"), "and another");
  assert.ok(reportedLabels.includes("Wi-Fi network"), "humanised through the acronym map, so SSID reads as a person would say it");
  assert.ok(!reportedLabels.includes("Battery level"), "a promoted fact is not repeated here — Battery is already in the headline");
  assert.ok(!reportedLabels.includes("Model"), "nor the model");
  assert.ok(!reportedLabels.some((label) => /udid/i.test(label)), "and a raw identifier (udid) is dropped, never shown");
  assert.ok(!reported.facts.some((fact) => fact.value === "internal-7"), "the identifier's value never reaches the page either");
  assert.ok(
    detail.headline.some((fact) => fact.label === "Battery" && fact.value.startsWith("84")),
    "the promoted battery stays in the headline where a person looks for it first",
  );
}

async function runDeviceActorNameTests() {
  // 🔴 WHO DID IT IS A NAME, NEVER THE HR ID IT WAS STORED UNDER (AGENTS.md §4). The tablet history and
  // the enrollment card's "saved by" both printed the raw column. The lookup is the shared
  // `namesByHrId`, driven here through its structural client — never the real `employees` table.
  const asked: string[][] = [];
  const client = {
    from: () => ({
      select: () => ({
        in: async (_column: string, values: string[]) => {
          asked.push(values);
          return { data: [{ full_name: "Omar Gawish", hr_id: "B-10", nickname: null }], error: null };
        },
      }),
    }),
  };
  const nameOf = await deviceActorNames(["B-10", "b-10", "super_admin", null], client);
  assert.equal(nameOf("B-10"), "Omar Gawish", "an HR id reads as the person's name");
  assert.equal(nameOf("b-10"), "Omar Gawish", "in whatever case it was stored");
  assert.equal(nameOf("super_admin"), UNNAMED_DEVICE_ACTOR, "an actor with no name on file is 'a colleague', never the code");
  assert.equal(nameOf(null), null, "and no actor is no actor");
  assert.equal(asked.length, 1, "one lookup for the whole list, not one per row");

  const failing = {
    from: () => ({ select: () => ({ in: async () => ({ data: null, error: { message: "down" } }) }) }),
  };
  assert.equal((await deviceActorNames(["B-10"], failing))("B-10"), UNNAMED_DEVICE_ACTOR, "a failed lookup costs the names, never the history");

  const history = stripComments(source("src/lib/devices/headwind/detail.ts"));
  assert.match(history, /deviceActorNames\(/, "the tablet history names who acted");
  assert.match(history, /\.limit\(HEADWIND_HISTORY_LIMIT \+ 1\)/, "and reads one past its limit, so the panel can say there is more");
  const enrollmentModule = stripComments(source("src/lib/devices/headwind/enrollment.ts"));
  assert.equal((enrollmentModule.match(/deviceActorNames\(/g) ?? []).length, 2, "the enrollment card's 'saved by' is a name on load and on save");

  // 🔴 AN UNREADABLE REGISTER IS NOT AN EMPTY ONE — otherwise every tablet offers "Add to custody",
  // a duplicate custody row one click away.
  const fleetModule = stripComments(source("src/lib/devices/headwind/fleet.ts"));
  assert.match(fleetModule, /unregistered: !registerError && entry === null,/, "with the register unread, no tablet is called unregistered");
  const fleetUi = stripComments(source("src/components/devices/headwind-fleet.tsx"));
  assert.match(fleetUi, /Custody not readable/, "and the row says the register could not be read");
  // …and so does the opened tablet's custody panel, which used to point at an Add button the row no
  // longer offers.
  assert.equal(
    (fleetUi.match(/registerUnreadable: !row\.unregistered && !row\.registerDeviceId,/g) ?? []).length,
    2,
    "both layouts tell the custody panel the register was not read",
  );
  const custodyUi = stripComments(source("src/components/devices/headwind-tablet-panel.tsx"));
  assert.match(custodyUi, /props\.registerUnreadable\s*\?\s*"The custody register could not be read just now/, "the panel says so instead of pointing at Add to custody");
  // The JS layout query equals the CSS's own `md` — this project pins it in tailwind.config.ts, so a
  // change to either side without the other opens a tablet's panel in the hidden layout.
  const mdScreen = /md:\s*"(\d+px)"/.exec(source("tailwind.config.ts"))?.[1];
  assert.ok(mdScreen, "tailwind.config.ts still pins md");
  assert.ok(fleetUi.includes(`const TABLE_QUERY = "(min-width: ${mdScreen})";`), `the layout query is md's own ${mdScreen}`);
  // The fleet row's Factory reset disarms through the kit's hook, so an earlier arm's timer cannot cut a
  // re-arm short (a raw setTimeout was never cleared).
  assert.match(fleetUi, /useDisarmAfterWindow\(confirmKey,/, "the row's press-again button uses the shared disarm");
  assert.doesNotMatch(fleetUi, /window\.setTimeout\(\(\) => setConfirmKey/, "and no fire-and-forget timer is left");
  // A failed revoke never hands back an armed button.
  assert.match(custodyUi, /setState\(\{ \.\.\.own, armedRevoke: false, busy: true,/, "sending a revoke spends the armed press");
  assert.match(custodyUi, /setState\(\{ \.\.\.own, armedRevoke: false, busy: false, failure:/, "and a failure does not re-arm it");
  // Removing a console sign-in disarms the same way as every tablet control.
  const settingsPanel = stripComments(source("src/components/devices/headwind-server-settings.tsx"));
  assert.match(settingsPanel, /useDisarmAfterWindow\(state\.armed,/, "the console-login Remove disarms after the window");
  // One status-word list for the Device custody page and the tablet panel.
  assert.match(custodyUi, /REGISTER_STATUS_WORDS = DEVICE_STATUS_LABEL;/, "the panel reads the shared status words");
  assert.match(
    stripComments(source("src/components/devices/device-register-workspace.tsx")),
    /STATUS_LABEL = DEVICE_STATUS_LABEL;/,
    "and so does the Device custody page",
  );
  // With the tablet server unset, the page says so instead of a blank page under its hero.
  const tabletsPage = stripComments(source("app/(admin)/devices/tablets/page.tsx"));
  assert.match(tabletsPage, /\{headwindReady \? null : \(/, "an unconnected server is said on the page");
  assert.match(fleetUi, /setLoadError\(null\);/, "a read that worked clears the last one's failure");
  assert.match(fleetUi, /Last known position/, "the locate button says what it shows");
  assert.doesNotMatch(fleetUi, /Where is it/, "not a question it cannot answer live");

  const enrollmentUi = stripComments(source("src/components/devices/headwind-enrollment.tsx"));
  assert.match(enrollmentUi, /"com\.hmdm\.launcher": "Headwind MDM agent"/, "the agent reads as a name, not its package");
  assert.doesNotMatch(enrollmentUi, /🔴/, "and the warning is an amber chip in words, never an emoji");
}

function runShipsDarkTests() {
  // 🔴 THE WHOLE SECTION SHIPS DARK. Nothing renders and no request is made until the company's own
  // server exists and its settings are on Railway — which is what makes this safe to merge to
  // production before the server is built.
  const page = stripComments(source("app/(admin)/devices/tablets/page.tsx"));
  assert.match(page, /const headwindReady = isHeadwindConfigured\(\);/);
  assert.match(page, /\{headwindReady \? <HeadwindFleet \/> : null\}/, "no settings, no section — and no fetch either");
  // 🔴 ALL THREE SECTIONS, NOT ONE. The enrollment card reads Phoenix's own table rather than the
  // Headwind box, so it is the one that would happily render with no server at all — and an enrollment
  // code for a server that does not exist is a code that enrolls a tablet into nothing.
  assert.match(page, /\{headwindReady \? <HeadwindEnrollment \/> : null\}/, "the enrollment card ships dark with the rest");
  assert.match(page, /\{headwindReady \? <HeadwindServerSettings \/> : null\}/, "and so do the fleet-wide settings");
  // 🔴 MANAGEENGINE IS GONE — off the page 2026-10-22, when every rep tablet was enrolled in Headwind as
  // device owner, and its code deleted from the repo on 2026-10-23 at the owner's word (the last copy is
  // commit 78a9f90ba). Nothing on the tablets page may reach for it again.
  for (const component of ["ManageEngineEnrollment", "ManageEngineRepTabletRules", "ManageEngineAppRepository", "ManageEngineFleet"]) {
    assert.doesNotMatch(page, new RegExp(`<${component}\\b`), `${component} no longer renders on the tablets page`);
  }
  assert.doesNotMatch(page, /isManageEngineConfigured/, "and the page no longer asks whether ManageEngine is set up");
  assert.ok(!existsSync(new URL("../src/lib/devices/manageengine", import.meta.url)),"and the ManageEngine bridge is deleted, not merely unrendered");

  // The two free buttons carry no paid mark — that contrast with the section above is the payoff.
  const fleet = source("src/components/devices/headwind-fleet.tsx");
  assert.doesNotMatch(stripComments(fleet), /stopsAfterTrial|TRIAL_STOP/, "screen viewing and control cost nothing here");
  assert.match(fleet, /FREE_CHIP/, "and they say so in a chip, because colour is never the only signal");
  assert.match(fleet, /PENDING_CHIP/, "an action that cannot be sent yet says so in words too");
}

/**
 * The box's own recipe — the one place where a silent, invisible regression is possible.
 *
 * 🔴 WHY THIS IS A TEST AND NOT A NOTE. Lock, lost mode, factory reset and reset-the-screen-lock are
 * carried by our own add-on baked into the image (`infra/headwind-phoenix-actions/`). The tablets obey
 * those five fields as shipped; the STOCK free server has no way to set them. So flipping this service
 * back to `image: headwindmdm/hmdm:…` — which is exactly what a tidy-up that "removes an unnecessary
 * build step" would do — breaks four custody actions on a hundred tablets, with no error anywhere in
 * this repository and a refusal on the box that reads like a broken tablet. Nothing else would catch it.
 */
function runServerImageTests() {
  const compose = source("docker-compose.headwind.yml");
  const hmdm = compose.slice(compose.indexOf("\n  hmdm:"), compose.indexOf("\n  hbbs:"));
  assert.ok(hmdm.includes("  hmdm:"), "the compose file still has an hmdm service to pin");

  assert.match(
    hmdm,
    /build:\s*\n\s*context: \.\/infra\/headwind-phoenix-actions\n/,
    "the tablet server is BUILT from our own Dockerfile — the stock image cannot send lock, lost mode, factory reset or a screen-lock reset",
  );
  assert.match(
    hmdm,
    /args:\s*\n\s*HEADWIND_IMAGE_TAG: \$\{HEADWIND_IMAGE_TAG\}/,
    "and it is built against the SAME pinned tag the server runs, or the add-on compiles against one version and runs against another",
  );
  assert.doesNotMatch(
    hmdm,
    /image: headwindmdm\/hmdm:/,
    "never back to the stock image: four custody actions would go dark with no error in this repo",
  );

  // The Dockerfile has to extend the running tag rather than pick one, for the same reason.
  const dockerfile = source("infra/headwind-phoenix-actions/Dockerfile");
  assert.match(dockerfile, /ARG HEADWIND_IMAGE_TAG/, "the tag comes in from compose");
  assert.doesNotMatch(dockerfile, /FROM headwindmdm\/hmdm:latest/, "never `latest` on a hundred company tablets");

  // 🔴 THE IMAGE HAS NO EXPLODED WEBAPP, AND ONE OF THE TWO MISTAKES THAT FOLLOW IS SILENT.
  //
  // `headwindmdm/hmdm` ships Tomcat and an entrypoint. The application is a WAR the entrypoint
  // DOWNLOADS on first start, so `/usr/local/tomcat/webapps/ROOT/` exists only inside a RUNNING
  // container. Two things were written against it and Railway's first build, 2026-09-26, found the
  // first within ninety seconds:
  //
  //   COPY --from=headwind …/webapps/ROOT/WEB-INF/lib   failed the build outright. Loud, and cheap.
  //   COPY --from=build … INTO …/webapps/ROOT/WEB-INF/lib   would have SUCCEEDED — Docker creates the
  //   path — and shipped a broken image: at first start the entrypoint drops a newer `ROOT.war` in
  //   beside it and Tomcat, unpacking it, deletes the directory the jar was sitting in. The add-on
  //   would be absent, the status endpoint would answer 404, and the console would report the four
  //   custody actions as unavailable. Nothing in this repository would be wrong.
  //
  // Stripped with the `#` lexer, not the JavaScript one: this file's header quotes both wrong paths
  // at length so nobody writes them again, and a raw-text guard would match its own warning.
  const recipe = stripHashComments(dockerfile);
  assert.ok(
    !recipe.includes("webapps/ROOT"),
    "no instruction reads from or writes to the exploded webapp — that directory does not exist in the image, only in a running container",
  );
  assert.match(
    recipe,
    /jar uf /,
    "the add-on jar goes INSIDE the WAR, which is the only placement that survives Tomcat unpacking it",
  );

  // 🔴 AND THE CACHE IS SEEDED AT START, NOT AT BUILD, BECAUSE A VOLUME SITS ON IT.
  // compose mounts `headwind-work` over /usr/local/tomcat/work, which is where Headwind's WAR cache
  // lives. A WAR baked in at build time is invisible the moment that volume exists: the entrypoint
  // finds an empty cache, downloads a clean WAR, and the add-on is gone with no error anywhere.
  assert.match(
    recipe,
    /ENTRYPOINT \["\/phoenix-entrypoint\.sh"\]/,
    "the image starts through our own entrypoint, which seeds the cache after mounts",
  );
  const entrypoint = stripHashComments(source("infra/headwind-phoenix-actions/phoenix-entrypoint.sh"));
  assert.match(
    entrypoint,
    /exec \/docker-entrypoint\.sh "\$@"/,
    "and it then hands over to Headwind's own entrypoint untouched, rather than reimplementing it",
  );
  assert.doesNotMatch(
    entrypoint,
    /BASE_DIR=["']?\/usr/,
    "the cache path is read out of the image's own entrypoint, never hard-coded — a hard-coded path that drifts does not fail, it silently loses the add-on",
  );

  // 🔴 AND IT RE-PROVISIONS RUSTDESK ON EVERY START, BECAUSE HEADWIND WILL NOT.
  //
  // /files/<name> is served from $BASE_DIR/files, under the same ephemeral /usr/local/tomcat/work as
  // the WAR cache. Railway has no volume there, so every redeploy recreates it bare. Headwind's own
  // entrypoint re-fetches the apps that are in the install-time seed (its launcher and plugins); it
  // does NOT re-fetch RustDesk, which was added later through the console. So the 2026-09-26 https
  // redeploy left the RustDesk device record pointing at /files/rustdesk-1.4.9-aarch64-signed.apk
  // (urlArm64, still correct) while the file itself 404'd, and the tablet could not install it. This
  // step does for RustDesk exactly what Headwind does for its seed: ensure the APK is in $BASE_DIR/files
  // on start, fetching it if missing. Remove it and RustDesk silently disappears from the fleet on the
  // next unrelated rebuild of this image.
  assert.match(
    entrypoint,
    /rustdesk-1\.4\.9-aarch64-signed\.apk/,
    "the entrypoint re-provisions the RustDesk APK by its exact filename — the same name the device record's urlArm64 already points at",
  );
  assert.match(
    entrypoint,
    /FILES_DIR="\$BASE_DIR\/files"/,
    "into $BASE_DIR/files, the directory Headwind serves /files/ from — derived from the same BASE_DIR read out of the image, never hard-coded",
  );

  // 🔴 AND THE PHOENIX CUSTOM LAUNCHER IS RE-PROVISIONED THE SAME WAY, for the same reason.
  //
  // The rep tablets enrol onto a custom launcher build (clean status bar, hidden drawer icon) that is
  // not in Headwind's install-time seed, so like RustDesk it must be re-placed into $BASE_DIR/files on
  // every start or a bare Railway work/ leaves the device-owner launcher a 404. It is fetched by its
  // exact filename from the fork's immutable release, and — this is the load-bearing part — the block
  // must never abort startup, because this entrypoint runs before Headwind's own and a bad release must
  // not be able to take the whole MDM down.
  assert.match(
    entrypoint,
    /hmdm-phoenix-6\.40\.apk/,
    "the entrypoint re-provisions the Phoenix custom launcher by its exact filename — the name the launcher version url is pointed at",
  );
  assert.match(
    entrypoint,
    /releases\/download\/launcher-6\.40-r1\//,
    "fetched from the immutable fork release asset, the public URL a bare Railway container can reach",
  );
  assert.match(
    entrypoint,
    /could not fetch a valid \$PHX_LAUNCHER_APK[\s\S]*it will retry next start/,
    "a failed launcher fetch logs and falls through — it never aborts startup, so a bad release cannot down the MDM",
  );

  // 🔴 AND WHATSAPP IS RE-PROVISIONED TOO, FROM WHATSAPP ITSELF — the rep tablets' everyday app.
  //
  // Configuration 3 serves WhatsApp at /files/WhatsApp.apk, and that file died with the same bare
  // work/ on a redeploy: measured 2026-10-22, it answered 404 and the rep's tablet logged "Failed to
  // download app … Bad server response" every hour from 11 October, so WhatsApp never installed. Unlike
  // RustDesk and the launcher it is not an immutable pinned asset — WhatsApp publishes one floating
  // official URL — so the check is a size FLOOR plus the zip magic, never an exact size, and a failed
  // fetch must still fall through rather than abort startup. Remove this block and every new tablet
  // goes without WhatsApp again after the next unrelated rebuild.
  assert.match(
    entrypoint,
    /WHATSAPP_APK="WhatsApp\.apk"/,
    "the entrypoint re-provisions WhatsApp under the exact filename configuration 3 already points at",
  );
  assert.match(
    entrypoint,
    /WHATSAPP_URL="https:\/\/www\.whatsapp\.com\/android\/current\/WhatsApp\.apk"/,
    "fetched from WhatsApp's own official download, never a re-hosted copy",
  );
  assert.match(
    entrypoint,
    /-ge "\$WHATSAPP_MIN_SIZE"[\s\S]*\[ "\$wa_magic" = "PK" \]/,
    "a fetched file is moved into place only when it clears the size floor AND starts with the zip magic, so an error page is never served as an app",
  );
  assert.match(
    entrypoint,
    /could not fetch a valid \$WHATSAPP_APK[\s\S]*it will retry next start/,
    "a failed WhatsApp fetch logs and falls through — it never aborts startup, so WhatsApp's site being down cannot down the MDM",
  );
  assert.ok(
    entrypoint.indexOf("WHATSAPP_APK=") < entrypoint.indexOf('exec /docker-entrypoint.sh "$@"'),
    "and it runs BEFORE the hand-over to Headwind's entrypoint, since nothing after an exec ever runs",
  );

  // 🔴 TELEGRAM AND WPS OFFICE ARE RE-PROVISIONED THE SAME WAY, EACH FROM ITS OWN PUBLISHER.
  //
  // Measured 2026-10-22: /files/Telegram.apk and /files/wps_18.25.2_abi32_en00000.apk both answered 404,
  // so configuration 3 had two everyday apps no rep tablet could ever install. Telegram floats (a size
  // floor plus the zip magic, like WhatsApp); WPS is a per-version file, pinned to its exact size. Drop
  // either call, or point it at a re-hosted copy, and the tablets lose that app on the next rebuild.
  assert.match(
    entrypoint,
    /provision_official_apk "Telegram\.apk" "https:\/\/telegram\.org\/dl\/android\/apk" "" "\$TELEGRAM_MIN_SIZE"/,
    "Telegram is fetched from telegram.org's own direct download under the filename configuration 3 serves, with a size floor rather than an exact size",
  );
  assert.match(
    entrypoint,
    /provision_official_apk "wps_18\.25\.2_abi32_en00000\.apk" \\\n\s+"https:\/\/wdl1\.pcfg\.cache\.wpscdn\.com\/wpsdl\/wpsoffice\/download\/32bit\/wps_18\.25\.2_abi32_en00000\.apk" "\$WPS_SIZE" 0/,
    "WPS Office is fetched from WPS's own CDN and pinned to its exact size",
  );
  assert.match(entrypoint, /^WPS_SIZE=171366058\b/m, "the WPS pin is the size WPS's own file measured on 2026-10-22");
  assert.match(
    entrypoint,
    /apk_size_ok "\$pa_got" "\$pa_exact" "\$pa_min" && \[ "\$pa_magic" = "PK" \]/,
    "a fetched Telegram or WPS file is moved into place only when it clears its size check AND starts with the zip magic",
  );
  assert.match(
    entrypoint,
    /could not fetch a valid \$pa_name[\s\S]*it will retry next start[\s\S]*return 0\n\}/,
    "a failed Telegram or WPS fetch logs and returns 0 — under set -eu anything else would abort startup and down the MDM",
  );
  assert.ok(
    entrypoint.indexOf('provision_official_apk "wps_') < entrypoint.indexOf('exec /docker-entrypoint.sh "$@"'),
    "and both run BEFORE the hand-over to Headwind's entrypoint",
  );

  // 🔴 EVERY START-UP DOWNLOAD IS BOUNDED, AND THE EVERYDAY APPS NEVER HOLD THE SERVER DOWN.
  //
  // phoenix-headwind has no health check (healthcheckPath null, read 2026-10-22), so traffic switches the
  // moment the container starts and the MDM answers nothing until the exec. wget's defaults (20 tries,
  // a 900 s read timeout) let one stalled CDN hold every tablet off the server for hours, and WhatsApp,
  // Telegram and WPS are ~390 MB that no enrolment needs. So every fetch goes through one bounded helper,
  // the three everyday apps run in a background subshell, and only what enrolment needs (RustDesk and
  // the launcher) stays in front of Tomcat.
  assert.match(entrypoint, /wget -q -T 30 -t 2 -O "\$1" "\$2"/, "wget is bounded: two tries, 30 s each");
  assert.match(
    entrypoint,
    /curl -fsSL --connect-timeout 15 --max-time 900 -o "\$1" "\$2"/,
    "and curl, if it is ever the one present, has a hard ceiling",
  );
  assert.doesNotMatch(entrypoint, /^\s*(wget -q -O|curl -fsSL -o) /m, "no app download bypasses the bounded helper");
  const background = entrypoint.match(/\n\(\n([\s\S]*?)\n\) &\n\nexec \/docker-entrypoint\.sh "\$@"/);
  assert.ok(background, "the everyday apps run in a background subshell that closes right before the exec");
  for (const app of ['WHATSAPP_APK="WhatsApp.apk"', 'provision_official_apk "Telegram.apk"', 'provision_official_apk "wps_']) {
    assert.ok(background[1].includes(app), `${app} is fetched in the background, so Tomcat starts at once`);
  }
  for (const enrolment of ["RUSTDESK_APK=", "PHX_LAUNCHER_APK=", 'provision_official_apk "hmdm-phoenix-6.39.apk"']) {
    assert.ok(!background[1].includes(enrolment), `${enrolment} stays in the foreground, because enrolment needs it`);
  }

  // 🔴 AND 6.39 KEEPS BEING SERVED UNTIL THE LAUNCHER'S URL HAS MOVED. Configuration 3 points the launcher
  // (app 46 / version 10045) at /files/hmdm-phoenix-6.39.apk, and the url moves to 6.40 by hand only after
  // the server is up — so a redeploy serving 6.40 alone would 404 every enrolment in between.
  assert.match(
    entrypoint,
    /provision_official_apk "hmdm-phoenix-6\.39\.apk" \\\n\s+"https:\/\/github\.com\/it-gawish-hr\/hmdm-android\/releases\/download\/launcher-6\.39-r1\/hmdm-phoenix-6\.39\.apk" "\$PHX_LAUNCHER_PREVIOUS_SIZE" 0/,
    "the previous launcher is re-provisioned from its own pinned release beside 6.40",
  );
  assert.match(entrypoint, /^PHX_LAUNCHER_PREVIOUS_SIZE=6286121\b/m, "pinned to the 6.39 asset's exact size");

  // 🔴 THE CORE JAR IS FOUND BY THE CLASS IT CARRIES, NEVER BY ITS FILENAME.
  //
  // Headwind ships no `server-*.jar`. Measured 2026-09-26 by unpacking hmdm-5.40.1-os.war: 114 jars
  // in WEB-INF/lib and not one of them matches that name. The core is eleven small jars named for
  // their area — common, push, audit, deviceinfo, notification, platform, messaging, devicelog-core,
  // devicelog-postgres, jwt, xtra — all at 0.1.0, and both classes this add-on compiles against
  // (SyncResponseHook, SyncResponseInt) are inside `common-0.1.0.jar`.
  //
  // The name-based `find` returned nothing, `-Dfile=` fell back to a directory, and Maven answered
  // `Failed to install artifact com.hmdm:server:jar:: Is a directory` — an empty version in the
  // coordinate, forty minutes from the error text to the cause. A filename can be renamed between
  // versions; the class the add-on extends cannot move without the add-on breaking anyway.
  assert.match(
    recipe,
    /com\/hmdm\/rest\/json\/SyncResponseHook\.class/,
    "the build locates Headwind's core by the class the add-on extends, so a renamed jar cannot silently empty the classpath",
  );
  assert.ok(
    !recipe.includes("server*.jar"),
    "and never by a `server*.jar` name, which does not exist in any Headwind WAR",
  );

  const pom = source("infra/headwind-phoenix-actions/pom.xml");
  assert.match(
    pom,
    /<artifactId>common<\/artifactId>/,
    "the pom depends on com.hmdm:common — the artifact that actually carries SyncResponseHook",
  );
  assert.doesNotMatch(
    pom,
    /<artifactId>server<\/artifactId>/,
    "never com.hmdm:server, which Headwind does not publish and this WAR does not contain",
  );

  // 🔴 JAVA 8 BYTECODE — THE FIFTH BUILD, 2026-09-26, AND THE WORST FAILURE OF THE FIVE.
  // Headwind runs Jersey 2.25.1, which scans every jar in WEB-INF/lib for @Path through a repackaged
  // ASM 5. ASM 5 reads class files up to major 52 and throws a bare IllegalArgumentException — no
  // message, no class name — on anything newer. Java 11 emits major 55. Compiling this add-on to 11
  // did not just stop it loading: Jersey aborted its scan, the HMDMApplication filter failed to
  // start, and Tomcat killed the whole context. A working Headwind server, broken by a compiler flag,
  // on a deployment Railway reported green. Every one of Headwind's own 255 classes is major 52.
  assert.match(
    pom,
    /<maven\.compiler\.release>8<\/maven\.compiler\.release>/,
    "the add-on compiles to Java 8 bytecode — Headwind's Jersey 2.25.1 scans WEB-INF/lib with ASM 5, which refuses major 55 and takes the ENTIRE application down, not just this jar",
  );
  for (const legacy of ["maven.compiler.source", "maven.compiler.target"]) {
    assert.ok(
      !pom.includes(`<${legacy}>`),
      `and through <maven.compiler.release>, never <${legacy}> — source/target compile old syntax against the JDK 11 class library, so a Java 11-only method resolves at build time and NoSuchMethodErrors in production`,
    );
  }

  // 🔴 AND THE `provided` VERSIONS ARE THE ONES THE WAR SHIPS, NOT THE NEWEST THAT RESOLVES.
  // This is the one mistake in that file that does NOT fail the build: compiling against a newer
  // provided API than the running server carries fails later, once, as a NoSuchMethodError inside a
  // hook nobody is watching. Read out of hmdm-5.40.1-os.war the same day.
  for (const [artifact, version] of [
    ["guice", "4.2.2"],
    ["jackson-annotations", "2.10.0"],
    ["javax.ws.rs-api", "2.0.1"],
  ] as const) {
    assert.match(
      pom,
      new RegExp(`<artifactId>${artifact.replace(/\./g, "\\.")}</artifactId>\\s*\\n\\s*<version>${version.replace(/\./g, "\\.")}</version>`),
      `${artifact} is pinned to ${version}, the version inside the WAR — a newer provided API compiles and then fails at runtime`,
    );
  }

  // 🔴 AND `-DpomFile`, NOT BARE COORDINATES — THE THIRD FAILED BUILD, 2026-09-26.
  // Given only -DgroupId/-DartifactId/-Dversion, install:install-file digs the pom Maven left INSIDE
  // the jar out of META-INF/maven and installs THAT as the descriptor. Headwind's carries
  // `<parent>com.hmdm:root:0.1.0</parent>`, a pom that exists only in Headwind's own source tree. The
  // install succeeded and the very next command died reading what it had just written:
  // "Failed to read artifact descriptor for com.hmdm:common:jar:0.1.0 … com.hmdm:root:pom:0.1.0 (absent)".
  assert.match(
    recipe,
    /-DpomFile=/,
    "each Headwind jar is installed with a minimal generated descriptor, never the reactor pom baked inside it — that one names a parent nothing can resolve",
  );

  // 🔴 AND TOMCAT'S WEB-APPLICATION LOG IS FORCED ONTO STDOUT — THE FOURTH BUILD, 2026-09-26.
  // That build deployed, Railway reported SUCCESS, and Tomcat printed "One or more Filters failed to
  // start. Full details will be found in the appropriate container log file" — a file inside the
  // container, which on Railway nothing can read. The deployment was green and the server was serving
  // nothing. Appending the console handler to the `[localhost]` logger puts that detail where Railway
  // keeps it. It looks like tidy-up-able noise, which is exactly why it is pinned.
  assert.match(
    recipe,
    /\[Catalina\]\.\[localhost\]\.handlers = .*java\.util\.logging\.ConsoleHandler/,
    "Tomcat's web-application log is appended to stdout, because Railway captures stdout and nothing else — without it a failed filter names its own cause into a file no one can open",
  );

  // ── The four defects that would NOT have failed a build ───────────────────────────────────────
  //
  // 🔴 EVERY ONE OF THESE SHIPS A GREEN BUILD AND A DEAD ADD-ON. That is what makes them worth a test
  // each: the first draft of this add-on would have compiled, built, deployed, started, logged
  // nothing, and answered 404 on every endpoint while four buttons in Phoenix did nothing at all.
  // All four were found by reading the shipped WAR on 2026-09-26, not by running anything.

  // Read with comments stripped, for the same reason the Dockerfile above is: each of these files
  // documents the wrong version of itself at length so nobody writes it again, and a raw-text guard
  // would match its own warning. (The JavaScript lexer is the right one for Java — identical comment
  // grammar; the only divergences are regex literals, which Java has not, and char literals, which
  // nothing in this directory uses. Add one and pick a lexer that knows about it.)
  const java = (file: string) =>
    stripComments(source(`infra/headwind-phoenix-actions/src/main/java/com/hmdm/plugins/phoenix/${file}`));

  // 1. Headwind instantiates a plugin by scanning for implementations of PluginConfiguration. There
  //    is no list to add to and no descriptor file — but a bare Guice module is picked up by nothing.
  const pluginConfig = java("PhoenixPluginConfigurationImpl.java");
  assert.match(
    pluginConfig,
    /implements PluginConfiguration/,
    "the add-on declares a PluginConfiguration — the only thing Headwind's classpath scan looks for, and without it no module in this directory is ever constructed",
  );

  // 2. 🔴 AND THAT SCAN IS WHITELISTED TO ONE PACKAGE. `PluginList` runs
  //    `new ClassGraph().enableAllInfo().whitelistPackages("com.hmdm").scan()`, so a configuration
  //    class anywhere else is invisible. The first draft lived in `com.satopharma.phoenix.headwind`.
  assert.match(
    pluginConfig,
    /^package com\.hmdm\.plugins\.phoenix;/m,
    "the plugin configuration lives under com.hmdm, because Headwind's ClassGraph scan whitelists exactly that package and would never see it anywhere else",
  );
  assert.match(
    pluginConfig,
    /return "com\.hmdm\.plugins\.phoenix";/,
    "and it declares that same subtree as its root package, the way every shipped Headwind plugin does",
  );

  // 3. The hook is a MULTIBINDING. SyncResource injects `Set<SyncResponseHook>`, and Guice fills a Set
  //    only from a Multibinder — a plain bind() binds a key nothing injects, so the set stays empty
  //    and the hook is never called. Nothing anywhere would say so.
  const wiring = java("guice/module/PhoenixActionsModule.java");
  assert.match(
    wiring,
    /Multibinder\.newSetBinder\(binder\(\), SyncResponseHook\.class\)/,
    "the sync hook is added through a Multibinder — the call site injects a Set, which a plain bind() never fills",
  );
  assert.doesNotMatch(
    wiring,
    /\n\s*bind\(SyncResponseHook\.class\)/,
    "and never as a plain binding, which starts cleanly and simply never runs",
  );

  // 4. The decorator delegates the WHOLE interface. An incomplete delegation does not fail to
  //    compile if the missing methods are written by hand as stubs — it ships tablets a configuration
  //    with its applications or kiosk settings quietly missing. 66 is the interface's own method
  //    count, measured from SyncResponseInt in common-0.1.0.jar; a Headwind upgrade that adds a field
  //    fails the compile first and this number is then bumped deliberately, which is the point.
  const decorator = java("rest/PhoenixSyncResponseDecorator.java");
  assert.equal(
    (decorator.match(/return delegate\./g) ?? []).length,
    66,
    "every one of SyncResponseInt's 66 getters is delegated — a gap here does not crash, it hands a tablet a configuration with pieces missing",
  );

  // 🔴 AND NOTHING CALLS getDeviceId(), WHICH SyncResponseInt DOES NOT HAVE. The first draft used it
  // in both the hook and the decorator, from the interface as published on the web rather than the
  // one in the WAR. The device is identified by the `int deviceId` the hook is handed, and the store
  // joins Headwind's own `devices` row on it.
  const hook = java("PhoenixSyncResponseHook.java");
  for (const [name, code] of [["the hook", hook], ["the decorator", decorator]] as const) {
    assert.ok(
      !code.includes("getDeviceId()"),
      `${name} never calls getDeviceId() — SyncResponseInt declares no such method, and the tablet is identified by the device id the hook is handed`,
    );
  }

  // 6. 🔴 THE CONFIRMATION IS GATED ON DELIVERY, AND THAT CLAUSE IS THE SECURITY OF THIS ADD-ON.
  //    The three confirmation URLs are unauthenticated — the stock agent posts them with no token, and
  //    authenticating them would mean shipping a modified agent, which is the one thing this design
  //    avoids. So anyone who knows a device number can call them, and the number is printed on the
  //    tablet. Without `consumed_at is not null` a stranger could close a row that had NEVER been
  //    delivered: queue a wipe, confirm it a second later, and the console reports a wiped tablet that
  //    is sitting in somebody's bag. `consumed_at` is written by nothing but the sync hook, while it
  //    puts the field into a real response — so requiring it narrows a forged confirmation to the
  //    seconds in which the tablet is carrying the instruction out anyway.
  const store = java("PhoenixActionStore.java");
  assert.match(
    store,
    /confirmed_at is null and consumed_at is not null/,
    "a confirmation can only close a row the sync hook actually delivered — without that clause an unauthenticated caller could mark a freshly queued wipe as done before the tablet ever heard about it",
  );

  // 7. 🔴 AND A COLUMN ADDED AFTER THE FIRST DEPLOY NEEDS AN ALTER, NOT A WIDER CREATE. The live table
  //    was created 2026-09-25 and `create table if not exists` skips the statement WHOLE rather than
  //    reconciling columns, so a column added to the create block alone never reaches the running box —
  //    and every statement naming it then fails inside the hook's own swallowed catch, invisibly.
  assert.match(
    store,
    /alter table phoenix_pending_actions add column if not exists/,
    "ensureSchema issues add-column-if-not-exists as well as create-table-if-not-exists, because the live table already exists and a widened create reaches it never",
  );

  // 8. The source of a confirmation is recorded from getRemoteAddr() and NEVER from X-Forwarded-For:
  //    that header is set by whoever is calling, so trusting it would let a forged confirmation choose
  //    what gets written beside it, which is worse than recording nothing at all.
  const confirmResource = java("rest/DeviceResetConfirmResource.java");
  assert.match(
    confirmResource,
    /request\.getRemoteAddr\(\)/,
    "the confirmation's source is read from the connection, not from a header the caller controls",
  );
  assert.doesNotMatch(
    confirmResource,
    /X-Forwarded-For|x-forwarded-for/,
    "and never from X-Forwarded-For, which a forged confirmation would simply set to whatever it liked",
  );

  // 9. A confirmation that closes nothing is the detection, so it must be logged — and the answer to
  //    the agent must still be OK, because refusing makes a real tablet retry forever.
  assert.match(
    confirmResource,
    /closed == 0/,
    "a confirmation that closed no row is noticed rather than silently accepted — that log line is the only signal a forged or stale confirmation leaves",
  );

  // 10. 🔴 THE TABLET SERVER'S HOST-LEVEL REWRITE RULES (owner, 2026-10-22). Two jobs in one file:
  //     the two public uploads (`/rest/public/applications/upload`, `/rest/videos`) are refused on every
  //     name — "close the tablet server's open upload path" — and every name EXCEPT
  //     mdm-console.satopharma.com serves the tablet agent's own paths and nothing else — "split the
  //     Headwind console onto mdm-console behind Access".
  //
  //     🔴 TOMCAT MATCHES THE WHOLE PATH. RewriteRule and RewriteCond both call Matcher.matches(), so the
  //     model below anchors every pattern at both ends, exactly as Tomcat does. The first test of the
  //     upload rules used JavaScript's `test()`, which matches a PREFIX, and so it passed `^/rest/videos`
  //     as refusing `/rest/videos/clip.mp4` — which Tomcat never would have. That is how the trailing-slash
  //     gap (`/rest/videos/` through the door) shipped green.
  //
  //     The cases live in rewrite-cases.txt, and RewriteCheck.java runs TOMCAT'S OWN ENGINE over the same
  //     file at image build (the `headwind-image` workflow builds it on every PR touching that folder).
  //     This model is the fast first line; Tomcat is the authority.
  //
  //     BREAK-TEST: drop `(/.*)?$` from the videos rule, or delete one path from the allowlist rule, or
  //     loosen the host condition, and the matching case below fires.
  type Cond = { test: string; pattern: RegExp; positive: boolean };
  type Rule = { pattern: RegExp; positive: boolean; forbidden: boolean; conds: Cond[] };
  const anchored = (pattern: string, flags: string) => new RegExp(`^(?:${pattern})$`, `s${flags}`);
  const rewriteLines = source("infra/headwind-phoenix-actions/rewrite.config")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const rules: Rule[] = [];
  let pendingConds: Cond[] = [];
  for (const line of rewriteLines) {
    const [kind, first, second, flagText = ""] = line.split(/\s+/);
    const nocase = /\bNC\b/.test(flagText);
    if (kind === "RewriteCond") {
      const positive = !second!.startsWith("!");
      pendingConds.push({ test: first!, pattern: anchored(second!.replace(/^!/, ""), nocase ? "i" : ""), positive });
      continue;
    }
    assert.equal(kind, "RewriteRule", `rewrite.config holds only RewriteRule and RewriteCond lines — not: ${line}`);
    assert.equal(second, "-", "every rule substitutes nothing and refuses");
    const positive = !first!.startsWith("!");
    rules.push({
      pattern: anchored(first!.replace(/^!/, ""), nocase ? "i" : ""),
      positive,
      forbidden: /\bF\b/.test(flagText),
      conds: pendingConds,
    });
    pendingConds = [];
  }
  assert.equal(pendingConds.length, 0, "no RewriteCond is left dangling at the end of the file");
  assert.equal(rules.length, 3, "three rules: the two uploads and the host split");
  assert.ok(rules.every((rule) => rule.forbidden), "every rule refuses with [F]");
  const tomcatRefuses = (host: string, path: string) =>
    rules.some(
      (rule) =>
        rule.pattern.test(path) === rule.positive &&
        rule.conds.every((cond) => {
          assert.equal(cond.test, "%{HTTP_HOST}", "the only variable the rules read is the host");
          return cond.pattern.test(host) === cond.positive;
        }),
    );

  const cases = source("infra/headwind-phoenix-actions/rewrite-cases.txt")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(/\s+/));
  assert.ok(cases.length >= 40, `rewrite-cases.txt carries the cases (${cases.length})`);
  for (const [expect, host, path] of cases) {
    assert.ok(expect === "allow" || expect === "refuse", `a case starts with allow or refuse, not ${expect}`);
    assert.equal(
      tomcatRefuses(host!, path!),
      expect === "refuse",
      `${host}${path} should be ${expect === "allow" ? "ALLOWED" : "REFUSED"} — the rules would ${tomcatRefuses(host!, path!) ? "refuse" : "allow"} it`,
    );
  }

  // 🔴 THE TABLETS' WHOLE VOCABULARY IS IN THE CASES, ON THE TABLETS' OWN HOSTNAME. This list is read
  // from the agent's source (ServerService.java, PushNotificationWorker, PushLongPollingService,
  // GetServerConfigTask at h-mdm/hmdm-android master, identical at our launcher fork's launcher-6.39-r1).
  // A path that leaves the allowlist leaves a tablet unable to sync, and the server would look healthy.
  const AGENT_PATHS = [
    "/rest/public/sync/configuration/{n}",
    "/rest/public/sync/info",
    "/rest/notifications/device/{n}",
    "/rest/notification/polling/{n}",
    "/rest/plugins/devicelog/log/rules/{n}",
    "/rest/plugins/devicelog/log/list/{n}",
    "/rest/plugins/deviceinfo/deviceinfo/public/{n}",
    "/rest/plugins/devicelocations/public/update/{n}",
    "/rest/plugins/deviceinfo/deviceinfo-plugin-settings/device/{n}",
    "/rest/plugins/devicereset/public/{n}",
    "/rest/plugins/devicereset/public/reboot/{n}",
    "/rest/plugins/devicereset/public/password/{n}",
  ];
  for (const template of AGENT_PATHS) {
    const path = template.replace("{n}", "PHX-TAB-0007");
    assert.ok(
      cases.some(([expect, host, p]) => expect === "allow" && host === "mdm.satopharma.com" && p === path),
      `rewrite-cases.txt proves the tablets still reach ${path} on mdm.satopharma.com`,
    );
    assert.ok(!tomcatRefuses("mdm.satopharma.com", path), `and the rules let ${path} through`);
  }
  assert.ok(!tomcatRefuses("mdm.satopharma.com", "/files/RustDesk.apk"), "and every APK under /files/");

  // The console's hostname in the rules is the one AccessGateFilter checks for an Access pass. If they
  // ever drift, the rewrite lets the console through on a name the filter does not guard.
  const gate = stripComments(source("infra/headwind-phoenix-actions/src/main/java/com/hmdm/plugins/phoenix/security/AccessGateFilter.java"));
  const gateHost = gate.match(/CONSOLE_HOST = "([^"]+)"/)?.[1];
  assert.equal(gateHost, "mdm-console.satopharma.com", "AccessGateFilter guards the console hostname");
  assert.ok(
    rules[2]!.conds.some((cond) => !cond.positive && cond.pattern.test(gateHost!) && !cond.pattern.test(`x${gateHost}`)),
    "and the host split exempts exactly that name, no more",
  );

  // The Dockerfile puts the rules at HOST level (ROOT.xml is regenerated at every start, server.xml is
  // not), and runs Tomcat's own parser AND engine on them at build, because a rule Tomcat cannot parse
  // stops the whole Host while Railway reports the deploy green, and a rule that parses but refuses a
  // tablet path takes the fleet dark just as quietly.
  const upload = stripHashComments(dockerfile);
  assert.match(
    upload,
    /COPY rewrite\.config \/usr\/local\/tomcat\/conf\/Catalina\/localhost\/rewrite\.config/,
    "the rules sit in the Host's own config folder, where the Host-level valve reads them",
  );
  assert.match(upload, /COPY rewrite-cases\.txt \/tmp\/rewrite-cases\.txt/, "the cases go into the image build");
  assert.match(
    upload,
    /sed -i 's\|<\/Host>\|  <Valve className="org\.apache\.catalina\.valves\.rewrite\.RewriteValve" \/>/,
    "the valve goes into server.xml's one Host, which nothing rewrites at start",
  );
  assert.match(upload, /grep -c '<\/Host>'/, "and refuses to guess when server.xml does not hold exactly one Host");
  const check = upload.match(/\/tmp\/RewriteCheck\.java "\$TOMCAT\/conf\/Catalina\/localhost\/rewrite\.config" (\d+) \/tmp\/rewrite-cases\.txt/);
  assert.ok(check, "the build runs RewriteCheck on the installed rules file and the cases");
  assert.equal(Number(check?.[1]), rules.length, "with the rule count the file really holds");
  const rewriteCheck = stripComments(source("infra/headwind-phoenix-actions/RewriteCheck.java"));
  assert.match(rewriteCheck, /RewriteValve\.parse\(line\)/, "RewriteCheck parses each line with Tomcat's own parser");
  assert.match(rewriteCheck, /rule\.addCondition\(cond\)/, "attaches each condition to the rule after it, as the valve does");
  assert.match(rewriteCheck, /rule\.parse\(new HashMap<>\(\)\)/, "and compiles each pattern the way the valve does at start");
  assert.match(rewriteCheck, /rule\.evaluate\(parts\[2\], resolver\)/, "then runs Tomcat's own engine over every case");
  assert.match(rewriteCheck, /"HTTP_HOST"\.equals\(key\)\) return host/, "handing it the case's host as %{HTTP_HOST}");

  // 11. 🔴 THE CONSOLE CHECKS CLOUDFLARE'S ACCESS PASS ITSELF (owner, 2026-10-22: shut the back door at
  //     the server). Access guards only traffic that comes through Cloudflare; Railway's edge answers
  //     anyone who connects to it with the console's name, which never meets Cloudflare. So the add-on
  //     verifies the signed pass on every request to the console's hostname.
  const restWiring = stripComments(source("infra/headwind-phoenix-actions/src/main/java/com/hmdm/plugins/phoenix/guice/module/PhoenixRestModule.java"));
  const body = restWiring.slice(restWiring.indexOf("configureServlets"));
  assert.match(body, /filter\("\/\*"\)\.through\(AccessGateFilter\.class\)/, "the gate is registered on every path");
  assert.ok(
    body.indexOf("AccessGateFilter.class") < body.indexOf("JWTFilter.class"),
    "and before the add-on's own private-path filters",
  );
  assert.match(gate, /request\.getServerName\(\)/, "the gate tests getServerName(), the value Tomcat gives the rewrite as %{HTTP_HOST}");
  assert.doesNotMatch(gate, /getHeader\("Host"\)|X-Forwarded/i, "never a raw Host or forwarded header the two could read differently");
  assert.match(gate, /System\.getenv\("PHX_ACCESS_TEAM_DOMAIN"\)/, "the team comes from the service's variables");
  assert.match(gate, /System\.getenv\("PHX_ACCESS_AUD"\)/, "and so does the console application's audience tag");
  assert.match(gate, /Mode\.MISCONFIGURED/, "a half-set gate refuses rather than guessing open");
  assert.match(gate, /"Cf-Access-Jwt-Assertion"/, "the pass is read from Cloudflare's own header");
  const verifier = stripComments(source("infra/headwind-phoenix-actions/src/main/java/com/hmdm/plugins/phoenix/security/AccessTokenVerifier.java"));
  assert.match(verifier, /"RS256"\.equals\(header\.get\("alg"\)\)/, "only RS256 passes — `none` and HMAC tricks are refused");
  assert.match(verifier, /SHA256withRSA/, "the signature is checked");
  assert.match(verifier, /issuer\.equals\(claims\.get\("iss"\)\)/, "the issuer must be the team");
  assert.match(verifier, /hasAudience\(claims\.get\("aud"\)\)/, "the audience must be THIS application");
  assert.match(verifier, /\/cdn-cgi\/access\/certs/, "keys come from Cloudflare's published list");
  assert.match(verifier, /REFETCH_FLOOR_MILLIS/, "and an unknown key id cannot make the server hammer Cloudflare");
  for (const file of ["AccessGateFilter.java", "AccessTokenVerifier.java", "MiniJson.java"]) {
    const java = stripComments(source(`infra/headwind-phoenix-actions/src/main/java/com/hmdm/plugins/phoenix/security/${file}`));
    assert.doesNotMatch(java, /com\.fasterxml\.jackson\.databind|java\.net\.http|\bvar\s+\w+\s*=/, `${file} uses nothing the WAR or Java 8 lacks`);
  }
  const buildStage = upload.slice(upload.indexOf("AS build"), upload.indexOf("jar uf"));
  assert.match(
    buildStage,
    /RUN java -cp target\/classes \/tmp\/AccessVerifierCheck\.java/,
    "the build proves the verifier against the compiled classes before they go into the WAR",
  );
  const verifierCheck = stripComments(source("infra/headwind-phoenix-actions/AccessVerifierCheck.java"));
  for (const forgery of ["ANOTHER Access app", "expired", "not valid yet", "another team", "stranger's key", "never published", "alg none", "alg HS256", "altered claims"]) {
    assert.ok(verifierCheck.includes(forgery), `AccessVerifierCheck refuses a pass from: ${forgery}`);
  }

  // 12. And CI builds that image before a merge can ship it — the runbook's "no safe way to rehearse".
  const imageWorkflow = source(".github/workflows/headwind-image.yml");
  assert.match(imageWorkflow, /- "infra\/headwind-phoenix-actions\/\*\*"/, "the image build runs on every PR touching the add-on's folder");
  assert.match(imageWorkflow, /docker build [^\n]*infra\/headwind-phoenix-actions/, "and builds exactly that folder, as Railway does");
  assert.doesNotMatch(imageWorkflow, /docker push|railway |secrets\./, "and pushes and deploys nothing");
}

/**
 * The one failure mode nothing else in this repository would see: a Railway certificate that stops
 * renewing behind Cloudflare's proxy.
 *
 * 🔴 WHY A WORKFLOW AND NOT A NOTE. Railway proves ownership of a custom domain by reading that
 * hostname's CNAME out of DNS, and through an orange cloud it reads `""` — measured 2026-09-26 on
 * `mdm-console.satopharma.com`, which went to `DNS_RECORD_STATUS_PROPAGATED` within one poll of the
 * cloud being turned grey. Once a record is proxied, Cloudflare serves its OWN certificate to the
 * browser, so the padlock stays green while the origin certificate expires underneath it, and Full
 * (strict) — zone-wide here — turns that into a 526 sixty days after anybody touched anything.
 * /api/healthz answers from behind Cloudflare, CI knows nothing about certificates, and the deploy
 * drift check compares SHAs, so every existing signal in this repository stays green through it.
 */
function runOriginCertificateCheckTests() {
  const workflow = stripHashComments(source(".github/workflows/origin-certificate-check.yml"));

  // 🔴 IT READS THE ORIGIN, NOT THE HOSTNAME. Asking the hostname gets Cloudflare's certificate once
  // the record is orange — which is the blind spot, not the measurement. Connecting to the Railway edge
  // target with SNI set to the custom hostname is what makes Railway serve the certificate it holds
  // FOR that hostname, grey or orange. Proven against all three live hosts before this shipped.
  assert.match(
    workflow,
    /openssl s_client -connect "\$\{target\}:443" -servername "\$\{host\}"/,
    "the check connects to the Railway edge target with SNI set to the custom hostname, which is the only way to read the ORIGIN certificate once Cloudflare is proxying",
  );

  // 🔴 AND IT COVERS THE PRODUCTION APP, NOT ONLY THE TABLET HOSTNAMES. phoenix-hr.satopharma.com is a
  // Railway custom domain on the same zone; the same silent renewal failure there takes the business
  // down, and it is the cheapest hostname to forget because nobody set it up this month.
  assert.match(
    workflow,
    /phoenix-hr\.satopharma\.com\|/,
    "the production app's own hostname is covered — the same failure there is far more expensive than on the console",
  );

  // The alarm has to reach a person: a schedule-triggered failure emails the run author, and a cron run
  // has none. Same secrets and same channel as deploy-drift-check.yml, never a new recipient.
  assert.match(
    workflow,
    /TELEGRAM_ALERT_CHAT_ID/,
    "a failing scheduled check notifies nobody by construction, so it alerts through the owner's existing Telegram channel",
  );
}

/**
 * The console the owner actually presses — the panel kit, the per-tablet sections and the fleet-wide
 * ones.
 *
 * 🔴 THESE ARE SOURCE PINS, NOT RENDER TESTS, AND THAT IS DELIBERATE. There is no DOM in this suite,
 * and the things worth guarding here are not what a render would show: that an action out of reach is
 * a SENTENCE and never a greyed control, that an armed press names what it destroys, that a wipe's
 * scope cannot be chosen by the browser, and that nothing puts a credential where a credential must
 * not go. Each of those is a property of the source, and each of them fails silently on a screen.
 */
function runConsoleUiTests() {
  const kit = stripComments(source("src/components/devices/headwind-panel-kit.tsx"));
  const panel = stripComments(source("src/components/devices/headwind-tablet-panel.tsx"));
  const settings = stripComments(source("src/components/devices/headwind-server-settings.tsx"));
  const enrollment = stripComments(source("src/components/devices/headwind-enrollment.tsx"));

  // 🔴 THE GUARANTEE THAT KEEPS ONE TABLET'S FACTS OFF ANOTHER TABLET'S HEADING. The answer is stored
  // beside the URL it answers, so "loading" is derived during the render that changed the URL. Lose
  // this and a stale read renders under the wrong tablet — on a custody console, in front of somebody
  // deciding whether to erase it.
  assert.match(kit, /const settled = state\.answered && state\.url === url;/, "the read hook keys its answer to its own URL");
  assert.match(kit, /export function CannotDo\(/, "and the kit owns the 'why not' sentence, so no panel invents its own");

  // ONE copy of the hook. A second would be the one that quietly loses the guarantee above.
  assert.doesNotMatch(panel, /function useRead</, "the tablet panel imports the read hook rather than keeping a second copy");
  assert.doesNotMatch(settings, /function useRead</, "and so does the server-settings screen");
  for (const [name, text] of [["the tablet panel", panel], ["the server settings", settings]] as const) {
    assert.match(text, /@\/components\/devices\/headwind-panel-kit/, `${name} takes its pieces from the kit`);
  }

  // 🔴 THE OWNER'S RULING OF 2026-09-25 MADE MECHANICAL: "no, do not build a dead buttons." An action
  // this box cannot honour renders as a sentence carrying the server's own reason, in the place the
  // button would have been. A `disabled` control keyed on availability is exactly the shape that is
  // refused — it invites a press, teaches nothing, and reads as "not built yet" whether the cause is a
  // box that needs rebuilding or a permission only a manufacturer's signature grants.
  assert.match(panel, /<CannotDo key=\{action\.id\} label=\{action\.label\} reason=\{action\.unavailableReason \?\? ""\}/, "an unavailable action is a sentence");
  assert.doesNotMatch(panel, /disabled=\{!?\s*action\.available/, "and never a greyed button");
  assert.match(panel, /const available = actions\.filter\(\(action\) => action\.available\);/, "only the available ones become buttons");

  // The message counter is a COPY of the server's limit, because importing it would drag the audit
  // writer into a browser bundle. Pinned together so the two cannot drift apart unnoticed.
  assert.match(panel, new RegExp(`const MESSAGE_LIMIT = ${HEADWIND_MESSAGE_LIMIT};`), "the console counts to the server's own limit");

  // 🔴 THE WIPE'S SCOPE IS NOT A PARAMETER — the same rule the route is pinned on, at the other end of
  // the wire. A body that can carry apps or folders is a wipe that can be aimed from a browser.
  assert.match(panel, /postJson<\{ message: string \}>\("\/api\/devices\/headwind\/wipe", \{ deviceNumber \}\)/, "the wipe body names a tablet and nothing else");
  assert.doesNotMatch(panel, /apps: \[|folders: \[/, "the browser cannot choose what a wipe erases");
  // And the second press says out loud what goes, from the server's own list — never "confirm".
  assert.match(panel, /Press again to erase \$\{erases\.join\(", "\)\} from \$\{tabletName\}/, "the armed wipe names the camera roll out loud, because the owner chose the scope that takes field photos");
  // …and names the tablet as a person calls it (its asset tag), not Headwind's device number.
  assert.match(panel, /tabletName = deviceNumber,/, "the tablet's name falls back to its device number only when the register has no tag");
  // 🔴 A PRESS-AGAIN BUTTON DOES NOT STAY LOADED. Every armed control on the panel disarms after the
  // kit's shared window, so a stray press minutes later starts over instead of erasing a tablet.
  assert.match(kit, /export const ARM_WINDOW_MS = 8_000;/, "the kit owns one arm window");
  assert.equal(
    (panel.match(/useDisarmAfterWindow\(own\.armed(Revoke)?,/g) ?? []).length,
    4,
    "actions, wipe, app removal and revoke all disarm on their own",
  );
  assert.doesNotMatch(`${panel}\n${settings}`, /PANEL_INPUT/, "every field wears the shared form tokens, not a panel copy");
  assert.doesNotMatch(panel, /Are you sure|confirm\?/i, "no dialog stands in for saying what happens");

  // 🔴 NOTHING HERE KEEPS A CREDENTIAL ANYWHERE A CREDENTIAL SURVIVES. The enrollment payload and a new
  // console password both live in component state for as long as they are on screen and nowhere else.
  for (const [name, text] of [
    ["the tablet panel", panel],
    ["the server settings", settings],
    ["the enrollment card", enrollment],
  ] as const) {
    assert.doesNotMatch(text, /localStorage|sessionStorage|document\.cookie/, `${name} stores nothing in the browser`);
    assert.doesNotMatch(text, /console\.(log|info|warn|error|debug)/, `${name} logs nothing`);
  }
  assert.match(enrollment, /requestJson<RevealedTemplate>\("\/api\/devices\/headwind\/enrollment", \{ show: true \}\)/, "the code comes back only when somebody asks for it");
  assert.doesNotMatch(enrollment, /enrollment\?.*payload|payload=\$\{/, "and never through a URL, which is logged by everything it passes");
  assert.match(settings, /autoComplete="new-password"/, "a new console password is not offered from a browser's saved logins");
  assert.match(settings, /\.\.\.NO_USER_PENDING,/, "and the whole form is reset on success, which is what drops it");

  // 🔒 THE SQUARE-EDGE GOLDEN RULE, and the no-ellipsis rule, on every new surface. Both are decided
  // by a class name, so both regress silently.
  for (const [name, text] of [
    ["the panel kit", kit],
    ["the tablet panel", panel],
    ["the server settings", settings],
    ["the enrollment card", enrollment],
  ] as const) {
    assert.doesNotMatch(text, /\brounded(-|\b)/, `${name} keeps square corners`);
    assert.doesNotMatch(text, /\btruncate\b|text-ellipsis|line-clamp/, `${name} wraps text rather than cutting it`);
    // 🔒 THE FITS-THE-SCREEN GOLDEN RULE. `overflow-x-auto` over a min-width IS the bug it looks like
    // the fix for — it hides a too-wide layout behind a sideways scroll instead of making it fit.
    assert.doesNotMatch(text, /overflow-x-auto|min-w-\[/, `${name} fits the screen rather than scrolling sideways`);
  }
}

/**
 * The console behind a Cloudflare Tunnel (the owner's decision, 2026-09-25).
 *
 * 🔴 THIS IS THE ONE THAT WOULD TAKE THE WHOLE BRIDGE DARK IF IT REGRESSED. Cloudflare Access asks a
 * PERSON to sign in, and Phoenix is not a person — without the service-token headers every call is
 * answered by Cloudflare's own sign-in page instead of by Headwind, on a server that is in fact
 * perfectly healthy. The failure is silent-shaped and points at the wrong credential, so both the
 * headers and the sentences that name the right door are pinned here.
 */
async function runCloudflareAccessTests() {
  assert.deepEqual(headwindAccessHeaders({} as NodeJS.ProcessEnv), {}, "no tunnel, no headers — nothing changes for a direct server");
  assert.deepEqual(headwindAccessHeaders(ENV), {}, "and the ordinary settings alone add none either");

  const behindTunnel = {
    ...ENV,
    HEADWIND_MDM_ACCESS_CLIENT_ID: "abc123.access",
    HEADWIND_MDM_ACCESS_CLIENT_SECRET: "the-service-token-secret",
  } as unknown as NodeJS.ProcessEnv;
  assert.deepEqual(headwindAccessHeaders(behindTunnel), {
    "CF-Access-Client-Id": "abc123.access",
    "CF-Access-Client-Secret": "the-service-token-secret",
  });

  // Half a token cannot authenticate, and Access would answer HTML rather than JSON — so it is
  // refused here, by the name of the missing half, instead of surfacing later as an unreadable reply.
  for (const [half, missing] of [
    ["HEADWIND_MDM_ACCESS_CLIENT_ID", "HEADWIND_MDM_ACCESS_CLIENT_SECRET"],
    ["HEADWIND_MDM_ACCESS_CLIENT_SECRET", "HEADWIND_MDM_ACCESS_CLIENT_ID"],
  ] as const) {
    assert.throws(
      () => headwindAccessHeaders({ ...ENV, [half]: "set" } as unknown as NodeJS.ProcessEnv),
      (error: unknown) => error instanceof HeadwindNotConfiguredError && error.message.includes(missing),
      `half a service token is refused and names ${missing}`,
    );
  }

  // Both halves ride on the SIGN-IN as well as the API calls — it is the first request Cloudflare
  // sees, so missing it there would turn every later call into a failure blaming the admin password.
  resetHeadwindTokenCache();
  const tunnelled = makeFetch({ api: [{ body: { data: { ok: true }, status: "OK" }, status: 200 }] });
  await callHeadwind("/rest/private/devices/search", { method: "POST" }, tunnelled.fetch, behindTunnel);
  for (const call of tunnelled.calls) {
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers["CF-Access-Client-Id"], "abc123.access", `${call.url} carried the service token id`);
    assert.equal(headers["CF-Access-Client-Secret"], "the-service-token-secret", `${call.url} carried its secret`);
  }
  assert.ok(
    tunnelled.calls.some((call) => call.url.includes("/jwt/login")),
    "and the sign-in is one of the calls that carried them",
  );

  // A reply that is not JSON, WHEN A SERVICE TOKEN IS SET, is most likely Access's own sign-in page —
  // and the error has to say so, or an afternoon goes on the admin password of a server answering fine.
  resetHeadwindTokenCache();
  const signInPage = makeFetch({ login: [{ body: new Error("not json"), status: 403 }] });
  await assert.rejects(
    () => getHeadwindToken(signInPage.fetch, behindTunnel),
    (error: unknown) =>
      error instanceof HeadwindNotConfiguredError &&
      /HEADWIND_MDM_ACCESS_CLIENT_ID/.test(error.message) &&
      /not JSON/.test(error.message),
    "a sign-in page names the Cloudflare door first, not the Headwind password",
  );

  // 🔴 AND THE OTHER WAY ROUND, WHICH THIS CODE HAD BACKWARDS UNTIL 2026-09-26. The comment here used
  // to read "a reply that is not JSON IS Cloudflare, not Headwind", and the error message said so
  // unconditionally. Measured against the live server the same day: `POST /rest/public/jwt/login` with
  // a login that does not exist, no Cloudflare anywhere in the path, answers a TOMCAT HTML 401 error
  // page — `sendError`, not JSON. So the ordinary wrong-password case produced the Cloudflare
  // sentence, and pointed the reader at two variables that were not set on the service at all. With NO
  // service token configured there is nothing but Headwind in the path, so the credential is the only
  // thing left to name — and the Access variables must NOT be named, or the advice is a dead end.
  resetHeadwindTokenCache();
  const tomcatErrorPage = makeFetch({ login: [{ body: new Error("<!doctype html> HTTP Status 401"), status: 401 }] });
  await assert.rejects(
    () => getHeadwindToken(tomcatErrorPage.fetch, ENV),
    (error: unknown) =>
      error instanceof HeadwindNotConfiguredError &&
      /HEADWIND_MDM_LOGIN and HEADWIND_MDM_PASSWORD/.test(error.message) &&
      /Tomcat/.test(error.message) &&
      !/HEADWIND_MDM_ACCESS_CLIENT_ID/.test(error.message),
    "with no service token set, an HTML refusal names the LOGIN and PASSWORD and never sends the reader to Cloudflare variables that do not exist",
  );

  // 🔴 A 200 WITH NO TOKEN IS NOT ALWAYS A REFUSAL, and calling it one cost an evening on
  // production. Headwind answers `status: OK` with `data.passwordReset` plus a reset token when the
  // account must change its password first — which is how a freshly created console user arrives — and
  // `data.twoFactor` when 2FA is on. Its own console reads both. Phoenix read neither and reported
  // "the server refused the Phoenix sign-in — check HEADWIND_MDM_LOGIN and HEADWIND_MDM_PASSWORD",
  // while the server's audit log recorded that very sign-in as `errorCode=0`: a SUCCESS. The credential
  // was right, and the message sent the owner back to Railway for the third time that night.
  resetHeadwindTokenCache();
  const mustChange = makeFetch({
    login: [{ body: { data: { passwordReset: true, passwordResetToken: "reset-1" }, status: "OK" }, status: 200 }],
  });
  await assert.rejects(
    () => getHeadwindToken(mustChange.fetch, ENV),
    (error: unknown) =>
      error instanceof HeadwindNotConfiguredError &&
      /accepted the sign-in/.test(error.message) &&
      /password change/.test(error.message) &&
      !/refused/.test(error.message),
    "a password-change demand says the credential is correct and names what the server wants, never 'refused'",
  );
  resetHeadwindTokenCache();
  const twoFactor = makeFetch({ login: [{ body: { data: { twoFactor: true }, status: "OK" }, status: 200 }] });
  await assert.rejects(
    () => getHeadwindToken(twoFactor.fetch, ENV),
    (error: unknown) =>
      error instanceof HeadwindNotConfiguredError &&
      /two-factor/.test(error.message) &&
      !/refused/.test(error.message),
    "and a two-factor account is named as such rather than reported as a bad password",
  );
  resetHeadwindTokenCache();

  // And the secret is never in what a person or a log is shown.
  resetHeadwindTokenCache();
  const refused = makeFetch({ login: [{ body: { message: "Wrong password", status: "ERROR" }, status: 200 }] });
  await assert.rejects(
    () => getHeadwindToken(refused.fetch, behindTunnel),
    (error: unknown) => error instanceof HeadwindNotConfiguredError && !error.message.includes("the-service-token-secret"),
    "the service-token secret never reaches an error message",
  );
  resetHeadwindTokenCache();

  // The runbook has to carry BOTH halves, because the server is built by hand and nothing in CI can
  // catch a step nobody took: how Phoenix gets through Access, and the refusal of the `/rest/*`
  // exception that would otherwise look like a tidy simplification.
  const runbook = source("docs/devices/headwind-rustdesk.md");
  assert.match(runbook, /HEADWIND_MDM_ACCESS_CLIENT_ID/, "the runbook says how Phoenix gets through Access");
  assert.match(runbook, /HEADWIND_MDM_ACCESS_CLIENT_SECRET/, "and names its other half");
  assert.match(runbook, /CF-Access-Client-Id/, "and names the header, so it can be recognised in a log");
  assert.match(
    runbook,
    /no exception rule for `\/rest\/\*`/,
    "and refuses that exception in writing — it is the obvious-looking simplification, and it would leave the API that factory-resets tablets open",
  );
  // 🔴 THE ONE PLAUSIBLE FAILURE OF THE OWNER'S LAST STEP HAD ITS ADVICE POINTING AT A DEAD END.
  // A refused sign-in comes back as an HTML page, and both the code and the runbook used to read that
  // as Cloudflare — while no service token is set on the service at all. The runbook has to carry the
  // measurement, not just the fixed behaviour, or the next reader re-derives it from the symptom.
  assert.match(
    runbook,
    /Tomcat HTML 401/,
    "the runbook records that a refused Headwind sign-in answers an HTML error page, so a non-JSON reply is never read as proof of Cloudflare",
  );
  assert.match(
    runbook,
    /never through `railway variables --stdin`, which stores a BOM INSIDE the value/,
    "and warns how to type the two credentials, because a BOM no screen displays would fail every sign-in with a password that looks correct",
  );
  // 🔴 THE OBVIOUS WAY TO VERIFY THE ADD-ON'S TABLE DOES NOT EXIST, AND THE RUNBOOK HAS TO SAY SO.
  // `headwind-db-eu` has no TCP proxy — DATABASE_URL points at its private domain and there is no
  // DATABASE_PUBLIC_URL — so a laptop cannot connect at all (measured: ENOTFOUND). Without this, the
  // next session reaches for psql, hits a DNS failure that looks like a broken connection string, and
  // may well "fix" it by opening a proxy — putting the fleet's database on the public internet to save
  // one command. The runbook names the startup log as the evidence instead.
  //
  // 🔴 THE SERVICE WAS RENAMED BY DELETION, NOT BY A RENAME: `headwind-db` in `sfo` was DELETED on
  // 2026-09-28 after the fleet database moved to EU West, so `postgres.railway.internal` — which this
  // comment used to name — now resolves to nothing at all. A stale hostname in a comment is worse than
  // no comment: it reads as the thing to try.
  //
  // What this assertion pins is that there is no STANDING public endpoint. It is not a ban on ever
  // opening one: the runbook documents `railway tcp-proxy create` for a migration that genuinely needs
  // psql, together with deleting it afterwards and the fact that the delete takes the proxy id
  // POSITIONALLY or removes nothing. The distinction is deliberate — "never open one" was unenforceable
  // and got ignored under pressure, whereas "open it, use it, close it, and say so" is a procedure
  // somebody can actually follow. The failure this guards against is the proxy nobody closed.
  assert.match(
    runbook,
    /no `DATABASE_PUBLIC_URL`/,
    "the runbook records that the Headwind database has no public endpoint, so a session does not try to connect to it and then open one",
  );
  assert.match(
    runbook,
    /Do not open a TCP proxy on this database/,
    "and refuses that proxy in writing, because the fleet's database would be on the public internet to make one verification easier",
  );
  // 🔴 REWORDED 2026-09-25 WHEN THE SERVER MOVED TO RAILWAY, AND THE DANGER IT GUARDS IS UNCHANGED.
  // This used to read `31000 stays open directly`, because the rented box published the tablets'
  // push channel on its own port. Railway publishes no second port, so that sentence is gone — but
  // the mistake it existed to prevent is not: a tablet has no Cloudflare identity and never will,
  // so Access on the TABLETS' hostname answers every sync with a sign-in page and takes the whole
  // fleet dark while the server itself looks healthy. The runbook must refuse that in writing.
  assert.match(
    runbook,
    /NEVER PUT ACCESS ON `mdm\.satopharma\.com`/,
    "the tablets' own hostname is NOT behind Access — putting it there would take the fleet offline",
  );
  assert.match(
    runbook,
    /31000 is not published/,
    "and the runbook states the real cost of Railway's one-port limit rather than leaving it to be found in an incident",
  );

  // 🔴 THE MOST EXPENSIVE MISTAKE IN THE WHOLE RUNBOOK, AND THE MOST NATURAL ONE TO MAKE: putting
  // one rule on one hostname. The fleet and the console must stay two names, and only the console's
  // goes through Cloudflare. The Railway path makes this EASIER to get wrong, not harder — both
  // names sit on the same service now, so nothing physical separates them any more.
  assert.match(
    runbook,
    /Zero Trust → Access → Applications\*\*, add\s+`mdm-console\.satopharma\.com`/,
    "the Access application is on the CONSOLE hostname",
  );
  // The old cloudflared instruction is gone with the box, and must not come back on the tablets'
  // name if the self-hosted path is ever revived.
  assert.doesNotMatch(
    runbook,
    /tunnel route dns \S+ mdm\.satopharma\.com/,
    "and no tunnel is ever routed to mdm.satopharma.com, which is the tablets' own name",
  );
  // 🔴 REWRITTEN 2026-09-26, AND THE REASON MATTERS MORE THAN THE VALUE. This used to require
  // `HEADWIND_MDM_BASE_URL=https://mdm-console.satopharma.com` on the belief that pointing Phoenix at
  // the tablets' hostname "put the API back on the public internet". It never did: ONE Tomcat serves
  // `/rest/*` on EVERY hostname aimed at the service (the assertion below says so in the runbook's own
  // words), and `mdm.satopharma.com` must stay Access-free forever or the fleet goes dark — so the
  // private REST surface is on a public name whatever this variable says. What the choice really
  // decides is coupling, and the console name is the coupled one: the moment Access goes on it,
  // Phoenix breaks unless two service-token values are set and kept right. So the setting is the
  // tablets' hostname, and this pin exists to stop a future session "tidying" it back to the console
  // name and arming that failure for whenever Access is finally switched on.
  assert.match(
    runbook,
    /HEADWIND_MDM_BASE_URL=https:\/\/mdm\.satopharma\.com/,
    "Phoenix is pointed at the tablets' hostname, which can never have Access on it — so turning Access on for the console cannot take Phoenix down with it",
  );
  assert.match(
    runbook,
    /the choice of base\s+URL changes nothing at all about what is exposed/,
    "and the runbook states WHY that is safe, so the correction cannot be undone by someone re-deriving the old reasoning",
  );

  // 🔴 THE TABLE ABOVE SPLITS THE HOSTNAMES BY AUDIENCE, AND READS LIKE IT SPLITS THEM BY SURFACE.
  // It does not. Headwind is ONE web application on ONE port: `/` is the console and `/rest/*` is
  // the tablets' API, on EVERY hostname pointed at the service. So while `mdm.satopharma.com` is
  // grey — which it must be, forever — the console is reachable there with no Access in front of
  // it, and Access on the console's own name is a cost-of-discovery measure, not a seal. A future
  // session that trims this sentence will conclude the console is protected when it is not.
  assert.match(
    runbook,
    /ACCESS ON `mdm-console` DOES NOT SEAL THE CONSOLE/,
    "the runbook says in writing that one Tomcat serves the console on BOTH hostnames, so Access on the console name alone does not protect it",
  );
  // 🔴 AND THAT IS WHY THE ADMIN PASSWORD, NOT ACCESS, IS THE BOUNDARY — §4.2 already says the
  // server seeds `admin`/`admin`, but nothing joined the two facts until a name was about to be
  // published with the seed still in place.
  assert.match(
    runbook,
    /Certificate Transparency/,
    "and it names the mechanism that turns a freshly-issued certificate into an advertisement: CT logs are scanned automatically, so a guessable name must not go live while the password is still the seed",
  );
  // 🔴 NOT A SESSION'S TO SWITCH ON. Zero Trust onboarding opens on a PLAN — Free is $0/seat, and
  // $0 is still a subscription on the owner's account. A session that assumes Access can simply be
  // configured will report the console as guarded when Access does not exist on the account at all.
  assert.match(
    runbook,
    /ACCESS CANNOT BE SWITCHED ON BY A SESSION — IT STARTS WITH A PLAN/,
    "the runbook says Zero Trust onboarding begins with a plan selection, which is the owner's and no session's",
  );
  // 🔴 THE ORANGE CLOUD IS NOT A TIDY-UP. Railway proves ownership by reading the CNAME's own value
  // out of DNS, and through Cloudflare's proxy it reads "". Once the record is orange, Cloudflare
  // serves its OWN edge certificate, so the browser padlock stays green while the origin certificate
  // expires underneath it — and Full (strict) then turns that into a 526 sixty days after anybody
  // touched anything. A session that flips the cloud orange "now that the certificate exists" has
  // armed exactly that, so the runbook has to say the flip belongs to the Access step.
  assert.match(
    runbook,
    /THE ORANGE CLOUD DOES NOT BECOME SAFE ONCE THE CERTIFICATE EXISTS — IT PUTS THE RENEWAL AT RISK/,
    "the runbook warns that proxying the console hostname risks Railway's certificate RENEWAL, silently, and belongs to the Access step rather than to a tidy-up once the first certificate has issued",
  );
  // 🔴 THE WORD "WITNESSED" IS DOING A LOT OF WORK. The agent's three confirmation paths are
  // /rest/plugins/…/public/ and carry no credential — they cannot, because authenticating them would
  // mean shipping a modified agent, which is the one thing this design avoids. Anyone who knows a
  // device number can therefore confirm a pending action; nobody who lacks the JWT can create one.
  // The custody consequence is the whole risk: a tablet written off as wiped on a confirmation row
  // alone. The runbook has to say corroboration, not proof, or the console implies the stronger claim.
  assert.match(
    runbook,
    /"WITNESSED" MEANS SOMETHING THAT KNEW THE DEVICE NUMBER SAID SO — READ IT AS CORROBORATION/,
    "the runbook states that the agent's confirmation endpoints are unauthenticated by necessity, so a confirmation is corroboration rather than proof and a tablet is never written off as clean on that row alone",
  );
  // Phoenix and Headwind are the same Railway project and environment, so Phoenix's own server-side
  // calls COULD stay on the private network and never leave Railway at all. That is worth recording —
  // without it, the obvious reading of §4.7 is that Phoenix must be let through Access and the console
  // then has to be loosened for it, which is a real and unnecessary weakening.
  // 🔴 BUT IT IS AN UPGRADE, NOT THE SETTING, and the runbook must keep saying so: Railway's private
  // network is IPv6-only, nothing has yet watched this container resolve an AAAA-only name, and the
  // one command that would prove it needs an SSH key the account does not have. A base URL that does
  // not resolve fails EVERY tablet action, so the gain (no public transit) does not justify setting it
  // on a hunch — which is exactly what "preferred" invited a future session to do.
  assert.match(
    runbook,
    /phoenix-headwind\.railway\.internal/,
    "the runbook records Railway's private hostname as a possible HEADWIND_MDM_BASE_URL, so nobody concludes Access must be loosened to let Phoenix through",
  );
  assert.match(
    runbook,
    /It is NOT the current setting, and it should not be\s+set on a hunch/,
    "and it marks that address as unproven rather than preferred, because an unresolvable base URL fails every tablet action",
  );
  // 🔴 THE WATCH PATTERN IS A FOLDER, NOT A FILE TYPE, AND IT CAUGHT OUT THE SESSION THAT WROTE THE
  // PARAGRAPH ABOVE IT ON THE SAME DAY. `infra/headwind-phoenix-actions/**` matches the add-on's
  // README and its schema.sql as well as its Java, so a docs-only edit inside that folder rebuilds the
  // image and replaces the container the tablets sync against: #4451 changed nothing but that README
  // and still deployed `SUCCESS`, not `SKIPPED`. The paragraph before it — "a merge to main does NOT
  // redeploy this service" — is true of the repository at large and reads as though it covers the
  // folder too, which is precisely how the wrong claim got made. Without this beside it, the next
  // person to fix a typo in that README restarts the fleet's server without knowing they did.
  assert.match(
    runbook,
    /EDITING THE README IN THERE RESTARTS THE\s+FLEET'S SERVER/,
    "the runbook warns that the service's watch pattern matches the add-on's README as well as its Java, so a docs-only edit in that folder rebuilds and restarts the server the tablets talk to",
  );
}

/**
 * The one-command setup script — pinned on the four things that make it safe to run at 05:00.
 *
 * It exists because doing this by hand cost the owner an hour: the console's mandatory Role field
 * refuses a save silently, so `HEADWIND_MDM_LOGIN` pointed at an account that was never created and the
 * server answered "user not found", which reads exactly like a wrong password. A script cannot forget
 * the Role field, cannot mistype the login, and can prove the account signs in before writing anything.
 *
 * These are source pins because nothing else can cover it: the script talks to a live server and to the
 * Railway CLI, so CI can never run it. What CI CAN do is refuse a version of it that would leak a
 * password or reintroduce a trap this workstream already paid for.
 */
function runBootstrapScriptTests() {
  const script = stripComments(source("scripts/headwind-bootstrap.mjs"));
  // The print check runs on the RAW file, not the stripped one: `stripComments` blanks the inside of a
  // template literal, so a leak written the most natural way — say(`${password}`) — survives the strip
  // invisibly and the pin reads green. Measured while breaking this very assertion on 2026-09-26.
  const raw = source("scripts/headwind-bootstrap.mjs");

  // 1 · UPPER-CASE MD5. Read from the console the live server serves, not from documentation. Sending
  // lower-case gets a correct password refused as wrong — errorCode=1, the cruellest failure here.
  assert.match(
    script,
    /digest\("hex"\)\.toUpperCase\(\)/,
    "the script sends the password as UPPER-CASE hex MD5, the form the server's own console sends",
  );

  // 2 · NEITHER PASSWORD IS EVER PRINTED. The generated one goes straight into Railway's secret store
  // and is then forgotten; the admin one is read from a hidden prompt. A script that echoed either would
  // put a credential that factory-resets a hundred tablets into a terminal scrollback and a transcript.
  for (const line of raw.split(String.fromCharCode(10))) {
    if (!line.includes("say(") && !line.includes("console.log(")) continue;
    assert.ok(
      !/\$\{password\}|\$\{adminPassword\}/.test(line),
      `no line that prints may carry a password value — this one does: ${line.trim()}`,
    );
  }
  assert.match(
    script,
    /password\.length/,
    "the success line reports the password's LENGTH, which is the proof that matters and carries nothing",
  );
  assert.match(
    script,
    /setRawMode\(true\)/,
    "the admin password is read with the echo off, so it never reaches the screen or the scrollback",
  );

  // 3 · NOT --stdin. It stores a BOM INSIDE the value, and every sign-in then fails against a password
  // that looks perfectly correct — a byte no screen displays. Measured on this account (AGENTS.md 2.3).
  assert.ok(
    !/--stdin/.test(script),
    "the script must not use `railway variable set --stdin`, which stores a BOM inside the value",
  );

  // 4 · EXACTLY ONE REDEPLOY, AND ONLY AFTER THE ACCOUNT IS PROVEN. The login goes in with
  // --skip-deploys and the password without, so the service restarts once with both values present —
  // never once with half a credential, which reads as "wrong password" for the length of a build.
  assert.match(
    script,
    /HEADWIND_MDM_LOGIN=\$\{LOGIN\}`, "--skip-deploys"/,
    "the login is written with --skip-deploys",
  );
  assert.match(
    script,
    /HEADWIND_MDM_PASSWORD=\$\{password\}`\)/,
    "and the password without it, so one redeploy lands both at once",
  );
  // 6 · THE THREE ENDPOINTS, READ FROM THE CONSOLE'S OWN SERVICE DEFINITION rather than guessed. The
  // first real run died on `/rest/private/roles` (no such path, so no roles, so the script refused) —
  // and that refusal is the only reason the next call cost nothing. One path along from the list is
  // `PUT /rest/private/users/current`, "change MY OWN password": a create aimed there would have
  // re-passworded the administrator running the script and locked him out of his own console.
  assert.match(script, /"\/rest\/private\/users\/roles"/, "roles come from /rest/private/users/roles");
  assert.match(script, /"\/rest\/private\/users\/all"/, "the user list comes from /rest/private/users/all");
  assert.ok(
    !/\/rest\/private\/users\/current/.test(script),
    "and the script never touches /rest/private/users/current, which would change the running administrator's own password",
  );

  const provenAt = script.indexOf("signs in and gets a token");
  const railwayAt = script.indexOf("variable");
  assert.ok(provenAt > 0 && railwayAt > provenAt, "and nothing is written to Railway until the new account has signed in");

  // 5 · THE RUNBOOK HAS TO CARRY THE ONE COMMAND AND THE THREE ERROR CODES. The codes are the only
  // honest diagnosis of a refused sign-in: Phoenix's page sees an HTML 401 either way, so "wrong
  // password" and "no such account" are indistinguishable from the app. An hour went on that once.
  const book = source("docs/devices/headwind-rustdesk.md");
  assert.match(
    book,
    /node scripts\/headwind-bootstrap\.mjs/,
    "the runbook names the one command that creates the account and sets both variables",
  );
  assert.match(
    book,
    /THE PASSWORD GOES ON THE WIRE AS \*\*UPPER-CASE\*\* MD5/,
    "and records that the hash is upper-case, read from the console the live server serves",
  );
  // 🔴 THIS PIN GUARDED A FALSE FACT UNTIL 2026-09-26. It required the runbook to say `errorCode=2`
  // means "no such login". It does not: on the jwt.login path a wrong password and a login that does
  // not exist both answer `2`. Reading it the other way told the owner an account that demonstrably
  // existed — `update.user` had logged it with `id: 2` and role `Admin` — had never been created.
  assert.match(
    book,
    /THE TOKEN COMES BACK AS `id_token`, AT THE TOP LEVEL/,
    "the runbook records the reply shape that made a successful sign-in read as a refusal all night",
  );
  assert.match(
    book,
    /DOES NOT MEAN "NO SUCH LOGIN"/,
    "the runbook refuses the reading that a 2 proves the account is missing, because that cost an hour",
  );

  // 🔴 THE THREE THINGS §5.2 MEASURED, PINNED SO A TIDY-UP CANNOT DROP THEM. Each one is a fact a
  // session would otherwise re-derive from an empty screen: the nested search page, the http base URL
  // the QR hands out, and the device limit that LOOKS like a ceiling and is not one.
  assert.match(
    book,
    /nested\s+under `devices`/,
    "the runbook records the shape the device search actually answers with",
  );
  assert.match(
    book,
    /`301` to https/,
    "and that every http request to the tablets' own hostname is redirected, which is what can silently drop a POST",
  );
  assert.match(
    book,
    /`deviceLimit = 3` does NOT cap the fleet/,
    "and that the customer record's limit is not the fleet's limit — measured, so nobody raises it in a panic at tablet four",
  );

  // 🔴 A PUT THAT REPORTS `OK` AND CHANGES NOTHING is the worst shape a write can have, and this server
  // has one. `baseUrl` — and an application's absolute URL with it — is recomputed on read from the
  // install-time protocol, so both writes answered `HTTP 200 status=OK` and both values came back http.
  // The runbook has to carry that, or the next session reads the OK as done and moves on.
  assert.match(
    book,
    /`baseUrl` is NOT writable/,
    "the runbook records that the base URL cannot be written through the configuration endpoint",
  );
  assert.match(
    book,
    /read the value back, never trust the `OK`/,
    "and says what to do about a write that reports success and changes nothing",
  );
  assert.match(
    book,
    /`newServerUrl = https:\/\/mdm\.satopharma\.com` on configuration 3/,
    "and names what was set instead, so nobody re-attempts the write that cannot work",
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * The remote screen ID — the one number in the whole tablet setup that a person types.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

async function runRemoteScreenIdTests() {
  resetHeadwindTokenCache();

  // RustDesk shows its ID grouped as `123 456 789`. The spaces are its own formatting, so they are
  // stripped rather than refused — a person copying what is on the tablet's screen is not making a typo.
  assert.equal(normalizeRemoteScreenId("123 456 789"), "123456789");
  assert.equal(normalizeRemoteScreenId("  123456789  "), "123456789");

  // Nothing reaches the network until the value could possibly be an ID.
  const untouched = makeFetch({ api: [{ body: { status: "OK" }, status: 200 }] });
  for (const [bad, why] of [
    ["12345", "five characters is not an ID — RustDesk's own are nine or ten"],
    ["+20 100 123 4567", "a phone number pasted by mistake"],
    ["the id is on the tablet", "a sentence"],
    ["123456789; drop", "anything carrying punctuation"],
  ] as const) {
    await assert.rejects(
      () => setHeadwindRemoteScreenId({ deviceNumber: "PHX-TAB-0002", remoteScreenId: bad }, "B-10", untouched.fetch, ENV),
      HeadwindRemoteScreenIdError,
      why,
    );
  }
  await assert.rejects(
    () => setHeadwindRemoteScreenId({ deviceNumber: "  ", remoteScreenId: "123456789" }, "B-10", untouched.fetch, ENV),
    HeadwindRemoteScreenIdError,
    "and an ID with no tablet named",
  );
  assert.equal(untouched.calls.length, 0, "none of those reached the network at all — not even a sign-in");

  // 🔴 RESOLVED AGAINST THE LIVE LIST, THROUGH THE NESTED PAGE. The reply shape is the one the real
  // server sends, so this test fails if the unwrapper is ever narrowed back to the flat shape.
  resetHeadwindTokenCache();
  const gone = makeFetch({
    api: [{ body: { data: { configurations: {}, devices: { items: [{ id: 7, number: "PHX-TAB-0002" }] } }, status: "OK" }, status: 200 }],
  });
  await assert.rejects(
    () => setHeadwindRemoteScreenId({ deviceNumber: "PHX-TAB-0009", remoteScreenId: "123456789" }, "B-10", gone.fetch, ENV),
    HeadwindRemoteScreenIdError,
    "a tablet that is not on the server cannot be given an ID",
  );

  // The value already stored is not written again — no PUT, no audit row, and it says so plainly.
  resetHeadwindTokenCache();
  const same = makeFetch({
    api: [
      {
        body: { data: { devices: { items: [{ custom1: "123456789", id: 7, number: "PHX-TAB-0002" }] } }, status: "OK" },
        status: 200,
      },
    ],
  });
  const unchanged = await setHeadwindRemoteScreenId(
    { deviceNumber: "PHX-TAB-0002", remoteScreenId: "123 456 789" },
    "B-10",
    same.fetch,
    ENV,
  );
  assert.equal(unchanged.remoteScreenId, "123456789");
  assert.match(unchanged.message, /already carries remote screen ID 123456789/);
  assert.equal(
    same.calls.filter((call) => call.init.method === "PUT").length,
    0,
    "the same value is not written again",
  );

  // 🔴 THE ONE THAT MATTERS: A `status: OK` THAT CHANGED NOTHING IS REPORTED AS A FAILURE. This server
  // has a PUT that answers OK and leaves the value alone — `baseUrl`, measured 2026-09-26 — so the
  // write is read back, and a success is claimed only when the server holds what was asked for.
  resetHeadwindTokenCache();
  const lied = makeFetch({
    api: [
      { body: { data: { devices: { items: [{ id: 7, number: "PHX-TAB-0002" }] } }, status: "OK" }, status: 200 },
      { body: { status: "OK" }, status: 200 },
      { body: { data: { devices: { items: [{ id: 7, number: "PHX-TAB-0002" }] } }, status: "OK" }, status: 200 },
    ],
  });
  await assert.rejects(
    () => setHeadwindRemoteScreenId({ deviceNumber: "PHX-TAB-0002", remoteScreenId: "123456789" }, "B-10", lied.fetch, ENV),
    (error: unknown) =>
      error instanceof HeadwindRemoteScreenIdError &&
      /accepted the change and then still reports no remote screen ID/.test(error.message) &&
      /Nothing has been recorded/.test(error.message),
    "an OK that did not take is a failure with the reason, never a green message",
  );
  assert.equal(lied.calls.filter((call) => call.init.method === "PUT").length, 1, "it tried exactly once");

  // 🔴 THE BUG THIS GUARDS: the search hands `info` back as an OBJECT, and the PUT deserializer wants a
  // JSON STRING — `Cannot deserialize instance of java.lang.String out of START_OBJECT … Device["info"]`
  // (measured 2026-09-26, worked round by hand at the time). `deviceWriteBody` stringifies it. Every
  // fixture above omits `info`, which is exactly why the object was re-sent verbatim and nothing caught it.
  // Driven down the read-back-fails path (like `lied` above) so the write never reaches the audit row,
  // which cannot persist without a service-role key here; the PUT body is captured all the same, and that
  // is where the fix lives.
  resetHeadwindTokenCache();
  const infoObject = makeFetch({
    api: [
      {
        body: {
          data: {
            devices: {
              items: [
                { custom1: null, groups: [{ id: 4 }], id: 7, info: { batteryLevel: 88, model: "TB328XU" }, number: "PHX-TAB-0002" },
              ],
            },
          },
          status: "OK",
        },
        status: 200,
      },
      { body: { status: "OK" }, status: 200 },
      { body: { data: { devices: { items: [{ id: 7, number: "PHX-TAB-0002" }] } }, status: "OK" }, status: 200 },
    ],
  });
  await assert.rejects(
    () => setHeadwindRemoteScreenId({ deviceNumber: "PHX-TAB-0002", remoteScreenId: "123456789" }, "B-10", infoObject.fetch, ENV),
    HeadwindRemoteScreenIdError,
    "the read-back does not confirm here, so the write stops before the audit row",
  );
  const put = infoObject.calls.find((call) => call.init.method === "PUT");
  assert.ok(put, "the change is written");
  const putBody = JSON.parse(String(put!.init.body)) as Record<string, unknown>;
  assert.equal(typeof putBody.info, "string", "`info` goes back to Headwind as a JSON string, never as the object the search returned");
  assert.deepEqual(
    JSON.parse(putBody.info as string),
    { batteryLevel: 88, model: "TB328XU" },
    "and it is the same info, only stringified",
  );
  assert.ok(Array.isArray(putBody.groups), "the opaque round-trip still carries the tablet's groups");
  assert.equal(putBody.custom1, "123456789", "with the new ID set");

  // The write itself carries the register-free parts at source: the opaque round-trip, the audit row.
  const writer = stripComments(source("src/lib/devices/headwind/remote-screen-id.ts"));
  assert.match(writer, /deviceWriteBody\(device, \{ custom1: next \}\)/, "an OPAQUE round-trip that stringifies info — a hand-built body drops the tablet's groups or 400s on info");
  assert.match(writer, /entityType: "headwind_device_command"/, "and the change writes a REQUIRED audit row");
  assert.match(writer, /oldValues: \{ remoteScreenId: previous \}/, "naming what it was before, so a wrong ID can be traced");

  // The route is the security boundary, like every other write in this bridge.
  const route = stripComments(source("app/api/devices/headwind/remote-id/route.ts"));
  assert.match(route, /const csrf = assertSameOriginMutation\(request\);\s*if \(csrf\) return csrf;/);
  assert.match(route, /assertPermission\(access, "company_devices", "approve"\)/, "Super Admin only, on the server");
  assert.match(route, /payload\.remoteScreenId === "string"/, "and the ID comes from the body, never from the URL");

  // And it is declared, with its CSRF and audit obligations, where the coverage test can see it.
  const registry = source("src/lib/security/access-registry.ts");
  assert.match(
    registry,
    /pattern: "\/api\/devices\/headwind\/remote-id", permission: \{ resource: "company_devices", action: "approve" \}, csrfRequired: true/,
    "the route is in the access registry with the same gate as the rest of the bridge",
  );

  // 🔴 THE FIELD IS TYPED IN PHOENIX BECAUSE THE CONSOLE CANNOT DRAW IT — and the row above the panel
  // has to catch up, or a saved ID sits beside a row still reading that there is none.
  const panel = stripComments(source("src/components/devices/headwind-tablet-panel.tsx"));
  assert.match(panel, /"\/api\/devices\/headwind\/remote-id"/, "the panel posts to the route");
  assert.match(panel, /onSaved\?\.\(\)/, "and tells the fleet to read itself again once it has saved");
  const fleet = stripComments(source("src/components/devices/headwind-fleet.tsx"));
  assert.match(fleet, /remoteScreenId=\{row\.rustDeskId\}/, "the fleet hands the panel the ID the tablet already has");
  assert.match(fleet, /onRemoteScreenIdSaved=\{props\.onRefresh\}/, "and refreshes the row when the panel saves one");
}

/**
 * 🔴 EVERY ADD-ON ENDPOINT LIVES UNDER `/private/` OR `/public/`, AND UNDER THE FILTER THAT GUARDS IT.
 *
 * Headwind's own convention is that `/rest/plugins/<id>/private/*` needs a login and
 * `/rest/plugins/<id>/public/*` is open on purpose — but the convention is only words: what actually
 * refuses a stranger is the `filter(...)` list in `PhoenixRestModule`, and a JAX-RS path is the CLASS
 * `@Path` joined to the METHOD `@Path`. A new method written as `@Path("/status")`, or a new resource
 * bound without a matching filter entry, compiles, deploys and serves with no login at all, and nothing
 * in Phoenix would notice. Read the two halves together, as Jersey does, and refuse any endpoint that
 * no registered filter covers. (Pinned 2026-10-22, after an audit of the same rule needed a look-ahead
 * regex the search tool could not run and was done by hand.)
 */
function runPluginPathTests() {
  const root = "infra/headwind-phoenix-actions/src/main/java/com/hmdm/plugins/phoenix";
  const restModule = stripComments(source(`${root}/guice/module/PhoenixRestModule.java`));
  const pluginConfig = stripComments(source(`${root}/PhoenixPluginConfigurationImpl.java`));

  const listed = (name: string) => {
    const block = restModule.match(new RegExp(`${name}\\s*=\\s*Arrays\\.asList\\(([^)]*)\\)`));
    assert.ok(block, `PhoenixRestModule declares ${name}`);
    return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  };
  const protectedPatterns = listed("PROTECTED_RESOURCES");
  const publicPatterns = listed("PUBLIC_RESOURCES");

  for (const filter of ["JWTFilter", "AuthFilter", "PrivateIPFilter"]) {
    assert.match(
      restModule,
      new RegExp(`filter\\(PROTECTED_RESOURCES\\)\\.through\\(${filter}\\.class\\)`),
      `the protected paths go through ${filter} — drop it and a private endpoint answers without a login`,
    );
  }
  assert.match(restModule, /filter\(PUBLIC_RESOURCES\)\.through\(PublicIPFilter\.class\)/, "the public paths keep Headwind's PublicIPFilter");

  // The module's own comment says the plugin id is repeated as a literal and pinned here: it is.
  const pluginId = pluginConfig.match(/PLUGIN_ID\s*=\s*"([^"]+)"/)?.[1];
  assert.equal(pluginId, "phoenix-actions", "the plugin id the console addresses");
  assert.deepEqual(
    protectedPatterns,
    [`/rest/plugins/${pluginId}/private/*`],
    "the protected filter covers exactly the plugin id's private tree — a drift leaves the real endpoints unfiltered",
  );
  for (const pattern of [...protectedPatterns, ...publicPatterns]) {
    assert.ok(pattern.endsWith("/*"), `${pattern} is a prefix pattern`);
  }
  const prefixOf = (pattern: string) => pattern.slice(0, -1);

  const bound = new Set([...restModule.matchAll(/\bbind\((\w+)\.class\)/g)].map((m) => m[1]));
  const endpoints: string[] = [];
  for (const file of readdirSync(new URL(`../${root}/rest/`, import.meta.url))) {
    if (!file.endsWith(".java")) continue;
    const java = stripComments(source(`${root}/rest/${file}`));
    const declaration = java.match(/@Path\("([^"]*)"\)\s*public\s+class\s+(\w+)/);
    if (!declaration) {
      assert.doesNotMatch(java, /@Path\("/, `${file} carries @Path on methods but none on its class — read it by hand`);
      continue;
    }
    const [, classPath, className] = declaration;
    assert.ok(bound.has(className), `${className} serves @Path routes, so PhoenixRestModule must bind it`);

    const body = java.slice(java.indexOf(declaration[0]) + declaration[0].length);
    const methodPaths = [...body.matchAll(/@Path\("([^"]*)"\)/g)].map((m) => m[1]);
    const verbs = body.match(/@(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/g) ?? [];
    assert.equal(
      methodPaths.length,
      verbs.length,
      `every endpoint in ${className} carries its own @Path — a verb on the bare class path ${classPath} sits outside both /private/ and /public/`,
    );
    for (const methodPath of methodPaths) endpoints.push(`/rest${classPath}${methodPath}`);
  }

  assert.ok(endpoints.length >= 5, `the scan found the add-on's endpoints (found ${endpoints.length}) — a parser that finds none proves nothing`);
  assert.ok(endpoints.includes("/rest/plugins/phoenix-actions/private/status"), "the status endpoint Phoenix asks first is among them");
  for (const endpoint of endpoints) {
    const isPrivate = protectedPatterns.some((p) => endpoint.startsWith(prefixOf(p)));
    const isPublic = publicPatterns.some((p) => endpoint.startsWith(prefixOf(p)));
    assert.ok(
      isPrivate || isPublic,
      `${endpoint} is under no filter registered in PhoenixRestModule, so it would answer anyone with no login`,
    );
    if (isPrivate) assert.match(endpoint, /\/private\//, `${endpoint} is filtered as private and named /private/`);
    if (isPublic) assert.match(endpoint, /\/public\//, `${endpoint} is filtered as public and named /public/`);
  }
}

/**
 * The Tablet Dashboard's own arithmetic, and the files a tablet's rules push.
 *
 * These are pure functions on purpose — the overview counts, the two map-point mappers and the file
 * projection carry the dashboard's whole logic with no React and no network, so they are pinned here
 * where breaking one shows at once. The page and its components import them; they never re-derive them.
 */
function runDashboardTests() {
  // A fixed "now" so the online window is arithmetic, not a clock race.
  const now = Date.parse("2026-10-22T12:00:00.000Z");
  const recent = new Date(now - 60 * 60 * 1000).toISOString(); // an hour ago → online
  const stale = new Date(now - DASHBOARD_ONLINE_WINDOW_MS - 1000).toISOString(); // just past a day → not online

  const rows: RepHeadwindRow[] = [
    repRow({ batteryCharging: false, batteryLevel: 12, deviceNumber: "A", lastContactAt: recent, latitude: 30.04, longitude: 31.23, rustDeskId: "111" }),
    repRow({ batteryCharging: true, batteryLevel: 8, deviceNumber: "B", lastContactAt: recent, rustDeskId: "222" }),
    repRow({ batteryLevel: 95, deviceNumber: "C", lastContactAt: stale, latitude: 29.9, longitude: 31.1, unregistered: true }),
    repRow({ batteryLevel: null, deviceNumber: "D" }),
  ];

  const summary = summarizeFleet(rows, now);
  assert.equal(summary.total, 4, "every managed tablet is counted");
  assert.equal(summary.online, 2, "online is a check-in inside the last day — the stale one and the never-seen one are out");
  assert.equal(summary.reportingLocation, 2, "only the two carrying coordinates report a position");
  assert.equal(summary.screenReady, 2, "screen-ready is a RustDesk id present");
  // 🔴 LOW BATTERY IS 'AT OR BELOW 20 AND OFF THE CHARGER'. B is at 8 but charging, so it is NOT low —
  // a tablet on the charger is not about to die in the field. BREAK-TEST: drop the `!== true` charging
  // guard in dashboard.ts and this reads 2.
  assert.equal(summary.lowBattery, 1, "only A is low: 12% and off the charger; B at 8% is charging; D reported no level");
  assert.equal(summary.notInRegister, 1, "one tablet the register does not yet know");
  assert.equal(DASHBOARD_LOW_BATTERY, 20, "the low-battery line is 20%");
  assert.equal(summary.fullySetUp, 0, "none of the four baseline rows (no SIM recorded) is fully set up");

  // ── Setup readiness ────────────────────────────────────────────────────────────────────────────
  // 🔴 LAUNCHER RANK ORDERS BY NUMERIC SEGMENTS, NOT STRING. These are `6.<build>` versions, so 6.39 is
  // NEWER than 6.9 (build 39 > build 9) — yet "6.39" < "6.9" as strings. BREAK-TEST: compare the version
  // strings directly in `launcherRank` and the second line below reads backwards.
  assert.ok((launcherRank("6.48") ?? 0) > (launcherRank("6.39") ?? 0), "6.48 ranks above 6.39");
  assert.ok((launcherRank("6.39") ?? 0) > (launcherRank("6.9") ?? 0), "6.39 ranks above 6.9 — a string compare gets this backwards");
  assert.equal(launcherRank(null), null, "no version reported → no rank");
  assert.equal(launcherRank("—"), null, "a version with no digits has no rank, rather than ranking as zero");

  const launcherFleet = [
    repRow({ deviceNumber: "R1", launcherVersion: "6.39" }),
    repRow({ deviceNumber: "R2", launcherVersion: "6.48" }),
    repRow({ deviceNumber: "R3", launcherVersion: null }),
  ];
  assert.equal(fleetLauncherTarget(launcherFleet), launcherRank("6.48"), "the fleet target is the newest launcher any tablet runs");
  assert.equal(fleetLauncherTarget([repRow({ deviceNumber: "none" })]), null, "no tablet reports a version → no target, so nothing is behind");

  const target = fleetLauncherTarget(launcherFleet);
  const fully = repRow({
    deviceNumber: "FULL",
    latitude: 30.0,
    launcherVersion: "6.48",
    longitude: 31.2,
    rustDeskId: "scr-1",
    simNumber: "8801700000001",
  });
  const ready = tabletSetupReadiness(fully, { launcherTarget: target });
  assert.ok(
    ready.inCustody && ready.simRecorded && ready.screenIdReported && ready.locationReported && ready.launcherCurrent,
    "every provisioning signal is green on a fully set-up tablet",
  );
  // 🔴 `ready` IS THE CONJUNCTION OF THE FIVE. BREAK-TEST: drop any one term from `ready` in dashboard.ts
  // and one of the five-missing assertions below stops flipping it.
  assert.equal(ready.ready, true, "and `ready` is their conjunction");

  assert.equal(tabletSetupReadiness({ ...fully, unregistered: true }, { launcherTarget: target }).inCustody, false, "not in the register → not in custody");
  assert.equal(tabletSetupReadiness({ ...fully, unregistered: true }, { launcherTarget: target }).ready, false, "a tablet not in custody is not ready");
  assert.equal(tabletSetupReadiness({ ...fully, lineNumber: null, simNumber: null }, { launcherTarget: target }).simRecorded, false, "no SIM and no line → SIM not recorded");
  assert.equal(tabletSetupReadiness({ ...fully, lineNumber: null, simNumber: null }, { launcherTarget: target }).ready, false, "a tablet with no SIM recorded is not ready");
  assert.equal(tabletSetupReadiness({ ...fully, rustDeskId: null }, { launcherTarget: target }).screenIdReported, false, "no RustDesk id → screen not set up");
  assert.equal(tabletSetupReadiness({ ...fully, rustDeskId: null }, { launcherTarget: target }).ready, false, "a tablet with no screen id is not ready");
  assert.equal(tabletSetupReadiness({ ...fully, latitude: null, longitude: null }, { launcherTarget: target }).locationReported, false, "never located → no location");
  assert.equal(tabletSetupReadiness({ ...fully, latitude: null, longitude: null }, { launcherTarget: target }).ready, false, "a tablet that has never located is not ready");
  assert.equal(tabletSetupReadiness({ ...fully, launcherVersion: "6.39" }, { launcherTarget: target }).launcherCurrent, false, "behind the fleet's newest launcher → not current");
  assert.equal(tabletSetupReadiness({ ...fully, launcherVersion: "6.39" }, { launcherTarget: target }).ready, false, "a tablet behind on its launcher is not ready");

  // A line number alone carries the SIM signal — either field means the tablet has a data line.
  assert.equal(tabletSetupReadiness({ ...fully, lineNumber: "01001234567", simNumber: null }, { launcherTarget: target }).simRecorded, true, "a recorded line number alone counts as a SIM");
  // 🔴 ONLINE AND BATTERY ARE HEALTH, NOT PROVISIONING. A finished tablet briefly off or flat is still set up.
  assert.equal(tabletSetupReadiness({ ...fully, batteryLevel: 4, lastContactAt: null }, { launcherTarget: target }).ready, true, "being offline and flat does not undo provisioning");
  // No fleet target → the launcher never blocks readiness, so a brand-new fleet is not all flagged behind.
  assert.equal(tabletSetupReadiness({ ...fully, launcherVersion: "1.0" }, { launcherTarget: null }).launcherCurrent, true, "with no fleet target, no tablet reads as behind");

  const setupFleet = [fully, { ...fully, deviceNumber: "HALF", lineNumber: null, simNumber: null }, repRow({ deviceNumber: "BARE" })];
  assert.equal(summarizeFleet(setupFleet, now).fullySetUp, 1, "summarizeFleet counts only the fully provisioned tablet");

  // The fleet map: one point per tablet that has a position, labelled with its tag/holder.
  const held = repRow({ assetTag: "PHX-TAB-0007", deviceNumber: "E", holderName: "Gannatullah Amer", latitude: 30.1, longitude: 31.2 });
  const unregisteredRow = repRow({ assetTag: null, deviceNumber: "F", latitude: 30.2, longitude: 31.3, unregistered: true });
  const points = fleetRowsToPoints([held, unregisteredRow, repRow({ deviceNumber: "G" })]);
  assert.equal(points.length, 2, "a tablet with no coordinates is left off the map, never plotted at (0,0)");
  assert.equal(points[0].label, "PHX-TAB-0007", "a placed tablet is labelled with its asset tag");
  assert.equal(points[0].sublabel, "Gannatullah Amer", "and the holder rides in the tooltip — a name, never an id");
  assert.equal(points[0].order, null, "a fleet marker has no trail number");
  assert.equal(points[1].sublabel, "Not in the custody register", "a tablet nobody holds says which it is rather than reading blank");

  // The trail: fixes numbered oldest-first, joined in time order, unplaceable ones dropped.
  const t0 = "2026-10-20T08:00:00.000Z";
  const t1 = "2026-10-20T09:00:00.000Z";
  const t2 = "2026-10-20T10:00:00.000Z";
  const fixes: DashboardLocationFix[] = [
    { batteryLevel: 70, latitude: 30.2, longitude: 31.3, recordedAt: t2, source: "check-in" },
    { batteryLevel: 80, latitude: 30.0, longitude: 31.1, recordedAt: t0, source: "plugin" },
    { batteryLevel: 75, latitude: 30.1, longitude: 31.2, recordedAt: t1, source: "check-in" },
    { batteryLevel: null, latitude: Number.NaN, longitude: 31.0, recordedAt: null, source: "plugin" },
  ];
  const trail = fixesToPoints(fixes);
  assert.equal(trail.length, 3, "the fix with no usable coordinates is dropped");
  // 🔴 OLDEST FIRST. The read hands fixes back newest-first; a trail reads in time order. BREAK-TEST:
  // remove the sort in dashboard.ts and the order below is [t2, t0, t1].
  assert.deepEqual(trail.map((point) => point.sublabel), [t0, t1, t2], "sorted oldest-first by recorded time");
  assert.deepEqual(trail.map((point) => point.order), [1, 2, 3], "numbered from one in that order");
  assert.deepEqual(trail.map((point) => point.label), ["1", "2", "3"], "and the marker label is the stop number");
  assert.equal(trail[0].latitude, 30.0, "stop one is the earliest fix's position");

  // The file projection: the four browser-safe fields, read defensively, nothing secret.
  const files = configurationFiles({
    files: [
      { description: "The field manual", fileId: 5, path: "manual.pdf", url: "https://mdm.test.local/files/manual.pdf" },
      { description: null, id: 9, path: null }, // name falls back to its id
      { externalUrl: true, id: 12, path: "logo.png" }, // a boolean externalUrl is not a URL
      { description: "" }, // nothing to label and nothing to act on → dropped
      "not an object",
      null,
    ],
    id: 3,
    name: "Rep tablets",
    password: "plain-text-secret",
  } as never);
  assert.equal(files.length, 3, "the two unusable entries are dropped; the three real ones are kept");
  assert.deepEqual(files[0], {
    description: "The field manual",
    fileId: 5,
    name: "manual.pdf",
    url: "https://mdm.test.local/files/manual.pdf",
  });
  assert.equal(files[1].name, "File 9", "a file with no path reads as its id, never blank");
  assert.equal(files[1].fileId, 9, "the id is read from either `fileId` or `id`");
  assert.equal(files[2].url, null, "🔴 a boolean externalUrl flag is never shown as a link — only a string URL is");
  assert.equal(files[2].name, "logo.png");
  // 🔴 NOTHING SECRET LEAVES THE PROJECTION. The configuration carries the tablet's plaintext admin
  // password; the file list must never carry it or any other field of the object.
  const serialised = JSON.stringify(files);
  assert.ok(!serialised.includes("plain-text-secret"), "the configuration's plaintext password never reaches the file list");
  assert.deepEqual(configurationFiles({ id: 1, name: "x" } as never), [], "a configuration with no files is an empty list, never a throw");

  // The route and the components are wired to these — pinned at the source so a rename shows here.
  const route = stripComments(source("app/api/devices/headwind/route.ts"));
  assert.match(route, /case "files":/, "the fleet route answers a files view");
  assert.match(route, /getHeadwindConfigurationFiles\(/, "through the browser-safe reader, never the whole configuration");
  assert.match(route, /assertPermission\(access, "company_devices", "approve"\)/, "Super Admin only, like every other view");

  const panel = stripComments(source("src/components/devices/headwind-tablet-panel.tsx"));
  assert.match(panel, /view=files/, "the tablet panel has a files panel that reads the files view");
  assert.match(panel, /change: "file"[\s\S]*?remove: true/, "and its Remove takes the file off the rules");
  assert.match(panel, /every tablet on these rules/, "🔴 the armed Remove says the file leaves every tablet on the rules, not only this one");
  assert.match(panel, /view=screen&mode=control/, "the live browse opens a RustDesk control session");
  assert.match(panel, /File Transfer tab/, "and tells the person to use RustDesk's File Transfer tab — there is no file-transfer deep link");
  assert.match(panel, /kind="trail"/, "the movements panel draws the trail map");
  assert.match(panel, /fixesToPoints\(/, "from the pure mapper pinned above");

  // 🔴 THE DASHBOARD PAGE IS SUPER-ADMIN ONLY AND SAYS CALLS AND MESSAGES ARE NEVER SHOWN.
  const page = stripComments(source("app/(admin)/devices/tablets/dashboard/page.tsx"));
  assert.match(page, /canAccess\(access, "company_devices", "approve"\)/, "the page gate is the approve permission");
  assert.match(page, /redirect\("\/hr\/devices"\)/, "and anyone turned away is sent to the register they can use");
  assert.match(page, /isHeadwindConfigured\(\)/, "it ships dark until the server exists");
  assert.match(page, /[Cc]alls and messages are never shown/, "and the page says plainly that calls and messages are never shown");

  const nav = stripComments(source("src/config/system-navigation.ts"));
  assert.match(nav, /href: "\/devices\/tablets\/dashboard"/, "the dashboard has a sidebar row");
  assert.match(
    nav,
    /href: "\/devices\/tablets\/dashboard",[\s\S]*?action: "approve"/,
    "gated on the approve permission, so it never reaches a seat the page turns away",
  );

  const overview = stripComments(source("src/components/devices/tablet-fleet-overview.tsx"));
  assert.match(overview, /summarizeFleet\(/, "the overview strip counts through the pure summary, not its own query");
  assert.match(overview, /Fully set up/, "the overview shows a Fully set up tile");
  assert.match(overview, /summary\.fullySetUp/, "sourced from the pure summary's count, never a re-count in the component");

  const fleetComponent = stripComments(source("src/components/devices/headwind-fleet.tsx"));
  assert.match(fleetComponent, /tabletSetupReadiness\(/, "the fleet rows derive their setup chips from the pure readiness helper");
  assert.match(fleetComponent, /fleetLauncherTarget\(/, "and measure launcher currency against the fleet's newest, computed once for all rows");
  const map = stripComments(source("src/components/devices/tablet-fleet-map.tsx"));
  assert.match(map, /NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY/, "the map reuses the shared browser key");
  assert.match(map, /border border-slate-200/, "and wears the devices look — a slate border, square, not the field map's rounded card");
}

/**
 * On-demand screen recording: the pure upload door, and the fingerprints that keep the capture off the
 * frozen Expo app and the device's upload session-less.
 */
function runRecordingTests() {
  // The length is parsed, clamped and defaulted.
  assert.equal(clampRecordingDuration(60), 60, "a plain length is kept");
  assert.equal(clampRecordingDuration(2), RECORDING_MIN_SECONDS, "below the floor clamps up");
  assert.equal(clampRecordingDuration(99999), RECORDING_MAX_SECONDS, "above the cap clamps down");
  assert.equal(clampRecordingDuration("45"), 45, "a numeric string is read");
  assert.equal(clampRecordingDuration("nonsense"), RECORDING_DEFAULT_SECONDS, "junk falls back to the default");
  assert.equal(clampRecordingDuration(undefined), RECORDING_DEFAULT_SECONDS, "a missing length falls back to the default");

  // recordingUploadDecision — the whole upload door, proven without a database.
  const token = "a".repeat(64);
  const hash = hashRecordingToken(token);
  const now = 1_700_000_000_000;
  const freshRow = { requestedAtMs: now, status: "requested", uploadTokenHash: hash };

  assert.deepEqual(
    recordingUploadDecision({ contentType: "video/mp4", nowMs: now + 1000, presentedToken: token, row: freshRow, sizeBytes: 1024 }),
    { ok: true },
    "a fresh slot, the right token, a small mp4 is accepted",
  );
  assert.equal(
    recordingUploadDecision({ contentType: "video/webm; codecs=vp9", nowMs: now, presentedToken: token, row: freshRow, sizeBytes: 1024 }).ok,
    true,
    "webm with a codecs parameter is accepted",
  );

  const noRow = recordingUploadDecision({ contentType: "video/mp4", nowMs: now, presentedToken: token, row: null, sizeBytes: 10 });
  assert.equal(noRow.ok, false, "no such recording is refused");
  assert.equal(noRow.ok ? 0 : noRow.status, 404, "and answers 404");

  // 🔴 THE HEADLINE: a token that does not match is refused 403. Break it — compare the WRONG hash, or
  // drop the timingSafeEqual — and this assertion is what fires.
  const badToken = recordingUploadDecision({ contentType: "video/mp4", nowMs: now, presentedToken: "b".repeat(64), row: freshRow, sizeBytes: 10 });
  assert.equal(badToken.ok, false, "a token that does not match the slot is refused");
  assert.equal(badToken.ok ? 0 : badToken.status, 403, "and the refusal is 403");

  assert.equal(
    recordingUploadDecision({ contentType: "video/mp4", nowMs: now, presentedToken: token, row: { requestedAtMs: now, status: "ready", uploadTokenHash: hash }, sizeBytes: 10 }).ok,
    false,
    "a slot already handled is refused",
  );
  assert.equal(
    recordingUploadDecision({ contentType: "video/mp4", nowMs: now, presentedToken: token, row: { requestedAtMs: now, status: "requested", uploadTokenHash: null }, sizeBytes: 10 }).ok,
    false,
    "a closed slot (its hash cleared) is refused",
  );

  const expired = recordingUploadDecision({ contentType: "video/mp4", nowMs: now + RECORDING_TOKEN_TTL_SECONDS * 1000 + 1, presentedToken: token, row: freshRow, sizeBytes: 10 });
  assert.equal(expired.ok, false, "past the window is refused");
  assert.equal(expired.ok ? 0 : expired.status, 410, "and answers 410");

  assert.equal(recordingUploadDecision({ contentType: "video/mp4", nowMs: now, presentedToken: token, row: freshRow, sizeBytes: 0 }).ok, false, "an empty upload is refused");
  assert.equal(recordingUploadDecision({ contentType: "video/mp4", nowMs: now, presentedToken: token, row: freshRow, sizeBytes: RECORDING_MAX_BYTES + 1 }).ok, false, "over the byte cap is refused");
  assert.equal(recordingUploadDecision({ contentType: "image/png", nowMs: now, presentedToken: token, row: freshRow, sizeBytes: 10 }).ok, false, "a non-video type is refused");

  // recordingSlotOpenDecision — what the door refuses on the row alone, before it reads a body.
  const slotStatus = (row: Parameters<typeof recordingSlotOpenDecision>[0], nowMs = now) => {
    const decision = recordingSlotOpenDecision(row, nowMs);
    return decision.ok ? 200 : decision.status;
  };
  assert.equal(slotStatus(freshRow), 200, "a fresh slot is open");
  assert.equal(slotStatus(null), 404, "a slot that does not exist is refused 404");
  assert.equal(slotStatus({ ...freshRow, status: "ready" }), 409, "a slot already handled is refused 409");
  assert.equal(slotStatus({ ...freshRow, uploadTokenHash: null }), 410, "a slot whose token is spent is refused 410");
  assert.equal(slotStatus(freshRow, now + RECORDING_TOKEN_TTL_SECONDS * 1000 + 1), 410, "a slot past its window is refused 410");

  // The address the tablet is told to upload to names its slot, so the door can check it first.
  const slotUrl = new URL(recordingUploadUrl("https://phoenix-hr.satopharma.com/", "11111111-2222-4333-8444-555555555555"));
  assert.equal(slotUrl.origin + slotUrl.pathname, "https://phoenix-hr.satopharma.com/api/devices/recordings/upload", "the upload address is the door, one slash");
  assert.equal(slotUrl.searchParams.get(RECORDING_UPLOAD_ID_PARAM), "11111111-2222-4333-8444-555555555555", "and it carries the recording's id");

  // SOURCE FINGERPRINTS — the capture is driven to the RustDesk fork, never the frozen Expo app.
  const recordings = stripComments(source("src/lib/devices/headwind/recordings.ts"));
  assert.match(
    recordings,
    /const uploadUrl = recordingUploadUrl\(input\.uploadBaseUrl, id\)/,
    "the record push hands the tablet the address that names its slot",
  );
  assert.match(recordings, /messageType: "intent"/, "the record push uses the agent's intent door");
  assert.match(recordings, /pkg: rustDeskPackageName\(env\)/, "aimed at the RustDesk-fork launcher's package");
  assert.doesNotMatch(
    recordings,
    /com\.satopharma\.phoenixworkforce/,
    "never the frozen Expo app package — recording it there would mean editing mobile/, which is frozen",
  );
  assert.match(recordings, /upload_token_hash: hashRecordingToken\(token\)/, "only the token's hash is stored, never the token");

  // The device upload door is session-less and token-authenticated; the trigger route is Super Admin.
  const uploadRoute = stripComments(source("app/api/devices/recordings/upload/route.ts"));
  assert.doesNotMatch(
    uploadRoute,
    /resolveAccessContext|assertPermission|assertSameOriginMutation/,
    "the device upload door has no session and no CSRF gate — the per-recording token is the whole auth",
  );
  assert.match(uploadRoute, /ingestRecording\(/, "it hands the bytes to ingestRecording, which matches the token");

  const recordRoute = stripComments(source("app/api/devices/headwind/record/route.ts"));
  assert.match(recordRoute, /assertSameOriginMutation\(request\)/, "the trigger route is same-origin");
  assert.match(recordRoute, /assertPermission\(access, "company_devices", "approve"\)/, "and Super Admin only");

  // Registered in the access registry: the trigger as a session route, the upload as machine-token.
  const registry = source("src/lib/security/access-registry.ts");
  assert.match(
    registry,
    /pattern: "\/api\/devices\/headwind\/record", permission: \{ resource: "company_devices", action: "approve" \}, csrfRequired: true/,
    "the record route is registered Super Admin + csrf",
  );
  assert.match(
    registry,
    /authMode: "machine-token", methods: \["POST"\], pattern: "\/api\/devices\/recordings\/upload"/,
    "the upload route is registered as a machine-token door",
  );

  // The dashboard route serves the recordings view and the panel plays them back.
  const route = stripComments(source("app/api/devices/headwind/route.ts"));
  assert.match(route, /case "recordings":/, "the dashboard route serves view=recordings");
  const panel = stripComments(source("src/components/devices/headwind-tablet-panel.tsx"));
  assert.match(panel, /<RecordingsPanel deviceNumber=\{deviceNumber\} \/>/, "the panel is mounted on the tablet drill-down");
  assert.match(panel, /view=recordings/, "and reads the recordings view");
}

/**
 * The recording upload door (audit, 2026-10-26, point 24). It used to buffer a whole multipart body of
 * up to 256 MB before it looked at anything, with no rate limit; then it read the slot, stored the file
 * with an overwrite and marked the row by id alone, so two uploads on one token both passed and the
 * second replaced the first. No database is reached: the Supabase settings are either removed (the
 * client cannot be built) or pointed at a stand-in PostgREST on 127.0.0.1.
 */
async function runRecordingUploadDoorTests() {
  // ── the length gate, pure ──
  const lengthStatus = (value: string | null) => {
    const decision = recordingUploadLengthDecision(value);
    return decision.ok ? 200 : decision.status;
  };
  assert.equal(lengthStatus(null), 411, "no Content-Length (a chunked body) is refused 411 — its size is unknown until it is read");
  assert.equal(lengthStatus("  "), 411, "a blank Content-Length is the same as none");
  assert.equal(lengthStatus("12abc"), 400, "a Content-Length that is not digits is refused");
  assert.equal(lengthStatus("1e9"), 400, "an exponent is not a Content-Length");
  assert.equal(lengthStatus("-5"), 400, "a negative Content-Length is refused");
  assert.equal(lengthStatus("0"), 400, "an empty body is refused");
  assert.equal(lengthStatus("1"), 200);
  assert.equal(lengthStatus(String(RECORDING_UPLOAD_MAX_REQUEST_BYTES)), 200, "a body exactly at the cap is read");
  assert.equal(lengthStatus(String(RECORDING_UPLOAD_MAX_REQUEST_BYTES + 1)), 413, "one byte over the cap is refused 413");
  assert.ok(RECORDING_UPLOAD_MAX_REQUEST_BYTES > RECORDING_MAX_BYTES, "the request cap leaves room for the multipart framing around a full-size file");

  /** A body that records whether anything ever read it. highWaterMark 0: nothing is pulled until a read. */
  const probeBody = () => {
    const probe = { pulled: false };
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          probe.pulled = true;
          controller.enqueue(new Uint8Array(16));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    return { probe, stream };
  };
  const probeRequest = (stream: ReadableStream<Uint8Array>, contentLength: string | null, slotId?: string) =>
    new Request(slotId === undefined ? "https://phoenix.test/api/devices/recordings/upload" : recordingUploadUrl("https://phoenix.test", slotId), {
      body: stream,
      duplex: "half",
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "x-forwarded-for": "8.8.4.4",
        ...(contentLength === null ? {} : { "content-length": contentLength }),
      },
      method: "POST",
    } as RequestInit);

  const SUPABASE_SETTINGS = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
  const saved = SUPABASE_SETTINGS.map((name) => [name, process.env[name]] as const);
  const restore = () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };

  let standRpcAllowed = true;
  let standClaimRows = 1;
  let standSlot: "open" | "none" | "handled" | "closed" | "unreadable" = "open";
  let rowReads = 0;
  let storageCalls = 0;
  const patches: string[] = [];
  const upserts: string[] = [];
  const token = "c".repeat(64);
  const hash = hashRecordingToken(token);
  const recordingId = "11111111-2222-4333-8444-555555555555";
  const stand = createServer((request, response) => {
    const url = request.url ?? "";
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const json = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (url.includes("/rpc/api_rate_limit_consume")) {
        return json(200, [{ allowed: standRpcAllowed, retry_after_seconds: standRpcAllowed ? 0 : 30 }]);
      }
      if (url.startsWith("/storage/v1/object/")) {
        storageCalls += 1;
        upserts.push(String(request.headers["x-upsert"]));
        return json(200, { Id: "stand-in", Key: url.slice("/storage/v1/object/".length) });
      }
      if (url.startsWith("/rest/v1/device_screen_recordings")) {
        if (request.method === "GET") {
          rowReads += 1;
          if (standSlot === "unreadable") return json(500, { code: "XX000", message: "stand-in read failure" });
          if (standSlot === "none") return json(200, []);
          return json(200, [
            {
              id: recordingId,
              requested_at: new Date().toISOString(),
              status: standSlot === "handled" ? "ready" : "requested",
              storage_path: `7/${recordingId}.mp4`,
              upload_token_hash: standSlot === "closed" ? null : hash,
            },
          ]);
        }
        if (request.method === "PATCH") {
          patches.push(decodeURIComponent(url));
          if (patches.length === 1) return json(200, standClaimRows === 1 ? [{ id: recordingId }] : []);
          response.writeHead(204);
          return response.end();
        }
      }
      json(404, { message: `stand-in has no answer for ${request.method} ${url}` });
    });
  });

  /** A real multipart upload, sent with the Content-Length a tablet sends. */
  const multipartUpload = async (address: string, formRecordingId = recordingId) => {
    const form = new FormData();
    form.set("recordingId", formRecordingId);
    form.set("token", token);
    form.set("capturedSeconds", "42");
    form.set("file", new File([new Uint8Array(2048)], "screen.mp4", { type: "video/mp4" }));
    const encoded = new Response(form);
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    return new Request(recordingUploadUrl("https://phoenix.test", recordingId), {
      body: bytes,
      headers: {
        "content-length": String(bytes.byteLength),
        "content-type": encoded.headers.get("content-type") ?? "",
        "x-forwarded-for": address,
      },
      method: "POST",
    });
  };

  await new Promise<void>((resolve) => stand.listen(0, "127.0.0.1", () => resolve()));
  try {
    // ── 1. refused on the header alone, before a byte of the body is read ──
    for (const name of SUPABASE_SETTINGS) delete process.env[name];
    {
      const { probe, stream } = probeBody();
      const response = await recordingUploadPost(probeRequest(stream, null));
      assert.equal(response.status, 411, "an upload with no Content-Length is refused 411");
      assert.equal(probe.pulled, false, "and its body is never read");
    }
    {
      const { probe, stream } = probeBody();
      const response = await recordingUploadPost(probeRequest(stream, String(RECORDING_UPLOAD_MAX_REQUEST_BYTES + 1)));
      assert.equal(response.status, 413, "an upload declaring more than the cap is refused 413");
      assert.equal(probe.pulled, false, "and its body is never read — the door used to buffer all of it first");
    }
    {
      // The limiter cannot reach its store (no settings): refused, never waved through, body unread.
      const { probe, stream } = probeBody();
      const response = await recordingUploadPost(probeRequest(stream, "4096"));
      assert.equal(response.status, 503, "a rate limit that cannot be checked refuses the upload (fails closed)");
      assert.equal(probe.pulled, false, "and the body is never read");
    }

    // ── 2. against the stand-in store ──
    const { port } = stand.address() as AddressInfo;
    process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "stand-in-not-a-key";
    {
      standRpcAllowed = false;
      const { probe, stream } = probeBody();
      const response = await recordingUploadPost(probeRequest(stream, "4096"));
      assert.equal(response.status, 429, "an address over RECORDING_UPLOAD_RATE_LIMIT a minute is refused 429");
      assert.equal(response.headers.get("retry-after"), "30", "with the store's Retry-After");
      assert.equal(probe.pulled, false, "and its body is never read");
      standRpcAllowed = true;
    }
    // 🔴 THE SLOT BEFORE THE BODY: the address names the slot, and an upload with no slot, a malformed
    // one, or one that is gone, handled, spent or unreadable is refused before a byte of its body is
    // pulled. Without this a caller holding no token made the door buffer up to 256 MB a request.
    {
      const readsBefore = rowReads;
      const { probe, stream } = probeBody();
      const response = await recordingUploadPost(probeRequest(stream, "4096"));
      assert.equal(response.status, 400, "an upload whose address names no slot is refused 400");
      assert.equal(probe.pulled, false, "and its body is never read");
      assert.equal(rowReads, readsBefore, "and no row is read for it");
    }
    {
      const readsBefore = rowReads;
      const { probe, stream } = probeBody();
      const response = await recordingUploadPost(probeRequest(stream, "4096", "not-a-recording"));
      assert.equal(response.status, 400, "a malformed recordingId is refused 400");
      assert.equal(probe.pulled, false, "and its body is never read");
      assert.equal(rowReads, readsBefore, "and no row is read for it");
    }
    for (const [slot, status, label] of [
      ["none", 404, "a slot that does not exist"],
      ["handled", 409, "a slot already handled"],
      ["closed", 410, "a slot whose token is spent"],
      ["unreadable", 503, "a slot that cannot be read"],
    ] as const) {
      standSlot = slot;
      const readsBefore = rowReads;
      const { probe, stream } = probeBody();
      const response = await recordingUploadPost(probeRequest(stream, "4096", recordingId));
      assert.equal(response.status, status, `${label} is refused ${status}`);
      assert.equal(probe.pulled, false, `${label}: the body is never read`);
      assert.equal(rowReads, readsBefore + 1, `${label}: on one row read`);
    }
    standSlot = "open";
    {
      // The form may repeat the id, but never name a slot other than the one the address was checked on.
      const response = await recordingUploadPost(await multipartUpload("8.8.4.7", "99999999-2222-4333-8444-555555555555"));
      assert.equal(response.status, 400, "a form recordingId that differs from the address's is refused 400");
      assert.equal(storageCalls, 0, "and it never reaches storage");
      assert.equal(patches.length, 0, "or claims anything");
    }
    {
      // 🔴 THE RACE: the slot was claimed by another upload in between this one's read and its claim.
      standClaimRows = 0;
      const response = await recordingUploadPost(await multipartUpload("8.8.4.5"));
      assert.equal(response.status, 409, "an upload that loses the claim is refused 409");
      assert.equal(storageCalls, 0, "and it never reaches storage — the loser used to overwrite the winner's file");
      assert.match(patches[0] ?? "", /status=eq\.requested/, "the claim only matches a row still requested");
      assert.match(patches[0] ?? "", new RegExp(`upload_token_hash=eq\\.${hash}`), "and still holding the hash this token matched");
    }
    {
      patches.length = 0;
      standClaimRows = 1;
      const response = await recordingUploadPost(await multipartUpload("8.8.4.6"));
      assert.equal(response.status, 200, "the upload that wins the claim is stored");
      assert.equal(storageCalls, 1, "once");
      assert.deepEqual(upserts, ["false"], "and never with an overwrite");
      assert.equal(patches.length, 2, "the claim, then the ready mark");
      assert.match(patches[1] ?? "", /status=eq\.requested/, "the ready mark only lands on a row still requested");
    }
  } finally {
    restore();
    await new Promise<void>((resolve) => stand.close(() => resolve()));
  }
}

export async function runHeadwindBridgeTests() {
  await runAuthTests();
  await runCloudflareAccessTests();
  await runClientTests();
  await runDeviceTests();
  await runDeviceDetailTests();
  await runDeviceActorNameTests();
  runDashboardTests();
  runMatcherTests();
  runRegisterSyncTests();
  await runCommandTests();
  runAppsTests();
  await runAppRemovalTests();
  await runRemoteScreenIdTests();
  await runCorporateWipeTests();
  runRecordingTests();
  await runRecordingUploadDoorTests();
  await runConfigurationTests();
  await runUploadTests();
  await runLocationTests();
  await runCustodyActionTests();
  runEnrollmentTests();
  await runConsoleUserTests();
  runRemoteScreenTests();
  runErrorMappingTests();
  runDoorTests();
  runServerImageTests();
  runPluginPathTests();
  runOriginCertificateCheckTests();
  runBootstrapScriptTests();
  runConsoleUiTests();
  runShipsDarkTests();
}
