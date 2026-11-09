/**
 * What the rep tablets download — the install links, and every write that puts an app on their rules.
 *
 * WHY THIS EXISTS (9 Nov 2026). Twice a single dead install link held a rep tablet on an old launcher
 * for weeks: first six 404s on a rebuilt download host (runbook §8.16), then two line apps registered
 * on `http://`, whose 301 the tablet counts as a failed download (§8.18). The update run stops at the
 * first dead link, so the launcher after it — the one that sends location — never arrived, while every
 * screen in Phoenix looked healthy. The earlier check followed redirects and called the 301s fine.
 *
 * These tests pin, with a stub server and no network: the install-link check (HEAD, redirects NOT
 * followed, exactly 200); the https step that could do nothing and report success; the link write
 * that never checked the link; the "hide" that deleted the link instead; the rep tablets' several sets
 * of rules, each reached with its own audit row; the device and rules reads that turned an unread
 * reply into "nothing there"; and a removal the tablet's own rules would undo within the hour.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { HeadwindAppInputError, getHeadwindDeviceApps, removeHeadwindApp } from "../src/lib/devices/headwind/apps.ts";
import { HeadwindRequestError } from "../src/lib/devices/headwind/client.ts";
import {
  checkHeadwindInstallLinks,
  HeadwindConfigurationError,
  linkHeadwindApp,
  linkHeadwindAppToRules,
  listHeadwindConfigurations,
  probeInstallLink,
  resolveHeadwindRules,
  secureHeadwindVersionLinks,
  type HeadwindAuditWriter,
} from "../src/lib/devices/headwind/configurations.ts";
import { HeadwindDeviceNotFoundError } from "../src/lib/devices/headwind/devices.ts";
import {
  headwindUploadLengthDecision,
  HEADWIND_MAX_UPLOAD_REQUEST_BYTES,
  HeadwindUploadError,
  uploadHeadwindApp,
} from "../src/lib/devices/headwind/uploads.ts";
import { stripComments } from "./support/comment-strip.ts";

const BASE = "https://mdm.test.local";
const FILES = "https://mdm.satopharma.com/files";
const ENV = {
  HEADWIND_MDM_BASE_URL: BASE,
  HEADWIND_MDM_LOGIN: "phoenix",
  HEADWIND_MDM_PASSWORD: "a-real-password",
} as unknown as NodeJS.ProcessEnv;

type Reply = { status: number; body?: unknown; headers?: Record<string, string>; throws?: boolean };
type Call = { method: string; url: string; init: RequestInit };

/**
 * A stub server routed by `METHOD url`. API paths are written bare (`GET /rest/...`) and answered
 * inside Headwind's `{ status: "OK", data }` envelope; a full URL is a download link and is answered
 * as given. A list of replies is used in turn, the last repeating. An unrouted call throws, and is
 * recorded so a test can say which call it did not expect.
 */
function server(routes: Record<string, Reply | Reply[]>) {
  const calls: Call[] = [];
  const events: string[] = [];
  const unrouted: string[] = [];
  const queues = new Map<string, Reply[]>();
  for (const [key, value] of Object.entries(routes)) {
    const [method, target] = key.split(" ");
    const url = target.startsWith("/") ? `${BASE}${target}` : target;
    queues.set(`${method} ${url}`, Array.isArray(value) ? [...value] : [value]);
  }
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({ init, method, url });
    events.push(`${method} ${url}`);
    if (url.endsWith("/rest/public/jwt/login")) {
      return response({ body: { data: { authToken: "jwt-1" }, status: "OK" }, status: 200 });
    }
    const queue = queues.get(`${method} ${url}`);
    if (!queue) {
      unrouted.push(`${method} ${url}`);
      throw new Error(`unrouted: ${method} ${url}`);
    }
    const reply = queue.length > 1 ? queue.shift()! : queue[0];
    if (reply.throws) throw new Error("connect ECONNREFUSED");
    return response(reply);
  }) as unknown as typeof fetch;
  const api = (method: string, path: string) => calls.filter((call) => call.method === method && call.url === `${BASE}${path}`);
  return { api, calls, events, fetch: fetchImpl, unrouted };
}

function response(reply: Reply): Response {
  return {
    body: null,
    headers: new Headers(reply.headers ?? {}),
    json: async () => reply.body ?? null,
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    type: "basic",
  } as unknown as Response;
}

const ok = (data: unknown): Reply => ({ body: { data, status: "OK" }, status: 200 });
const file = (status: number, headers?: Record<string, string>): Reply => ({ headers, status });

