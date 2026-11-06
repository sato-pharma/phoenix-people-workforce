import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Read recorder for the owner-only MCP source host.
 *
 * WHY THIS EXISTS. Several report loaders swallow a failed read and carry on: the organogram seat
 * report logs an unreadable employee master and still draws the chart, `teams` and the seat-offer
 * lookup fail soft, `isClosingPublished` answers `false` for a database error, and the employee
 * directory can serve a stale copy when a load fails. A report that RETURNED therefore proves
 * nothing about whether every read behind it succeeded. This module records every PostgREST request
 * made while a collection runs, from the layer underneath all of those loaders, so a swallowed
 * failure is still visible to whoever asks.
 *
 * OPT-IN AND INVISIBLE ELSEWHERE. Nothing here changes how Phoenix reads: `fetch` is wrapped once,
 * and the wrapper does nothing at all unless an `AsyncLocalStorage` scope opened by
 * `runWithReadRecorder` is active in the calling async context. A normal web request never opens one.
 * It records metadata only (method, relation, status, `Content-Range`), never a body or a header
 * value that could carry a credential.
 */

export type RecordedRead = {
  /** `METHOD path?query` — identical requests (retries included) share one key. */
  key: string;
  method: string;
  /** The table, view or function named by the PostgREST path, or null when it is not one. */
  relation: string | null;
  kind: "table" | "rpc" | "other";
  /** HTTP status, or null when the transport itself failed (timeout, DNS, reset). */
  status: number | null;
  ok: boolean;
  /** The request carried an explicit `limit=` (every `.range()` page and `.limit()` read does). */
  limited: boolean;
  /** `Content-Range` as PostgREST answered it; null when the header was absent or unparseable. */
  rangeStart: number | null;
  rangeEnd: number | null;
  total: number | null;
};

type Recorder = { reads: RecordedRead[] };

const scope = new AsyncLocalStorage<Recorder>();
const installed = Symbol.for("phoenix.mcpSource.fetchRecorder");

// Parses a `Content-Range` such as "0-999/*" or "0-9/10", plus PostgREST's empty answer (a star
// for the range and a zero total).
export function parseContentRange(value: string | null | undefined): Pick<RecordedRead, "rangeStart" | "rangeEnd" | "total"> {
  const empty = { rangeStart: null, rangeEnd: null, total: null };
  const text = String(value ?? "").trim();
  const match = /^(?:(\d+)-(\d+)|\*)\/(\d+|\*)$/.exec(text);
  if (!match) return empty;
  const total = match[3] === "*" ? null : Number(match[3]);
  if (match[1] === undefined) return { rangeStart: null, rangeEnd: null, total };
  return { rangeStart: Number(match[1]), rangeEnd: Number(match[2]), total };
}

/** The relation a `/rest/v1/<name>?...` path reads, or null when the URL is not a PostgREST read. */
export function describeRestUrl(url: string): { relation: string; kind: "table" | "rpc"; limited: boolean; path: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const match = /^\/rest\/v1\/(rpc\/)?([A-Za-z0-9_]+)\/?$/.exec(parsed.pathname);
  if (!match) return null;
  return {
    relation: match[2],
    kind: match[1] ? "rpc" : "table",
    limited: parsed.searchParams.has("limit"),
    path: `${parsed.pathname}${parsed.search}`,
  };
}

function methodOf(input: RequestInfo | URL, init: RequestInit | undefined): string {
  const fromInit = init?.method;
  if (typeof fromInit === "string" && fromInit.length > 0) return fromInit.toUpperCase();
  if (typeof Request !== "undefined" && input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Wraps `globalThis.fetch` once. Safe to call repeatedly. The wrapper is a pass-through whenever no
 * recorder scope is active, and it never alters the response or the thrown error.
 */
export function installReadRecorder(): void {
  const holder = globalThis as unknown as Record<symbol, unknown>;
  if (holder[installed]) return;
  const original = globalThis.fetch;
  holder[installed] = true;
  const wrapper = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const recorder = scope.getStore();
    const described = recorder ? describeRestUrl(urlOf(input)) : null;
    if (!recorder || !described) return original(input, init);
    const method = methodOf(input, init);
    const base = {
      key: `${method} ${described.path}`,
      method,
      relation: described.relation,
      kind: described.kind,
      limited: described.limited,
    };
    try {
      const response = await original(input, init);
      recorder.reads.push({
        ...base,
        status: response.status,
        ok: response.ok,
        ...parseContentRange(response.headers.get("content-range")),
      });
      return response;
    } catch (error) {
      recorder.reads.push({ ...base, status: null, ok: false, rangeStart: null, rangeEnd: null, total: null });
      throw error;
    }
  }) as typeof fetch;
  // Names the fetch it wraps. The test-account fence no longer reads this — it proves itself by a
  // probe through the whole chain (testDryRunFenceIsLive, src/lib/auth/test-dry-run.ts).
  (wrapper as unknown as Record<string, unknown>).__phoenixWrappedFetch = original;
  globalThis.fetch = wrapper;
}

export type RecordedRun<T> =
  | { ok: true; value: T; reads: RecordedRead[] }
  | { ok: false; error: unknown; reads: RecordedRead[] };

/**
 * Runs `work` inside a fresh recorder scope and returns the value together with every request it
 * made. Never throws: a failure of `work` is returned so the caller still gets the read log.
 */
export async function runWithReadRecorder<T>(work: () => Promise<T>): Promise<RecordedRun<T>> {
  installReadRecorder();
  const recorder: Recorder = { reads: [] };
  try {
    const value = await scope.run(recorder, work);
    return { ok: true, value, reads: recorder.reads };
  } catch (error) {
    return { ok: false, error, reads: recorder.reads };
  }
}
