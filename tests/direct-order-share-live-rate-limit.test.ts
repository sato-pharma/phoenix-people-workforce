// The public Direct Orders live link is rate-limited per address AND per link, before its body (and
// so its passcode) is read, and the limiter fails CLOSED (audit point 19, owner-approved 2026-10-26).
//
// WHY THIS EXISTS. `POST /api/share/direct-orders/[token]/live` takes a passcode of as few as 4
// characters and serves every direct order behind the link — pharmacy names, doctors, quantities and
// values — to someone with no Phoenix account. Nothing limited how many passcodes one caller could
// try, so a short passcode could be guessed by brute force. Now the route asks `assertApiRateLimit`
// twice (`rateLimitIdentity({ request })` and `rateLimitIdentity({ request, token })`) before
// `request.json()`; over the limit answers 429 with Retry-After, and a limiter that cannot reach its
// database answers 503 and serves nothing. No database is touched: the admin client points at a
// `.invalid` URL and `fetch` is stubbed, then everything is restored.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { stripComments } from "./support/comment-strip.ts";

const SUPABASE_URL = "http://direct-order-share-test.invalid";
const ROUTE = "app/api/share/direct-orders/[token]/live/route.ts";
const TOKEN_A = "a".repeat(43);
const TOKEN_B = "b".repeat(43);
const ENV_NAMES = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;

type Limiter = "allow" | "deny" | "down";
type Call = { path: string; bucketKey: string | null };
type LiveRoute = (request: Request, context: { params: Promise<{ token: string }> }) => Promise<Response>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

async function withStubbedDatabase(limiter: Limiter, run: (calls: Call[]) => Promise<void>) {
  const calls: Call[] = [];
  const savedFetch = globalThis.fetch;
  const env = process.env as Record<string, string | undefined>;
  const savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
  env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  env.SUPABASE_SERVICE_ROLE_KEY = "test-only-not-a-key";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const path = url.pathname.replace(/^\/rest\/v1\//, "");
    let bucketKey: string | null = null;
    if (path === "rpc/api_rate_limit_consume" && typeof init?.body === "string") {
      bucketKey = String((JSON.parse(init.body) as { p_bucket_key?: string }).p_bucket_key ?? "");
    }
    calls.push({ bucketKey, path: `${url.origin}/${path}` });
    if (path === "rpc/api_rate_limit_consume") {
      if (limiter === "down") return json({ code: "XX000", details: null, hint: null, message: "connection reset by peer" }, 500);
      return json([{ allowed: limiter === "allow", retry_after_seconds: limiter === "deny" ? 37 : null }]);
    }
    // The share link itself is unknown — enough to prove the route went past the limiter.
    return json([]);
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = savedFetch;
    for (const name of ENV_NAMES) {
      if (savedEnv[name] === undefined) delete env[name];
      else env[name] = savedEnv[name];
    }
  }
  assert.ok(
    calls.every((call) => call.path.startsWith(`${SUPABASE_URL}/`)),
    "the test never reaches a real database",
  );
}

async function loadRoute(): Promise<LiveRoute> {
  const route = (await import(pathToFileURL(resolve(process.cwd(), ROUTE)).href)) as { POST: LiveRoute };
  return route.POST;
}

/** A POST to the live link whose body read is recorded, so the test can tell it was never opened. */
function livePost(token: string, address: string) {
  const request = new Request(`https://phoenix.test/api/share/direct-orders/${token}/live`, {
    body: JSON.stringify({ passcode: "1234" }),
    headers: { "content-type": "application/json", "x-forwarded-for": address },
    method: "POST",
  });
  const seen = { bodyRead: false };
  const original = request.json.bind(request);
  Object.defineProperty(request, "json", {
    value: async () => {
      seen.bodyRead = true;
      return original();
    },
  });
  return { request, seen };
}

const limiterCalls = (calls: readonly Call[]) => calls.filter((call) => call.path.endsWith("/rpc/api_rate_limit_consume"));
const otherCalls = (calls: readonly Call[]) => calls.filter((call) => !call.path.endsWith("/rpc/api_rate_limit_consume"));