function auditLog(events?: string[]) {
  const rows: Array<Parameters<HeadwindAuditWriter>[0]> = [];
  const audit: HeadwindAuditWriter = async (row) => {
    rows.push(row);
    events?.push(`audit ${String((row.newValues as Record<string, unknown> | null)?.change)}`);
  };
  return { audit, rows };
}

const RULES = [
  { id: 3, name: "Rep tablets" },
  { id: 4, name: "Rep tablets — Anti Infective" },
  { id: 5, name: "Rep tablets — Pedia" },
  { id: 9, name: "Warehouse scanners" },
];

/** A configuration as the server holds it — WITH the plaintext tablet password that must never leave. */
const rulesObject = (id: number) => ok({ id, name: RULES.find((entry) => entry.id === id)!.name, password: "plaintext-secret-123" });

const PEDIA = { action: 0, id: 90, name: "Pedia Line", pkg: "com.satopharma.pedia", showIcon: true, type: "app", version: "1.3.4" };
const PEDIA_URL = `${FILES}/Sato-Pedia-1.3.4.apk`;

function apkFile(name = "Sato-Pedia-1.3.4.apk") {
  return new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9, 9])], name);
}

function source(relative: string): string {
  return readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
}

/* ── F18: an unread reply is never "nothing there" ── */

export async function listAndDeviceReadsRefuseUnreadableReplies() {
  for (const unreadable of [{}, "error", 7]) {
    const stub = server({ "GET /rest/private/configurations/search/": ok(unreadable) });
    await assert.rejects(
      () => listHeadwindConfigurations(stub.fetch, ENV),
      HeadwindRequestError,
      "🔴 a list of rules that is not a list throws — it used to read as 'the server holds no sets of rules yet'",
    );
  }
  const empty = server({ "GET /rest/private/configurations/search/": ok([]) });
  assert.deepEqual(await listHeadwindConfigurations(empty.fetch, ENV), { configurations: [] }, "a real empty list is still empty");

  const fleet = server({
    "POST /rest/private/devices/search": ok({
      devices: { items: [{ id: 7, info: { applications: [{ name: "WhatsApp", pkg: "com.whatsapp", version: "2.24" }] }, number: "PHX-TAB-0007" }] },
    }),
  });
  await assert.rejects(
    () => getHeadwindDeviceApps("PHX-TAB-0099", "com.carriez.flutter_hbb", fleet.fetch, ENV),
    HeadwindDeviceNotFoundError,
    "🔴 a tablet that is not in the fleet throws — it used to read as a tablet with no apps installed",
  );
  const found = await getHeadwindDeviceApps("PHX-TAB-0007", "com.carriez.flutter_hbb", fleet.fetch, ENV);
  assert.deepEqual(found.installed.map((app) => app.packageName), ["com.whatsapp"], "a tablet in the fleet still lists its apps");
}

/* ── F3: the install-link check ── */

