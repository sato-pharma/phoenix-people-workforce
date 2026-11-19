/**
 * AN IN-MEMORY POSTGREST FOR BEHAVIOUR TESTS (REC-078) — the stand-in #569 built for the held-salary and
 * deduction tests, moved here so every money-path test drives the REAL domain code against the same thing.
 *
 * `withStandIn` points the real Supabase admin client at an in-memory PostgREST: tables are arrays of rows,
 * every request is recorded in `seen`, and a request to any other host throws — no network, no environment
 * file, nothing from production. Reads honour the filters below; POST inserts (or upserts, with
 * `on_conflict`), PATCH updates the matching rows, DELETE removes them. A database function is modelled by an
 * `rpc` handler that is handed the live tables; model a function's transaction with `atomically`, which
 * applies the work to a copy and keeps it only if the whole function finished, as Postgres does.
 *
 * Two callers racing: start both calls and `Promise.allSettled` them. Each request is answered in one
 * tick, so an `rpc` handler runs as one indivisible step, exactly like a function holding its row locks;
 * the callers interleave only at their own awaits, as two server requests do.
 */
import { clearModuleLockCache } from "../../src/lib/auth/module-locks.ts";
import { clearPermissionMatrixCache } from "../../src/lib/auth/permissions.ts";

export type Row = Record<string, unknown>;
export type Failure = { status: number; body: Record<string, unknown> };
export type Seen = { method: string; table: string | null; rpc: string | null; params: URLSearchParams; body: unknown };
export type RpcAnswer = { status: number; body: unknown };
export type Tables = Record<string, Row[]>;
export type StandIn = {
  tables: Tables;
  failReads?: Record<string, Failure>;
  failWrites?: Record<string, Failure>;
  /**
   * Fail one table's write only on its Nth write (1-based) — "the second write fails", the forced failure
   * after the first write. Each entry is used once.
   */
  failNthWrite?: Record<string, { nth: number; failure: Failure }>;
  /** A database function. It is handed the args and the live tables; throw a `RpcRaise` to answer an error. */
  rpc?: Record<string, (args: Record<string, unknown>, tables: Tables) => RpcAnswer>;
};

export const STAND_IN_ORIGIN = "http://127.0.0.1:54397";
const RESERVED_PARAMS = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

/** What a database function raises: PostgREST answers it as a 400 with the SQLSTATE and the message. */
export class RpcRaise extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function compare(value: unknown, raw: string): number {
  const left = typeof value === "number" ? value : String(value ?? "");
  const right = typeof value === "number" ? Number(raw) : raw;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function listOf(raw: string): string[] {
  return raw
    .slice(1, -1)
    .split(",")
    .map((item) => item.replace(/^"|"$/g, ""));
}

export function matchesFilter(row: Row, key: string, raw: string): boolean {
  const value = row[key];
  if (raw.startsWith("not.")) return !matchesFilter(row, key, raw.slice(4));
  if (raw.startsWith("eq.")) return String(value ?? "") === raw.slice(3);
  if (raw.startsWith("neq.")) return String(value ?? "") !== raw.slice(4);
  if (raw.startsWith("is.")) {
    const want = raw.slice(3);
    if (want === "null") return value == null;
    if (want === "true") return value === true;
    if (want === "false") return value === false;
    return String(value) === want;
  }
  if (raw.startsWith("in.(") && raw.endsWith(")")) return listOf(raw.slice(3)).includes(String(value ?? ""));
  if (raw.startsWith("gt.")) return value != null && compare(value, raw.slice(3)) > 0;
  if (raw.startsWith("gte.")) return value != null && compare(value, raw.slice(4)) >= 0;
  if (raw.startsWith("lt.")) return value != null && compare(value, raw.slice(3)) < 0;
  if (raw.startsWith("lte.")) return value != null && compare(value, raw.slice(4)) <= 0;
  throw new Error(`the stand-in does not understand the filter ${key}=${raw}`);
}

export function filtered(rows: Row[], params: URLSearchParams): Row[] {
  let out = rows.filter((row) => {
    for (const [key, raw] of params) {
      if (RESERVED_PARAMS.has(key)) continue;
      if (!matchesFilter(row, key, raw)) return false;
    }
    return true;
  });
  const order = params.get("order");
  if (order) {
    const keys = order.split(",").map((part) => {
      const [column, direction] = part.split(".");
      return { column, desc: direction === "desc" };
    });
    out = [...out].sort((left, right) => {
      for (const { column, desc } of keys) {
        const a = left[column];
        const b = right[column];
        const cmp = typeof a === "number" && typeof b === "number" ? a - b : String(a ?? "").localeCompare(String(b ?? ""));
        if (cmp !== 0) return desc ? -cmp : cmp;
      }
      return 0;
    });
  }
  const offset = Number(params.get("offset") ?? 0);
  const limit = params.get("limit");
  if (offset > 0 || limit != null) out = out.slice(offset, limit == null ? undefined : offset + Number(limit));
  return out;
}

/** A deep copy of every table, for "the tables afterwards equal the tables before". */
export function snapshot(tables: Tables): Tables {
  return JSON.parse(JSON.stringify(tables)) as Tables;
}

/**
 * Model one database function's transaction: `work` changes a copy of the tables; if it returns, the copy
 * replaces the tables, and if it throws, nothing it did is kept. Returns what `work` returned.
 */
export function atomically<T>(tables: Tables, work: (draft: Tables) => T): T {
  const draft = snapshot(tables);
  const result = work(draft);
  for (const key of Object.keys(tables)) if (!(key in draft)) delete tables[key];
  for (const [key, rows] of Object.entries(draft)) tables[key] = rows;
  return result;
}

/**
 * Runs `body` against the REAL admin client pointed at an in-memory PostgREST. Every request is recorded;
 * a request to any other host throws. The fetch, both settings and the permission and lock caches are put
 * back afterwards, so nothing later in the shard talks to the stand-in (a leaked stub hangs a later test).
 */
export async function withStandIn(standIn: StandIn, body: (seen: Seen[]) => Promise<void>): Promise<void> {
  const seen: Seen[] = [];
  const writeCounts = new Map<string, number>();
  const env = process.env as Record<string, string | undefined>;
  const realFetch = globalThis.fetch;
  const realUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const realKey = env.SUPABASE_SERVICE_ROLE_KEY;
  env.NEXT_PUBLIC_SUPABASE_URL = STAND_IN_ORIGIN;
  env.SUPABASE_SERVICE_ROLE_KEY = "stand-in-key-never-sent";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    if (url.origin !== STAND_IN_ORIGIN) throw new Error(`the stand-in refuses to reach ${url.origin}`);
    const method = String(init?.method ?? request?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? request?.headers ?? undefined);
    const wantsObject = (headers.get("accept") ?? "").includes("vnd.pgrst.object");
    const rawBody = typeof init?.body === "string" ? init.body : request && !init?.body ? await request.clone().text() : "";
    const parsed: unknown = rawBody ? JSON.parse(rawBody) : null;

    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const name = decodeURIComponent(url.pathname.slice("/rest/v1/rpc/".length));
      seen.push({ body: parsed, method, params: url.searchParams, rpc: name, table: null });
      const handler = standIn.rpc?.[name];
      if (!handler) return json({ code: "PGRST202", message: `stand-in has no function ${name}` }, 404);
      try {
        const answer = handler((parsed ?? {}) as Record<string, unknown>, standIn.tables);
        return json(answer.body, answer.status);
      } catch (error) {
        if (error instanceof RpcRaise) return json({ code: error.code, details: null, hint: null, message: error.message }, error.status);
        throw error;
      }
    }
    if (!url.pathname.startsWith("/rest/v1/")) {
      seen.push({ body: parsed, method, params: url.searchParams, rpc: null, table: url.pathname });
      return json({}, 200);
    }

