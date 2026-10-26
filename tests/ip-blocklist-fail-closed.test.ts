// The admin IP blocklist fails CLOSED at the three sign-in doors (audit point 15, owner-approved
// 2026-10-26).
//
// WHY THIS EXISTS. `isIpBlocked` answered "not blocked" whenever the blocklist could not be read, so
// an address the owner had blocked walked straight through the password and biometric sign-ins
// during any database blip. Now `isIpBlocked(ip, { onError: "closed" })` answers "blocked" on a
// failed read, and the password route and both biometric login routes pass it. Every other caller
// keeps the fail-open default. No database is touched: the admin client is pointed at a dummy URL
// and `fetch` is stubbed for the whole run, then both are restored.
//
// AN OUTAGE IS NOT A BLOCK (risk review, 26 Oct). Answered as "blocked", a failed read put "Login
// blocked: IP on blocklist" in the audit log for an address nobody blocked and told the person to wait
// out a lockout. The sign-in doors now read `readIpBlock`, which answers "unreadable" apart from
// "blocked", and refuse it with a 503 "temporarily unavailable" and an audit line of its own.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { isIpBlocked, readIpBlock } from "../src/lib/auth/ip-blocklist.ts";
import { stripComments } from "./support/comment-strip.ts";

const ENV_NAMES = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;

async function withStubbedDatabase(answer: () => Response | Promise<Response>, run: () => Promise<void>) {
  const savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  const savedFetch = globalThis.fetch;
  const asked: string[] = [];
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://blocklist-test.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-not-a-key";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input instanceof Request ? input.url : input));
    return answer();
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = savedFetch;
    for (const name of ENV_NAMES) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  }
  assert.ok(
    asked.every((url) => url.startsWith("http://blocklist-test.invalid/")),
    "the test never reaches a real database",
  );
  return asked;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

async function testTheModes() {
  const ip = "203.0.113.9";

  // A read the database refuses (a non-retryable PostgREST error).
  await withStubbedDatabase(
    () => json({ code: "42501", details: null, hint: null, message: "permission denied for table blocked_ips" }, 403),
    async () => {
      assert.equal(await readIpBlock(ip), "unreadable", "HEADLINE: a failed read is told apart from a block");
      assert.equal(await isIpBlocked(ip, { onError: "closed" }), true, "HEADLINE: an unreadable blocklist refuses a sign-in in closed mode");
      assert.equal(await isIpBlocked(ip), false, "the default stays fail-open for every other caller");
      assert.equal(await isIpBlocked(ip, { onError: "open" }), false);
    },
  );

  // A read that never reaches the database at all.
  await withStubbedDatabase(
    () => {
      throw new TypeError("fetch failed");
    },
    async () => {
      assert.equal(await readIpBlock(ip), "unreadable", "a network failure is unreadable, not blocked");
      assert.equal(await isIpBlocked(ip, { onError: "closed" }), true, "a network failure refuses a sign-in in closed mode");
      assert.equal(await isIpBlocked(ip), false);
    },
  );

  // A healthy read: closed mode changes nothing about the answer.
  await withStubbedDatabase(
    () => json([]),
    async () => {
      assert.equal(await isIpBlocked(ip, { onError: "closed" }), false, "an address with no block is let through");
      assert.equal(await readIpBlock(ip), "clear");
    },
  );
  await withStubbedDatabase(
    () => json([{ expires_at: null, ip }]),
    async () => {
      assert.equal(await isIpBlocked(ip, { onError: "closed" }), true, "a permanent block holds");
      assert.equal(await readIpBlock(ip), "blocked");
      assert.equal(await isIpBlocked(ip), true);
    },
  );
  await withStubbedDatabase(
    () => json([{ expires_at: "2000-01-01T00:00:00.000Z", ip }]),
    async () => {
      assert.equal(await isIpBlocked(ip, { onError: "closed" }), false, "an expired block has healed");
      assert.equal(await readIpBlock(ip), "clear");
    },
  );

  // No address to match: a block is per address, so there is nothing to refuse on.
  const asked = await withStubbedDatabase(
    () => json([]),
    async () => {
      assert.equal(await isIpBlocked(null, { onError: "closed" }), false);
      assert.equal(await readIpBlock(null), "clear");
    },
  );
  assert.deepEqual(asked, [], "no address, no database read");
}

function testTheSignInDoorsUseClosedMode() {
  const code = (path: string) => stripComments(readFileSync(resolve(process.cwd(), path), "utf8"));

  // Each door reads the three-way answer, refuses "unreadable" as a 503 "sign_in_unavailable", and
  // refuses "blocked" separately — so neither can pass, and neither is reported as the other.
  const doors = [
    "app/api/auth/login/route.ts",
    "app/api/auth/biometric/login/options/route.ts",
    "app/api/auth/biometric/login/verify/route.ts",
  ];
  for (const path of doors) {
    const source = code(path);
    assert.match(source, /readIpBlock\(/, `HEADLINE: ${path} reads the three-way blocklist answer`);
    assert.doesNotMatch(source, /isIpBlocked\(/, `${path} no longer folds an outage into a block`);
    const unreadable = source.indexOf('=== "unreadable"');
    assert.ok(unreadable !== -1, `${path} handles an unreadable blocklist`);
    const answer = source.slice(unreadable, unreadable + 900);
    assert.match(answer, /"sign_in_unavailable"/, `HEADLINE: ${path} answers an unreadable blocklist as sign-in unavailable`);
    assert.match(answer, /503/, `${path} answers it with a 503`);
    assert.doesNotMatch(answer.slice(0, answer.indexOf("503")), /rate_limited|on blocklist/, `${path} never reports an outage as a block`);
    assert.match(source, /=== "blocked"/, `${path} still refuses a blocked address`);
  }
  const login = code("app/api/auth/login/route.ts");
  assert.match(login, /summary: "Login refused: IP blocklist could not be read"/, "the password door audits an outage on its own line");
  assert.match(login, /summary: "Login blocked: IP on blocklist"/, "and a real block on the old one");
  assert.match(
    code("src/components/auth/premium-login-page.tsx"),
    /sign_in_unavailable: "Sign-in is temporarily unavailable/,
    "the login page names the outage after a redirect-mode refusal",
  );
}

export async function runIpBlocklistFailClosedTests() {
  await testTheModes();
  testTheSignInDoorsUseClosedMode();
}
