import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { assertSystemAdministratorWorkspaceAccess, type AccessContext } from "../src/lib/auth/permissions.ts";
import { testAccountMayRun } from "../src/lib/auth/test-persona.ts";
import {
  EMPTY_SCREEN_THROTTLE,
  MAX_SCREENS_PER_TAB_PER_HOUR,
  SAME_SCREEN_GAP_MS,
  classifyScreenKind,
  decideScreenThrottle,
  extractRefusalMessage,
  isSkippedScreenPath,
  maskApiPath,
  sameOriginApiPath,
  screenThrottleKey,
  type ScreenThrottleState,
} from "../src/lib/error-monitor/screen-capture-rules.ts";
import { installScreenCapture } from "../src/lib/error-monitor/screen-capture.ts";
import { SCREEN_IMAGE_MAX_BYTES, parseScreenReport, screenStoragePath } from "../src/lib/error-monitor/screen-intake.ts";
import { screenOwnerFor } from "../src/lib/error-monitor/user-error-screens.ts";
import {
  USER_SCREENS_DETECTOR,
  buildUserScreenFindings,
  createUserScreensDetector,
  userScreenMessage,
  userScreenSignature,
  type UserScreenRow,
} from "../src/lib/system-audit/detectors/user-screens.ts";
import { FINDING_DETECTORS } from "../src/lib/system-audit/detectors/index.ts";
import { occurrenceScreenIds } from "../src/lib/system-audit/occurrence-detail.ts";
import { createStaticPersonDirectory } from "../src/lib/system-audit/person-directory.ts";
import type { FindingBatch, FindingSink } from "../src/lib/system-audit/types.ts";
import { SYSTEM_AUDIT_FAMILIES } from "../src/lib/system-audit/types.ts";
import { stripComments } from "./system-audit-routes-access.test.ts";

/**
 * THE ERROR SCREENSHOT (owner, 23 Oct 2026): every error or block a person meets leaves a picture of
 * what they saw, shown as-is to the Super Admin only, kept 90 days. docs/system-audit.md, "What the
 * person saw". Five things are pinned here:
 *
 *   1. the browser's rules — which answer is a refusal, which paths are never photographed, how a
 *      path is masked, the per-tab throttle, and the words read off a refusal;
 *   2. the wrapper — it hands the caller the very answer fetch gave, rejects exactly as fetch did,
 *      wraps once, and schedules a picture only for a refusal on a path not skipped;
 *   3. the intake — a real JPEG of at most 1.2 MB, capped fields, a test account filed under itself;
 *   4. the detector — the signature, the fold, the exact words in column 6, the watermark, and the
 *      90-day retention only on the nightly run and never past what the ledger holds;
 *   5. the picture route — Super Admin only, guard before any read.
 */

// ─── 1. The rules ─────────────────────────────────────────────────────────────────────────────────

