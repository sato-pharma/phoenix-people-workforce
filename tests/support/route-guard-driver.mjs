// Run by tests/route-guard-harness.test.ts, one process per slice of route files (REC-080).
//
// It imports each route file's REAL handlers and calls every mutating method (POST, PATCH, PUT, DELETE)
// the way Next does — a NextRequest, a params promise, inside Next's own request scope — once for each
// caller the parent names (a signed-out visitor, a role that should be refused). The database is a
// stand-in that records every call and answers like an empty PostgREST; every other way out of the
// process (fetch to another host, http/https, raw sockets) is recorded and blocked. Nothing leaves the
// machine, and no environment file is read: the parent hands this process a clean environment.
//
// It writes one JSON line per result to the output file AS IT GOES, so a slice that is killed for taking
// too long still reports every route it finished, and the parent can name the ones it never reached.
//
// Arguments: <jobs.json> <results.jsonl>
//   jobs.json: [{ file, route, urlPath, params, calls: [{ method, callers: [{ label, headers }] }] }]
// Each result line: { type: "import" | "call", ... } — see emit() calls below.
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { pathToFileURL } from "node:url";

// Next's request storage takes AsyncLocalStorage from globalThis when it is first imported.
globalThis.AsyncLocalStorage = AsyncLocalStorage;

const [jobsPath, resultsPath] = process.argv.slice(2);
if (!jobsPath || !resultsPath) {
  console.error("usage: route-guard-driver.mjs <jobs.json> <results.jsonl>");
  process.exit(2);
}
const jobs = JSON.parse(readFileSync(jobsPath, "utf8"));
writeFileSync(resultsPath, "");
const emit = (record) => appendFileSync(resultsPath, `${JSON.stringify(record)}\n`);

const STAND_IN_HOST = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://guard-harness.invalid").host;
const CALL_TIMEOUT_MS = Number(process.env.GUARD_HARNESS_CALL_TIMEOUT_MS ?? 8000);
const SETTLE_MS = Number(process.env.GUARD_HARNESS_SETTLE_MS ?? 30);

// ── The recorder ─────────────────────────────────────────────────────────────────────────────────────
// Calls run one at a time, so the events of whatever is running belong to it. Anything that fires while
// no call is running (a module's own start-up work, a timer from an earlier call) goes to `idle`.
const idle = { events: [] };
let current = idle;
const record = (event) => current.events.push(event);

function jsonResponse(status, body, extraHeaders = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    headers: { "content-type": "application/json", ...extraHeaders },
    status,
  });
}

function wantsObject(headers) {
  return (headers.get("accept") ?? "").includes("vnd.pgrst.object");
}

/** The stand-in database: an empty PostgREST, an empty storage and auth, and every call recorded. */
function standInAnswer(url, method, headers) {
  const write = method !== "GET" && method !== "HEAD";
  const pathname = url.pathname;
  if (pathname.startsWith("/rest/v1/rpc/")) {
    const name = decodeURIComponent(pathname.slice("/rest/v1/rpc/".length));
    record({ kind: "rpc", method, target: name });
    if (name === "api_rate_limit_consume") {
      const row = { allowed: true, retry_after_seconds: 0 };
      return jsonResponse(200, wantsObject(headers) ? row : [row]);
    }
    return jsonResponse(200, wantsObject(headers) ? null : []);
  }
  if (pathname.startsWith("/rest/v1/")) {
    const table = decodeURIComponent(pathname.slice("/rest/v1/".length).split("/")[0] ?? "");
    if (write) {
      record({ kind: "db", method, target: table });
      return jsonResponse(201, wantsObject(headers) ? { id: "00000000-0000-4000-8000-000000000000" } : []);
    }
    record({ kind: "read", method, target: table });
    if (wantsObject(headers)) return jsonResponse(406, { code: "PGRST116", details: "The result contains 0 rows", message: "JSON object requested, multiple (or no) rows returned" });
    return jsonResponse(200, method === "HEAD" ? undefined : [], { "content-range": "*/0" });
  }
  const kind = pathname.startsWith("/storage/v1/") ? "storage" : pathname.startsWith("/auth/v1/") ? "auth" : "other";
  record({ kind: write ? kind : "read", method, target: pathname });
  if (!write) return jsonResponse(kind === "storage" ? 404 : 200, kind === "storage" ? { error: "not_found", message: "Object not found" } : []);
  return jsonResponse(kind === "storage" ? 400 : 200, kind === "storage" ? { error: "guard_harness", message: "stand-in storage refuses writes" } : {});
}

globalThis.fetch = async (input, init = {}) => {
  const request = input instanceof Request ? input : null;
  const url = new URL(request ? request.url : String(input));
  const method = String(init.method ?? request?.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers ?? request?.headers ?? undefined);
  if (url.host !== STAND_IN_HOST) {
    record({ kind: "outbound", method, target: `${url.host}${url.pathname}` });
    return jsonResponse(503, { error: "guard_harness_outbound_blocked" });
  }
  return standInAnswer(url, method, headers);
};

