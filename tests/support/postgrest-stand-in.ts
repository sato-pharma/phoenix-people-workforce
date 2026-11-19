import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

import { clearModuleLockCache } from "../../src/lib/auth/module-locks.ts";
import { clearPermissionMatrixCache } from "../../src/lib/auth/permissions.ts";
import { invalidateEmployeeDirectoryCache } from "../../src/lib/employees/employee-directory.ts";

/**
 * ONE in-memory PostgREST for the behaviour tests (REC-078 / REC-079, phase 2).
 *
 * The REAL admin client (`getSupabaseAdmin()`) is pointed at an address nothing listens on, and the
 * global fetch answers it from tables held in memory. Every request is recorded in the order it was
 * made, so a test can assert what the code WROTE, in what order, and that it wrote nothing at all
 * when it refused. The shape is the one tests/payroll-ledger-and-permission-behaviour.test.ts (#569)
 * proved, widened to the filters, upserts and counts the leave, hire, exit and folder tests need.
 *
 * What it guarantees while a body runs, and puts back afterwards:
 *  - no request leaves the machine: fetch to any other host is recorded as `outbound` and answered
 *    503, and http/https/net/tls are refused outright (an SMTP or socket path cannot slip past);
 *  - no environment file is read, and the two Supabase settings are the stand-in's own;
 *  - the permission matrix, the module locks and the employee directory are dropped before and after,
 *    so nothing cached from the stand-in leaks into a later test in the same shard.
 *
 * It understands the filters these suites send (eq, neq, is, in, gt, gte, lt, lte, like, ilike,
 * not.<op>, or=(…), and=(…)), order on several columns, limit/offset, exact counts, single-row
 * answers, insert, upsert on a conflict key, update and delete. A filter it does not understand is
 * answered 400 with its name, so a test never passes by reading rows the code did not ask for.
 */

export type Row = Record<string, unknown>;
export type Failure = { status: number; body: Record<string, unknown> };
export type RpcAnswer = { status: number; body: unknown };

export type Seen = {
  /** read = GET/HEAD on a table; write = POST/PATCH/DELETE on a table; rpc; storage; auth; outbound. */
  kind: "read" | "write" | "rpc" | "storage" | "auth" | "outbound" | "other";
  method: string;
  table: string | null;
  rpc: string | null;
  params: URLSearchParams;
  body: unknown;
  headers: Headers;
  /** The host for an outbound call, the path for everything else. */
  target: string;
};

export type StandIn = {
  tables: Record<string, Row[]>;
  /** A read of this table answers the failure instead (a function sees the request first). */
  failReads?: Record<string, Failure | ((seen: Seen) => Failure | null)>;
  /** A write to this table answers the failure instead. */
  failWrites?: Record<string, Failure | ((seen: Seen) => Failure | null)>;
  /** A function call answers what its handler returns; a plain value is a 200 body. */
  rpc?: Record<string, (args: Record<string, unknown>, standIn: StandIn) => RpcAnswer | unknown>;
  /** Unknown functions answer 404 PGRST202 unless this says otherwise. */
  unknownRpc?: (name: string, args: Record<string, unknown>) => RpcAnswer;
};

export const STAND_IN_ORIGIN = "http://127.0.0.1:54399";
const RESERVED_PARAMS = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    headers: { "content-type": "application/json", ...extraHeaders },
    status,
  });
}

class UnsupportedFilter extends Error {}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).replace(/\\"/g, '"') : value;
}

function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const character of list) {
    if (character === '"') quoted = !quoted;
    if (!quoted && character === "(") depth += 1;
    if (!quoted && character === ")") depth -= 1;
    if (!quoted && depth === 0 && character === ",") {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current) parts.push(current);
  return parts;
}