function rulesTests() {
  // A refusal is a 4xx; a failure is a 5xx or no answer at all.
  assert.equal(classifyScreenKind({ status: 403, networkFailure: false, method: "POST" }), "refused_request");
  assert.equal(classifyScreenKind({ status: 409, networkFailure: false, method: "POST" }), "refused_request");
  assert.equal(classifyScreenKind({ status: 422, networkFailure: false, method: "PATCH" }), "refused_request");
  assert.equal(classifyScreenKind({ status: 500, networkFailure: false, method: "POST" }), "failed_request");
  assert.equal(classifyScreenKind({ status: 503, networkFailure: false, method: "GET" }), "failed_request");
  assert.equal(classifyScreenKind({ status: null, networkFailure: true, method: "POST" }), "failed_request");
  assert.equal(classifyScreenKind({ status: 200, networkFailure: false, method: "POST" }), null, "a success is not a screen");
  assert.equal(classifyScreenKind({ status: 302, networkFailure: false, method: "GET" }), null);
  // A read that finds nothing is a question, not a block; a write that finds nothing IS one.
  assert.equal(classifyScreenKind({ status: 404, networkFailure: false, method: "GET" }), null);
  assert.equal(classifyScreenKind({ status: 401, networkFailure: false, method: "POST" }), null, "no session, no picture — the intake would refuse it");
  assert.equal(classifyScreenKind({ status: 404, networkFailure: false, method: "POST" }), "refused_request");
  assert.equal(classifyScreenKind({ status: 403, networkFailure: false, method: "GET" }), "refused_request", "a refused read is a block");

  // The skip list: the capture's own path, the reporters, sign-in, and the background polls.
  for (const path of [
    "/api/errors/screen",
    "/api/errors/client",
    "/api/auth/heartbeat",
    "/api/auth/login",
    "/api/activity/track",
    "/api/notifications/in-app",
    "/api/approvals/badge-counts",
    "/api/approvals-hub/pending-count",
    "/api/direct-orders/needs-action-count",
    "/api/readyz",
    "/api/healthz",
    "/api/phoenix-crm/touch-trail",
  ]) {
    assert.equal(isSkippedScreenPath(path), true, `${path} is never photographed`);
  }
  for (const path of ["/api/phoenix-crm/visits", "/api/phoenix-crm/visits/123/validate", "/api/leave-requests", "/api/notifications/settings", "/api/errorsx"]) {
    assert.equal(isSkippedScreenPath(path), false, `${path} is a request a person made, and is photographed`);
  }

  // Masking: the record goes, the route stays.
  assert.equal(maskApiPath("/api/phoenix-crm/visits/3f2b5c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f/validate?x=1"), "/api/phoenix-crm/visits/:id/validate");
  assert.equal(maskApiPath("/api/employees/B-10"), "/api/employees/:id");
  assert.equal(maskApiPath("/api/payroll/2026-10/lines/77"), "/api/payroll/:id/lines/:id");
  assert.equal(maskApiPath("/api/integrations/ireports360/sync"), "/api/integrations/ireports360/sync", "a route word with a digit stays");
  assert.equal(maskApiPath("not a path"), null);

  // The throttle: the same screen once in 2 minutes; at most 12 a tab an hour.
  const key = screenThrottleKey({ kind: "refused_request", apiPath: "/api/phoenix-crm/visits/1/validate", status: 409 });
  assert.equal(
    key,
    screenThrottleKey({ kind: "refused_request", apiPath: "/api/phoenix-crm/visits/2/validate", status: 409 }),
    "two records of one refusal share a throttle key",
  );
  const t0 = Date.parse("2026-10-23T09:00:00Z");
  const first = decideScreenThrottle(EMPTY_SCREEN_THROTTLE, key, t0);
  assert.equal(first.allowed, true);
  assert.equal(decideScreenThrottle(first.state, key, t0 + SAME_SCREEN_GAP_MS - 1).allowed, false, "the same screen inside 2 minutes is not sent again");
  assert.equal(decideScreenThrottle(first.state, key, t0 + SAME_SCREEN_GAP_MS).allowed, true, "after 2 minutes it is");
  const refused = decideScreenThrottle(first.state, key, t0 + 1_000);
  assert.deepEqual(refused.state.lastByKey, first.state.lastByKey, "a refused attempt never pushes the window forward");

  let state: ScreenThrottleState = EMPTY_SCREEN_THROTTLE;
  for (let index = 0; index < MAX_SCREENS_PER_TAB_PER_HOUR; index += 1) {
    const decision = decideScreenThrottle(state, `k${index}`, t0 + index * 1_000);
    assert.equal(decision.allowed, true, `picture ${index + 1} of the hour is allowed`);
    state = decision.state;
  }
  assert.equal(decideScreenThrottle(state, "k-new", t0 + 20_000).allowed, false, "the 13th picture in an hour is not sent");
  assert.equal(decideScreenThrottle(state, "k-new", t0 + 60 * 60 * 1000 + 1).allowed, true, "an hour later the window has rolled");

  // The words: message, else error, else detail; JSON only; capped.
  assert.equal(extractRefusalMessage("application/json", JSON.stringify({ error: "conflict", message: "This visit was already saved." })), "This visit was already saved.");
  assert.equal(extractRefusalMessage("application/json", JSON.stringify({ error: "You cannot validate this visit." })), "You cannot validate this visit.");
  assert.equal(extractRefusalMessage("application/json", JSON.stringify({ detail: "Locked." })), "Locked.");
  assert.equal(extractRefusalMessage("application/json", JSON.stringify({ error: { message: "Nested words" } })), "Nested words");
  assert.equal(extractRefusalMessage("text/html", "<html>Bad gateway</html>"), null, "an HTML page carries no words we can trust");
  assert.equal(extractRefusalMessage("application/json", "not json"), null);
  assert.equal(extractRefusalMessage("application/json", JSON.stringify({ message: "x".repeat(900) }))?.length, 500);

  assert.equal(sameOriginApiPath("/api/leave-requests?x=1", "https://phoenix.test"), "/api/leave-requests");
  assert.equal(sameOriginApiPath("https://other.example/api/x", "https://phoenix.test"), null, "another origin is never photographed");
  assert.equal(sameOriginApiPath("/employees", "https://phoenix.test"), null, "a page fetch is not an API call");
}

