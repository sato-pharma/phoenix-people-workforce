import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import type { AuditLogInput } from "../src/lib/admin/audit.ts";
import {
  headwindActionCatalogue,
  headwindAddonInstalled,
  takeHeadwindAction,
  HeadwindActionError,
} from "../src/lib/devices/headwind/actions.ts";
import { HeadwindAppInputError } from "../src/lib/devices/headwind/apps.ts";
import { HeadwindNotConfiguredError, headwindPasswordHash, resetHeadwindTokenCache } from "../src/lib/devices/headwind/auth.ts";
import { callHeadwind, HeadwindRequestError } from "../src/lib/devices/headwind/client.ts";
import { HeadwindCommandUnconfirmedError } from "../src/lib/devices/headwind/commands.ts";
import { HeadwindConfigurationError } from "../src/lib/devices/headwind/configurations.ts";
import { HeadwindDeviceNotFoundError } from "../src/lib/devices/headwind/devices.ts";
import { HeadwindEnrollmentError } from "../src/lib/devices/headwind/enrollment.ts";
import { headwindErrorResponse } from "../src/lib/devices/headwind/http.ts";
import { HeadwindLocationError } from "../src/lib/devices/headwind/locations.ts";
import { HeadwindRemoteScreenIdError } from "../src/lib/devices/headwind/remote-screen-id.ts";
import { HeadwindCommandInputError } from "../src/lib/devices/headwind/target.ts";
import { HeadwindUploadError } from "../src/lib/devices/headwind/uploads.ts";
import {
  createHeadwindConsoleUser,
  getHeadwindConsoleUsers,
  removeHeadwindConsoleUser,
  HeadwindUserError,
} from "../src/lib/devices/headwind/users.ts";
import { wipeHeadwindDevice, HeadwindWipeError } from "../src/lib/devices/headwind/wipe.ts";
import { RustDeskNotConfiguredError } from "../src/lib/devices/rustdesk/config.ts";

/**
 * The Headwind sign-in, the console logins, the custody actions, the wipe and the error mapping —
 * the 9 Nov 2026 audit of the tablet bridge (stream: sign-in, client, users, custody actions).
 *
 * Every test here runs against a stub `fetch` routed by method and path. No network, no Headwind, no
 * database: the audit writer is handed in, so the row each act writes can be read here.
 */

const ENV = {
  HEADWIND_MDM_BASE_URL: "https://mdm.test.local",
  HEADWIND_MDM_LOGIN: "phoenix",
  HEADWIND_MDM_PASSWORD: "a-real-password",
} as unknown as NodeJS.ProcessEnv;

const NEW_PASSWORD = "Correct-Horse-Battery-9";
// Headwind's own login wire format (UPPER-CASE MD5), through Phoenix's one encoder — which
// `tests/headwind-bridge.test.ts` pins against an independent hash.
const NEW_PASSWORD_WIRE = headwindPasswordHash(NEW_PASSWORD);

/** A reply: JSON (`body`), a reply that is not JSON (`notJson`), or a fetch that throws. */
type Reply = { status: number; body?: unknown; notJson?: true } | { throws: Error };
type Call = { method: string; path: string; body: string | null };
type Route = (call: Call, nth: number) => Reply | undefined;

const ok = (data?: unknown): Reply => ({ body: data === undefined ? { status: "OK" } : { data, status: "OK" }, status: 200 });

function timeoutError(): Error {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

/**
 * A `fetch` routed by method and path. The sign-in answers a token unless `login` says otherwise;
 * each API call asks `route`, which gets the call and how many times that same method+path has been
 * asked before. A call nothing answers is a 599 the assertions will show, never a silent success.
 */
function stubFetch(route: Route, login: Reply = { body: { id_token: "jwt-1" }, status: 200 }) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const call: Call = {
      body: typeof init.body === "string" ? init.body : null,
      method: String(init.method ?? "GET").toUpperCase(),
      path: url.pathname,
    };
    calls.push(call);
    const key = `${call.method} ${call.path}`;
    const nth = counts.get(key) ?? 0;
    counts.set(key, nth + 1);
    const reply = call.path === "/rest/public/jwt/login" ? login : route(call, nth) ?? { body: { message: `unrouted ${key}` }, status: 599 };
    if ("throws" in reply) throw reply.throws;
    return {
      json: async () => {
        if (reply.notJson) throw new SyntaxError("Unexpected token < in JSON");
        return reply.body;
      },
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchImpl };
}

