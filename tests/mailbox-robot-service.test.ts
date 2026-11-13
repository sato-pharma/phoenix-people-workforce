import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createTurbifyConsoleDriver } from "../src/lib/mailbox-offboarding/robot/turbify-console.ts";
import { parseRobotActor } from "../src/lib/new-hire-mailbox/robot/actions/actor.ts";
import { forwardToRobotService, ROBOT_ACTIONS, robotActionPath } from "../src/lib/new-hire-mailbox/robot/actions/forward.ts";
import { createJoinerDriverFromEnv } from "../src/lib/new-hire-mailbox/robot/sweep-deps.ts";
import { resolveProcessRole, robotOnlyRouteRefusal, runsBackgroundJobs, workerOnlyRouteRefusal } from "../src/lib/platform/process-role.ts";
import {
  RobotDriverRefusedError,
  robotDriverRefusal,
  robotServiceConfigured,
  robotServiceUrl,
} from "../src/lib/platform/robot-service.ts";
import { answerNowRouteProblems } from "./cron-answer-now.test.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE TURBIFY MAILBOX ROBOTS RUN ON THEIR OWN RAILWAY SERVICE ONCE IT IS SWITCHED ON (audit REC-075).
 *
 * The robots drive a real Chromium against the Turbify console. Until now they ran inside the website,
 * beside the pages employees use. The owner chose "own small Railway service": `phoenix-workforce-robot`,
 * `PHOENIX_PROCESS_ROLE=robot`, and one switch on the website, `PHOENIX_ROBOT_SERVICE_URL`. What this
 * file pins:
 *   1. with the switch OFF nothing changes — every process builds a driver as before;
 *   2. with it ON, both driver factories refuse anywhere but the robot service, BEFORE anything is read
 *      or launched;
 *   3. the robot cron route and the four internal routes refuse off the robot service, the internal
 *      ones only after the CRON_SECRET bearer;
 *   4. the four website routes keep their session, CSRF, role and rate-limit checks and forward only
 *      after them; the forwarder passes the robot service's answer through unchanged and says 502,
 *      without a credential, when it cannot reach it;
 *   5. the daily sweep skips the two robot passes once the switch is on;
 *   6. the Railway block for the service is Europe, robot role, and none of the website's variables.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const code = (path: string) => stripComments(read(path));

const ENV_KEYS = [
  "CRON_SECRET",
  "CRON_SECRET_PREVIOUS",
  "PHOENIX_PROCESS_ROLE",
  "PHOENIX_ROBOT_SERVICE_URL",
  "PHOENIX_TURBIFY_ADMIN_PASSWORD",
  "PHOENIX_TURBIFY_ADMIN_USER",
] as const;

