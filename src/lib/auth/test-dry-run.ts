/**
 * A TEST ACCOUNT'S SAVE RUNS FULLY AND SAVES NOTHING — the fence (owner, 2026-11-06, "Runs fully, saves
 * nothing"; the decision half and why it exists: ./test-dry-run-rules.ts).
 *
 * One wrapper around `globalThis.fetch`, installed first thing at boot (instrumentation.ts). Every
 * read passes untouched. A WRITE made while serving a marked test-account request never leaves the
 * server as a write:
 *
 *   - Supabase tables (PostgREST insert / upsert / update / delete) — answered here as PostgREST would
 *     answer: the rows sent back with an id, or the matching rows (read for real) with the change laid
 *     on top. Nothing is written.
 *   - Supabase functions (RPC) — a STABLE or IMMUTABLE one is sent as it is (it cannot write). A
 *     VOLATILE one goes through `phx_test_dry_run_rpc`, which runs it for real inside a sub-transaction
 *     and rolls back everything it wrote, so its checks, its refusals and its answer are the real ones.
 *   - Supabase storage — signing and listing pass; an upload, a move, a copy or a removal is answered
 *     "done" and stores nothing.
 *   - Supabase auth, edge functions and realtime — answered "done".
 *   - Every other host — email (Resend, Brevo), Telegram, OneSignal, WhatsApp, Google, our own app —
 *     answered "done" and nothing is sent. Only hosts whose POST is a READ are let through: the AI
 *     providers, Google routes/places/maps, the Google token exchange, Sentry.
 *
 * 🔴 FAIL-CLOSED: resolveAccessContext lets a test account's write run only when `testDryRunFenceIsLive()`
 * proves this wrapper is the fetch actually in use. If anything replaced it, the save is refused as it
 * always was — it is never run unfenced.
 */

import { randomUUID } from "node:crypto";

import { AI_PROVIDER_HOSTS } from "../ai/provider-hosts.ts";
import { noteTestDryRunSeen, requestIsTestDryRun, testDryRunRecentlySeen } from "./test-dry-run-rules.ts";

type FetchFn = typeof fetch;

const FENCE_MARK = Symbol.for("phoenix.testDryRun.fence");
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DRY_RUN_RPC = "phx_test_dry_run_rpc";

/** Hosts whose POST is a read: asking an AI, pricing a route, looking up a place, a Google token, an error report. */
const READ_ONLY_POST_HOSTS = [
  ...AI_PROVIDER_HOSTS,
  "generativelanguage.googleapis.com",
  "routes.googleapis.com",
  "places.googleapis.com",
  "maps.googleapis.com",
  "oauth2.googleapis.com",
  "sentry.io",
];

function hostIsReadOnlyPost(hostname: string): boolean {
  return READ_ONLY_POST_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

function supabaseHostname(): string | null {
  try {
    return new URL(String(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "")).hostname || null;
  } catch {
    return null;
  }
}

function isSupabaseHost(hostname: string): boolean {
  return hostname === supabaseHostname() || hostname.endsWith(".supabase.co");
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  return String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function urlOf(input: RequestInfo | URL): URL | null {
  try {
    return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  } catch {
    return null;
  }
}

function headersOf(input: RequestInfo | URL, init?: RequestInit): Headers {
  return new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
}

async function bodyJsonOf(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  try {
    const raw = init?.body ?? null;
    if (typeof raw === "string") return raw ? JSON.parse(raw) : null;
    if (raw == null && input instanceof Request) {
      const text = await input.clone().text();
      return text ? JSON.parse(text) : null;
    }
  } catch {
    return null;
  }
  return null;
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "x-phoenix-test-dry-run": "1", ...extra });
  if (status === 204) return new Response(null, { status, headers });
  return new Response(JSON.stringify(body), { status, headers });
}

function wantsObject(headers: Headers): boolean {
  return (headers.get("accept") ?? "").includes("vnd.pgrst.object");
}

function notOneRow(count: number): Response {
  return json(
    { code: "PGRST116", details: `The result contains ${count} rows`, hint: null, message: "JSON object requested, multiple (or no) rows returned" },
    406,
  );
}

/** The rows a PostgREST answer would carry, shaped by the caller's Accept and Prefer. */
function rowsAnswer(rows: unknown[], headers: Headers, status: number): Response {
  const prefer = headers.get("prefer") ?? "";
  const range = { "content-range": rows.length ? `0-${rows.length - 1}/${rows.length}` : "*/0" };
  if (!/return=representation/.test(prefer)) return json(null, status === 201 ? 201 : 204, range);
  if (wantsObject(headers)) return rows.length === 1 ? json(rows[0], status, range) : notOneRow(rows.length);
  return json(rows, status, range);
}

