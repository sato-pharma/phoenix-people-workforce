import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ts from "typescript";

import { POST as recordPost } from "../app/api/devices/headwind/record/route.ts";
import { POST as remoteIdPost } from "../app/api/devices/headwind/remote-id/route.ts";
import { clearPermissionMatrixCache } from "../src/lib/auth/permissions.ts";
import { resetHeadwindTokenCache } from "../src/lib/devices/headwind/auth.ts";
import {
  RECORDING_TOKEN_TTL_SECONDS,
  hashRecordingToken,
  ingestRecording,
  recordingContainerMatches,
  recordingDisplayStatus,
  recordingSlotOpenDecision,
  recordingStoragePath,
} from "../src/lib/devices/headwind/recordings.ts";
import { HeadwindRemoteScreenIdError, setHeadwindRemoteScreenId } from "../src/lib/devices/headwind/remote-screen-id.ts";
import { trustedOriginForRedirect } from "../src/lib/security/origins.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The screen-recording, remote-screen and tablet-panel audit (9 Nov 2026).
 *
 * Each block below is one defect that shipped: a recording that could never upload because the tablet
 * was handed the container's own bind address; a slot that read "Recording…" for ever because nothing
 * writes `expired`; a slot left open behind a push that failed; a mistyped remote screen ID answering
 * 500; a tablet number used raw as a storage folder; a declared video type taken on the tablet's word;
 * a failed slot read answered as "no such recording"; and panel reads that rendered nothing at all when
 * the server's answer could not be read. The routes are driven for real against a stand-in database and
 * a stand-in Headwind server whose addresses cannot resolve, so nothing here reaches either.
 */

const SUPABASE = "https://recordings-audit-db.invalid";
const HEADWIND = "https://mdm.recordings-audit.invalid";

/** Same server, by origin — a prefix match would also accept `https://mdm.recordings-audit.invalid.elsewhere`. */
function onOrigin(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}
const DEVICE = "PHX-TAB-0042";
const PUBLIC_ORIGIN = "https://phoenix-hr.satopharma.com";

const STAND_IN_SETTINGS: Record<string, string> = {
  HEADWIND_MDM_BASE_URL: HEADWIND,
  HEADWIND_MDM_LOGIN: "phoenix",
  HEADWIND_MDM_PASSWORD: "stand-in-password",
  NEXT_PUBLIC_SUPABASE_URL: SUPABASE,
  NODE_ENV: "development",
  PHOENIX_ENABLE_DEV_AUTH_HEADERS: "true",
  SUPABASE_SERVICE_ROLE_KEY: "stand-in-service-role-key",
};