// ─── 2. The wrapper ───────────────────────────────────────────────────────────────────────────────

async function settle() {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function wrapperTests() {
  const env = process.env as Record<string, string | undefined>;
  const previousEnv = env.NODE_ENV;
  const globals = globalThis as unknown as Record<string, unknown>;
  const previousWindow = globals.window;
  const scheduled: number[] = [];
  const answers = new Map<string, () => Promise<Response>>();
  const realFetch = (input: RequestInfo | URL) => {
    const url = String(input);
    const answer = answers.get(url);
    return answer ? answer() : Promise.resolve(new Response("{}", { status: 200 }));
  };
  const fakeWindow: Record<string, unknown> = {
    fetch: realFetch,
    location: { href: "https://phoenix.test/employee-portals/field-crm/visits", origin: "https://phoenix.test", pathname: "/employee-portals/field-crm/visits" },
    setTimeout: (_callback: () => void, ms: number) => {
      scheduled.push(ms);
      return 1;
    },
  };
  try {
    env.NODE_ENV = "production";
    globals.window = fakeWindow;
    installScreenCapture();
    const wrapped = fakeWindow.fetch as typeof fetch;
    assert.notEqual(wrapped, realFetch, "the wrapper is installed in a production build");
    installScreenCapture();
    assert.equal(fakeWindow.fetch, wrapped, "a second install never wraps twice");

    // The caller gets the very Response fetch gave, body unread.
    const refusal = new Response(JSON.stringify({ message: "Visit already validated." }), { status: 409, headers: { "content-type": "application/json" } });
    answers.set("/api/phoenix-crm/visits/9/validate", async () => refusal);
    const got = await wrapped("/api/phoenix-crm/visits/9/validate", { method: "POST" });
    assert.equal(got, refusal, "the wrapper returns the caller's own answer, not a copy");
    assert.equal(await got.json().then((body: { message: string }) => body.message), "Visit already validated.", "the caller can still read the body");
    await settle();
    assert.deepEqual(scheduled, [900], "a refusal schedules one picture ~900 ms later");

    // A success, a skipped path and a 404 read schedule nothing.
    await wrapped("/api/leave-requests");
    answers.set("/api/errors/screen", async () => new Response("{}", { status: 429 }));
    await wrapped("/api/errors/screen", { method: "POST" });
    answers.set("/api/employees/B-10/photo", async () => new Response("", { status: 404 }));
    await wrapped("/api/employees/B-10/photo");
    await settle();
    assert.deepEqual(scheduled, [900], "a success, the capture's own path and a 404 read are never photographed");

    // A network failure rejects exactly as fetch did — the wrapper never swallows or retries it.
    const offline = new TypeError("Failed to fetch");
    answers.set("/api/outstation/expenses", () => Promise.reject(offline));
    await assert.rejects(wrapped("/api/outstation/expenses", { method: "POST" }), (error) => error === offline);
    await settle();
    assert.deepEqual(scheduled, [900, 900], "a failed request schedules a picture too");

    // A request the page cancelled is nobody's block.
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    answers.set("/api/leave-balance", () => Promise.reject(abort));
    await assert.rejects(wrapped("/api/leave-balance"), (error) => error === abort);
    await settle();
    assert.deepEqual(scheduled, [900, 900], "an aborted request is not photographed");
  } finally {
    // Assigning undefined to process.env would store the string "undefined".
    if (previousEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = previousEnv;
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
  }
}

// ─── 3. The intake ────────────────────────────────────────────────────────────────────────────────

const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]).toString("base64")}`;

function intakeTests() {
  const ok = parseScreenReport({
    kind: "refused_request",
    status: 403,
    method: "post",
    apiPath: "/api/phoenix-crm/visits?token=secret",
    pagePath: "/employee-portals/field-crm/visits?tab=today",
    message: "  You cannot save this visit.  ",
    width: 390,
    height: 844,
    image: JPEG,
  });
  assert.ok(ok.ok, "a real refusal with a real JPEG is accepted");
  if (ok.ok) {
    assert.equal(ok.report.method, "POST");
    assert.equal(ok.report.apiPath, "/api/phoenix-crm/visits", "the query never reaches the table");
    assert.equal(ok.report.pagePath, "/employee-portals/field-crm/visits");
    assert.equal(ok.report.message, "You cannot save this visit.");
    assert.equal(ok.report.image.contentType, "image/jpeg");
    assert.equal(ok.report.image.bytes[0], 0xff);
  }

  const refuse = (body: Record<string, unknown>, why: string) => assert.equal(parseScreenReport(body).ok, false, why);
  refuse({ kind: "warning", status: 403, apiPath: "/api/x", image: JPEG }, "an unknown kind is refused");
  refuse({ kind: "refused_request", status: 500, apiPath: "/api/x", image: JPEG }, "a refusal must carry a 4xx");
  refuse({ kind: "refused_request", status: 403, image: JPEG }, "a refusal names its API path");
  refuse({ kind: "refused_request", status: 403, apiPath: "/elsewhere", image: JPEG }, "the API path must be under /api/");
  refuse({ kind: "failed_request", status: 99, apiPath: "/api/x", image: JPEG }, "a status outside HTTP is refused");
  refuse({ kind: "error_screen", image: "data:image/png;base64,iVBORw0KGgo=" }, "a PNG is refused");
  refuse({ kind: "error_screen", image: `data:image/jpeg;base64,${Buffer.from("not a jpeg at all").toString("base64")}` }, "a data URL that only SAYS jpeg is refused");
  refuse({ kind: "error_screen", image: `data:image/jpeg;base64,${"A".repeat(Math.ceil(((SCREEN_IMAGE_MAX_BYTES + 3) * 4) / 3))}` }, "a picture over 1.2 MB decoded is refused");
  refuse({ kind: "error_screen" }, "no picture, no row");
  assert.equal(parseScreenReport("text").ok, false);

  const webp = `data:image/webp;base64,${Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ", "latin1").toString("base64")}`;
  const screen = parseScreenReport({ kind: "error_screen", pagePath: "/admin", message: "Cannot read properties of undefined", image: webp });
  assert.ok(screen.ok, "an error screen needs no API path, and a real WebP is accepted");
  if (screen.ok) assert.equal(screen.report.apiPath, null);

  assert.equal(
    screenStoragePath({ cairoDate: "2026-10-23", owner: "B-10", id: "abc", contentType: "image/jpeg" }),
    "2026-10-23/B-10/abc.jpg",
  );
  assert.equal(screenStoragePath({ cairoDate: "2026-10-23", owner: "../x y", id: "abc", contentType: "image/webp" }), "2026-10-23/_x_y/abc.webp", "a folder can never climb out");

  // A real employee is filed under their stored HR id; a test account under ITS login, never hers.
  const real = screenOwnerFor({ hrId: "b-10", loginId: "b-10", role: "Super Admin", testPersona: null } as AccessContext);
  assert.deepEqual(real, { hrId: "B-10", loginId: "b-10", role: "Super Admin", isTest: false });
  const test = screenOwnerFor({ hrId: "b-7", loginId: "TEST-REP-1", role: "Medical Representative", testPersona: { mirrors: "b-7" } } as unknown as AccessContext);
  assert.equal(test.hrId, null, "a test account's picture never lands on the employee it mirrors");
  assert.equal(test.loginId, "TEST-REP-1");
  assert.equal(test.isTest, true);

  // The test account may send exactly this one diagnostic POST, and nothing beside it.
  assert.equal(testAccountMayRun("POST", "/api/errors/screen"), true);
  assert.equal(testAccountMayRun("POST", "/api/errors/screen/x"), false);
  assert.equal(testAccountMayRun("POST", "/api/errors/client"), false);
}

