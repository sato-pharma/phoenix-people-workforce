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
import {
  headwindActionCatalogue,
  isHeadwindActionId,
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
  configurationBranding,
  configurationSummary,
  linkHeadwindApp,
  moveHeadwindDeviceToConfiguration,
  setHeadwindBranding,
  HEADWIND_ICON_SIZES,
  HeadwindConfigurationError,
} from "../src/lib/devices/headwind/configurations.ts";
import {
  parseHeadwindEnrollmentTemplate,
  HeadwindEnrollmentError,
} from "../src/lib/devices/headwind/enrollment.ts";
import {
  locationFixesFromPlugin,
  locateHeadwindDevice,
  HeadwindLocationError,
} from "../src/lib/devices/headwind/locations.ts";
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
  getHeadwindLocation,
  listHeadwindDevices,
  matchHeadwindToRegister,
  matchHeadwindToRegisterDetailed,
  type HeadwindDevice,
} from "../src/lib/devices/headwind/devices.ts";
import { headwindErrorResponse } from "../src/lib/devices/headwind/http.ts";
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

  const configs = stripComments(source("src/lib/devices/headwind/configurations.ts"));
  // 🔴 THE OPAQUE ROUND-TRIP. `PUT /rest/private/configurations` WIPES AND RE-INSERTS the configuration's
  // applications, settings and files. A hand-built body — even a correct-looking one — therefore empties
  // the app list of every tablet carrying those rules. The only safe write is the server's own object
  // with one field changed.
  assert.match(configs, /const next = \{ \.\.\.current, \.\.\.patch \}/, "the whole object is read back and returned with one field changed");
  assert.match(configs, /"\/rest\/private\/applications\/configurations"/, "attaching ONE app uses the surgical endpoint, which rewrites nothing else");
  assert.match(configs, /"\/rest\/private\/web-ui-files\/configurations"/, "and so does attaching one file");
  // 🔴 A CONFIGURATION OBJECT CARRIES A PLAINTEXT PASSWORD — the Swagger's "MD5 hash" is wrong, the hash
  // is computed at device-sync time from a plaintext column. So the object must never be logged, and
  // never put in an audit row whole.
  assert.doesNotMatch(configs, /console\.(log|info|warn|error|debug)/, "the configuration object is never logged — it carries a plaintext password");
  assert.doesNotMatch(configs, /newValues: \{[^}]*current/, "and never written into an audit row whole");
  assert.match(configs, /HEADWIND_ICON_SIZES/, "the icon sizes are the three the launcher understands");
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
  assert.match(panel, /Press again to erase \$\{erases\.join\(", "\)\} from \$\{deviceNumber\}/, "the armed wipe names the camera roll out loud, because the owner chose the scope that takes field photos");
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
  assert.match(
    runbook,
    /HEADWIND_MDM_BASE_URL=https:\/\/mdm-console\.satopharma\.com/,
    "and Phoenix is pointed at the console hostname too, so the API stays behind Access",
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
  // calls can stay on the private network and never meet Cloudflare — which deletes the Access service
  // token from the setup rather than adding anything. Without this written down, the obvious reading of
  // §4.7 is that Phoenix must be let through Access, and the console then has to be loosened for it.
  assert.match(
    runbook,
    /phoenix-headwind\.railway\.internal/,
    "the runbook offers Railway's private hostname as the preferred HEADWIND_MDM_BASE_URL, so Phoenix's calls never reach Cloudflare and Access never has to be loosened to let Phoenix through",
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
  await runAppRemovalTests();
  await runCorporateWipeTests();
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
  runConsoleUiTests();
  runShipsDarkTests();
}