/** Read the rows a PATCH or DELETE would touch — the same filters, sent as the read they are. */
async function matchingRows(url: URL, headers: Headers, real: FetchFn): Promise<{ rows: unknown[] } | { error: Response }> {
  const read = new URL(url.href);
  read.searchParams.delete("columns");
  read.searchParams.delete("on_conflict");
  const readHeaders = new Headers(headers);
  readHeaders.delete("prefer");
  readHeaders.delete("content-type");
  readHeaders.set("accept", "application/json");
  const response = await real(read, { method: "GET", headers: readHeaders });
  if (!response.ok) return { error: response };
  const body = await response.json().catch(() => []);
  return { rows: Array.isArray(body) ? body : body == null ? [] : [body] };
}

function asRows(body: unknown): Record<string, unknown>[] {
  const list = Array.isArray(body) ? body : body == null ? [] : [body];
  return list.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
}

async function fakeTableWrite(url: URL, method: string, input: RequestInfo | URL, init: RequestInit | undefined, real: FetchFn): Promise<Response> {
  const headers = headersOf(input, init);
  const body = await bodyJsonOf(input, init);
  if (method === "POST" || method === "PUT") {
    const now = new Date().toISOString();
    const rows = asRows(body).map((row) => ({ id: randomUUID(), created_at: now, updated_at: now, ...row }));
    return rowsAnswer(rows, headers, 201);
  }
  const prefer = headers.get("prefer") ?? "";
  if (!/return=representation|count=/.test(prefer)) return json(null, 204);
  const found = await matchingRows(url, headers, real);
  if ("error" in found) return found.error;
  const change = method === "PATCH" && body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const rows = asRows(found.rows).map((row) => ({ ...row, ...change }));
  return rowsAnswer(rows, headers, 200);
}

/** The slice of a function's set answer the caller asked for (Range header, or limit/offset). */
function sliceSet(rows: unknown[], url: URL, headers: Headers): unknown[] {
  const range = /^(\d+)-(\d*)$/.exec(headers.get("range") ?? "");
  if (range) return rows.slice(Number(range[1]), range[2] ? Number(range[2]) + 1 : undefined);
  const offset = Number(url.searchParams.get("offset") ?? 0) || 0;
  const limit = url.searchParams.get("limit");
  return rows.slice(offset, limit ? offset + (Number(limit) || 0) : undefined);
}

async function dryRunRpc(url: URL, fnName: string, input: RequestInfo | URL, init: RequestInit | undefined, real: FetchFn): Promise<Response> {
  const headers = headersOf(input, init);
  const args = await bodyJsonOf(input, init);
  const wrapperUrl = new URL(url.href);
  wrapperUrl.pathname = url.pathname.replace(/\/rpc\/[^/]+$/, `/rpc/${DRY_RUN_RPC}`);
  wrapperUrl.search = "";
  const wrapperHeaders = new Headers(headers);
  wrapperHeaders.delete("prefer");
  wrapperHeaders.delete("range");
  wrapperHeaders.set("accept", "application/json");
  wrapperHeaders.set("content-type", "application/json");
  const response = await real(wrapperUrl, {
    method: "POST",
    headers: wrapperHeaders,
    body: JSON.stringify({ p_function: fnName, p_args: args && typeof args === "object" && !Array.isArray(args) ? args : {} }),
  });
  // The function's own refusal is the real answer; a missing wrapper or a caller who may not use it is
  // an error too — never a reason to send the real call.
  if (!response.ok) return response;
  const answer = (await response.json().catch(() => null)) as { passthrough?: boolean; kind?: string; value?: unknown } | null;
  if (!answer) return json({ code: "PHXDRY", message: "Test account: the dry run gave no answer.", details: null, hint: null }, 500);
  if (answer.passthrough) return real(input, init);
  if (answer.kind === "void") return json(null, 204);
  if (answer.kind === "set") {
    const all = Array.isArray(answer.value) ? answer.value : [];
    const rows = sliceSet(all, url, headers);
    if (wantsObject(headers)) return rows.length === 1 ? json(rows[0]) : notOneRow(rows.length);
    const contentRange = rows.length ? `0-${rows.length - 1}/${all.length}` : `*/${all.length}`;
    return json(rows, 200, { "content-range": contentRange });
  }
  return json(answer.value ?? null);
}