// ─── 4. The detector ──────────────────────────────────────────────────────────────────────────────

function screen(overrides: Partial<UserScreenRow> = {}): UserScreenRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    created_at: "2026-10-23T08:00:00.000Z",
    hr_id: "B-21",
    login_id: "b-21",
    role: "Medical Representative",
    kind: "refused_request",
    http_status: 409,
    method: "POST",
    api_path: "/api/phoenix-crm/visits/3f2b5c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f/validate",
    page_path: "/employee-portals/field-crm/visits",
    message: "This visit was already validated.",
    release: "abc123",
    is_test: false,
    ...overrides,
  };
}

const PEOPLE = new Map([["b-21", { hrIdDisplay: "B-21", name: "Mona Adel", role: "Medical Representative" }]]);
const LABEL = () => ({ label: "Field CRM", source: "nav_exact" as const, shell: "portal" as const, href: "/employee-portals/field-crm" });

function detectorFoldTests() {
  // One refusal on two records is ONE signature; a different status or kind is another.
  const a = userScreenSignature(screen());
  assert.equal(a, userScreenSignature(screen({ api_path: "/api/phoenix-crm/visits/9a2b5c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f/validate" })));
  assert.equal(a, userScreenSignature(screen({ message: "This visit was already validated." })));
  assert.notEqual(a, userScreenSignature(screen({ http_status: 403 })), "another status is another issue");
  assert.notEqual(a, userScreenSignature(screen({ kind: "failed_request", http_status: 500 })), "another kind is another issue");
  assert.notEqual(a, userScreenSignature(screen({ message: "You are not this visit's manager." })), "other words are another issue");
  assert.match(a, /^screen:v1:[0-9a-f]{16}$/);

  // Column 6 is the exact words captured — never invented.
  assert.equal(userScreenMessage(screen()), "This visit was already validated.");
  assert.equal(userScreenMessage(screen({ kind: "error_screen", message: "Cannot read properties of undefined (reading 'map')" })), "Error screen shown — Cannot read properties of undefined (reading 'map')");
  assert.equal(userScreenMessage(screen({ kind: "error_screen", message: null })), "Error screen shown");
  assert.match(userScreenMessage(screen({ message: null })), /^Refused \(HTTP 409\) — the answer carried no message/);
  assert.match(userScreenMessage(screen({ kind: "failed_request", http_status: null, message: null })), /^No answer — the request failed on the network/);

  // Two screens of one refusal by one person inside 10 minutes are ONE operation with both pictures;
  // one 11 minutes later is another; another person is another row of the same issue.
  const rows = [
    screen(),
    screen({ id: "00000000-0000-4000-8000-000000000002", created_at: "2026-10-23T08:04:00.000Z" }),
    screen({ id: "00000000-0000-4000-8000-000000000003", created_at: "2026-10-23T08:15:00.000Z" }),
    screen({ id: "00000000-0000-4000-8000-000000000004", hr_id: "B-30", login_id: "b-30", created_at: "2026-10-23T08:01:00.000Z" }),
  ];
  const findings = buildUserScreenFindings({ rows, people: PEOPLE, label: LABEL });
  assert.equal(findings.issues.length, 1, "one kind of refusal is one issue");
  assert.equal(findings.issues[0].family, "user_screen");
  assert.equal(findings.issues[0].firstSeenAt, "2026-10-23T08:00:00.000Z");
  assert.equal(findings.issues[0].lastSeenAt, "2026-10-23T08:15:00.000Z");
  assert.equal(findings.occurrences.length, 3, "a 10-minute gap and a second person each start a new operation");
  const firstOp = findings.occurrences.find((row) => row.relatedId === "00000000-0000-4000-8000-000000000001");
  assert.ok(firstOp);
  assert.equal(firstOp.attemptCount, 2);
  assert.deepEqual(firstOp.evidence?.screenIds, ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"], "the occurrence names both pictures");
  assert.deepEqual(firstOp.sourceRefs, ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]);
  assert.equal(firstOp.employeeName, "Mona Adel");
  assert.equal(firstOp.hrIdDisplay, "B-21");
  assert.equal(firstOp.moduleLabel, "Field CRM");
  assert.equal(firstOp.userMessage, "This visit was already validated.");
  assert.equal(firstOp.isSilent, false);
  assert.equal(firstOp.dedupeKey, `${a}:hr:b-21:00000000-0000-4000-8000-000000000001`);

  // A test account is filed under its own login, flagged, never under the person it mirrors.
  const test = buildUserScreenFindings({
    rows: [screen({ id: "00000000-0000-4000-8000-000000000009", hr_id: null, login_id: "TEST-REP-1", is_test: true })],
    people: PEOPLE,
    label: LABEL,
  }).occurrences[0];
  assert.equal(test.isTest, true);
  assert.equal(test.hrKey, "test-rep-1");
  assert.equal(test.employeeName, "Test account");

  // The drawer reads the pictures from the evidence, valid ids only, and only for this family.
  assert.deepEqual(
    occurrenceScreenIds({ family: "user_screen", evidence: { screenIds: ["00000000-0000-4000-8000-000000000001", "nope"] }, sourceRefs: [] }),
    ["00000000-0000-4000-8000-000000000001"],
  );
  assert.deepEqual(occurrenceScreenIds({ family: "app_error", evidence: { screenIds: ["00000000-0000-4000-8000-000000000001"] }, sourceRefs: [] }), []);

  assert.ok((SYSTEM_AUDIT_FAMILIES as readonly string[]).includes("user_screen"), "the family is declared");
  assert.ok(FINDING_DETECTORS.some((detector) => detector.id === USER_SCREENS_DETECTOR), "the nightly sweep runs the detector");
  const migration = readFileSync("supabase/migrations/20261023203000_user_error_screens.sql", "utf8");
  assert.match(migration, /'data_linkage', 'user_screen'\)\);/, "the ledger's family CHECK allows user_screen");
}

