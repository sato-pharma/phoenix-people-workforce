// The Brevo webhook takes its shared secret ONLY from `Authorization: Bearer`, compared in constant
// time, and refuses a secret in the URL (audit point 20, owner-approved 2026-10-26).
//
// WHY THIS EXISTS. `POST /api/webhooks/brevo` writes delivery, open and click events into
// `email_delivery_events`. Its only credential is BREVO_WEBHOOK_SECRET, and it used to be accepted
// from the URL (`?token=`) or an `x-brevo-token` header. A secret in a URL lands in every access log,
// proxy log and error report the URL passes through, so anyone who read one of those could post
// forged bounces and opens. Now the route reads the Bearer header only: `?token=` on its own is
// refused, so the old configuration fails loudly instead of leaking quietly.
//
// THE CUT-OVER (risk review, 26 Oct). Brevo is switched to the new Bearer secret before the deploy,
// while its address still carries the old `?token=`. A valid Bearer with `?token=` still on the URL is
// therefore ACCEPTED (and logged) — refusing it would drop every delivery event until the address is
// cleaned — and `?token=` with no valid Bearer is still refused.
//
// No database is touched: every request that passes auth posts an empty batch (`[]`), which records
// nothing; `fetch` throws if anything tries to leave the process; env is restored afterwards.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { stripComments } from "./support/comment-strip.ts";

const SECRET = "brevo-test-secret-not-real-0123456789";
const BASE = "https://phoenix.test/api/webhooks/brevo";
const ROUTE = "app/api/webhooks/brevo/route.ts";
const LIB = "src/lib/email/brevo-webhook-events.ts";

type BrevoPost = (request: Request) => Promise<Response>;
const logged: string[] = [];
type AuthLib = {
  checkBrevoWebhookAuth: (input: { url: string; headers: Headers; secret: string }) => { ok: boolean; reason?: string };
  verifyBrevoWebhookAuth: (input: { url: string; headers: Headers; secret: string }) => boolean;
};

async function loadRoute(): Promise<BrevoPost> {
  const route = (await import(pathToFileURL(resolve(process.cwd(), ROUTE)).href)) as { POST: BrevoPost };
  return route.POST;
}

async function loadLib(): Promise<AuthLib> {
  return (await import(pathToFileURL(resolve(process.cwd(), LIB)).href)) as AuthLib;
}

async function withSecret(run: () => Promise<void>) {
  const env = process.env as Record<string, string | undefined>;
  const savedSecret = env.BREVO_WEBHOOK_SECRET;
  const savedFetch = globalThis.fetch;
  const savedLog = console.log;
  logged.length = 0;
  env.BREVO_WEBHOOK_SECRET = SECRET;
  globalThis.fetch = (async () => {
    throw new Error("the Brevo webhook test must never reach the network");
  }) as typeof fetch;
  // The route logs a structured warning on every refusal; keep the test output readable, and keep
  // the lines so a test can read which warning was written.
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = savedLog;
    globalThis.fetch = savedFetch;
    if (savedSecret === undefined) delete env.BREVO_WEBHOOK_SECRET;
    else env.BREVO_WEBHOOK_SECRET = savedSecret;
  }
}

function webhookPost(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { body: "[]", headers: { "content-type": "application/json", ...headers }, method: "POST" });
}