type Seen = { method: string; url: string; body: string };
type StandIn = {
  seen: Seen[];
  push: "ok" | "refused";
  slotRead: "open" | "unreadable";
  deviceNumber: string;
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

/** One stand-in for both servers. Every call is recorded; nothing leaves the process. */
async function withStandIns(run: (stand: StandIn) => Promise<void>): Promise<void> {
  const env = process.env as Record<string, string | undefined>;
  const savedNames = [...Object.keys(STAND_IN_SETTINGS), "PHOENIX_ALLOWED_ORIGINS", "RUSTDESK_RELAY_HOST", "RUSTDESK_PUBLIC_KEY"];
  const saved = savedNames.map((name) => [name, env[name]] as const);
  const realFetch = globalThis.fetch;
  const stand: StandIn = { deviceNumber: DEVICE, push: "ok", seen: [], slotRead: "open" };
  Object.assign(env, STAND_IN_SETTINGS);
  delete env.PHOENIX_ALLOWED_ORIGINS;
  delete env.RUSTDESK_RELAY_HOST;
  delete env.RUSTDESK_PUBLIC_KEY;
  clearPermissionMatrixCache();
  resetHeadwindTokenCache();
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const request = input instanceof Request ? input : null;
    const url = request ? request.url : String(input);
    const method = (init.method ?? request?.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? init.body : request ? await request.clone().text() : "";
    stand.seen.push({ body, method, url });
    if (onOrigin(url, HEADWIND)) {
      const path = new URL(url).pathname;
      if (path.endsWith("/rest/public/jwt/login")) return json(200, { data: { authToken: "stand-in-jwt" }, status: "OK" });
      if (path.endsWith("/rest/private/devices/search")) {
        return json(200, { data: { devices: { items: [{ id: 7, number: stand.deviceNumber }] } }, status: "OK" });
      }
      if (path.endsWith("/rest/private/push")) {
        return stand.push === "ok" ? json(200, { status: "OK" }) : json(500, { message: "stand-in push refused" });
      }
      return json(404, { message: `stand-in Headwind has no ${path}` });
    }
    if (onOrigin(url, SUPABASE)) {
      const path = new URL(url).pathname;
      if (path === "/rest/v1/device_screen_recordings" && method === "GET") {
        if (stand.slotRead === "unreadable") return json(500, { code: "XX000", message: "stand-in read failure" });
        return json(200, [
          {
            id: "11111111-2222-4333-8444-555555555555",
            requested_at: new Date().toISOString(),
            status: "requested",
            storage_path: `${DEVICE}/11111111-2222-4333-8444-555555555555.mp4`,
            upload_token_hash: hashRecordingToken("d".repeat(64)),
          },
        ]);
      }
      if (method === "POST" || method === "PATCH") return json(201, []);
      return json(200, []);
    }
    throw new Error(`the stand-in refuses to reach ${url}`);
  }) as typeof fetch;
  try {
    await run(stand);
  } finally {
    globalThis.fetch = realFetch;
    clearPermissionMatrixCache();
    resetHeadwindTokenCache();
    for (const [name, value] of saved) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  }
}

/**
 * A Super Admin press, through the dev-auth headers (which answer only a loopback Host). The URL is the
 * server's own listener — `127.0.0.1:8080`, standing in for the container's `0.0.0.0:8080` behind
 * Railway — and differs from the origin the person is on, so a route that reads its request's own
 * origin hands the tablet the listener's address and this test sees it.
 */