function auditRecorder() {
  const rows: AuditLogInput[] = [];
  const write = (async (input: AuditLogInput) => {
    rows.push(input);
  }) as unknown as typeof import("../src/lib/admin/audit.ts").writeRequiredAuditLog;
  return { rows, write };
}

const ROLES = [
  { id: 1, name: "Admin" },
  { id: 2, name: "User" },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// F14 — console logins follow the contract the bootstrap MEASURED, and are read back before success.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
async function runConsoleLoginContractTests() {
  resetHeadwindTokenCache();
  const audit = auditRecorder();
  const created = { id: 9, login: "omar.g", name: "Omar", passwordReset: false, userRole: { id: 2, name: "User" } };
  const server = stubFetch((call, nth) => {
    if (call.method === "GET" && call.path === "/rest/private/users/roles") return ok(ROLES);
    if (call.method === "GET" && call.path === "/rest/private/users/all") return ok(nth === 0 ? [] : [created]);
    if (call.method === "PUT" && call.path === "/rest/private/users") return ok();
    return undefined;
  });
  const result = await createHeadwindConsoleUser(
    { email: " ", login: " omar.g ", name: "Omar", password: NEW_PASSWORD, roleId: 2 },
    "B-10",
    server.fetch,
    ENV,
    audit.write,
  );

  // BREAK-TEST (F14 paths): put back "/rest/private/roles" and "/rest/private/users/search/" in users.ts
  // and this deepEqual fires with the two dead paths in place of the measured ones.
  const apiCalls = server.calls.filter((call) => call.path !== "/rest/public/jwt/login");
  assert.deepEqual(
    apiCalls.map((call) => `${call.method} ${call.path}`).sort(),
    ["GET /rest/private/users/all", "GET /rest/private/users/all", "GET /rest/private/users/roles", "PUT /rest/private/users"].sort(),
    "roles from /users/roles, the list from /users/all (read before AND after), the create as PUT /users — the bootstrap's measured paths",
  );

  // BREAK-TEST (F14 body): put back `newPassword: input.password` and `userRoleId: input.roleId` and
  // these fire — the password arrives as itself and the role as a key the server's User has no field for.
  const put = JSON.parse(String(apiCalls.find((call) => call.method === "PUT")!.body)) as Record<string, unknown>;
  assert.equal(put.newPassword, NEW_PASSWORD_WIRE, "the new password goes up as its UPPER-CASE MD5, as the console and the bootstrap send it");
  assert.equal(put.confirmModal, NEW_PASSWORD_WIRE, "and confirmModal carries the same hash");
  assert.deepEqual(put.userRole, { id: 2 }, "the role is userRole: { id } — the server's User has no userRoleId");
  assert.equal("userRoleId" in put, false, "and no userRoleId key is sent");
  assert.equal("id" in put, false, "no id, so the server CREATES rather than updates someone");
  assert.equal(put.login, "omar.g");
  assert.equal(put.allDevicesAvailable, true);
  assert.equal(put.allConfigAvailable, true);
  assert.equal("email" in put, false, "a blank email is not sent");
  for (const call of server.calls) {
    assert.ok(!String(call.body ?? "").includes(NEW_PASSWORD), `${call.method} ${call.path} never carries the password itself`);
  }

  assert.match(result.message, /omar\.g is on the tablet server as User/, "success names the login and the role the server now holds");
  assert.doesNotMatch(result.message, /can now sign in/, "and no longer claims a sign-in nobody watched");
  assert.ok(!result.message.includes(NEW_PASSWORD) && !result.message.includes(NEW_PASSWORD_WIRE), "the reply never carries the password or its hash");
  assert.equal(audit.rows.length, 1, "one required audit row");
  const row = JSON.stringify(audit.rows[0]);
  assert.ok(!row.includes(NEW_PASSWORD) && !row.includes(NEW_PASSWORD_WIRE), "the audit row never carries the password or its hash");
  assert.equal(audit.rows[0].newValues?.confirmedOnServer, true, "and it records that the server holds the login");
  assert.equal(audit.rows[0].entityType, "headwind_user");

  // BREAK-TEST (read-back): delete the read-back in createHeadwindConsoleUser (return success after the
  // PUT) and this resolves instead of rejecting — the "can sign in" claim about a login that is not there.
  resetHeadwindTokenCache();
  const ghost = auditRecorder();
  const neverSaved = stubFetch((call) => {
    if (call.path === "/rest/private/users/roles") return ok(ROLES);
    if (call.path === "/rest/private/users/all") return ok([]);
    if (call.method === "PUT") return ok();
    return undefined;
  });
  await assert.rejects(
    () => createHeadwindConsoleUser({ login: "omar.g", password: NEW_PASSWORD, roleId: 2 }, "B-10", neverSaved.fetch, ENV, ghost.write),
    (error: unknown) => error instanceof HeadwindRequestError && error.status === 502 && /no login named omar\.g is on it/.test(error.message),
    "an OK envelope with no login on the list read back is a failure, never a success",
  );
  assert.equal(ghost.rows[0]?.newValues?.confirmedOnServer, false, "and the audit row says the server did not hold it");

  resetHeadwindTokenCache();
  const wrongRole = stubFetch((call, nth) => {
    if (call.path === "/rest/private/users/roles") return ok(ROLES);
    if (call.path === "/rest/private/users/all") return ok(nth === 0 ? [] : [{ ...created, userRole: { id: 1, name: "Admin" } }]);
    if (call.method === "PUT") return ok();
    return undefined;
  });
  await assert.rejects(
    () => createHeadwindConsoleUser({ login: "omar.g", password: NEW_PASSWORD, roleId: 2 }, "B-10", wrongRole.fetch, ENV, auditRecorder().write),
    (error: unknown) => error instanceof HeadwindRequestError && /as Admin, not User/.test(error.message),
    "a login the server holds under another role is reported as exactly that",
  );

  resetHeadwindTokenCache();
  const mustChange = stubFetch((call, nth) => {
    if (call.path === "/rest/private/users/roles") return ok(ROLES);
    if (call.path === "/rest/private/users/all") return ok(nth === 0 ? [] : [{ ...created, passwordReset: true }]);
    if (call.method === "PUT") return ok();
    return undefined;
  });
  const resetFirst = await createHeadwindConsoleUser({ login: "omar.g", password: NEW_PASSWORD, roleId: 2 }, "B-10", mustChange.fetch, ENV, auditRecorder().write);
  assert.match(resetFirst.message, /ask them to choose a new password the first time they sign in/, "a server set to demand a first-sign-in change says so");

  // Refused before the write: a role the server does not have, a login already there, and the server's
  // own duplicate key in words.
  resetHeadwindTokenCache();
  const preflight = stubFetch((call) => {
    if (call.path === "/rest/private/users/roles") return ok(ROLES);
    if (call.path === "/rest/private/users/all") return ok([{ id: 4, login: "taken", userRole: { id: 2 } }]);
    if (call.method === "PUT") return { body: { message: "error.duplicate.login", status: "ERROR" }, status: 200 };
    return undefined;
  });
  await assert.rejects(
    () => createHeadwindConsoleUser({ login: "omar.g", password: NEW_PASSWORD, roleId: 77 }, "B-10", preflight.fetch, ENV, auditRecorder().write),
    (error: unknown) => error instanceof HeadwindUserError && /not one the tablet server has/.test(error.message),
    "a role id the server did not list is refused before anything is written",
  );
  await assert.rejects(
    () => createHeadwindConsoleUser({ login: "taken", password: NEW_PASSWORD, roleId: 2 }, "B-10", preflight.fetch, ENV, auditRecorder().write),
    (error: unknown) => error instanceof HeadwindUserError && /already on the tablet server/.test(error.message),
    "a login already on the list is refused before a create that would collide",
  );
  assert.equal(preflight.calls.some((call) => call.method === "PUT"), false, "neither refusal reached the write");
  await assert.rejects(
    () => createHeadwindConsoleUser({ login: "racer", password: NEW_PASSWORD, roleId: 2 }, "B-10", preflight.fetch, ENV, auditRecorder().write),
    (error: unknown) => error instanceof HeadwindUserError && /already on the tablet server/.test(error.message) && !/error\.duplicate/.test(error.message),
    "the server's own duplicate key reaches the person in words, never as error.duplicate.login",
  );

  // The list reads the role the server's way: `userRole: { id, name }`.
  resetHeadwindTokenCache();
  const listing = stubFetch((call) => {
    if (call.path === "/rest/private/users/roles") return ok(ROLES);
    if (call.path === "/rest/private/users/all") return ok([{ id: 3, login: "zoe", userRole: { id: 1, name: "Admin" } }]);
    return undefined;
  });
  const read = await getHeadwindConsoleUsers(listing.fetch, ENV);
  assert.equal(read.users[0]?.roleName, "Admin", "a role given as userRole: { id } is resolved to its name");
  assert.equal(read.users[0]?.roleId, 1);
  assert.equal(read.roles.length, 2, "and the roles come from /users/roles");
}

async function runConsoleLoginRemovalTests() {
  // BREAK-TEST (removal path): put back `/rest/private/users/${id}` and the DELETE below goes to a path
  // the server has no DELETE on — the assertion on the path fires.
  resetHeadwindTokenCache();
  const audit = auditRecorder();
  const zoe = { id: 5, login: "zoe", userRole: { id: 2, name: "User" } };
  const server = stubFetch((call, nth) => {
    if (call.method === "GET" && call.path === "/rest/private/users/all") return ok(nth === 0 ? [zoe] : []);
    if (call.method === "DELETE" && call.path === "/rest/private/users/other/5") return ok();
    return undefined;
  });
  const removed = await removeHeadwindConsoleUser({ login: "somebody-else", userId: 5 }, "B-10", server.fetch, ENV, audit.write);
  assert.ok(server.calls.some((call) => call.method === "DELETE" && call.path === "/rest/private/users/other/5"), "removal is DELETE /users/other/{id}, upstream's path");
  assert.match(removed.message, /^zoe is no longer on the tablet server's list of logins/, "the reply names the login the SERVER holds under that id");
  assert.equal(audit.rows[0]?.oldValues?.login, "zoe", "and so does the audit row — never the name the browser sent");

  // BREAK-TEST (self-removal): delete the bridge-login refusal in removeHeadwindConsoleUser and both of
  // these reach the DELETE — Phoenix removing the one login it signs in with.
  resetHeadwindTokenCache();
  const self = stubFetch((call) => {
    if (call.path === "/rest/private/users/all") {
      return ok([
        { editable: false, id: 1, login: "phoenix", userRole: { id: 1 } },
        { editable: false, id: 2, login: "the-current-session", userRole: { id: 1 } },
      ]);
    }
    if (call.method === "DELETE") return ok();
    return undefined;
  });
  for (const userId of [1, 2]) {
    await assert.rejects(
      () => removeHeadwindConsoleUser({ login: "", userId }, "B-10", self.fetch, ENV, auditRecorder().write),
      (error: unknown) => error instanceof HeadwindUserError && /Phoenix itself signs in/.test(error.message),
      "the bridge's own login (by HEADWIND_MDM_LOGIN, or the server's editable: false) is never removed from here",
    );
  }
  assert.equal(self.calls.some((call) => call.method === "DELETE"), false, "and no DELETE was sent");

  resetHeadwindTokenCache();
  const sticky = stubFetch((call) => {
    if (call.path === "/rest/private/users/all") return ok([zoe]);
    if (call.method === "DELETE") return ok();
    return undefined;
  });
  const stickyAudit = auditRecorder();
  await assert.rejects(
    () => removeHeadwindConsoleUser({ login: "zoe", userId: 5 }, "B-10", sticky.fetch, ENV, stickyAudit.write),
    (error: unknown) => error instanceof HeadwindRequestError && /still on its list/.test(error.message),
    "an OK that leaves the login on the list is reported as still there",
  );
  assert.equal(stickyAudit.rows[0]?.newValues?.stillOnServer, true);

  resetHeadwindTokenCache();
  const gone = stubFetch((call) => (call.path === "/rest/private/users/all" ? ok([]) : undefined));
  await assert.rejects(
    () => removeHeadwindConsoleUser({ login: "zoe", userId: 5 }, "B-10", gone.fetch, ENV, auditRecorder().write),
    HeadwindUserError,
    "a login no longer on the list is not 'removed' again",
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// F16 — only a 404 means the add-on is absent.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
async function runAddonProbeTests() {
  // BREAK-TEST: put back `catch { return false; }` in headwindAddonInstalled and these resolve to
  // false — a box that is down reads as "rebuild it without the add-on".
  for (const [reply, because] of [
    [{ body: { message: "Bad gateway" }, status: 502 } as Reply, "a 502 from the box"],
    [{ throws: timeoutError() } as Reply, "a timeout"],
    [{ status: 403, notJson: true } as Reply, "a Cloudflare Access refusal"],
  ] as const) {
    resetHeadwindTokenCache();
    const stub = stubFetch((call) => (call.path.endsWith("/phoenix-actions/private/status") ? reply : undefined));
    await assert.rejects(
      () => headwindAddonInstalled(stub.fetch, ENV),
      HeadwindRequestError,
      `${because} surfaces as itself, never as "the add-on is not installed"`,
    );
  }
  resetHeadwindTokenCache();
  const catalogueDown = stubFetch((call) => (call.path.endsWith("/status") ? { body: { message: "down" }, status: 503 } : undefined));
  await assert.rejects(() => headwindActionCatalogue(catalogueDown.fetch, ENV), HeadwindRequestError, "and the catalogue says the server failed, not that four actions need a rebuild");

  resetHeadwindTokenCache();
  const absent = stubFetch((call) => (call.path.endsWith("/status") ? { body: { message: "Not Found" }, status: 404 } : undefined));
  assert.equal(await headwindAddonInstalled(absent.fetch, ENV), false, "a 404 is the one answer that means the add-on is not there");
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// F17 — only a missing setting is "not configured"; a server that answered is a request error.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
async function runSignInFailureTests() {
  // BREAK-TEST: delete the `response.status >= 500` branch in mintHeadwindToken and the 503 below comes
  // back as a credential refusal (401) — the server's failure blamed on the password.
  for (const [login, because] of [
    [{ body: { message: "Service Unavailable" }, status: 503 } as Reply, "a 503 with a JSON body"],
    [{ status: 500, notJson: true } as Reply, "a Tomcat 500 page"],
  ] as const) {
    resetHeadwindTokenCache();
    const stub = stubFetch(() => ok({}), login);
    await assert.rejects(
      () => callHeadwind("/rest/private/devices/search", { method: "POST" }, stub.fetch, ENV),
      (error: unknown) =>
        error instanceof HeadwindRequestError &&
        !(error instanceof HeadwindNotConfiguredError) &&
        error.status === 502 &&
        /failed while signing Phoenix in/.test(error.message) &&
        !/HEADWIND_MDM_PASSWORD/.test(error.message),
      `${because} at sign-in is the server failing, not a missing setting and not the password`,
    );
    resetHeadwindTokenCache();
    const response = headwindErrorResponse(
      await callHeadwind("/rest/private/devices/search", {}, stubFetch(() => ok({}), login).fetch, ENV).catch((error: unknown) => error),
      "fallback",
    );
    assert.equal(response.status, 502, "the route answers 502");
    assert.equal(((await response.json()) as { setupRequired?: unknown }).setupRequired, undefined, "and never draws the 'connect the bridge' setup state");
  }

  // A 200 page that is not JSON is not Headwind refusing a password.
  resetHeadwindTokenCache();
  const htmlOk = stubFetch(() => ok({}), { status: 200, notJson: true });
  await assert.rejects(
    () => callHeadwind("/rest/private/devices/search", {}, htmlOk.fetch, ENV),
    (error: unknown) =>
      error instanceof HeadwindRequestError && /not Headwind's/.test(error.message) && /HEADWIND_MDM_BASE_URL/.test(error.message) && !/refused the Phoenix sign-in/.test(error.message),
    "a 200 HTML answer names the address and Access, never the login and password",
  );

  // A refused credential is the server answering: a request error, 401.
  resetHeadwindTokenCache();
  const refused = stubFetch(() => ok({}), { body: { message: "Wrong password", status: "ERROR" }, status: 200 });
  await assert.rejects(
    () => callHeadwind("/rest/private/devices/search", {}, refused.fetch, ENV),
    (error: unknown) => error instanceof HeadwindRequestError && error.status === 401 && /HEADWIND_MDM_PASSWORD/.test(error.message),
    "a refused credential is a 401 request error that still names the two settings to check",
  );

  // And a missing setting is still exactly that.
  resetHeadwindTokenCache();
  const missing = await callHeadwind("/x", {}, stubFetch(() => ok({})).fetch, {} as NodeJS.ProcessEnv).catch((error: unknown) => error);
  assert.ok(missing instanceof HeadwindNotConfiguredError, "no credential at all is the one not-configured case");
  assert.equal(headwindErrorResponse(missing, "fallback").status, 400);

  // BREAK-TEST: delete signInTimeoutError's branch in mintHeadwindToken and this message becomes "The
  // request may have reached Headwind and taken effect — check the device before repeating it", about
  // a lock that was never sent.
  resetHeadwindTokenCache();
  const slowSignIn = stubFetch(() => ok({}), { throws: timeoutError() });
  await assert.rejects(
    () => callHeadwind(`/rest/plugins/phoenix-actions/private/action`, { body: "{}", method: "POST" }, slowSignIn.fetch, ENV),
    (error: unknown) =>
      error instanceof HeadwindRequestError &&
      error.status === 504 &&
      /Nothing else was sent/.test(error.message) &&
      !/may have reached Headwind and taken effect/.test(error.message),
    "a sign-in that timed out says no action was sent — never that the action may have taken effect",
  );
  assert.equal(slowSignIn.calls.some((call) => call.path.includes("/phoenix-actions/")), false, "and indeed the action was never sent");

  // BREAK-TEST: put back the unconditional Cloudflare sentence in messageFromBody and this 500 with no
  // body is blamed on two Access variables that are not even set.
  resetHeadwindTokenCache();
  const emptyFiveHundred = stubFetch(() => ({ status: 500, notJson: true }));
  await assert.rejects(
    () => callHeadwind("/rest/plugins/phoenix-actions/private/action", { body: "{}", method: "POST" }, emptyFiveHundred.fetch, ENV),
    (error: unknown) => error instanceof HeadwindRequestError && /failed \(HTTP 500\)/.test(error.message) && !/Cloudflare|ACCESS_CLIENT/.test(error.message),
    "a 5xx with no body is the server failing, not a Cloudflare sign-in page",
  );
  resetHeadwindTokenCache();
  const behindAccess = { ...ENV, HEADWIND_MDM_ACCESS_CLIENT_ID: "id", HEADWIND_MDM_ACCESS_CLIENT_SECRET: "the-secret" } as unknown as NodeJS.ProcessEnv;
  const accessPage = stubFetch(() => ({ status: 403, notJson: true }));
  await assert.rejects(
    () => callHeadwind("/rest/private/devices/search", {}, accessPage.fetch, behindAccess),
    (error: unknown) => error instanceof HeadwindRequestError && /HEADWIND_MDM_ACCESS_CLIENT_ID/.test(error.message) && !error.message.includes("the-secret"),
    "with a service token set, a non-JSON 403 still names the Access door — and never prints the secret",
  );
  resetHeadwindTokenCache();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// F15 — every error class in the module maps to a status that is not the generic 500.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
function runErrorMappingSweepTests() {
  // BREAK-TEST: take HeadwindRemoteScreenIdError out of http.ts and this fires with 500.
  assert.equal(headwindErrorResponse(new HeadwindRemoteScreenIdError("that is a sentence"), "fallback").status, 400, "a bad remote screen ID is the person's typo — 400, not 500");

  const mapped: Array<[Error, number]> = [
    [new HeadwindActionError("x"), 400],
    [new HeadwindAppInputError("x"), 400],
    [new HeadwindNotConfiguredError("x"), 400],
    [new HeadwindRequestError(500, "x"), 502],
    [new HeadwindCommandUnconfirmedError("x"), 501],
    [new HeadwindConfigurationError("x"), 400],
    [new HeadwindDeviceNotFoundError("x"), 400],
    [new HeadwindEnrollmentError("x"), 400],
    [new HeadwindLocationError("x"), 400],
    [new HeadwindRemoteScreenIdError("x"), 400],
    [new HeadwindCommandInputError("x"), 400],
    [new HeadwindUploadError("x"), 400],
    [new HeadwindUserError("x"), 400],
    [new HeadwindWipeError("x"), 400],
    [new HeadwindWipeError("x", true), 502],
    [new RustDeskNotConfiguredError("x"), 400],
  ];
  for (const [error, status] of mapped) {
    assert.equal(headwindErrorResponse(error, "fallback").status, status, `${error.name} answers ${status}`);
  }

  // And the sweep is held against the source: a NEW error class in the module that http.ts does not
  // name falls to 500 — refused here, by name, the day it is added.
  const dir = new URL("../src/lib/devices/headwind/", import.meta.url);
  const declared = readdirSync(dir)
    .filter((file) => file.endsWith(".ts"))
    .flatMap((file) => [...readFileSync(new URL(file, dir), "utf8").matchAll(/export class (\w+) extends Error/g)].map((match) => match[1]));
  const http = readFileSync(new URL("http.ts", dir), "utf8");
  assert.ok(declared.length >= 14, "the sweep found the module's error classes");
  for (const name of declared) {
    assert.ok(new RegExp(`instanceof ${name}\\b`).test(http), `${name} is mapped in http.ts, so it never answers the generic 500`);
  }
  assert.deepEqual(
    [...new Set(mapped.map(([error]) => error.name))].sort(),
    [...new Set([...declared, "RustDeskNotConfiguredError"])].sort(),
    "every declared class has a status pinned above",
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Custody actions — the reply and the audit row say what Phoenix did (queued), not what nobody saw.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const FLEET = ok({ items: [{ id: 7, number: "PHX-TAB-0007" }] });

function addonBox() {
  return stubFetch((call) => {
    if (call.path === "/rest/private/devices/search") return FLEET;
    if (call.path.endsWith("/phoenix-actions/private/status")) return { body: { actions: [], ready: true }, status: 200 };
    if (call.path.endsWith("/phoenix-actions/private/action")) return { body: { confirmed: false, queued: true, status: "OK" }, status: 200 };
    return undefined;
  });
}

async function runCustodyWordingTests() {
  // BREAK-TEST: put back "will lock at its next check-in, usually within a minute or two" and the
  // pastTense "Locked" and these fire.
  for (const [action, message, summary] of [
    ["LOCK", null, /^Queued a lock for /],
    ["LOST_MODE_ON", "Call 0100 000 0000 to return it", /^Queued lost mode for /],
    ["UNLOCK", null, /^Queued an unlock for /],
    ["FACTORY_RESET", null, /^Queued a factory reset for /],
  ] as const) {
    resetHeadwindTokenCache();
    const audit = auditRecorder();
    const box = addonBox();
    const result = await takeHeadwindAction({ action, deviceNumber: "PHX-TAB-0007", message }, "B-10", box.fetch, ENV, audit.write);
    assert.doesNotMatch(result.message, /minute or two|usually within/, `${action}: no timing nobody measured`);
    assert.match(result.message, /queued/i, `${action}: the reply says it is queued`);
    assert.match(result.message, /has not seen/, `${action}: and that Phoenix has not seen the tablet do it`);
    assert.match(audit.rows[0]?.summary ?? "", summary, `${action}: the command history says queued, never done`);
    assert.doesNotMatch(audit.rows[0]?.summary ?? "", /^(Locked|Unlocked|Put lost mode on|Factory reset) /, `${action}: no past-tense effect in the audit row`);
  }

  // The impossible stays refused, before the network.
  const untouched = stubFetch(() => undefined);
  await assert.rejects(
    () => takeHeadwindAction({ action: "SHUT_DOWN", deviceNumber: "PHX-TAB-0007" }, "B-10", untouched.fetch, ENV, auditRecorder().write),
    HeadwindActionError,
  );
  assert.equal(untouched.calls.length, 0, "shut down never reaches the network");

  // The screen-lock PIN is in the reply once and never in the audit row.
  resetHeadwindTokenCache();
  const pinAudit = auditRecorder();
  const pinBox = addonBox();
  const reset = await takeHeadwindAction({ action: "RESET_SCREEN_LOCK", deviceNumber: "PHX-TAB-0007" }, "B-10", pinBox.fetch, ENV, pinAudit.write);
  const pin = /PIN (\d{6})/.exec(reset.message)?.[1];
  assert.ok(pin, "the PIN is shown once in the reply");
  assert.ok(!JSON.stringify(pinAudit.rows).includes(pin!), "and never written into the audit row");
  resetHeadwindTokenCache();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The corporate wipe — how far it got, told honestly in the row and the sentence.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
function wipeBox(pushReply: (nth: number) => Reply) {
  return stubFetch((call, nth) => {
    if (call.path === "/rest/private/devices/search") return FLEET;
    if (call.method === "POST" && call.path === "/rest/private/push") return pushReply(nth);
    return undefined;
  });
}

async function runWipeAccountingTests() {
  // BREAK-TEST (nothing sent): put back the single "Erased part of the company's data … N of 4" summary
  // and this row reads as a part-erasure that never happened.
  resetHeadwindTokenCache();
  const firstRefused = auditRecorder();
  await assert.rejects(
    () =>
      wipeHeadwindDevice(
        { deviceNumber: "PHX-TAB-0007" },
        "B-10",
        wipeBox(() => ({ body: { message: "error.notfound.device", status: "ERROR" }, status: 200 })).fetch,
        ENV,
        firstRefused.write,
      ),
    (error: unknown) => error instanceof HeadwindRequestError && !(error instanceof HeadwindWipeError) && /Nothing was erased/.test(error.message),
    "a refusal of the FIRST instruction says nothing was erased — it is not a partial wipe",
  );
  assert.match(firstRefused.rows[0]?.summary ?? "", /^Tried to erase .* nothing was sent$/, "and the tablet's history says nothing was sent");
  assert.deepEqual(firstRefused.rows[0]?.newValues?.sent, []);
  assert.equal(firstRefused.rows[0]?.newValues?.completed, false);

  // BREAK-TEST (uncertain): drop `uncertain` from the catch in wipeHeadwindDevice and the timed-out step
  // is reported as "not sent" — when the server may have taken it.
  resetHeadwindTokenCache();
  const timedOut = auditRecorder();
  await assert.rejects(
    () =>
      wipeHeadwindDevice(
        { deviceNumber: "PHX-TAB-0007" },
        "B-10",
        wipeBox((nth) => (nth === 0 ? ok() : { throws: timeoutError() })).fetch,
        ENV,
        timedOut.write,
      ),
    (error: unknown) =>
      error instanceof HeadwindWipeError && error.partial && /cleared Chrome\), so that one may or may not have been taken/.test(error.message),
    "a step that timed out is named as uncertain, never as not sent",
  );
  assert.deepEqual(timedOut.rows[0]?.newValues?.sent, ["cleared the Phoenix app"], "the row lists what the server took");
  assert.equal(timedOut.rows[0]?.newValues?.uncertain, "cleared Chrome", "and the step that may or may not have landed");
  assert.match(timedOut.rows[0]?.summary ?? "", /may or may not have reached it/);

  resetHeadwindTokenCache();
  const halfway = auditRecorder();
  await assert.rejects(
    () =>
      wipeHeadwindDevice(
        { deviceNumber: "PHX-TAB-0007" },
        "B-10",
        wipeBox((nth) => (nth < 2 ? ok() : { body: { message: "refused", status: "ERROR" }, status: 200 })).fetch,
        ENV,
        halfway.write,
      ),
    (error: unknown) => error instanceof HeadwindWipeError && error.partial && /took 2 of the 4 instructions/.test(error.message),
    "a true partial is still a partial, with the count",
  );
  assert.equal(halfway.rows[0]?.newValues?.uncertain, null, "a refusal is certain — nothing uncertain to name");
  assert.equal(headwindErrorResponse(new HeadwindWipeError("x", true), "f").status, 502);

  resetHeadwindTokenCache();
  const whole = auditRecorder();
  const done = await wipeHeadwindDevice({ deviceNumber: "PHX-TAB-0007" }, "B-10", wipeBox(() => ok()).fetch, ENV, whole.write);
  assert.equal(done.sent.length, 4, "a whole wipe sends all four");
  assert.equal(whole.rows[0]?.newValues?.completed, true);
  resetHeadwindTokenCache();
}

function runRouteOrderTests() {
  // CSRF first, then the permission, on every write route of this stream — before any body is read.
  for (const route of ["users", "actions", "wipe", "imei"]) {
    const text = readFileSync(new URL(`../app/api/devices/headwind/${route}/route.ts`, import.meta.url), "utf8");
    const post = text.slice(text.indexOf("export async function POST"));
    const csrf = post.indexOf("assertSameOriginMutation(request)");
    const permission = post.indexOf('assertPermission(access, "company_devices", "approve")');
    const body = post.indexOf("request.json(");
    assert.ok(csrf > 0 && permission > csrf, `${route}: same-origin is checked before the permission`);
    assert.ok(body === -1 || body > permission, `${route}: and the body is read only after both`);
  }
}

export async function runHeadwindUsersActionsTests() {
  await runConsoleLoginContractTests();
  await runConsoleLoginRemovalTests();
  await runAddonProbeTests();
  await runSignInFailureTests();
  runErrorMappingSweepTests();
  await runCustodyWordingTests();
  await runWipeAccountingTests();
  runRouteOrderTests();
}