export async function installLinkCheckMeetsLinksAsATabletDoes() {
  const list = (apps: unknown[]) => ok(apps);
  const stub = server({
    "GET /rest/private/configurations/search/": ok(RULES),
    "GET /rest/private/configurations/applications/3": list([
      { action: 1, id: 1, name: "Launcher", url: `${FILES}/launcher-6.48.apk`, version: "6.48" },
      { action: 1, id: 2, name: "Pedia Line", url: `${FILES}/pedia-301.apk`, version: "1.3.4" },
      { action: 1, id: 3, name: "Outlook", url: `${FILES}/outlook.xapk`, version: "4.2" },
      { action: 1, id: 4, name: "Waze", url: `${FILES}/waze.apk`, version: "5.0" },
      { action: 1, id: 5, name: "Anti-Infective", url: "http://mdm.satopharma.com/files/ai.apk", version: "1.0.18" },
      { action: 1, id: 6, name: "Head-refusing host", url: `${FILES}/no-head.apk`, version: "1" },
      { action: 0, id: 7, name: "Not on these rules", url: `${FILES}/dead-but-unused.apk` },
      { action: 2, id: 8, name: "Removed by these rules", url: `${FILES}/dead-removed.apk` },
      { action: 1, id: 9, name: "A web link", type: "web", url: "https://satopharma.com" },
      { action: 1, id: 10, name: "Settings", system: true },
      { action: 1, id: 11, name: "No link at all" },
      { action: 1, id: 12, name: "Unreachable host", url: `${FILES}/unreachable.apk` },
      { action: 1, id: 13, name: "RustDesk", url: null, urlArm64: `${FILES}/rustdesk-arm64.apk`, version: "1.3" },
    ]),
    "GET /rest/private/configurations/applications/4": list([
      { action: 1, id: 1, name: "Launcher", url: `${FILES}/launcher-6.48.apk`, version: "6.48" },
    ]),
    "GET /rest/private/configurations/applications/5": list([]),
    [`HEAD ${FILES}/launcher-6.48.apk`]: file(200),
    [`HEAD ${FILES}/pedia-301.apk`]: file(301, { location: `${FILES}/elsewhere.apk` }),
    [`HEAD ${FILES}/outlook.xapk`]: file(404),
    [`HEAD ${FILES}/waze.apk`]: file(503),
    [`HEAD ${FILES}/no-head.apk`]: file(405),
    [`GET ${FILES}/no-head.apk`]: file(206),
    [`HEAD ${FILES}/unreachable.apk`]: { status: 0, throws: true },
    [`HEAD ${FILES}/rustdesk-arm64.apk`]: file(200),
  });

  const { checkedAt, configurations } = await checkHeadwindInstallLinks("rep", stub.fetch, ENV);
  assert.deepEqual(stub.unrouted, [], "no call went anywhere the test did not expect");
  assert.ok(!Number.isNaN(Date.parse(checkedAt)), "the check carries the time it was made");
  assert.deepEqual(
    configurations.map((entry) => entry.name),
    ["Rep tablets", "Rep tablets — Anti Infective", "Rep tablets — Pedia"],
    "every rep set of rules is checked — found by name, and the warehouse rules are not",
  );

  const rep = configurations[0];
  const verdict = Object.fromEntries(rep.links.map((link) => [link.name, link.verdict]));
  assert.deepEqual(
    verdict,
    {
      "Anti-Infective": "not-https",
      "Head-refusing host": "ok",
      "Launcher": "ok",
      "No link at all": "no-link",
      "Outlook": "missing",
      "Pedia Line": "redirect",
      "RustDesk": "ok",
      "Unreachable host": "unreachable",
      "Waze": "server-error",
    },
    "🔴 a 301 is a dead link to a tablet, as are a 404, a 503, an http link and no link — and only the apps these rules INSTALL from a download are checked",
  );
  assert.equal(rep.broken, 6, "six of the nine would stop a tablet's run");
  assert.deepEqual(
    rep.links.slice(0, 6).map((link) => link.verdict !== "ok"),
    [true, true, true, true, true, true],
    "the broken links come first, so the one that stops the run is read before the ones that work",
  );
  const redirect = rep.links.find((link) => link.name === "Pedia Line")!;
  assert.equal(redirect.status, 301);
  assert.equal(redirect.redirectsTo, `${FILES}/elsewhere.apk`, "where a redirect points is shown");
  assert.match(redirect.label, /will not follow/, "and the verdict says what that means for a tablet");
  assert.equal(rep.links.find((link) => link.name === "RustDesk")!.url, `${FILES}/rustdesk-arm64.apk`, "a split app's arm64 link is checked");

  const fileCalls = stub.calls.filter((call) => call.url.startsWith(FILES));
  assert.ok(fileCalls.length > 0);
  for (const call of fileCalls) {
    assert.equal(call.init.redirect, "manual", `🔴 ${call.method} ${call.url} was asked WITHOUT following a redirect`);
    assert.equal(new Headers(call.init.headers).get("authorization"), null, "and with no credential — the tablet sends none");
  }
  assert.equal(
    stub.calls.filter((call) => call.url === "http://mdm.satopharma.com/files/ai.apk").length,
    0,
    "an http link is a dead link without being asked",
  );
  const ranged = stub.calls.find((call) => call.method === "GET" && call.url === `${FILES}/no-head.apk`);
  assert.equal(new Headers(ranged?.init.headers).get("range"), "bytes=0-0", "a server that refuses HEAD is asked for one byte, and 206 is OK");
  assert.equal(
    stub.calls.filter((call) => call.url === `${FILES}/launcher-6.48.apk`).length,
    1,
    "a link shared by two sets of rules is asked once",
  );
  assert.deepEqual(configurations[1].links.map((link) => link.verdict), ["ok"]);
  assert.equal(configurations[2].links.length, 0, "a set that installs nothing from a download has nothing to check");

  const one = await checkHeadwindInstallLinks([4], stub.fetch, ENV);
  assert.deepEqual(one.configurations.map((entry) => entry.name), ["Rep tablets — Anti Infective"], "a named set is checked alone");
  await assert.rejects(() => checkHeadwindInstallLinks([77], stub.fetch, ENV), HeadwindConfigurationError, "a set not on the server is refused");

  const unread = server({
    "GET /rest/private/configurations/applications/3": ok({ status: "busy" }),
    "GET /rest/private/configurations/search/": ok(RULES),
  });
  await assert.rejects(
    () => checkHeadwindInstallLinks([3], unread.fetch, ENV),
    HeadwindConfigurationError,
    "🔴 an app list that is not a list refuses — it would otherwise read as 'no links to check', all clear",
  );

  // A 200 on HEAD is the only OK without the ranged fallback: a 302 is a redirect too.
  const found = server({ [`HEAD ${FILES}/x.apk`]: file(302, { location: "https://x" }) });
  assert.equal((await probeInstallLink(`${FILES}/x.apk`, found.fetch)).verdict, "redirect");
}