function recordingSink(cursor: Record<string, unknown> | null) {
  const writes: Array<{ detector: string; batch: FindingBatch }> = [];
  const sink: FindingSink = {
    kind: "file",
    async write(detector, _runId, batch) {
      writes.push({ detector, batch });
      return { issues: batch.issues.length, inserted: batch.occurrences.length, updated: 0 };
    },
    async readCursor() {
      return cursor;
    },
  };
  return { sink, writes };
}

async function detectorRunTests() {
  const rows = [screen(), screen({ id: "00000000-0000-4000-8000-000000000002", created_at: "2026-10-23T08:04:00.000Z" })];
  const reads: Array<{ after: unknown }> = [];
  const prunes: Array<{ nowMs: number; notAfter: string | null }> = [];
  const detector = createUserScreensDetector({
    source: {
      async readPage({ after }) {
        reads.push({ after });
        return after ? [] : rows;
      },
    },
    people: createStaticPersonDirectory(PEOPLE),
    prune: async (input) => {
      prunes.push(input);
      return { cutoff: "2026-07-25T00:00:00.000Z", candidates: 3, deletedRows: 3, deletedFiles: 3, keptForRetry: 0, error: null };
    },
  });
  const now = Date.parse("2026-10-23T09:00:00.000Z");
  const { sink, writes } = recordingSink(null);
  const result = await detector.run({ mode: "cron", deadline: now + 60_000, sink, runId: "run-1", now: () => now });
  assert.equal(result.status, "ok");
  assert.equal(result.scanned, 2);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].detector, USER_SCREENS_DETECTOR);
  assert.equal(writes[0].batch.merge, "max", "a re-read lands on itself and changes nothing");
  assert.deepEqual(writes[0].batch.cursor, { createdAt: "2026-10-23T08:04:00.000Z", id: "00000000-0000-4000-8000-000000000002" }, "the watermark moves with the write");
  assert.equal(reads.length, 2, "only an empty page ends the read");
  assert.deepEqual(prunes, [{ nowMs: now, notAfter: "2026-10-23T08:04:00.000Z" }], "retention runs once, never past the watermark");
  assert.equal((result.report?.retention as { deletedRows: number }).deletedRows, 3, "the run record counts what retention removed");

  // A historical run writes no watermark and never removes a picture.
  const historicalPrunes: unknown[] = [];
  const historical = createUserScreensDetector({
    source: { async readPage({ after }) { return after ? [] : rows; } },
    people: createStaticPersonDirectory(PEOPLE),
    prune: async (input) => {
      historicalPrunes.push(input);
      return { cutoff: "", candidates: 0, deletedRows: 0, deletedFiles: 0, keptForRetry: 0, error: null };
    },
  });
  const second = recordingSink(null);
  await historical.run({ mode: "historical", deadline: now + 60_000, sink: second.sink, runId: null, now: () => now, window: { from: "2026-10-23", to: "2026-10-23" } });
  assert.equal(second.writes[0].batch.cursor, null);
  assert.deepEqual(historicalPrunes, [], "the historical runner never prunes");

  // A read that fails is ERRORED and named — never a clean night.
  const failing = createUserScreensDetector({
    source: { async readPage() { throw new Error("timeout"); } },
    people: createStaticPersonDirectory(PEOPLE),
  });
  const third = recordingSink(null);
  const failed = await failing.run({ mode: "cron", deadline: now + 60_000, sink: third.sink, runId: null, now: () => now });
  assert.equal(failed.status, "errored");
  assert.deepEqual(failed.unreadableSources, ["user_error_screens"]);
}