    const table = decodeURIComponent(url.pathname.slice("/rest/v1/".length));
    seen.push({ body: parsed, method, params: url.searchParams, rpc: null, table });
    if (method === "GET" || method === "HEAD") {
      const failure = standIn.failReads?.[table];
      if (failure) return json(failure.body, failure.status);
      // A read never creates a table: a stray background read from an earlier test (the audit outbox drain, say)
      // must not change the tables a test compares before and after.
      const matches = filtered(standIn.tables[table] ?? [], url.searchParams);
      if (wantsObject) {
        if (matches.length !== 1) {
          return json(
            { code: "PGRST116", details: `The result contains ${matches.length} rows`, hint: null, message: "JSON object requested, multiple (or no) rows returned" },
            406,
          );
        }
        return json(matches[0]);
      }
      return json(matches);
    }

    const failure = standIn.failWrites?.[table];
    if (failure) return json(failure.body, failure.status);
    const rows = (standIn.tables[table] ??= []);
    const count = (writeCounts.get(table) ?? 0) + 1;
    writeCounts.set(table, count);
    const nth = standIn.failNthWrite?.[table];
    if (nth && nth.nth === count) {
      delete standIn.failNthWrite?.[table];
      return json(nth.failure.body, nth.failure.status);
    }
    let written: Row[] = [];
    if (method === "POST") {
      const incoming = (Array.isArray(parsed) ? parsed : [parsed]) as Row[];
      const conflict = url.searchParams.get("on_conflict")?.split(",").map((part) => part.trim()).filter(Boolean) ?? [];
      const ignore = (headers.get("prefer") ?? "").includes("ignore-duplicates");
      for (const row of incoming) {
        const existing = conflict.length > 0 ? rows.find((candidate) => conflict.every((key) => String(candidate[key] ?? "") === String(row[key] ?? ""))) : undefined;
        if (existing) {
          if (!ignore) Object.assign(existing, row);
          written.push({ ...existing });
        } else {
          const copy = { ...row };
          rows.push(copy);
          written.push({ ...copy });
        }
      }
    } else if (method === "PATCH") {
      for (const row of filtered(rows, url.searchParams)) {
        Object.assign(row, parsed as Row);
        written.push({ ...row });
      }
    } else if (method === "DELETE") {
      const doomed = filtered(rows, url.searchParams);
      written = doomed.map((row) => ({ ...row }));
      standIn.tables[table] = rows.filter((row) => !doomed.includes(row));
    }
    return json(wantsObject ? written[0] ?? null : written, method === "POST" ? 201 : 200);
  }) as typeof fetch;

  try {
    await body(seen);
  } finally {
    globalThis.fetch = realFetch;
    if (realUrl === undefined) delete env.NEXT_PUBLIC_SUPABASE_URL;
    else env.NEXT_PUBLIC_SUPABASE_URL = realUrl;
    if (realKey === undefined) delete env.SUPABASE_SERVICE_ROLE_KEY;
    else env.SUPABASE_SERVICE_ROLE_KEY = realKey;
    clearPermissionMatrixCache();
    clearModuleLockCache();
  }
}

export const writesTo = (seen: Seen[], table: string): Seen[] =>
  seen.filter((request) => request.table === table && request.method !== "GET" && request.method !== "HEAD");
export const rpcCalls = (seen: Seen[], name: string): Seen[] => seen.filter((request) => request.rpc === name);
export const anyWrite = (seen: Seen[]): Seen[] =>
  seen.filter((request) => request.method !== "GET" && request.method !== "HEAD" && request.rpc === null);