/* ── F5: the https step ── */

export async function versionLinksStepRefusesWhenItDidNothing() {
  const versionsPath = "/rest/private/applications/90/versions";
  const http = { id: 10090, url: "http://mdm.satopharma.com/files/Sato-Pedia-1.3.4.apk", version: "1.3.4", versionCode: 134 };
  const https = { ...http, url: PEDIA_URL };

  for (const unreadable of [{}, "error"]) {
    const stub = server({ [`GET ${versionsPath}`]: ok(unreadable) });
    await assert.rejects(
      () => secureHeadwindVersionLinks(90, stub.fetch, ENV),
      HeadwindConfigurationError,
      "🔴 a version read that is not a list refuses — it used to become [] and report the links secured",
    );
    assert.equal(stub.api("PUT", "/rest/private/applications/versions").length, 0);
  }

  const moved = server({
    [`GET ${versionsPath}`]: [ok([http]), ok([https])],
    [`HEAD ${PEDIA_URL}`]: file(200),
    "PUT /rest/private/applications/versions": ok(null),
  });
  assert.deepEqual((await secureHeadwindVersionLinks(90, moved.fetch, ENV)).changed, 1);
  const put = moved.api("PUT", "/rest/private/applications/versions");
  assert.equal(put.length, 1);
  assert.deepEqual(JSON.parse(String(put[0].init.body)), https, "the live row goes back whole, its id kept, only the link changed");
  assert.equal(moved.api("GET", versionsPath).length, 2, "and the change is read BACK, never trusted from the OK");

  const kept = server({
    [`GET ${versionsPath}`]: ok([http]),
    [`HEAD ${PEDIA_URL}`]: file(200),
    "PUT /rest/private/applications/versions": ok(null),
  });
  await assert.rejects(
    () => secureHeadwindVersionLinks(90, kept.fetch, ENV),
    (error: unknown) => error instanceof HeadwindConfigurationError && /still not https/.test(error.message),
    "🔴 a PUT that answers OK but leaves the link http (RustDesk's, 26 Sep 2026) refuses the link",
  );

  const deadTwin = server({ [`GET ${versionsPath}`]: ok([http]), [`HEAD ${PEDIA_URL}`]: file(404) });
  await assert.rejects(
    () => secureHeadwindVersionLinks(90, deadTwin.fetch, ENV),
    (error: unknown) => error instanceof HeadwindConfigurationError && /left as it was/.test(error.message),
    "an http link whose https twin is dead is never rewritten to it, and the link is refused",
  );
  assert.equal(deadTwin.api("PUT", "/rest/private/applications/versions").length, 0, "nothing was written");

  const oldOnly = server({
    [`GET ${versionsPath}`]: ok([{ id: 1, url: "http://old.example/a.apk", versionCode: 1 }, { id: 2, url: PEDIA_URL, versionCode: 134 }]),
    "HEAD https://old.example/a.apk": file(404),
  });
  assert.equal((await secureHeadwindVersionLinks(90, oldOnly.fetch, ENV)).changed, 0, "an old version no tablet gets does not block the newest");
}

/* ── F5 order, F4 and F6 through the upload ── */