function fakeStorageWrite(url: URL, method: string, body: unknown): Response | null {
  const path = url.pathname.replace(/^\/storage\/v1/, "");
  // Signing a link, listing a folder and the upload-signing handshake are reads.
  if (/^\/object\/(sign|list|info|upload\/sign)\//.test(path) || /^\/object\/sign\//.test(path)) return null;
  if (/^\/object\/(move|copy)$/.test(path)) {
    const destination = (body as { destinationKey?: string } | null)?.destinationKey ?? "";
    return json({ message: "Successfully moved", Key: destination, Id: randomUUID() });
  }
  if (method === "DELETE") return json([]);
  const object = /^\/object\/(.+)$/.exec(path);
  if (object) return json({ Key: object[1], Id: randomUUID() });
  return json({});
}

/**
 * The fence for one call. `real` is the fetch it wraps. Exported so the unit test can drive it with
 * a stand-in fetch and a stand-in "is this a dry run" answer.
 */
export async function testDryRunFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  real: FetchFn,
  isDryRun: () => Promise<boolean> = isTestDryRunRequest,
): Promise<Response> {
  const method = methodOf(input, init);
  if (READ_METHODS.has(method)) return real(input, init);
  if (!(await isDryRun())) return real(input, init);

  const url = urlOf(input);
  if (!url) return json({ ok: true, result: {} });

  if (isSupabaseHost(url.hostname)) {
    const rpc = /\/rest\/v1\/rpc\/([^/?]+)$/.exec(url.pathname);
    if (rpc) {
      if (rpc[1] === DRY_RUN_RPC) return real(input, init);
      return dryRunRpc(url, rpc[1], input, init, real);
    }
    if (url.pathname.startsWith("/rest/v1/")) return fakeTableWrite(url, method, input, init, real);
    if (url.pathname.startsWith("/storage/v1/")) {
      const faked = fakeStorageWrite(url, method, await bodyJsonOf(input, init));
      return faked ?? real(input, init);
    }
    return json({});
  }

  if (hostIsReadOnlyPost(url.hostname)) return real(input, init);
  // An email, a Telegram, a push, a WhatsApp, a calendar write, a call back into Phoenix itself:
  // answered as a sender expects and never sent.
  return json({ ok: true, result: {}, id: "test-dry-run", messageId: "test-dry-run", success: true });
}

/** Whether the request being served right now is a marked test-account dry run. */
export async function isTestDryRunRequest(): Promise<boolean> {
  // Nothing marked lately → no request is a dry run, and no header read is paid (or attempted outside
  // a request, at build time or in a timer).
  if (!testDryRunRecentlySeen()) return false;
  try {
    const { headers } = await import("next/headers");
    return requestIsTestDryRun(await headers());
  } catch {
    return false;
  }
}

/** Wrap `globalThis.fetch` once. Called first thing in instrumentation.ts `register()`. */
export function installTestDryRunFetchFence(): boolean {
  const current = globalThis.fetch as FetchFn & Record<string | symbol, unknown>;
  if (!current || testDryRunFenceIsLive()) return false;
  const fenced = (async (input: RequestInfo | URL, init?: RequestInit) => testDryRunFetch(input, init, current)) as FetchFn &
    Record<string | symbol, unknown>;
  fenced[FENCE_MARK] = true;
  globalThis.fetch = fenced;
  return true;
}

/**
 * True when the fetch in use is the fence, or a wrapper around it that names what it wraps — Next.js's
 * (`_nextOriginalFetch`) or our own (`__phoenixWrappedFetch`, src/lib/mcp-source/read-recorder.ts).
 * resolveAccessContext refuses a test account's save when this is false — the fail-closed half.
 */
export function testDryRunFenceIsLive(): boolean {
  let fn = globalThis.fetch as unknown as Record<string | symbol, unknown> | undefined;
  for (let depth = 0; fn && depth < 5; depth += 1) {
    if (fn[FENCE_MARK] === true) return true;
    fn = (fn._nextOriginalFetch ?? fn.__phoenixWrappedFetch) as Record<string | symbol, unknown> | undefined;
  }
  return false;
}

/** resolveAccessContext's question: may this test-account write run as a dry run? Records the grant. */
export function grantTestDryRun(requestHeaders: { get(name: string): string | null } | null | undefined): boolean {
  if (!requestIsTestDryRun(requestHeaders)) return false;
  if (!testDryRunFenceIsLive()) return false;
  noteTestDryRunSeen();
  return true;
}

/**
 * The in-module twin of the access guard, for a service that refused a test account on its own: a
 * test account's save passes only while this request runs as a marked, fenced dry run.
 */
export async function assertTestAccountWriteIsDryRun(access: { testPersona?: unknown } | null | undefined): Promise<void> {
  if (!access?.testPersona) return;
  if (testDryRunFenceIsLive() && (await isTestDryRunRequest())) return;
  const { assertNotTestAccount } = await import("./test-persona.ts");
  assertNotTestAccount(access as Parameters<typeof assertNotTestAccount>[0]);
}