function superAdminRequest(path: string, body: unknown): Request {
  return new Request(`http://127.0.0.1:8080${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      host: "localhost:3000",
      origin: "http://localhost:3000",
      "x-phoenix-hr-id": "PREVIEW-NOBODY",
      "x-phoenix-role": "Super Admin",
    },
    method: "POST",
  });
}

function pushPayload(stand: StandIn, answer: string): { extra: { uploadUrl: string; recordingId: string } } {
  const push = stand.seen.find((call) => onOrigin(call.url, HEADWIND) && new URL(call.url).pathname.endsWith("/rest/private/push"));
  assert.ok(push, `the record request reached the tablet's push door (the route answered ${answer})`);
  return JSON.parse((JSON.parse(push!.body) as { payload: string }).payload);
}

// ── F13a — the tablet is handed an upload address it can reach ─────────────────────────────────────
async function runUploadAddressTests() {
  await withStandIns(async (stand) => {
    const response = await recordPost(superAdminRequest("/api/devices/headwind/record", { deviceNumber: DEVICE, durationSeconds: 30 }));
    const answer = `${response.status} ${await response.clone().text()}`;
    const { extra } = pushPayload(stand, answer);
    const address = new URL(extra.uploadUrl);
    assert.equal(
      address.origin,
      "http://localhost:3000",
      `HEADLINE: the tablet is told to upload to the trusted public origin, never the server's own listener (got ${address.origin})`,
    );
    assert.equal(address.pathname, "/api/devices/recordings/upload", "at the upload door");
    assert.equal(address.searchParams.get("recordingId"), extra.recordingId, "naming its own slot");
  });

  // The Railway shape itself, through the helper the route now uses: the bind address never comes out,
  // and a forwarded host Phoenix does not serve cannot aim a tablet's upload, and its token, at itself.
  const railway = (forwardedHost: string) =>
    new Request("https://0.0.0.0:8080/api/devices/headwind/record", {
      headers: { host: "0.0.0.0:8080", "x-forwarded-host": forwardedHost, "x-forwarded-proto": "https" },
    });
  assert.equal(trustedOriginForRedirect(railway("phoenix-hr.satopharma.com")), PUBLIC_ORIGIN, "behind Railway it is the public domain");
  assert.equal(trustedOriginForRedirect(railway("attacker.example")), PUBLIC_ORIGIN, "and a forged forwarded host falls back to it");

  const route = stripComments(readFileSync("app/api/devices/headwind/record/route.ts", "utf8"));
  assert.match(route, /uploadBaseUrl: trustedOriginForRedirect\(request\)/, "the record route takes the trusted origin");
}

// ── F13c — a push that failed closes its slot, with the reason ─────────────────────────────────────
async function runFailedPushTests() {
  await withStandIns(async (stand) => {
    stand.push = "refused";
    const response = await recordPost(superAdminRequest("/api/devices/headwind/record", { deviceNumber: DEVICE }));
    assert.equal(response.status, 502, "a refused push is the server's failure, said as one");
    const writes = stand.seen.filter((call) => call.url.startsWith(`${SUPABASE}/rest/v1/device_screen_recordings`));
    const insert = writes.find((call) => call.method === "POST");
    assert.ok(insert, "the slot was opened before the push");
    const closing = writes.find((call) => call.method === "PATCH");
    assert.ok(closing, "HEADLINE: a slot whose push failed is closed, not left open as 'Recording…'");
    const patch = JSON.parse(closing!.body) as { status?: string; error?: string; upload_token_hash?: unknown };
    assert.equal(patch.status, "failed", "it is marked failed");
    assert.equal(patch.upload_token_hash, null, "and its token is spent, so a push that landed behind a lost reply cannot file a capture");
    assert.match(patch.error ?? "", /did not reach the tablet: .*stand-in push refused/, "with the server's own reason");
    assert.match(decodeURIComponent(closing!.url), /status=eq\.requested/, "and only while it is still waiting");
  });
}

// ── F13b — a slot past its window reads expired, everywhere ───────────────────────────────────────
function runExpiryTests() {
  const asked = Date.parse("2026-11-09T10:00:00Z");
  const window = RECORDING_TOKEN_TTL_SECONDS * 1000;
  assert.equal(recordingDisplayStatus("requested", asked, asked + 60_000), "requested", "a slot inside its window is still waiting");
  assert.equal(
    recordingDisplayStatus("requested", asked, asked + window + 1),
    "expired",
    "HEADLINE: a slot the tablet never filled reads expired once its window has run out — nothing writes that status",
  );
  assert.equal(recordingDisplayStatus("requested", Number.NaN, asked), "expired", "a slot whose age cannot be told is not left open");
  assert.equal(recordingDisplayStatus("ready", asked, asked + window * 10), "ready", "a filed recording stays ready however old");
  assert.equal(recordingDisplayStatus("failed", asked, asked), "failed");
  assert.equal(recordingDisplayStatus("something-else", asked, asked), "failed", "an unknown status is never shown as fine");

  const hash = hashRecordingToken("e".repeat(64));
  const undated = recordingSlotOpenDecision({ requestedAtMs: Number.NaN, status: "requested", uploadTokenHash: hash }, asked);
  assert.equal(undated.ok ? 200 : undated.status, 410, "the upload door refuses a slot whose age cannot be told");
  const late = recordingSlotOpenDecision({ requestedAtMs: asked, status: "requested", uploadTokenHash: hash }, asked + window + 1);
  assert.equal(late.ok ? 200 : late.status, 410, "and a slot past its window, on the same clock the list reads");
}

// ── the storage path, the container and the slot read ─────────────────────────────────────────────
async function runIngestTests() {
  const id = "11111111-2222-4333-8444-555555555555";
  assert.equal(recordingStoragePath("PHX-TAB-0007", id), `PHX-TAB-0007/${id}.mp4`, "a plain tablet number is its own folder");
  for (const [number, why] of [
    ["../../hiring-pack", "a climb out of the folder"],
    ["PHX/TAB/7", "an extra folder"],
    ["تابلت ٧", "characters Storage refuses, after the tablet had already recorded"],
  ] as const) {
    const path = recordingStoragePath(number, id);
    assert.match(path, new RegExp(`^[A-Za-z0-9_-]+/${id}\\.mp4$`), `HEADLINE: ${why} never reaches the storage key (got ${path})`);
  }
  assert.equal(recordingStoragePath("", id), `tablet/${id}.mp4`, "an empty number still gives a folder");

  const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
  const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
  const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
  assert.equal(recordingContainerMatches(mp4, "video/mp4"), true, "an mp4 opening with its ftyp box is an mp4");
  assert.equal(recordingContainerMatches(webm, "video/webm; codecs=vp9"), true, "a webm opening with the EBML magic is a webm");
  assert.equal(recordingContainerMatches(html, "video/mp4"), false, "HEADLINE: a page declared as video/mp4 is not a recording");
  assert.equal(recordingContainerMatches(mp4, "video/webm"), false, "an mp4 declared as webm is refused");
  assert.equal(recordingContainerMatches(new Uint8Array(4), "video/mp4"), false, "a stub too short to hold a box is refused");

  await withStandIns(async (stand) => {
    const token = "d".repeat(64);
    const junk = await ingestRecording({ bytes: html, capturedSeconds: 10, contentType: "video/mp4", recordingId: id, token });
    assert.equal(junk.status, 415, "the upload door refuses bytes that are not the video they claim to be");
    assert.equal(
      stand.seen.filter((call) => call.method === "PATCH" || call.url.includes("/storage/v1/")).length,
      0,
      "before it claims the slot or stores anything, so the real capture can still land",
    );

    stand.slotRead = "unreadable";
    const unreadable = await ingestRecording({ bytes: mp4, capturedSeconds: 10, contentType: "video/mp4", recordingId: id, token });
    assert.equal(
      unreadable.status,
      503,
      "HEADLINE: a slot read that failed answers 503 so the tablet retries — it used to answer 404, 'no such recording'",
    );
  });
}

// ── F15 — a mistyped remote screen ID is the person's mistake, not a 500 ─────────────────────────────
async function runRemoteScreenIdTests() {
  await withStandIns(async () => {
    const mistyped = await remoteIdPost(
      superAdminRequest("/api/devices/headwind/remote-id", { deviceNumber: DEVICE, remoteScreenId: "the id is on the tablet" }),
    );
    assert.equal(mistyped.status, 400, `HEADLINE: a mistyped remote screen ID answers 400, never 500 (got ${mistyped.status})`);
    const said = (await mistyped.json()) as { message?: string };
    assert.match(said.message ?? "", /That is not a RustDesk ID/, "with the sentence that says what to type");

    const empty = await remoteIdPost(superAdminRequest("/api/devices/headwind/remote-id", null));
    assert.equal(empty.status, 400, "a body of null is an empty request, said as 400 — it used to throw reading a field of null");
  });

  // A write the server answered OK and did not hold is the server's fault, and the route says 502.
  resetHeadwindTokenCache();
  let reads = 0;
  const lying = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/rest/public/jwt/login")) return json(200, { data: { authToken: "jwt" }, status: "OK" });
    if (url.includes("/rest/private/devices/search")) {
      reads += 1;
      return json(200, { data: { devices: { items: [{ id: 7, number: DEVICE }] } }, status: "OK" });
    }
    return json(200, { status: "OK" });
  }) as typeof fetch;
  const env = { HEADWIND_MDM_BASE_URL: HEADWIND, HEADWIND_MDM_LOGIN: "phoenix", HEADWIND_MDM_PASSWORD: "x" } as unknown as NodeJS.ProcessEnv;
  const caught = await setHeadwindRemoteScreenId({ deviceNumber: DEVICE, remoteScreenId: "123456789" }, "B-10", lying, env).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(caught instanceof HeadwindRemoteScreenIdError, "a write that did not take is refused");
  assert.equal((caught as HeadwindRemoteScreenIdError).serverSide, true, "and marked as the server's failure");
  assert.equal(reads, 2, "it was read back after the write");
  const typo = new HeadwindRemoteScreenIdError("x");
  assert.equal(typo.serverSide, false, "a plain refusal is the person's to fix");
  const route = stripComments(readFileSync("app/api/devices/headwind/remote-id/route.ts", "utf8"));
  assert.match(route, /error\.serverSide \? 502 : 400/, "the route answers 502 for the server's failure and 400 for the person's");
}

