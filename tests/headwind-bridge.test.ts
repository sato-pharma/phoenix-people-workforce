import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  getHeadwindToken,
  headwindAccessHeaders,
  headwindPasswordHash,
  isHeadwindConfigured,
  HeadwindNotConfiguredError,
  resetHeadwindTokenCache,
} from "../src/lib/devices/headwind/auth.ts";
import { callHeadwind, HeadwindRequestError } from "../src/lib/devices/headwind/client.ts";
import {
  headwindCommandCatalogue,
  isHeadwindCommandId,
  isHeadwindCommandReady,
  issueHeadwindCommand,
  HEADWIND_COMMANDS,
  HEADWIND_MESSAGE_TYPES,
  HeadwindCommandInputError,
  HeadwindCommandUnconfirmedError,
} from "../src/lib/devices/headwind/commands.ts";
import {
  getHeadwindLocation,
  listHeadwindDevices,
  matchHeadwindToRegister,
  matchHeadwindToRegisterDetailed,
  type HeadwindDevice,
} from "../src/lib/devices/headwind/devices.ts";
import { headwindErrorResponse } from "../src/lib/devices/headwind/http.ts";
import { installedAppsFromInfo, HeadwindAppInputError } from "../src/lib/devices/headwind/apps.ts";
import { headwindImeisToRecord, headwindTabletsToRegister } from "../src/lib/devices/headwind/register-sync.ts";
import { isRustDeskConfigured, rustDeskPackageName, RustDeskNotConfiguredError } from "../src/lib/devices/rustdesk/config.ts";
import { rustDeskTarget } from "../src/lib/devices/rustdesk/session.ts";
import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";
import { stripComments } from "./support/comment-strip.ts";
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
 * which is not JSON at all reaches the code under test, and it is the exact shape a Cloudflare Access
 * sign-in page arrives in: an HTML page where an answer was expected.
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
    manufacturer: null,
    model: null,
    serialNumber: null,
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
    isAndroid: true,
    lastContactAt: null,
    latitude: null,
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
  resetHeadwindTokenCache();
  const signIn = makeFetch({});
  assert.equal(await getHeadwindToken(signIn.fetch, ENV), "jwt-1", "the token comes out of the envelope's data");
  const sent = JSON.parse(String(signIn.calls[0].init.body)) as { login: string; password: string };
  assert.equal(sent.login, "phoenix");
  assert.equal(sent.password, createHash("md5").update("a-real-password", "utf8").digest("hex"));
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
  // 🔴 THE MAP IS THE WHOLE SURFACE OF THE UNKNOWN. Exactly two message types are published by
  // Headwind; every other action is `null` until it is read off the live server's own API list. This
  // pin exists so that filling one in is a deliberate act with a test behind it, and so that nobody
  // can quietly invent a wire name — a guessed name produces a button that answers 200 and reaches
  // nothing, which on a custody console is worse than no button at all.
  assert.equal(HEADWIND_MESSAGE_TYPES.APPLY_SETTINGS, "configUpdated", "documented: re-read your settings");
  assert.equal(HEADWIND_MESSAGE_TYPES.WAKE_REMOTE_APP, "runApp", "documented: start this app");
  const unconfirmed = Object.entries(HEADWIND_MESSAGE_TYPES)
    .filter(([, value]) => value === null)
    .map(([id]) => id)
    .sort();
  assert.deepEqual(
    unconfirmed,
    ["FACTORY_RESET", "LOCATE_NOW", "LOCK", "PAUSE_KIOSK", "REBOOT", "RESUME_KIOSK"],
    "these six are real features of the Community edition whose WIRE NAME is not published — confirm each against the live server's Swagger before writing it in",
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
  assert.equal(isHeadwindCommandReady("REBOOT"), false);

  const catalogue = headwindCommandCatalogue();
  assert.equal(catalogue.length, HEADWIND_COMMANDS.length, "the console is told about every action, including the ones it cannot send");
  assert.equal(catalogue.filter((entry) => entry.ready).length, 2, "and exactly two can be sent today");

  // 🔴 AN UNCONFIRMED ACTION REFUSES BEFORE IT REACHES THE NETWORK. Not a guess, not a silent drop,
  // and not a failure blamed on the tablet.
  const untouched = makeFetch({ api: [{ body: { status: "OK" }, status: 200 }] });
  await assert.rejects(
    () => issueHeadwindCommand({ command: "REBOOT", deviceNumber: "PHX-TAB-0002" }, "B-10", untouched.fetch, ENV),
    HeadwindCommandUnconfirmedError,
  );
  assert.equal(untouched.calls.length, 0, "and nothing at all was sent — no sign-in, no push");

  await assert.rejects(
    () => issueHeadwindCommand({ command: "APPLY_SETTINGS", deviceNumber: "   " }, "B-10", untouched.fetch, ENV),
    HeadwindCommandInputError,
    "a command with no tablet named is refused before anything else happens",
  );

  // The wire shape is pinned at the source, because sending it for real needs the database.
  const commands = stripComments(source("src/lib/devices/headwind/commands.ts"));
  assert.match(commands, /"\/rest\/private\/push"/, "every action goes down the one push endpoint");
  assert.match(commands, /deviceNumbers: \[device\.deviceNumber\]/, "addressed by device NUMBER — an id would reach nothing and report success");
  assert.doesNotMatch(commands, /deviceNumbers: \[[^\]]*deviceId/, "and never by the server's row id");
  assert.match(commands, /payload: payloadFor\(/, "the payload is built by the one function that knows it must be a STRING");
  assert.match(commands, /entityType: "headwind_device_command"/, "and every action that lands writes a required audit row");
}

function runAppsTests() {
  const info = JSON.stringify({
    applications: [
      { name: "RustDesk", pkg: "com.carriez.flutter_hbb", version: "1.2.3" },
      { packageName: "com.phoenix.reps" },
      { name: "no package at all" },
    ],
  });
  const apps = installedAppsFromInfo(info, rustDeskPackageName(ENV));
  assert.equal(apps.length, 2, "an app with no package cannot be acted on and is dropped");
  const rustdesk = apps.find((app) => app.packageName === "com.carriez.flutter_hbb")!;
  assert.equal(rustdesk.isRemoteScreenApp, true, "the screen-sharing app is marked so a tablet missing it is obvious");
  assert.equal(apps.find((app) => app.packageName === "com.phoenix.reps")!.name, "com.phoenix.reps", "an unnamed app reads as its package, never as blank");
  assert.deepEqual(installedAppsFromInfo("{not json", "x"), [], "an unreadable blob is an empty list, never a throw");
  assert.deepEqual(installedAppsFromInfo({ applications: "nope" }, "x"), []);
}

function runRemoteScreenTests() {
  assert.equal(isRustDeskConfigured({} as NodeJS.ProcessEnv), false);
  assert.equal(isRustDeskConfigured(ENV), true);
  assert.equal(rustDeskPackageName(ENV), "com.carriez.flutter_hbb", "RustDesk's Android package keeps its Flutter project id — this looks wrong and is right");

  assert.throws(() => rustDeskTarget({ mode: "view", rustDeskId: "1" }, {} as NodeJS.ProcessEnv), RustDeskNotConfiguredError);

  // A tablet with no ID yet gets a sentence saying what to do, not an error.
  const notReady = rustDeskTarget({ mode: "control", rustDeskId: null }, ENV);
  assert.equal(notReady.target, null);
  assert.match(String(notReady.reason), /RustDesk ID/, "and it says in plain words where the ID comes from");

  const ready = rustDeskTarget({ mode: "control", rustDeskId: "123 456 789" }, ENV);
  assert.equal(ready.reason, null);
  assert.equal(ready.target?.connectUrl, "rustdesk://connect/123%20456%20789", "a value somebody typed is encoded, never pasted into a link raw");
  assert.equal(ready.target?.relayHost, "relay.test.local");

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
    [new RustDeskNotConfiguredError("no relay"), 400, "so is a missing relay"],
    [new HeadwindCommandUnconfirmedError("not connected yet"), 501, "an action Phoenix cannot name is neither the person's fault nor the tablet's"],
    [new HeadwindCommandInputError("say which tablet"), 400, "a mistake in what was sent"],
    [new HeadwindRequestError(500, "the server said no"), 502, "the far end refusing"],
    [new HeadwindAppInputError("say which tablet"), 400, "and an app read with no tablet named"],
    [new Error("something else"), 500, "anything else"],
  ];
  for (const [error, status, because] of cases) {
    assert.equal(headwindErrorResponse(error, "fallback").status, status, because);
  }
}