// ─── 5. The picture route ─────────────────────────────────────────────────────────────────────────

function screensRouteTests() {
  const superAdmin = { role: "Super Admin", scope: "company" } as Pick<AccessContext, "role" | "scope">;
  assert.doesNotThrow(() => assertSystemAdministratorWorkspaceAccess(superAdmin));
  for (const role of ["CEO", "HR Operations", "Medical Representative", "National Sales Manager"]) {
    assert.throws(
      () => assertSystemAdministratorWorkspaceAccess({ role, scope: "company" } as Pick<AccessContext, "role" | "scope">),
      /^Error: Forbidden:/,
      `${role} is refused the screenshots`,
    );
  }

  const code = stripComments(readFileSync("app/api/admin/system-audit/screens/[id]/route.ts", "utf8"));
  const resolved = code.indexOf("resolveAccessContext(request)");
  const expired = code.indexOf("unauthenticatedSessionResponse(access)");
  const guard = code.indexOf("assertSystemAdministratorWorkspaceAccess(access");
  const read = code.indexOf("loadUserScreenImage(");
  assert.ok(resolved >= 0 && expired > resolved && guard > expired, "the route resolves the caller, answers 401, then runs the Super Admin guard");
  assert.ok(read > guard, "no picture is read before the Super Admin guard");
  assert.match(code, /isForbiddenError\(error\)[\s\S]*status: 403/, "a refused caller gets 403");
  assert.match(code, /status: 404/, "an unknown or pruned picture is 404");
  assert.match(code, /"cache-control": "private, no-store"/, "a picture is never cached");
  assert.doesNotMatch(code, /createSignedUrl|getPublicUrl/, "no URL to the private bucket ever leaves the server");

  const intake = stripComments(readFileSync("app/api/errors/screen/route.ts", "utf8"));
  const csrf = intake.indexOf("assertSameOriginMutation(request)");
  const caller = intake.indexOf("resolveAccessContext(request)");
  const guest = intake.indexOf("unauthenticatedSessionResponse(access)");
  const store = intake.indexOf("storeUserErrorScreen(");
  assert.ok(csrf >= 0 && caller > csrf && guest > caller && store > guest, "the intake checks the origin, then the session, before it stores anything");
  assert.ok(intake.indexOf("countRecentUserErrorScreens(") < store, "the hourly limit is read before the picture is stored");
  assert.doesNotMatch(intake, /console\.(log|error|warn)\([^)]*image/, "the picture is never logged");
}

export async function runUserErrorScreensTests() {
  rulesTests();
  await wrapperTests();
  intakeTests();
  detectorFoldTests();
  await detectorRunTests();
  screensRouteTests();
}