type KitFetchers = {
  NO_ANSWER_MESSAGE: string;
  UNREACHABLE_MESSAGE: string;
  readJson: <T>(url: string) => Promise<T>;
  postJson: <T>(url: string, body: Record<string, unknown>) => Promise<T>;
};

/**
 * The kit's request helpers, loaded from the kit's own source. The kit is a client `.tsx` this runner
 * cannot import (it draws JSX), so the span that holds no JSX — from `readBody` to the read hook's
 * state type — is transpiled and run as it ships, never re-typed here.
 */
async function loadKitFetchers(): Promise<KitFetchers> {
  const kit = readFileSync("src/components/devices/headwind-panel-kit.tsx", "utf8");
  const start = kit.indexOf("async function readBody(");
  const end = kit.indexOf("type ReadState<T>");
  assert.ok(start > -1 && end > start, "the kit's request helpers are where this test reads them");
  const span = kit.slice(start, end);
  const { outputText } = ts.transpileModule(span, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`)) as KitFetchers;
}

// ── the panel kit — an unreadable answer is said, never drawn as nothing ──────────────────────────
async function runPanelKitTests() {
  const { NO_ANSWER_MESSAGE, UNREACHABLE_MESSAGE, postJson, readJson } = await loadKitFetchers();
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response("<html>a proxy page</html>", { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(
      () => readJson("/api/devices/headwind?view=recordings"),
      (error: unknown) => error instanceof Error && error.message === NO_ANSWER_MESSAGE,
      "HEADLINE: an OK with no readable body is an error the panel prints — it used to render nothing at all",
    );
    await assert.rejects(
      () => postJson("/api/devices/headwind/record", { deviceNumber: DEVICE }),
      (error: unknown) => error instanceof Error && error.message === NO_ANSWER_MESSAGE,
      "and a press with no readable answer says so, never 'Cannot read properties of null'",
    );
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await assert.rejects(
      () => readJson("/api/devices/headwind?view=recordings"),
      (error: unknown) => error instanceof Error && error.message === UNREACHABLE_MESSAGE,
      "a network failure says Phoenix could not be reached, not the browser's own words",
    );
    globalThis.fetch = (async () => json(200, { recordings: [] })) as unknown as typeof fetch;
    assert.deepEqual(await readJson("/x"), { recordings: [] }, "a real answer still comes through untouched");
    globalThis.fetch = (async () => json(400, { message: "Say which tablet to record." })) as unknown as typeof fetch;
    await assert.rejects(() => postJson("/x", {}), /Say which tablet to record\./, "and a refusal still carries the server's own sentence");
  } finally {
    globalThis.fetch = realFetch;
  }

  const panel = stripComments(readFileSync("src/components/devices/headwind-tablet-panel.tsx", "utf8"));
  const recordings = panel.slice(panel.indexOf("function RecordingsPanel("), panel.indexOf("function WipePanel("));
  assert.match(
    recordings,
    /onClick=\{\(\) => setState\(\{ \.\.\.own, round: own\.round \+ 1 \}\)\}/,
    "the recordings list can be read again without reloading the page — the uploaded file never appeared otherwise",
  );
  assert.match(recordings, /recording\.status === "ready" && !recording\.playbackUrl/, "a ready file with no playback link says so");
  const remoteId = panel.slice(panel.indexOf("function RemoteScreenIdPanel("), panel.indexOf("type CustodyProps"));
  assert.match(remoteId, /disabled=\{own\.busy\}\s*inputMode="numeric"/, "the ID box is held while it saves");
}

export async function runHeadwindRecordingsAuditTests() {
  runExpiryTests();
  await runUploadAddressTests();
  await runFailedPushTests();
  await runIngestTests();
  await runRemoteScreenIdTests();
  await runPanelKitTests();
}
