import { NextResponse } from "next/server";

// TEMPORARY DIAGNOSTIC ROUTE (preview-only). Token-guarded, read-only, transient.
// Measures whether a Vercel serverless function can reach the iReports360 CRM
// (login + a heavy month of visits) within time/memory limits. Credentials are
// passed in the POST body for a single transient call and are NEVER stored, logged,
// or persisted. Each external call has its own internal AbortController timeout, so a
// network hang is REPORTED as "aborted" JSON instead of being silently killed at
// maxDuration (502). Remove this route once the root-cause is confirmed.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PROBE_TOKEN = "f43ba33a3c7497505fc6a19fbece69d447dbba2c";

type StepResult = {
  ok: boolean;
  status?: number;
  ms: number;
  bytes?: number;
  aborted?: boolean;
  error?: string;
  text?: string;
};

async function timedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<StepResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetch(url, { ...init, cache: "no-store", signal: ctrl.signal });
    const text = await res.text();
    return { ok: true, status: res.status, ms: Math.round(performance.now() - t0), bytes: text.length, text };
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : "unknown";
    return { ok: false, ms: Math.round(performance.now() - t0), aborted: name === "AbortError", error: `${name}: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

type ProbeBody = { token?: string; base?: string; username?: string; password?: string; start?: string; end?: string };

export async function POST(request: Request) {
  let body: ProbeBody | null = null;
  try { body = (await request.json()) as ProbeBody; } catch { body = null; }

  if (!body || body.token !== PROBE_TOKEN) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const base = (body.base || "").replace(/\/+$/, "");
  const username = body.username || "";
  const password = body.password || "";
  const start = body.start || "2026-05-01";
  const end = body.end || "2026-05-31";
  const mem0 = process.memoryUsage();
  const result: Record<string, unknown> = {
    region: process.env.VERCEL_REGION || "unknown",
    inputPresent: { base: Boolean(base), username: Boolean(username), password: Boolean(password) },
  };

  if (!base || !username || !password) {
    result.note = "missing base/username/password in request body";
    return NextResponse.json(result);
  }

  // Step 1: login (20s internal cap)
  const login = await timedFetch(
    `${base}/api/ReportsApi/login`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) },
    20000,
  );
  let token: string | null = null;
  if (login.ok && login.text) {
    try { token = (JSON.parse(login.text) as { token?: string })?.token ?? null; } catch { token = null; }
  }
  result.login = { ok: login.ok, status: login.status, ms: login.ms, aborted: login.aborted ?? false, hasToken: Boolean(token), error: login.error };
  if (!token) return NextResponse.json(result);

  // Step 2: heavy month of visits (45s internal cap) — the ~7.4 MB download
  const visits = await timedFetch(
    `${base}/api/ReportsApi/visits?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}`,
    { method: "GET", headers: { Authorization: `Bearer ${token}` } },
    45000,
  );
  let count: number | string = "n/a";
  if (visits.ok && visits.text) {
    try {
      const parsed = JSON.parse(visits.text) as { data?: unknown[] };
      count = Array.isArray(parsed?.data) ? parsed.data.length : "n/a";
    } catch { count = "parse_failed"; }
  }
  const mem1 = process.memoryUsage();
  result.visits = { ok: visits.ok, status: visits.status, ms: visits.ms, aborted: visits.aborted ?? false, count, bytes: visits.bytes, error: visits.error };
  result.memory = {
    rssStartMB: Math.round(mem0.rss / 1048576),
    rssAfterMB: Math.round(mem1.rss / 1048576),
    heapAfterMB: Math.round(mem1.heapUsed / 1048576),
  };

  return NextResponse.json(result);
}