function uploadServer(extra: Record<string, Reply | Reply[]> = {}) {
  const routes: Record<string, Reply | Reply[]> = {
    "GET /rest/private/configurations/search/": ok(RULES),
    "POST /rest/private/web-ui-files": ok({
      fileDetails: { name: "Pedia Line", pkg: "com.satopharma.pedia", version: "1.3.4", versionCode: 134 },
      serverPath: "/tmp/pedia.apk.temp",
    }),
    "PUT /rest/private/applications/android": ok({ id: 90, pkg: "com.satopharma.pedia", version: "1.3.4" }),
    "GET /rest/private/applications/90/versions": ok([{ id: 10090, url: PEDIA_URL, versionCode: 134 }]),
    [`HEAD ${PEDIA_URL}`]: file(200),
    "GET /rest/private/applications/configurations/90": ok([]),
    "POST /rest/private/applications/configurations": ok(null),
  };
  for (const id of [3, 4, 5]) {
    routes[`GET /rest/private/configurations/${id}`] = rulesObject(id);
    routes[`GET /rest/private/configurations/applications/${id}`] = ok([{ ...PEDIA, url: PEDIA_URL }]);
  }
  return server({ ...routes, ...extra });
}

export async function uploadReachesEveryRepSetWithOneAuditRowEach() {
  const stub = uploadServer();
  const { audit, rows } = auditLog(stub.events);
  const result = await uploadHeadwindApp({ file: apkFile(), rules: "rep" }, "B-10", stub.fetch, ENV, audit);
  assert.deepEqual(stub.unrouted, []);

  assert.equal(stub.api("POST", "/rest/private/web-ui-files").length, 1, "🔴 the APK is uploaded ONCE");
  const links = stub.api("POST", "/rest/private/applications/configurations");
  assert.deepEqual(
    links.map((call) => JSON.parse(String(call.init.body)).configurations[0].configurationId),
    [3, 4, 5],
    "🔴 and linked to EVERY rep set of rules — the line tablets' copies too, never the warehouse rules",
  );
  assert.deepEqual(result.rules, ["Rep tablets", "Rep tablets — Anti Infective", "Rep tablets — Pedia"]);
  assert.equal(result.installed, true);
  assert.match(result.message, /Rep tablets — Pedia/, "the reply names the rules it reached");

  assert.deepEqual(
    rows.map((row) => (row.newValues as Record<string, unknown>).change),
    ["application-upload", "application", "application", "application"],
    "one row for the registration, then one per set of rules",
  );
  assert.deepEqual(
    rows.slice(1).map((row) => row.summary),
    ["Pedia Line installed on Rep tablets", "Pedia Line installed on Rep tablets — Anti Infective", "Pedia Line installed on Rep tablets — Pedia"],
    "each link row names the app and the set of rules, not their ids",
  );
  assert.doesNotMatch(JSON.stringify(rows), /plaintext-secret-123/, "🔴 the tablet password carried by the rules never reaches an audit row");
  assert.doesNotMatch(JSON.stringify(result), /plaintext-secret-123/, "nor the reply");
  assert.ok(
    stub.events.indexOf("audit application-upload") < stub.events.indexOf(`GET ${BASE}/rest/private/applications/90/versions`),
    "🔴 the registration is audited BEFORE the https step",
  );
}

export async function anUpgradeTheServerAnswersWithAnotherVersionIsSaidNotRefused() {
  // Registering a version of a package the server already holds answers with that package's row, whose
  // `version` is the newest the server keeps. That is the ordinary upgrade — it must still reach the
  // rules, and the reply names the version the tablets will actually install.
  const stub = uploadServer({
    "PUT /rest/private/applications/android": ok({ id: 90, pkg: "com.satopharma.pedia", version: "1.3.3" }),
  });
  const { audit } = auditLog();
  const result = await uploadHeadwindApp({ file: apkFile(), rules: [5] }, "B-10", stub.fetch, ENV, audit);
  assert.equal(stub.api("POST", "/rest/private/applications/configurations").length, 1, "🔴 an upgrade whose answer names another version is still linked, never refused");
  assert.match(result.message, /newest com.satopharma.pedia is 1.3.3, not the uploaded 1.3.4/, "and the reply says which version the tablets install");
}

export async function uploadAuditsTheRegistrationEvenWhenTheHttpsStepRefuses() {
  const stub = uploadServer({ "GET /rest/private/applications/90/versions": ok({ status: "busy" }) });
  const { audit, rows } = auditLog();
  await assert.rejects(
    () => uploadHeadwindApp({ file: apkFile(), rules: [5] }, "B-10", stub.fetch, ENV, audit),
    HeadwindConfigurationError,
    "an unreadable version list refuses the upload's link",
  );
  assert.deepEqual(
    rows.map((row) => (row.newValues as Record<string, unknown>).change),
    ["application-upload"],
    "🔴 but the app IS on the server by then, and its registration has its audit row",
  );
  assert.equal(stub.api("POST", "/rest/private/applications/configurations").length, 0, "and nothing was linked");
}