/** Runs `body` with exactly these variables set (the rest of ENV_KEYS unset), then puts every one back. */
async function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>, body: () => Promise<void> | void) {
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]] as const));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try {
    await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const URL_ON = "https://robot.phoenix.test";
const SECRET = "robot-service-test-secret";

/** The thrown error of a factory call, or null if it returned (which must never happen here). */
async function thrownBy(factory: () => Promise<unknown>): Promise<unknown> {
  try {
    await factory();
    return null;
  } catch (error) {
    return error;
  }
}

async function runFactoryGuardCases() {
  // ── The switch and the role ──────────────────────────────────────────────────────────────────
  assert.equal(robotServiceUrl(undefined), null, "unset is OFF");
  assert.equal(robotServiceUrl("   "), null, "blank is OFF");
  assert.equal(robotServiceUrl(`${URL_ON}//`), URL_ON, "trailing slashes are dropped");
  assert.equal(robotServiceConfigured("not a url"), true, "any non-empty value is ON, so a typo forwards and fails loudly rather than running here");
  assert.equal(resolveProcessRole("robot"), "robot");
  assert.equal(resolveProcessRole(" ROBOT "), "robot", "read the way every role is read");
  assert.equal(runsBackgroundJobs("robot"), false, "the robot service runs no in-process scheduler");
  assert.ok(workerOnlyRouteRefusal("cron/inbound-intake", "robot"), "nor any worker-only cron route");

  // ── The pure refusal, every combination ──────────────────────────────────────────────────────
  for (const role of [undefined, "all", "web", "worker", "robot"]) {
    assert.equal(
      robotDriverRefusal({ PHOENIX_PROCESS_ROLE: role }),
      null,
      `switch OFF: a '${role ?? "unset"}' process builds a driver exactly as before`,
    );
  }
  for (const role of [undefined, "all", "web", "worker"]) {
    assert.ok(
      robotDriverRefusal({ PHOENIX_PROCESS_ROLE: role, PHOENIX_ROBOT_SERVICE_URL: URL_ON }),
      `switch ON: a '${role ?? "unset"}' process must refuse to build a robot driver`,
    );
  }
  assert.equal(robotDriverRefusal({ PHOENIX_PROCESS_ROLE: "robot", PHOENIX_ROBOT_SERVICE_URL: URL_ON }), null, "the robot service builds it");

  // ── The real factories. No credentials are set, so a factory that gets PAST the guard throws on the
  //    missing sign-in before any browser could open — nothing here can launch Chromium. ──────────
  const factories: Array<[string, () => Promise<unknown>]> = [
    ["createTurbifyConsoleDriver", () => createTurbifyConsoleDriver()],
    ["createJoinerDriverFromEnv", () => createJoinerDriverFromEnv()],
  ];
  for (const [name, factory] of factories) {
    await withEnv({ PHOENIX_PROCESS_ROLE: "web", PHOENIX_ROBOT_SERVICE_URL: URL_ON }, async () => {
      const error = await thrownBy(factory);
      assert.ok(
        error instanceof RobotDriverRefusedError,
        `${name}: on the website with the robot service switched on, the factory must refuse with RobotDriverRefusedError (got ${String(error)})`,
      );
    });
    await withEnv({ PHOENIX_PROCESS_ROLE: "worker", PHOENIX_ROBOT_SERVICE_URL: URL_ON }, async () => {
      assert.ok((await thrownBy(factory)) instanceof RobotDriverRefusedError, `${name}: and on the worker`);
    });
    await withEnv({ PHOENIX_PROCESS_ROLE: "web" }, async () => {
      const error = await thrownBy(factory);
      assert.ok(error instanceof Error, `${name}: switch OFF, it still throws here only for the missing sign-in`);
      assert.equal(error instanceof RobotDriverRefusedError, false, `${name}: switch OFF, the website is NOT refused — today's behaviour`);
      assert.match(error.message, /PHOENIX_TURBIFY_ADMIN_USER/, `${name}: it got past the guard to the credential check`);
    });
    await withEnv({ PHOENIX_PROCESS_ROLE: "robot", PHOENIX_ROBOT_SERVICE_URL: URL_ON }, async () => {
      const error = await thrownBy(factory);
      assert.equal(error instanceof RobotDriverRefusedError, false, `${name}: the robot service is never refused`);
    });
  }
}

async function runRobotOnlyRouteCases() {
  // ── The refusal itself ───────────────────────────────────────────────────────────────────────
  for (const role of [undefined, "all", "web", "worker"]) {
    const refusal = robotOnlyRouteRefusal("cron/mailbox-robots", role);
    assert.ok(refusal, `a '${role ?? "unset"}' process refuses a robot-only route — an unset role too`);
    assert.equal(refusal.status, 503);
    assert.equal(refusal.body.error, "wrong_process");
  }
  assert.equal(robotOnlyRouteRefusal("cron/mailbox-robots", "robot"), null);

  // ── The cron route, called for real: bearer first, then the role, before any run starts ───────
  const { GET: cronGet } = await import("../app/api/cron/mailbox-robots/route.ts");
  const cronRequest = (bearer?: string) =>
    new Request("https://phoenix.test/api/cron/mailbox-robots?wait=1", {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    });
  await withEnv({ CRON_SECRET: SECRET, PHOENIX_PROCESS_ROLE: "web" }, async () => {
    assert.equal((await cronGet(cronRequest())).status, 401, "no bearer: 401, before the role is even read");
    const wrong = await cronGet(cronRequest(SECRET));
    assert.equal(wrong.status, 503, "the website refuses the robot cron loudly");
    assert.equal(((await wrong.json()) as { error?: string }).error, "wrong_process");
  });
  await withEnv({ CRON_SECRET: SECRET, PHOENIX_PROCESS_ROLE: "worker" }, async () => {
    assert.equal((await cronGet(cronRequest(SECRET))).status, 503, "and so does the worker");
  });

  const cronSource = code("../app/api/cron/mailbox-robots/route.ts");
  assert.deepEqual(
    answerNowRouteProblems(cronSource, "JOB_SLUG", /pingDeadMansSwitch\(JOB_SLUG/),
    [],
    "the robot cron checks the bearer before it answers, answers 202 at once, and reports to its heartbeat",
  );
  const handler = cronSource.slice(cronSource.indexOf("export async function GET("));
  const denied = handler.indexOf("if (denied) return denied;");
  const wrongProcess = handler.indexOf('refuseUnlessRobot(JOB)');
  const answer = handler.indexOf("answerNowThenFinish(");
  assert.ok(denied > -1 && wrongProcess > denied && answer > wrongProcess, "bearer, then role, then the answer — in that order");
  assert.match(cronSource, /claimJobLease\(client\(\), \{ holder, jobKey: LEASE_KEY, ttlSeconds: LEASE_TTL_SECONDS \}\)/, "one run at a time, by lease");
  assert.match(cronSource, /if \(!lease\.held\)/, "a run that does not hold the lease does nothing");
  assert.match(cronSource, /runRobotSweepPass\(\)/);
  assert.match(cronSource, /runJoinerSweepPass\(defaultJoinerSweepDeps\(\)\)/);

  // ── The four internal routes, called for real ────────────────────────────────────────────────
  const post = (bearer: string | null, body: unknown) =>
    new Request("https://robot.phoenix.test/api/internal/mailbox-robot/x", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      method: "POST",
    });
  const actor = { hrId: "B-10", loginId: "login-1" };
  for (const action of ROBOT_ACTIONS) {
    const { POST } = await import(`../app/api/internal/mailbox-robot/${action}/route.ts`);
    await withEnv({ CRON_SECRET: SECRET, PHOENIX_PROCESS_ROLE: "robot" }, async () => {
      assert.equal((await POST(post(null, { actor, request: { dryRun: false } }))).status, 401, `${action}: no bearer, no run`);
      assert.equal((await POST(post("wrong", { actor, request: { dryRun: false } }))).status, 401, `${action}: a wrong bearer, no run`);
      assert.equal(
        (await POST(post(SECRET, { request: { dryRun: false } }))).status,
        400,
        `${action}: a forwarded request that does not name who asked is refused before anything runs`,
      );
    });
    for (const role of ["web", "worker", "all"]) {
      await withEnv({ CRON_SECRET: SECRET, PHOENIX_PROCESS_ROLE: role }, async () => {
        const response = await POST(post(SECRET, { actor, request: { dryRun: false } }));
        assert.equal(response.status, 503, `${action}: a '${role}' process refuses even with the right bearer`);
        assert.equal(((await response.json()) as { error?: string }).error, "wrong_process");
      });
    }
    await withEnv({ CRON_SECRET: SECRET, PHOENIX_PROCESS_ROLE: "web" }, async () => {
      assert.equal((await POST(post(null, { actor }))).status, 401, `${action}: the bearer is checked BEFORE the role`);
    });
    const source = code(`../app/api/internal/mailbox-robot/${action}/route.ts`);
    assert.match(source, new RegExp(`handleInternalRobotRequest\\(request, "${action}"`), `${action}: through the one shared door`);
  }
  // The live-only three refuse a forwarded dry run (the website answers those itself).
  for (const action of ["invite-inbox", "app-password-controls", "app-password-rehearsal"] as const) {
    const { POST } = await import(`../app/api/internal/mailbox-robot/${action}/route.ts`);
    await withEnv({ CRON_SECRET: SECRET, PHOENIX_PROCESS_ROLE: "robot" }, async () => {
      assert.equal((await POST(post(SECRET, { actor, request: { dryRun: true } }))).status, 400, `${action}: a forwarded dry run opens nothing`);
    });
  }

  const door = code("../src/lib/new-hire-mailbox/robot/actions/internal-route.ts");
  const bearerAt = door.indexOf("assertCronAuthorized(request, job)");
  const roleAt = door.indexOf("refuseUnlessRobot(job)");
  const bodyAt = door.indexOf("request.json()");
  assert.ok(bearerAt > -1 && roleAt > bearerAt && bodyAt > roleAt, "the shared door: bearer, then role, then the body");

  assert.match(code("../proxy.ts"), /pathname\.startsWith\("\/api\/internal\/mailbox-robot\/"\)/, "the server-to-server POST is CSRF-exempt, its bearer checked in the route");

  // ── The actor ────────────────────────────────────────────────────────────────────────────────
  assert.deepEqual(parseRobotActor(actor), actor);
  assert.deepEqual(parseRobotActor({ hrId: null, loginId: "x" }), { hrId: null, loginId: "x" });
  assert.equal(parseRobotActor({ hrId: null, loginId: null }), null, "someone must be named");
  assert.equal(parseRobotActor({ hrId: 7, loginId: "x" }), null);
  assert.equal(parseRobotActor(null), null);
}

async function runWebRouteCases() {
  const routes: Array<[string, (typeof ROBOT_ACTIONS)[number], RegExp]> = [
    ["../app/api/new-hire-mailboxes/adopt/route.ts", "adopt", /if \(!parsed\.dryRun && robotServiceConfigured\(\)\)/],
    ["../app/api/new-hire-mailboxes/invite-inbox/route.ts", "invite-inbox", /if \(!dryRun && robotServiceConfigured\(\)\)/],
    ["../app/api/new-hire-mailboxes/app-password-controls/route.ts", "app-password-controls", /if \(robotServiceConfigured\(\)\)/],
    ["../app/api/new-hire-mailboxes/app-password-rehearsal/route.ts", "app-password-rehearsal", /if \(robotServiceConfigured\(\)\)/],
  ];
  for (const [file, action, gate] of routes) {
    const source = code(file).replace(/\s+/g, " ");
    const handler = source.slice(source.indexOf("export async function POST("));
    const csrf = handler.indexOf("assertSameOriginMutation(request)");
    const session = handler.indexOf("resolveAccessContext(request)");
    const role = handler.indexOf("canReadInitialPassword(access.role)");
    const limit = handler.indexOf("assertApiRateLimit(");
    const forward = handler.indexOf(`forwardToRobotService({ action: "${action}"`);
    assert.ok(forward > -1, `${file}: forwards to the robot service when it is switched on`);
    assert.ok(csrf > -1 && csrf < forward, `${file}: CSRF before forwarding`);
    assert.ok(session > -1 && session < forward, `${file}: the session before forwarding`);
    assert.ok(role > -1 && role < forward, `${file}: the System Administrator check before forwarding`);
    assert.ok(limit > -1 && limit < forward, `${file}: the rate limit before forwarding — a forward is a live robot run`);
    assert.match(handler, gate, `${file}: forwards only a LIVE run, and only when switched on`);
    assert.equal(/createJoinerDriverFromEnv|createTurbifyConsoleDriver/.test(source), false, `${file}: builds no driver of its own`);
    assert.match(handler, /return await run[A-Za-z]+Action\(/, `${file}: otherwise it runs the ONE shared implementation here`);
  }
}

async function runForwarderCases() {
  type Call = { body: string; headers: Record<string, string>; method: string; url: string };
  const calls: Call[] = [];
  const answering = (status: number, body: string) => async (url: string, init: RequestInit) => {
    calls.push({ body: String(init.body), headers: init.headers as Record<string, string>, method: String(init.method), url });
    return new Response(body, { headers: { "content-type": "application/json" }, status });
  };
  const actor = { hrId: "B-10", loginId: "login-1" };

  const passed = await forwardToRobotService({
    action: "adopt",
    actor,
    fetchImpl: answering(207, '{"result":{"x":1},"success":true}'),
    request: { dryRun: false, named: ["a@b.c"] },
    secret: SECRET,
    url: `${URL_ON}/`,
  });
  assert.equal(passed.status, 207, "the robot service's status comes back unchanged");
  assert.equal(await passed.text(), '{"result":{"x":1},"success":true}', "and its body, byte for byte");
  assert.equal(calls[0].url, `${URL_ON}${robotActionPath("adopt")}`, "to /api/internal/mailbox-robot/<action>");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers.Authorization, `Bearer ${SECRET}`, "with the CRON_SECRET bearer");
  assert.deepEqual(JSON.parse(calls[0].body), { actor, request: { dryRun: false, named: ["a@b.c"] } }, "carrying who asked, for the audit row");

  const failing = await forwardToRobotService({
    action: "invite-inbox",
    actor,
    fetchImpl: async () => {
      throw new TypeError(`fetch failed: ${SECRET}`);
    },
    request: { dryRun: false },
    secret: SECRET,
    url: URL_ON,
  });
  assert.equal(failing.status, 502, "an unreachable robot service is a clear 502");
  const failingText = await failing.text();
  assert.match(failingText, /robot_service_unreachable/);
  assert.equal(failingText.includes(SECRET), false, "and the answer never carries the credential");

  const timedOut = await forwardToRobotService({
    action: "app-password-rehearsal",
    actor,
    fetchImpl: async () => {
      throw new DOMException("timed out", "TimeoutError");
    },
    request: { dryRun: false },
    secret: SECRET,
    url: URL_ON,
  });
  assert.equal(timedOut.status, 502);
  assert.match(await timedOut.text(), /may still be going on/, "a timeout says the run may still be going on there");

  const refused = await forwardToRobotService({ action: "adopt", actor, fetchImpl: answering(401, '{"error":"unauthorized"}'), request: {}, secret: SECRET, url: URL_ON });
  assert.equal(refused.status, 502, "a 401 from the robot service is the website's misconfiguration, never the user's");
  assert.match(await refused.text(), /robot_service_unauthorized/);

  const before = calls.length;
  assert.equal((await forwardToRobotService({ action: "adopt", actor, fetchImpl: answering(200, "{}"), request: {}, secret: "", url: URL_ON })).status, 503, "no CRON_SECRET: nothing is sent");
  assert.equal((await forwardToRobotService({ action: "adopt", actor, fetchImpl: answering(200, "{}"), request: {}, secret: SECRET, url: null })).status, 503, "no URL: nothing is sent");
  assert.equal((await forwardToRobotService({ action: "adopt", actor, fetchImpl: answering(200, "{}"), request: {}, secret: SECRET, url: "ftp://x" })).status, 502, "a non-http URL: nothing is sent");
  assert.equal(calls.length, before, "none of those three reached the network");
}

function runSweepCases() {
  const sweep = code("../app/api/cron/mailbox-offboarding-sweep/route.ts");
  assert.match(sweep, /const delegated = robotServiceConfigured\(\);/, "the sweep reads the switch");
  assert.match(sweep, /const robot = delegated \? robotPassesDelegated\(\) : await runRobotSweepPass\(\);/, "and skips the revocation robot when it is on");
  assert.match(
    sweep,
    /const joiner = delegated \? robotPassesDelegated\(\) : await runJoinerSweepPass\(defaultJoinerSweepDeps\(\)\);/,
    "and the joiner robot",
  );
  assert.match(sweep, /const access = await runDepartedAccessSweep\(\);/, "the departed-access sweep always stays");
  assert.match(sweep, /await runMailboxOffboardingSweep\(\)/, "and the register sweep");
}

function runRailwayBlockCases() {
  const iac = read("../.railway/railway.ts");
  const at = iac.indexOf('service("phoenix-workforce-robot"');
  assert.notEqual(at, -1, ".railway/railway.ts declares the robot service");
  const next = iac.indexOf('service("', at + 1);
  const block = iac.slice(at, next === -1 ? undefined : next);
  assert.match(block, /replicas: \{ "europe-west4-drams3a": 1 \}/, "one replica, in Europe — it must never start in sfo");
  assert.match(block, /healthcheckPath: "\/api\/readyz"/, "held by the same readiness gate as the website");
  assert.match(iac.slice(Math.max(0, at - 2000), at), /PHOENIX_PROCESS_ROLE \(=robot\)/, "its comment says the role it runs as");
  const env = /env: \{([^}]*)\}/.exec(block);
  assert.ok(env, "the robot block has an env list");
  const names = [...env[1].matchAll(/([A-Z0-9_]+): preserve\(\)/g)].map((m) => m[1]).sort();
  assert.ok(names.includes("PHOENIX_PROCESS_ROLE"), "it carries the process role");
  for (const needed of ["CRON_SECRET", "PHOENIX_TURBIFY_ADMIN_USER", "PHOENIX_TURBIFY_ADMIN_PASSWORD", "SUPABASE_SERVICE_ROLE_KEY", "PHOENIX_AUTH_SECRET"]) {
    assert.ok(names.includes(needed), `the robots need ${needed}`);
  }
  // None of the website's own integrations: no mail sender, no AI, no WhatsApp, no CRM poller, and the
  // switch itself only ever lives on the WEBSITE.
  const allowed = new Set([
    "APP_ENV", "CRON_SECRET", "HEALTHCHECKS_PING_KEY", "MAILBOX_MONITOR_SECRET", "NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_SENTRY_DSN",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_URL", "PHOENIX_AUTH_SECRET",
    "PHOENIX_NEW_MAILBOX_INITIAL_PASSWORD", "PHOENIX_PROCESS_ROLE", "PHOENIX_TURBIFY_ADMIN_PASSWORD", "PHOENIX_TURBIFY_ADMIN_USER",
    "PHOENIX_TURBIFY_JOINER_DRY_RUN", "PHOENIX_TURBIFY_JOINER_ENABLED", "PHOENIX_TURBIFY_REPORT_CONTROLS", "PHOENIX_TURBIFY_ROBOT_ENABLED",
    "SENTRY_DSN", "SUPABASE_SERVICE_ROLE_KEY",
  ]);
  const extra = names.filter((name) => !allowed.has(name));
  assert.deepEqual(extra, [], `the robot service carries only what the robots read — not the website's variables: ${extra.join(", ")}`);
  assert.equal(/PHOENIX_ROBOT_SERVICE_URL/.test(stripComments(iac)), false, "the switch is set on the website by hand, never in IaC");
  assert.match(iac, /resources: \[[^\]]*phoenixWorkforceRobot/, "and it is one of the project's resources, so a whole-project apply never deletes it");
}

export async function runMailboxRobotServiceTests() {
  await runFactoryGuardCases();
  await runRobotOnlyRouteCases();
  await runWebRouteCases();
  await runForwarderCases();
  runSweepCases();
  runRailwayBlockCases();
}