function runDoorTests() {
  const approve = { action: "approve", resource: "company_devices" };
  for (const [pattern, methods] of [
    ["/api/devices/headwind", ["GET", "POST"]],
    ["/api/devices/headwind/imei", ["POST"]],
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

function runShipsDarkTests() {
  // 🔴 THE WHOLE SECTION SHIPS DARK. Nothing renders and no request is made until the company's own
  // server exists and its settings are on Railway — which is what makes this safe to merge to
  // production before the server is built.
  const page = stripComments(source("app/(admin)/devices/tablets/page.tsx"));
  assert.match(page, /const headwindReady = isHeadwindConfigured\(\);/);
  assert.match(page, /\{headwindReady \? <HeadwindFleet \/> : null\}/, "no settings, no section — and no fetch either");
  assert.ok(
    page.indexOf("<ManageEngineFleet") < page.indexOf("<HeadwindFleet"),
    "ManageEngine stays above during the changeover: a tablet is in exactly one of the two, and today all of them are in the first",
  );

  // The two free buttons carry no paid mark — that contrast with the section above is the payoff.
  const fleet = source("src/components/devices/headwind-fleet.tsx");
  assert.doesNotMatch(stripComments(fleet), /stopsAfterTrial|TRIAL_STOP/, "screen viewing and control cost nothing here");
  assert.match(fleet, /FREE_CHIP/, "and they say so in a chip, because colour is never the only signal");
  assert.match(fleet, /PENDING_CHIP/, "an action that cannot be sent yet says so in words too");
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

  // 🔴 A REPLY THAT IS NOT JSON IS CLOUDFLARE, NOT HEADWIND — and the error has to say so, or an
  // afternoon goes on the admin password of a server that is answering fine.
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
  assert.match(
    runbook,
    /31000 stays open directly/,
    "while saying plainly that the tablets' own channel is NOT behind the tunnel — putting it there would take the fleet offline",
  );

  // 🔴 THE MOST EXPENSIVE MISTAKE IN THE WHOLE RUNBOOK, AND THE MOST NATURAL ONE TO MAKE.
  // `cloudflared tunnel route dns` replaces its hostname with a proxied CNAME, and Cloudflare's proxy
  // carries HTTP ports only. Run it on the TABLETS' name and every tablet goes dark at its next
  // check-in on 31000 — looking exactly like a dead server rather than like a DNS setting. So the
  // runbook must route the tunnel to a separate console hostname and never to the tablets' one.
  assert.match(
    runbook,
    /cloudflared tunnel route dns phoenix-mdm mdm-console\.satopharma\.com/,
    "the tunnel is routed to the CONSOLE hostname",
  );
  assert.doesNotMatch(
    runbook,
    /tunnel route dns \S+ mdm\.satopharma\.com/,
    "and never to mdm.satopharma.com, which the tablets reach on 31000 — a port Cloudflare's proxy does not carry",
  );
  assert.match(
    runbook,
    /HEADWIND_MDM_BASE_URL=https:\/\/mdm-console\.satopharma\.com/,
    "and Phoenix is pointed at the console hostname too, so the API stays behind Access",
  );
}

export async function runHeadwindBridgeTests() {
  await runAuthTests();
  await runCloudflareAccessTests();
  await runClientTests();
  await runDeviceTests();
  runMatcherTests();
  runRegisterSyncTests();
  await runCommandTests();
  runAppsTests();
  runRemoteScreenTests();
  runErrorMappingTests();
  runDoorTests();
  runShipsDarkTests();
}