export async function uploadRefusesWhatCannotWork() {
  const untouched = server({});
  await assert.rejects(
    () => uploadHeadwindApp({ file: new File(["not a zip"], "renamed.apk") }, "B-10", untouched.fetch, ENV),
    (error: unknown) => error instanceof HeadwindUploadError && /zip/.test(error.message),
    "🔴 a file merely NAMED .apk is refused before a byte is sent",
  );
  assert.equal(untouched.calls.length, 0);

  const noRules = uploadServer();
  await assert.rejects(
    () => uploadHeadwindApp({ file: apkFile(), rules: [77] }, "B-10", noRules.fetch, ENV),
    HeadwindConfigurationError,
    "rules that are not on the server refuse BEFORE the upload",
  );
  assert.equal(noRules.api("POST", "/rest/private/web-ui-files").length, 0, "so no bytes were left on the server aimed at nothing");

  const unreadable = uploadServer({ "POST /rest/private/web-ui-files": ok({ fileDetails: {}, serverPath: "/tmp/x.temp" }) });
  await assert.rejects(
    () => uploadHeadwindApp({ file: apkFile() }, "B-10", unreadable.fetch, ENV),
    (error: unknown) => error instanceof HeadwindUploadError && /package name/.test(error.message),
    "a file the server could read no package from is not registered",
  );
  assert.equal(unreadable.api("PUT", "/rest/private/applications/android").length, 0, "the register that would fail as a 200 and eat the file is never sent");

  for (const [reply, because] of [
    [{ id: 90, pkg: "com.other.app", version: "1.3.4" }, "another package"],
    // Another VERSION is said, not refused — `anUpgradeTheServerAnswersWithAnotherVersionIsSaidNotRefused`.
  ] as const) {
    const mismatch = uploadServer({ "PUT /rest/private/applications/android": ok(reply) });
    const { audit, rows } = auditLog();
    await assert.rejects(
      () => uploadHeadwindApp({ file: apkFile(), rules: [5] }, "B-10", mismatch.fetch, ENV, audit),
      HeadwindUploadError,
      `🔴 a register that answers with ${because} than the file's is never linked`,
    );
    assert.equal(mismatch.api("POST", "/rest/private/applications/configurations").length, 0);
    assert.equal(rows.length, 1, "the registration that did happen is still audited");
  }

  const noId = uploadServer({ "PUT /rest/private/applications/android": ok({ pkg: "com.satopharma.pedia" }) });
  await assert.rejects(
    () => uploadHeadwindApp({ file: apkFile(), rules: [5] }, "B-10", noId.fetch, ENV, auditLog().audit),
    (error: unknown) => error instanceof HeadwindUploadError && /no tablet rules/.test(error.message),
    "🔴 rules asked for but never linked is a refusal — it used to answer 200, 'on NO tablet yet'",
  );
}

/* ── F6 and F7: the link write ── */

export async function linkRefusesADeadLinkAndHidesProperly() {
  const deadRoutes = {
    ...Object.fromEntries([[`HEAD ${PEDIA_URL}`, file(301, { location: "https://satopharma.com/" })]]),
  };
  const dead = uploadServer(deadRoutes);
  const { audit, rows } = auditLog();
  await assert.rejects(
    () => linkHeadwindApp({ action: 1, applicationId: 90, configurationId: 5 }, "B-10", dead.fetch, ENV, audit),
    (error: unknown) => error instanceof HeadwindConfigurationError && /Redirects/.test(error.message) && /Pedia Line/.test(error.message),
    "🔴 an install whose download link redirects is refused before the link is written",
  );
  assert.equal(dead.api("POST", "/rest/private/applications/configurations").length, 0, "nothing was put on the rules");
  assert.equal(rows.length, 0, "and nothing was audited as installed");
  const head = dead.calls.find((call) => call.method === "HEAD");
  assert.equal(head?.init.redirect, "manual");

  const httpLink = uploadServer({
    "GET /rest/private/configurations/applications/5": [
      ok([{ ...PEDIA, url: "http://mdm.satopharma.com/files/Sato-Pedia-1.3.4.apk" }]),
      ok([{ ...PEDIA, url: PEDIA_URL }]),
    ],
    "GET /rest/private/applications/90/versions": [
      ok([{ id: 10090, url: "http://mdm.satopharma.com/files/Sato-Pedia-1.3.4.apk", versionCode: 134 }]),
      ok([{ id: 10090, url: PEDIA_URL, versionCode: 134 }]),
    ],
    "PUT /rest/private/applications/versions": ok(null),
  });
  const moved = auditLog();
  await linkHeadwindApp({ action: 1, applicationId: 90, configurationId: 5 }, "B-10", httpLink.fetch, ENV, moved.audit);
  assert.equal(httpLink.api("PUT", "/rest/private/applications/versions").length, 1, "🔴 linking moves the app's http link onto https first");
  assert.equal(httpLink.api("POST", "/rest/private/applications/configurations").length, 1, "and links once the https link answers 200");

  const untouched = server({});
  await assert.rejects(
    () => linkHeadwindApp({ action: 0, applicationId: 90, configurationId: 5 }, "B-10", untouched.fetch, ENV),
    (error: unknown) => error instanceof HeadwindConfigurationError && /icon off/.test(error.message),
    "🔴 action 0 is refused — with an id it DELETES the link, and a new one still installs",
  );
  assert.equal(untouched.calls.length, 0, "before anything is sent");

  const hide = uploadServer();
  const hidden = auditLog();
  const reply = await linkHeadwindApp({ action: 1, applicationId: 90, configurationId: 5, showIcon: false }, "B-10", hide.fetch, ENV, hidden.audit);
  const entry = JSON.parse(String(hide.api("POST", "/rest/private/applications/configurations")[0].init.body)).configurations[0];
  assert.equal(entry.action, 1, "🔴 hiding is INSTALLING");
  assert.equal(entry.showIcon, false, "with the link's icon off");
  assert.equal(hidden.rows[0].summary, "Pedia Line installed, with its icon hidden, on Rep tablets — Pedia", "the audit names the app and the rules");
  assert.match(reply.message, /icon hidden/);
}