async function testTheRouteTakesTheBearerHeaderOnly() {
  const POST = await loadRoute();
  await withSecret(async () => {
    const accepted = await POST(webhookPost(BASE, { authorization: `Bearer ${SECRET}` }));
    assert.equal(accepted.status, 200, "HEADLINE: the right secret in Authorization: Bearer is accepted");
    assert.deepEqual(await accepted.json(), { duplicates: 0, ok: true, recorded: 0 }, "an accepted empty batch records nothing");

    const lowerScheme = await POST(webhookPost(BASE, { authorization: `bearer ${SECRET}` }));
    assert.equal(lowerScheme.status, 200, "the Bearer scheme is matched case-insensitively");

    const inUrl = await POST(webhookPost(`${BASE}?token=${encodeURIComponent(SECRET)}`));
    assert.equal(inUrl.status, 401, "HEADLINE: the right secret in ?token= is refused");

    logged.length = 0;
    const cutOver = await POST(webhookPost(`${BASE}?token=old-secret-still-on-the-address`, { authorization: `Bearer ${SECRET}` }));
    assert.equal(cutOver.status, 200, "HEADLINE: during the cut-over a valid Bearer is accepted while the old ?token= is still on the URL");
    assert.ok(
      logged.some((line) => line.includes("webhook_secret_in_url")),
      "and the leftover ?token= is logged until the address is cleaned",
    );
    assert.ok(!logged.some((line) => line.includes("old-secret-still-on-the-address")), "the log never carries the token itself");

    const inUrlWrongBearer = await POST(webhookPost(`${BASE}?token=${encodeURIComponent(SECRET)}`, { authorization: "Bearer not-the-secret" }));
    assert.equal(inUrlWrongBearer.status, 401, "?token= with a wrong Bearer is refused — the URL token never counts");

    const oldHeader = await POST(webhookPost(BASE, { "x-brevo-token": SECRET }));
    assert.equal(oldHeader.status, 401, "the right secret in the old x-brevo-token header is refused");

    const wrong = await POST(webhookPost(BASE, { authorization: "Bearer not-the-secret" }));
    assert.equal(wrong.status, 401, "a wrong Bearer token is refused");

    const prefix = await POST(webhookPost(BASE, { authorization: `Bearer ${SECRET.slice(0, -1)}` }));
    assert.equal(prefix.status, 401, "a Bearer token one character short is refused");

    const basic = await POST(webhookPost(BASE, { authorization: `Basic ${SECRET}` }));
    assert.equal(basic.status, 401, "the secret under another scheme is refused");

    const missing = await POST(webhookPost(BASE));
    assert.equal(missing.status, 401, "no credential is refused");
  });

  const env = process.env as Record<string, string | undefined>;
  const saved = env.BREVO_WEBHOOK_SECRET;
  delete env.BREVO_WEBHOOK_SECRET;
  const savedLog = console.log;
  console.log = () => {};
  try {
    const unconfigured = await POST(webhookPost(BASE, { authorization: `Bearer ${SECRET}` }));
    assert.equal(unconfigured.status, 500, "with no BREVO_WEBHOOK_SECRET set nothing is accepted");
  } finally {
    console.log = savedLog;
    if (saved !== undefined) env.BREVO_WEBHOOK_SECRET = saved;
  }
}

async function testTheReasonNamesTheBrokenHalf() {
  const { checkBrevoWebhookAuth } = await loadLib();
  const bearer = new Headers({ authorization: `Bearer ${SECRET}` });
  assert.deepEqual(checkBrevoWebhookAuth({ headers: bearer, secret: SECRET, url: BASE }), { ok: true });
  assert.deepEqual(
    checkBrevoWebhookAuth({ headers: bearer, secret: SECRET, url: `${BASE}?token=x` }),
    { ok: true, warning: "secret_in_url" },
    "a valid Bearer with a token still on the URL is accepted and flagged",
  );
  const none = new Headers();
  assert.equal(checkBrevoWebhookAuth({ headers: none, secret: SECRET, url: `${BASE}?token=${SECRET}` }).reason, "secret_in_url", "a token on the URL alone is named as such");
  assert.equal(checkBrevoWebhookAuth({ headers: none, secret: SECRET, url: `${BASE}?token=` }).reason, "secret_in_url", "even an empty ?token= is refused");
  assert.equal(
    checkBrevoWebhookAuth({ headers: new Headers({ authorization: "Bearer x" }), secret: SECRET, url: `${BASE}?token=${SECRET}` }).reason,
    "secret_in_url",
    "a wrong Bearer plus the secret in ?token= is refused",
  );
  assert.equal(checkBrevoWebhookAuth({ headers: new Headers(), secret: SECRET, url: BASE }).reason, "bearer_missing");
  assert.equal(checkBrevoWebhookAuth({ headers: new Headers({ authorization: "Bearer x" }), secret: SECRET, url: BASE }).reason, "bearer_mismatch");
  assert.equal(checkBrevoWebhookAuth({ headers: bearer, secret: "  ", url: BASE }).reason, "secret_not_configured", "a blank secret accepts nothing");
  assert.equal(checkBrevoWebhookAuth({ headers: none, secret: SECRET, url: "not a url" }).ok, false, "an unreadable URL fails closed");
}

function testTheSource() {
  const lib = stripComments(readFileSync(resolve(process.cwd(), LIB), "utf8"));
  assert.doesNotMatch(lib, /searchParams\.get\(\s*["']token["']\s*\)/, "the library never reads the secret from ?token=");
  assert.doesNotMatch(lib, /x-brevo-token/, "the library never reads the old x-brevo-token header");
  assert.match(lib, /headers\.get\(\s*["']authorization["']\s*\)/, "the library reads the Authorization header");
  assert.match(lib, /crypto\.timingSafeEqual\(/, "the secret is compared in constant time");
  const route = stripComments(readFileSync(resolve(process.cwd(), ROUTE), "utf8"));
  assert.match(route, /process\.env\.BREVO_WEBHOOK_SECRET/, "the env name stays BREVO_WEBHOOK_SECRET");
  assert.doesNotMatch(route, /x-brevo-token|searchParams/, "the route reads no other credential");
}

export async function runBrevoWebhookBearerAuthTests() {
  await testTheRouteTakesTheBearerHeaderOnly();
  await testTheReasonNamesTheBrokenHalf();
  testTheSource();
}
