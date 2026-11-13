// The in-process rate limits are bounded, and a full one makes room instead of refusing everybody
// (audit, 2026-10-26, points 21, 22 and 23).
//
// 21/22: the WhatsApp embedded-signup route and the crash-report route caught a bucket-store error and
// let the request through with NO limit; the limiter's own in-process fallback was a Map that only
// grew. Both routes now opt in to onStoreError "memory" (a bounded map), and every other caller has
// a store error thrown at it, so it fails closed.
//
// 23: the page-timing beacon capped its address map at 5,000 and then refused EVERY caller, so 5,000
// rotating addresses switched the beacon off for everybody until a restart. A full map now evicts.
//
// No database is reached: the limiter tests take the Supabase settings out of process.env first, so
// the store "fails" before any client is built, in CI (which carries real credentials) as locally.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { createMemoryRateBuckets } from "../src/lib/security/memory-rate-buckets.ts";
import {
  API_RATE_LIMIT_MEMORY_MAX_KEYS,
  ApiRateLimitError,
  assertApiRateLimit,
} from "../src/lib/security/api-rate-limit.ts";
import { POST as pageTimingPost } from "../app/api/telemetry/page-timing/route.ts";
import { PAGE_TIMING_RATE_LIMIT } from "../src/lib/observability/page-timing-intake.ts";
import { stripComments } from "./support/comment-strip.ts";

const SUPABASE_SETTINGS = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;