export async function linkToEveryRepSetSaysWhichItMissed() {
  const stub = uploadServer({
    "GET /rest/private/configurations/applications/4": ok([{ ...PEDIA, url: `${FILES}/gone.apk` }]),
    [`HEAD ${FILES}/gone.apk`]: file(404),
  });
  const { audit, rows } = auditLog();
  await assert.rejects(
    () => linkHeadwindAppToRules({ action: 1, applicationId: 90, target: "rep" }, "B-10", stub.fetch, ENV, audit),
    (error: unknown) =>
      error instanceof HeadwindConfigurationError &&
      /done on Rep tablets, Rep tablets — Pedia/.test(error.message) &&
      /NOT done on Rep tablets — Anti Infective/.test(error.message),
    "🔴 a spread that reached two sets of three says so by name — never reported as done",
  );
  assert.equal(rows.length, 2, "one audit row for each set it did reach");
  assert.deepEqual(
    (await resolveHeadwindRules("rep", stub.fetch, ENV)).map((entry) => entry.id),
    [3, 4, 5],
    "the rep sets are found by their name, never by a hard-coded id",
  );
}

/* ── F20: a removal the rules would undo ── */

export async function removalTheRulesWouldUndoIsRefused() {
  const fleet = ok({
    configurations: { "5": { id: 5, name: "Rep tablets — Pedia" } },
    devices: { items: [{ configurationId: 5, id: 7, number: "PHX-TAB-0007" }] },
  });
  const stub = server({
    "GET /rest/private/configurations/applications/5": ok([
      { action: 1, id: 86, name: "WhatsApp", pkg: "com.whatsapp" },
      { action: 2, id: 84, name: "Telegram", pkg: "org.telegram.messenger.web" },
    ]),
    "POST /rest/private/devices/search": fleet,
    "POST /rest/private/push": ok(null),
  });
  await assert.rejects(
    () => removeHeadwindApp({ deviceNumber: "PHX-TAB-0007", packageName: "com.whatsapp" }, "B-10", stub.fetch, ENV),
    (error: unknown) =>
      error instanceof HeadwindAppInputError && /Rep tablets — Pedia/.test(error.message) && /install it again/.test(error.message),
    "🔴 an app the tablet's own rules install is refused, naming the rules — it would be back at the next check-in",
  );
  assert.equal(stub.api("POST", "/rest/private/push").length, 0, "and no uninstall was pushed");

  const unknownRules = server({
    "POST /rest/private/devices/search": ok({ devices: { items: [{ id: 7, number: "PHX-TAB-0007" }] } }),
  });
  await assert.rejects(
    () => removeHeadwindApp({ deviceNumber: "PHX-TAB-0007", packageName: "com.whatsapp" }, "B-10", unknownRules.fetch, ENV),
    HeadwindAppInputError,
    "rules that cannot be told are not read as 'not on the rules'",
  );
  assert.equal(unknownRules.api("POST", "/rest/private/push").length, 0);
}

/* ── the doors: route, script, page ── */