function likeToRegExp(pattern: string, flags: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/[*%]/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${escaped}$`, flags);
}

function compare(a: unknown, b: string): number {
  const left = a == null ? "" : String(a);
  const leftNumber = Number(left);
  const rightNumber = Number(b);
  if (left !== "" && b !== "" && Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  return left.localeCompare(b);
}

/** One `<operator>.<value>` against one column's value. */
function matchesOperator(value: unknown, raw: string): boolean {
  if (raw.startsWith("not.")) return !matchesOperator(value, raw.slice(4));
  const dot = raw.indexOf(".");
  const operator = dot === -1 ? raw : raw.slice(0, dot);
  const operand = dot === -1 ? "" : raw.slice(dot + 1);
  switch (operator) {
    case "eq":
      return value != null && String(value) === unquote(operand);
    case "neq":
      return value == null || String(value) !== unquote(operand);
    case "is":
      if (operand === "null") return value == null;
      if (operand === "true") return value === true;
      if (operand === "false") return value === false;
      throw new UnsupportedFilter(`is.${operand}`);
    case "in": {
      if (!operand.startsWith("(") || !operand.endsWith(")")) throw new UnsupportedFilter(`in.${operand}`);
      const items = splitTopLevel(operand.slice(1, -1)).map(unquote);
      return value != null && items.includes(String(value));
    }
    case "gt":
      return value != null && compare(value, unquote(operand)) > 0;
    case "gte":
      return value != null && compare(value, unquote(operand)) >= 0;
    case "lt":
      return value != null && compare(value, unquote(operand)) < 0;
    case "lte":
      return value != null && compare(value, unquote(operand)) <= 0;
    case "like":
      return value != null && likeToRegExp(unquote(operand), "").test(String(value));
    case "ilike":
      return value != null && likeToRegExp(unquote(operand), "i").test(String(value));
    case "cs": {
      if (!Array.isArray(value)) return false;
      const wanted = operand.replace(/^\{|\}$/g, "").split(",").filter(Boolean).map(unquote);
      return wanted.every((item) => value.map(String).includes(item));
    }
    default:
      throw new UnsupportedFilter(`${operator}.${operand}`);
  }
}

/** `col.op.value` inside an or=( … ) or and=( … ) group, nested groups included. */
function matchesCondition(row: Row, condition: string): boolean {
  const trimmed = condition.trim();
  for (const group of ["or", "and", "not.or", "not.and"] as const) {
    if (trimmed.startsWith(`${group}(`) && trimmed.endsWith(")")) {
      const inner = splitTopLevel(trimmed.slice(group.length + 1, -1));
      const result = group.endsWith("or") ? inner.some((part) => matchesCondition(row, part)) : inner.every((part) => matchesCondition(row, part));
      return group.startsWith("not.") ? !result : result;
    }
  }
  const dot = trimmed.indexOf(".");
  if (dot === -1) throw new UnsupportedFilter(trimmed);
  return matchesOperator(row[trimmed.slice(0, dot)], trimmed.slice(dot + 1));
}

function matchesParam(row: Row, key: string, raw: string): boolean {
  if (key === "or" || key === "and") return matchesCondition(row, `${key}${raw}`);
  if (key === "not.or" || key === "not.and") return matchesCondition(row, `${key}${raw}`);
  if (key.includes("->")) throw new UnsupportedFilter(`${key}=${raw}`);
  return matchesOperator(row[key], raw);
}

export function filterRows(rows: Row[], params: URLSearchParams): Row[] {
  let out = rows.filter((row) => {
    for (const [key, raw] of params) {
      if (RESERVED_PARAMS.has(key)) continue;
      if (!matchesParam(row, key, raw)) return false;
    }
    return true;
  });
  const order = params.get("order");
  if (order) {
    const keys = order.split(",").map((part) => {
      const [column, ...modifiers] = part.split(".");
      return { column, descending: modifiers.includes("desc"), nullsFirst: modifiers.includes("nullsfirst") };
    });
    out = [...out].sort((left, right) => {
      for (const key of keys) {
        const a = left[key.column];
        const b = right[key.column];
        if (a == null && b == null) continue;
        if (a == null) return key.nullsFirst ? -1 : 1;
        if (b == null) return key.nullsFirst ? 1 : -1;
        const result = compare(a, String(b));
        if (result !== 0) return key.descending ? -result : result;
      }
      return 0;
    });
  }
  const offset = Number(params.get("offset") ?? 0) || 0;
  const limit = params.get("limit");
  if (offset || limit) out = out.slice(offset, limit ? offset + Number(limit) : undefined);
  return out;
}

function failureFor(entry: Failure | ((seen: Seen) => Failure | null) | undefined, seen: Seen): Failure | null {
  if (!entry) return null;
  return typeof entry === "function" ? entry(seen) : entry;
}

let idCounter = 0;
function standInId(): string {
  idCounter += 1;
  return `00000000-0000-4000-8000-${String(idCounter).padStart(12, "0")}`;
}

function answerTable(standIn: StandIn, seen: Seen, url: URL): Response {
  const table = seen.table ?? "";
  // A read never creates a table, so "nothing changed" can be asserted by comparing the whole world.
  const isRead = seen.method === "GET" || seen.method === "HEAD";
  const rows = isRead ? standIn.tables[table] ?? [] : (standIn.tables[table] ??= []);
  const wantsObject = (seen.headers.get("accept") ?? "").includes("vnd.pgrst.object");
  const prefer = seen.headers.get("prefer") ?? "";

  try {
    if (seen.method === "GET" || seen.method === "HEAD") {
      const failure = failureFor(standIn.failReads?.[table], seen);
      if (failure) return json(failure.body, failure.status);
      const all = filterRows(rows, new URLSearchParams([...url.searchParams].filter(([key]) => key !== "limit" && key !== "offset")));
      const matches = filterRows(rows, url.searchParams);
      const range = { "content-range": `${matches.length ? `0-${matches.length - 1}` : "*"}/${prefer.includes("count=") ? all.length : "*"}` };
      if (seen.method === "HEAD") return new Response(null, { headers: range, status: 200 });
      if (wantsObject) {
        if (matches.length !== 1) {
          return json(
            { code: "PGRST116", details: `The result contains ${matches.length} rows`, hint: null, message: "JSON object requested, multiple (or no) rows returned" },
            406,
          );
        }
        return json(structuredClone(matches[0]), 200, range);
      }
      return json(structuredClone(matches), 200, range);
    }

    const failure = failureFor(standIn.failWrites?.[table], seen);
    if (failure) return json(failure.body, failure.status);

    let written: Row[] = [];
    if (seen.method === "POST") {
      const incoming = (Array.isArray(seen.body) ? seen.body : [seen.body]) as Row[];
      const conflictKey = url.searchParams.get("on_conflict")?.split(",").map((column) => column.trim()).filter(Boolean) ?? [];
      const merge = prefer.includes("resolution=merge-duplicates");
      const ignore = prefer.includes("resolution=ignore-duplicates");
      for (const candidate of incoming) {
        const existing = conflictKey.length
          ? rows.find((row) => conflictKey.every((column) => String(row[column] ?? "") === String(candidate[column] ?? "")))
          : undefined;
        if (existing && (merge || ignore)) {
          if (merge) Object.assign(existing, candidate);
          if (merge) written.push(structuredClone(existing));
          continue;
        }
        if (existing) {
          return json({ code: "23505", details: null, hint: null, message: `duplicate key value violates unique constraint on ${table}` }, 409);
        }
        const now = new Date().toISOString();
        const row = { created_at: now, id: standInId(), ...candidate };
        rows.push(row);
        written.push(structuredClone(row));
      }
    } else if (seen.method === "PATCH") {
      for (const row of filterRows(rows, url.searchParams)) {
        Object.assign(row, seen.body as Row);
        written.push(structuredClone(row));
      }
    } else if (seen.method === "DELETE") {
      const removed = filterRows(rows, url.searchParams);
      standIn.tables[table] = rows.filter((row) => !removed.includes(row));
      written = removed.map((row) => structuredClone(row));
    }
    if (wantsObject) {
      if (written.length !== 1) {
        return json(
          { code: "PGRST116", details: `The result contains ${written.length} rows`, hint: null, message: "JSON object requested, multiple (or no) rows returned" },
          406,
        );
      }
      return json(written[0], seen.method === "POST" ? 201 : 200);
    }
    return json(written, seen.method === "POST" ? 201 : 200);
  } catch (error) {
    if (error instanceof UnsupportedFilter) {
      return json({ code: "STANDIN", details: null, hint: null, message: `the stand-in does not understand the filter ${error.message} on ${table}` }, 400);
    }
    throw error;
  }
}

type Blockable = { target: Record<string, unknown>; name: string; original: unknown };

const QUIET_SPELL_MS = 60;
const QUIET_CEILING_MS = 3_000;

async function quiet(seen: Seen[]): Promise<void> {
  const started = Date.now();
  let count = -1;
  while (count !== seen.length && Date.now() - started < QUIET_CEILING_MS) {
    count = seen.length;
    await new Promise((resolve) => setTimeout(resolve, QUIET_SPELL_MS));
  }
}

/**
 * Runs `body` against the stand-in. `seen` is every request, in order. Everything the stand-in
 * replaced — fetch, the Supabase settings, the socket modules, the caches — is put back in `finally`.
 */
export async function withPostgrestStandIn(
  standIn: StandIn,
  body: (seen: Seen[]) => Promise<void>,
  options: { resets?: Array<() => void>; env?: Record<string, string> } = {},
): Promise<Seen[]> {
  const seen: Seen[] = [];
  const env = process.env as Record<string, string | undefined>;
  // `options.env` adds settings for this body only — e.g. the dev sign-in headers a real route handler
  // reads (NODE_ENV=development, PHOENIX_ENABLE_DEV_AUTH_HEADERS=true). Restored with the rest.
  const settings: Record<string, string> = {
    ...(options.env ?? {}),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "stand-in-anon-key-never-sent",
    NEXT_PUBLIC_SUPABASE_URL: STAND_IN_ORIGIN,
    SUPABASE_SERVICE_ROLE_KEY: "stand-in-service-key-never-sent",
  };
  const savedEnv = Object.keys(settings).map((name) => [name, env[name]] as const);
  const realFetch = globalThis.fetch;
  const resets = [clearPermissionMatrixCache, clearModuleLockCache, invalidateEmployeeDirectoryCache, ...(options.resets ?? [])];

  const record = (entry: Omit<Seen, "params" | "headers"> & { params?: URLSearchParams; headers?: Headers }) => {
    const full: Seen = { headers: new Headers(), params: new URLSearchParams(), ...entry };
    seen.push(full);
    return full;
  };

  const blocked: Blockable[] = [];
  const block = (target: Record<string, unknown>, name: string, via: string) => {
    blocked.push({ name, original: target[name], target });
    target[name] = (...args: unknown[]) => {
      const first = args[0] as { host?: unknown; hostname?: unknown } | string | undefined;
      const host = typeof first === "string" ? first : String(first?.host ?? first?.hostname ?? "socket");
      record({ body: null, kind: "outbound", method: via, rpc: null, table: null, target: host });
      throw new Error(`the stand-in refuses ${via} to ${host}`);
    };
  };

  Object.assign(env, settings);
  for (const reset of resets) reset();
  block(http as unknown as Record<string, unknown>, "request", "http.request");
  block(http as unknown as Record<string, unknown>, "get", "http.get");
  block(https as unknown as Record<string, unknown>, "request", "https.request");
  block(https as unknown as Record<string, unknown>, "get", "https.get");
  block(net as unknown as Record<string, unknown>, "connect", "net.connect");
  block(net as unknown as Record<string, unknown>, "createConnection", "net.createConnection");
  block(tls as unknown as Record<string, unknown>, "connect", "tls.connect");
  syncBuiltinESMExports();

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    const method = String(init?.method ?? request?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? request?.headers ?? undefined);
    let parsed: unknown = null;
    const rawBody = typeof init?.body === "string" ? init.body : null;
    if (rawBody) {
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        parsed = rawBody;
      }
    }
    if (url.origin !== STAND_IN_ORIGIN) {
      record({ body: parsed, headers, kind: "outbound", method, rpc: null, table: null, target: url.host });
      return json({ error: "stand_in_outbound_blocked" }, 503);
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const name = decodeURIComponent(url.pathname.slice("/rest/v1/rpc/".length));
      record({ body: parsed, headers, kind: "rpc", method, params: url.searchParams, rpc: name, table: null, target: url.pathname });
      const args = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
      const handler = standIn.rpc?.[name];
      if (!handler) {
        const answer = standIn.unknownRpc?.(name, args) ?? { body: { code: "PGRST202", message: `the stand-in has no function ${name}` }, status: 404 };
        return json(answer.body, answer.status);
      }
      const answer = handler(args, standIn);
      if (answer && typeof answer === "object" && "status" in answer && "body" in answer) {
        return json((answer as RpcAnswer).body, (answer as RpcAnswer).status);
      }
      return json(answer, 200);
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      const table = decodeURIComponent(url.pathname.slice("/rest/v1/".length).split("/")[0] ?? "");
      const kind = method === "GET" || method === "HEAD" ? "read" : "write";
      const entry = record({ body: parsed, headers, kind, method, params: url.searchParams, rpc: null, table, target: url.pathname });
      return answerTable(standIn, entry, url);
    }
    const kind = url.pathname.startsWith("/storage/v1/") ? "storage" : url.pathname.startsWith("/auth/v1/") ? "auth" : "other";
    record({ body: parsed, headers, kind, method, params: url.searchParams, rpc: null, table: null, target: url.pathname });
    if (kind === "storage") return json({ error: "not_found", message: "the stand-in stores no files", statusCode: "404" }, 404);
    return json({}, 200);
  }) as typeof fetch;

  try {
    await body(seen);
  } finally {
    // Work the code started and did not await (a `void notify(...)`) must finish against the stand-in,
    // never against whatever the environment points at once it is restored: wait until no request has
    // arrived for a quiet spell, up to a ceiling.
    await quiet(seen);
    globalThis.fetch = realFetch;
    for (const entry of blocked.reverse()) entry.target[entry.name] = entry.original;
    syncBuiltinESMExports();
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    for (const reset of resets) reset();
  }
  return seen;
}

/**
 * One active `workflow_registry_modules` row the registry loader accepts: every status the actions
 * name, each action leaving `from` for `to` and open to `roles`. The older modules fail CLOSED on a
 * missing row, so a test that drives their decisions seeds the rule it relies on, and nothing more.
 */
export function registryModuleRow(
  moduleKey: string,
  actions: Array<{ key: string; from: string[]; to: string; roles: string[] }>,
): Row {
  const statusKeys = [...new Set(actions.flatMap((action) => [...action.from, action.to]))].filter(
    (key) => key !== "deleted" && key !== "unchanged",
  );
  return {
    actions: actions.map((action) => ({
      allowedRoles: action.roles,
      auditLog: `${moduleKey}.${action.key}`,
      from: action.from,
      key: action.key,
      label: action.key,
      to: action.to,
    })),
    created_at: "2026-11-01T00:00:00+00:00",
    created_by: "stand-in",
    description: "seeded by a behaviour test",
    id: `registry-${moduleKey}`,
    is_active: true,
    module_key: moduleKey,
    module_name: moduleKey,
    statuses: statusKeys.map((key) => ({ key, label: key })),
    updated_at: "2026-11-01T00:00:00+00:00",
    updated_by: "stand-in",
    version: 1,
  };
}

/** What a real route handler needs to accept the dev sign-in headers (`x-phoenix-role`, `x-phoenix-hr-id`). */
export const DEV_AUTH_ENV: Record<string, string> = { NODE_ENV: "development", PHOENIX_ENABLE_DEV_AUTH_HEADERS: "true" };

/** A same-origin request to a route handler, signed in through the dev headers as `role` / `hrId`. */
export function devAuthRequest(method: string, path: string, who: { role: string; hrId: string }, body: unknown = {}): Request {
  return new Request(`http://localhost:3000${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      host: "localhost:3000",
      origin: "http://localhost:3000",
      "x-phoenix-hr-id": who.hrId,
      "x-phoenix-role": who.role,
    },
    method,
  });
}

/** The answer the shared rate limiter reads: allowed, no wait. */
export const RATE_LIMIT_ALLOWS = { api_rate_limit_consume: () => [{ allowed: true, retry_after_seconds: 0 }] };

/** The writes (insert, update, upsert, delete) to one table, in order. */
export const writesTo = (seen: Seen[], table: string) => seen.filter((entry) => entry.kind === "write" && entry.table === table);
/** The calls of one database function, in order. */
export const rpcCalls = (seen: Seen[], name: string) => seen.filter((entry) => entry.kind === "rpc" && entry.rpc === name);
/** Every call that tried to leave the machine. */
export const outboundCalls = (seen: Seen[]) => seen.filter((entry) => entry.kind === "outbound");
/** The body of a write as one row (an insert sends an array of one). */
export function writtenRow(entry: Seen): Row {
  return (Array.isArray(entry.body) ? entry.body[0] : entry.body) as Row;
}