/** Runs with the Supabase settings replaced (or removed), and puts the real ones back however it ends. */
async function withSupabase<T>(values: Partial<Record<(typeof SUPABASE_SETTINGS)[number], string>>, run: () => Promise<T>): Promise<T> {
  const saved = SUPABASE_SETTINGS.map((name) => [name, process.env[name]] as const);
  for (const name of SUPABASE_SETTINGS) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function withNoSupabase<T>(run: () => Promise<T>): Promise<T> {
  return withSupabase({}, run);
}

/** A public address (not private, loopback or carrier-grade), so clientAddress takes it as the caller. */
function publicAddress(index: number): string {
  return `8.${Math.floor(index / 65_536) % 256}.${Math.floor(index / 256) % 256}.${index % 256}`;
}

function beacon(address: string): Request {
  return new Request("https://phoenix.test/api/telemetry/page-timing", {
    body: "{}",
    headers: { "content-type": "application/json", "x-forwarded-for": address },
    method: "POST",
  });
}

export async function runMemoryRateBucketsTests() {
  // ── 1. the bounded counter itself ────────────────────────────────────────────────────────────
  {
    const buckets = createMemoryRateBuckets(3);
    const t0 = 1_000_000;
    assert.equal(buckets.consume("a", 2, 60_000, t0), 0, "the first hit is allowed");
    assert.equal(buckets.consume("a", 2, 60_000, t0 + 1), 0, "a hit up to the limit is allowed");
    assert.equal(buckets.consume("a", 2, 60_000, t0 + 2), 60, "the hit over the limit waits out the window");
    assert.equal(buckets.consume("a", 2, 60_000, t0 + 60_000), 0, "a new window starts from one");

    buckets.consume("b", 2, 60_000, t0 + 60_001);
    buckets.consume("c", 2, 60_000, t0 + 60_002);
    assert.equal(buckets.size, 3);
    // FULL, and every window is still running. The old page-timing map refused here, for everybody.
    assert.equal(buckets.consume("d", 2, 60_000, t0 + 60_003), 0, "a full map admits a new key by evicting, never refuses it");
    assert.equal(buckets.size, 3, "the map never holds more keys than its cap");
    // "a" started its window first, so it was the one evicted: its count is gone and it starts again.
    buckets.consume("b", 2, 60_000, t0 + 60_004);
    assert.equal(buckets.consume("b", 2, 60_000, t0 + 60_005), 60, "a key that was NOT evicted keeps its count");

    // Ended windows make room before any running one is touched.
    const sweep = createMemoryRateBuckets(2);
    sweep.consume("old", 2, 1_000, 0);
    sweep.consume("live", 2, 60_000, 500);
    sweep.consume("live", 2, 60_000, 600); // "live" is now AT its limit
    assert.equal(sweep.consume("new", 2, 60_000, 5_000), 0); // full; "old" ended at 1,000
    assert.equal(sweep.consume("live", 2, 60_000, 5_001), 56, "the running window survived with its count — the ended one was evicted instead");

    // Rotating keys can never grow it.
    const flood = createMemoryRateBuckets(100);
    for (let index = 0; index < 5_000; index += 1) flood.consume(`k${index}`, 1, 60_000, t0);
    assert.equal(flood.size, 100, "five thousand rotating keys leave the map at its cap");
  }

  // ── 2. the API limiter: opt-in memory fallback, everyone else fails closed ─────────────────────
  assert.equal(API_RATE_LIMIT_MEMORY_MAX_KEYS, 10_000, "the limiter's in-process fallback is capped at 10,000 keys");
  await withNoSupabase(async () => {
    const scope = `memory-rate-buckets-test-${Date.now()}`;
    // Without the opt-in, a store that cannot be reached is an error, never a pass.
    await assert.rejects(
      assertApiRateLimit({ identifier: "caller-1", limit: 2, scope, windowMs: 60_000 }),
      (error: unknown) => !(error instanceof ApiRateLimitError) && error instanceof Error,
      "a caller that did not opt in must have the store error THROWN at it, so it fails closed",
    );
    // With it, the same outage still counts the caller — in memory — and refuses over the limit.
    const opted = { identifier: "caller-2", limit: 2, onStoreError: "memory" as const, scope, windowMs: 60_000 };
    await assert.doesNotReject(assertApiRateLimit(opted), "an opted-in caller is counted in memory while the store is down, never refused for the outage");
    await assert.doesNotReject(assertApiRateLimit(opted), "an opted-in caller is counted in memory up to its limit");
    await assert.rejects(
      assertApiRateLimit(opted),
      (error: unknown) => error instanceof ApiRateLimitError && error.retryAfterSeconds >= 1,
      "an opted-in caller is still limited while the store is down",
    );
  });

  // The rate-limit SCHEMA missing used to drop EVERY caller — the sign-in limits included — to the
  // unbounded per-process map without a word. A stand-in fetch answers exactly what PostgREST answers
  // for a missing function and a missing table (PGRST202, PGRST205); nothing leaves the process. It is
  // this test's own fetch, installed and put back here: a local HTTP server was never reached on CI,
  // because another test in the same shard leaves globalThis.fetch replaced.
  const STAND_URL = "http://rate-limit-stand-in.invalid";
  let standHits = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(STAND_URL)) throw new Error(`the rate-limit stand-in was asked for ${url}`);
    standHits += 1;
    const body = url.includes("/rpc/")
      ? { code: "PGRST202", details: null, hint: null, message: "Could not find the function public.api_rate_limit_consume(p_bucket_key, p_limit, p_window_ms) in the schema cache" }
      : { code: "PGRST205", details: null, hint: null, message: "Could not find the table 'public.api_rate_limit_buckets' in the schema cache" };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status: 404 });
  };
  try {
    await withSupabase({ NEXT_PUBLIC_SUPABASE_URL: STAND_URL, SUPABASE_SERVICE_ROLE_KEY: "stand-in-not-a-key" }, async () => {
      const scope = `memory-rate-buckets-schema-test-${Date.now()}`;
      await assert.rejects(
        assertApiRateLimit({ identifier: "caller-3", limit: 2, scope, windowMs: 60_000 }),
        (error: unknown) => !(error instanceof ApiRateLimitError),
        "a missing rate-limit schema must fail a caller that did not opt in CLOSED — it used to wave every caller through to an unbounded in-process map",
      );
      const opted = { identifier: "caller-4", limit: 1, onStoreError: "memory" as const, scope, windowMs: 60_000 };
      await assert.doesNotReject(assertApiRateLimit(opted), "an opted-in caller is counted in memory when the schema is missing");
      await assert.rejects(assertApiRateLimit(opted), ApiRateLimitError, "and is limited there");
    });
    assert.ok(standHits >= 2, "the stand-in store was really asked (the limiter did not short-circuit)");
  } finally {
    globalThis.fetch = realFetch;
  }

  const limiterSource = stripComments(readFileSync("src/lib/security/api-rate-limit.ts", "utf8"));
  assert.ok(
    /const fallbackBuckets = createMemoryRateBuckets\(API_RATE_LIMIT_MEMORY_MAX_KEYS\);/.test(limiterSource),
    "the limiter's fallback must be the bounded counter, never a bare Map",
  );
  assert.ok(!/new Map</.test(limiterSource), "the limiter must hold no unbounded Map of its own");

  // Exactly the two routes opt in. Anyone else adding it is a decision to fail open on purpose.
  const OPTED_IN = ["app/api/errors/client/route.ts", "app/api/whatsapp/embedded-signup/exchange/route.ts"];
  for (const file of OPTED_IN) {
    const code = stripComments(readFileSync(file, "utf8"));
    const call = code.indexOf("await assertApiRateLimit({");
    assert.ok(call >= 0, `${file} must rate-limit`);
    const callEnd = code.indexOf("});", call);
    assert.ok(code.slice(call, callEnd).includes('onStoreError: "memory"'), `${file} must opt in to the bounded memory fallback`);
    // The catch must END the request on anything that is not an over-limit — the old one fell through.
    const catchAt = code.indexOf("} catch (error) {", callEnd);
    const catchEnd = code.indexOf("\n  }\n", catchAt);
    const handler = code.slice(catchAt, catchEnd);
    const returns = handler.match(/return NextResponse\.json\(/g) ?? [];
    assert.equal(returns.length, 2, `${file}: both the over-limit answer and the limiter-failure answer must return — nothing may fall through to the body`);
    assert.ok(/status: 429/.test(handler) && /status: 503/.test(handler), `${file} answers 429 over the limit and 503 when the limiter itself failed`);
  }
  const optInFiles: string[] = [];
  const { execFileSync } = await import("node:child_process");
  const listed = execFileSync("git", ["grep", "-l", "onStoreError", "--", "app", "src"], { encoding: "utf8" });
  for (const file of listed.split("\n").map((line) => line.trim()).filter(Boolean)) {
    if (file === "src/lib/security/api-rate-limit.ts") continue;
    if (stripComments(readFileSync(file, "utf8")).includes("onStoreError")) optInFiles.push(file);
  }
  assert.deepEqual(optInFiles.sort(), [...OPTED_IN].sort(), "only the crash report and the WhatsApp connection may opt in to the memory fallback");

  // ── 3. the page-timing beacon: a full map no longer refuses everybody ─────────────────────────
  // Fill well past the cap with one beacon per rotating address…
  for (let index = 0; index < 5_050; index += 1) {
    const response = await pageTimingPost(beacon(publicAddress(index)));
    assert.equal(response.status, 204, `rotating address ${index} must be answered, not refused`);
  }
  // …then a genuine newcomer is still answered. Before the fix this was a 429 for everyone.
  const newcomer = await pageTimingPost(beacon("9.9.9.9"));
  assert.equal(newcomer.status, 204, "after 5,000+ rotating addresses, a new address must still be answered (the full map used to refuse everybody)");
  // And the per-address limit still holds.
  let lastStatus = 0;
  for (let hit = 0; hit < PAGE_TIMING_RATE_LIMIT + 1; hit += 1) lastStatus = (await pageTimingPost(beacon("9.9.9.10"))).status;
  assert.equal(lastStatus, 429, "one address over PAGE_TIMING_RATE_LIMIT a minute is still refused");
}