export async function routesScriptAndPageCarryTheFixes() {
  assert.deepEqual(headwindUploadLengthDecision(null), {
    message: "The upload did not say how large it is, so it was not read. Send it again from the page.",
    ok: false,
    status: 411,
  });
  assert.equal((headwindUploadLengthDecision(String(HEADWIND_MAX_UPLOAD_REQUEST_BYTES + 1)) as { status: number }).status, 413, "🔴 an oversized body is refused before it is buffered");
  assert.equal((headwindUploadLengthDecision("12abc") as { status: number }).status, 400);
  assert.deepEqual(headwindUploadLengthDecision(String(HEADWIND_MAX_UPLOAD_REQUEST_BYTES)), { ok: true });

  const upload = stripComments(source("app/api/devices/headwind/upload/route.ts"));
  const permission = upload.indexOf('assertPermission(access, "company_devices", "approve")');
  const length = upload.indexOf('headwindUploadLengthDecision(request.headers.get("content-length"))');
  const body = upload.indexOf(".formData()");
  assert.ok(permission > 0 && permission < length && length < body, "the length is read after the permission and before the body");
  assert.match(upload, /value\.trim\(\) === "rep"\) return "rep"/, "the upload takes every rep set");
  assert.match(upload, /throw new HeadwindUploadError\("That is not a set of tablet rules/, "and refuses rules it cannot read rather than skipping the link");

  const configurations = stripComments(source("app/api/devices/headwind/configurations/route.ts"));
  assert.doesNotMatch(configurations, /payload\.action === 2 \? payload\.action : 1/, "🔴 an unknown action no longer becomes INSTALL");
  assert.match(configurations, /payload\.action === "hide"/, "hide is its own word");
  assert.match(configurations, /params\.get\("view"\) === "install-links"/, "the install-link check has its read");

  const script = stripComments(source("scripts/headwind-push-apk.ts"));
  assert.doesNotMatch(script, /\?\? "3"/, "🔴 the push script has no default set of rules");
  assert.match(script, /configArg\.trim\(\) === "rep"/, "it takes every rep set");
  assert.match(script, /split\(","\)/, "or a comma list");

  const page = stripComments(source("src/components/devices/headwind-server-settings.tsx"));
  assert.match(page, /view=install-links&configurationId=\$\{configurationId\}&round=\$\{round\}/, "each rep set shows its install links, re-checkable");
  assert.match(page, /cairoDateTime\(read\.data\.checkedAt\)/, "with the time of the check in Cairo");
  assert.match(page, /<InstallLinksBlock configurationId=\{configuration\.id\} \/>/);
  assert.match(page, /table-fixed/, "a desktop table that fits");
  assert.match(page, /md:hidden/, "and cards on a phone");
  assert.match(page, /body\.get\("reach"\) === "rep" \? "rep"/, "the upload offers every rep tablet");
  assert.doesNotMatch(page, /rounded/, "square corners");
}

/* ── the console-logins list on the same page ── */

export async function consoleLoginsListOffersNoRemoveOnTheBridgeLogin() {
  const page = stripComments(source("src/components/devices/headwind-server-settings.tsx"));
  // 🔴 The console-logins list offered Remove beside the bridge's own login, whose removal cuts Phoenix
  // off from every tablet; and it showed "switched off" from an `enabled` field the server's users lack.
  assert.match(
    page,
    /\{user\.removable === false \? \(\s*<span[^>]*>\s*Phoenix signs in with this login, so it cannot be removed here\./,
    "🔴 no Remove beside the login Phoenix signs in with — a plain reason instead",
  );
  assert.doesNotMatch(page, /\benabled\b/, "and no state the server never reports");
}

export async function runHeadwindInstallLinksTests() {
  await listAndDeviceReadsRefuseUnreadableReplies();
  await installLinkCheckMeetsLinksAsATabletDoes();
  await versionLinksStepRefusesWhenItDidNothing();
  await uploadReachesEveryRepSetWithOneAuditRowEach();
  await uploadAuditsTheRegistrationEvenWhenTheHttpsStepRefuses();
  await anUpgradeTheServerAnswersWithAnotherVersionIsSaidNotRefused();
  await uploadRefusesWhatCannotWork();
  await linkRefusesADeadLinkAndHidesProperly();
  await linkToEveryRepSetSaysWhichItMissed();
  await removalTheRulesWouldUndoIsRefused();
  await routesScriptAndPageCarryTheFixes();
  await consoleLoginsListOffersNoRemoveOnTheBridgeLogin();
}