function hostOf(args) {
  const first = args[0];
  if (typeof first === "string") return first;
  if (first instanceof URL) return first.host;
  if (first && typeof first === "object") return String(first.host ?? first.hostname ?? first.path ?? "socket");
  return String(first ?? "unknown");
}

function blocked(via) {
  return (...args) => {
    record({ kind: "outbound", method: via, target: hostOf(args) });
    throw new Error(`guard harness: ${via} blocked (${hostOf(args)})`);
  };
}

for (const [name, mod] of [["http", http], ["https", https]]) {
  mod.request = blocked(`${name}.request`);
  mod.get = blocked(`${name}.get`);
}
net.connect = blocked("net.connect");
net.createConnection = blocked("net.createConnection");
tls.connect = blocked("tls.connect");
syncBuiltinESMExports();

const unhandled = [];
process.on("unhandledRejection", (reason) => {
  unhandled.push(String(reason?.message ?? reason).slice(0, 200));
});
process.on("uncaughtException", (error) => {
  unhandled.push(String(error?.message ?? error).slice(0, 200));
});

// ── Next's request scope ─────────────────────────────────────────────────────────────────────────────
const { workAsyncStorage } = (await import("next/dist/server/app-render/work-async-storage.external.js")).default;
const { workUnitAsyncStorage } = (await import("next/dist/server/app-render/work-unit-async-storage.external.js")).default;
const cookiesModule = (await import("next/dist/compiled/@edge-runtime/cookies/index.js")).default;
const { NextRequest } = await import("next/server.js");

function inRequestScope(route, request, run) {
  const afterTasks = [];
  const workStore = {
    afterContext: {
      after(task) {
        afterTasks.push(typeof task === "function" ? Promise.resolve().then(task) : Promise.resolve(task));
      },
    },
    route,
  };
  const responseCookies = new cookiesModule.ResponseCookies(new Headers());
  const workUnitStore = {
    cookies: new cookiesModule.RequestCookies(request.headers),
    headers: request.headers,
    mutableCookies: responseCookies,
    phase: "action",
    type: "request",
    userspaceMutableCookies: responseCookies,
  };
  return workAsyncStorage.run(workStore, () =>
    workUnitAsyncStorage.run(workUnitStore, async () => {
      try {
        return await run();
      } finally {
        await Promise.allSettled(afterTasks);
      }
    }),
  );
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`guard harness: no answer within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

function paramsFor(job) {
  const params = job.params ?? {};
  // Next 16 hands a promise; an older handler reads the fields directly, so both shapes are offered.
  return Object.assign(Promise.resolve(params), params);
}

// ── The run ──────────────────────────────────────────────────────────────────────────────────────────
for (const job of jobs) {
  current = { events: [] };
  const importStartedAt = Date.now();
  let mod;
  try {
    mod = await import(pathToFileURL(path.resolve(job.file)).href);
  } catch (error) {
    emit({ type: "import", file: job.file, route: job.route, ok: false, error: String(error?.message ?? error).split("\n")[0].slice(0, 300) });
    current = idle;
    continue;
  }
  const startupEvents = current.events.filter((event) => event.kind !== "read");
  emit({ type: "import", file: job.file, route: job.route, ok: true, ms: Date.now() - importStartedAt, startupEvents });
  current = idle;

  for (const { method, callers } of job.calls) {
    const handler = mod[method];
    if (typeof handler !== "function") {
      emit({ type: "call", file: job.file, route: job.route, method, caller: "*", missing: true });
      continue;
    }
    for (const caller of callers) {
      const call = { events: [] };
      current = call;
      const startedAt = Date.now();
      let status = null;
      let threw = null;
      let bodyText = "";
      try {
        const request = new NextRequest(`http://localhost:3000${job.urlPath}`, {
          body: "{}",
          headers: caller.headers,
          method,
        });
        const response = await withTimeout(
          inRequestScope(job.route, request, () => handler(request, { params: paramsFor(job) })),
          CALL_TIMEOUT_MS,
        );
        status = typeof response?.status === "number" ? response.status : null;
        if (response && typeof response.text === "function") {
          bodyText = await withTimeout(response.text(), 2000).catch(() => "");
        }
      } catch (error) {
        threw = String(error?.message ?? error).split("\n")[0].slice(0, 300);
      }
      await settle();
      current = idle;
      emit({
        type: "call",
        file: job.file,
        route: job.route,
        method,
        caller: caller.label,
        status,
        threw,
        body: bodyText.slice(0, 160),
        events: call.events.filter((event) => event.kind !== "read"),
        ms: Date.now() - startedAt,
      });
    }
  }
}

emit({ type: "done", unhandled: unhandled.slice(0, 20), idleEvents: idle.events.filter((event) => event.kind !== "read").slice(0, 40) });
// A module can leave a timer or a socket behind; the slice is finished either way.
process.exit(0);