async function testTheLimitRunsBeforeThePasscodeIsRead() {
  const POST = await loadRoute();
  const call = (token: string, address = "203.0.113.20") => {
    const { request, seen } = livePost(token, address);
    return { response: POST(request, { params: Promise.resolve({ token }) }), seen };
  };

  await withStubbedDatabase("deny", async (calls) => {
    const { response, seen } = call(TOKEN_A);
    const answer = await response;
    assert.equal(answer.status, 429, "HEADLINE: a caller over the limit is refused with a 429");
    assert.equal(answer.headers.get("retry-after"), "37", "the 429 says when to come back");
    assert.match(answer.headers.get("cache-control") ?? "", /no-store/, "the refusal is never cached");
    assert.match(answer.headers.get("x-robots-tag") ?? "", /noindex/, "the refusal is never indexed");
    assert.equal(((await answer.json()) as { success?: boolean }).success, false, "the refusal carries no report");
    assert.equal(seen.bodyRead, false, "HEADLINE: the passcode is never read once the limit is reached");
    assert.deepEqual(otherCalls(calls), [], "the share link is never looked up once the limit is reached");
  });

  await withStubbedDatabase("down", async (calls) => {
    const { response, seen } = call(TOKEN_A);
    const answer = await response;
    assert.equal(answer.status, 503, "HEADLINE: a limiter that cannot reach its database fails CLOSED");
    assert.equal(seen.bodyRead, false, "a limiter outage never reads the passcode");
    assert.deepEqual(otherCalls(calls), [], "a limiter outage never looks up the share link");
  });

  await withStubbedDatabase("allow", async (calls) => {
    const first = call(TOKEN_A);
    const answer = await first.response;
    assert.notEqual(answer.status, 429, "a caller under the limit is not refused");
    assert.notEqual(answer.status, 503, "a reachable limiter does not refuse");
    assert.equal(first.seen.bodyRead, true, "a caller under the limit has their passcode read");
    assert.ok(otherCalls(calls).length > 0, "a caller under the limit reaches the share link lookup");

    const second = call(TOKEN_B);
    await second.response;
    const third = call(TOKEN_A, "198.51.100.7");
    await third.response;
    const keys = limiterCalls(calls).map((entry) => entry.bucketKey ?? "");
    assert.equal(keys.length, 6, "every request asks two limits");
    const ipKeys = keys.filter((key) => key.startsWith("direct_order_share_live_ip:"));
    const linkKeys = keys.filter((key) => key.startsWith("direct_order_share_live_link:"));
    assert.equal(ipKeys.length, 3, "one limit is keyed on the address");
    assert.equal(linkKeys.length, 3, "one limit is keyed on the link");
    assert.equal(ipKeys[0], ipKeys[1], "two links from one address share the address limit");
    assert.notEqual(ipKeys[0], ipKeys[2], "another address has its own address limit");
    assert.notEqual(linkKeys[0], linkKeys[1], "two links have separate link limits");
    assert.equal(linkKeys[0], linkKeys[2], "one link opened from two addresses shares the link limit");
  });
}

function testTheRouteSource() {
  const route = stripComments(readFileSync(resolve(process.cwd(), ROUTE), "utf8"));
  const ipLimit = route.indexOf('scope: "direct_order_share_live_ip"');
  const linkLimit = route.indexOf('scope: "direct_order_share_live_link"');
  const bodyRead = route.indexOf("request.json()");
  assert.ok(ipLimit > 0 && linkLimit > 0, "the live link limits per address and per link");
  assert.ok(bodyRead > 0 && ipLimit < bodyRead && linkLimit < bodyRead, "both limits run before the body is read");
  assert.match(route, /rateLimitIdentity\(\{ request \}\)/, "the address limit keys on the caller's address");
  assert.match(route, /rateLimitIdentity\(\{ request, token \}\)/, "the link limit keys on the token");
}

export async function runDirectOrderShareLiveRateLimitTests() {
  await testTheLimitRunsBeforeThePasscodeIsRead();
  testTheRouteSource();
}
