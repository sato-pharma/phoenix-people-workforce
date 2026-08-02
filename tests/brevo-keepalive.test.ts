import assert from "node:assert/strict";

import { pingBrevoApiKey } from "../src/lib/email/brevo-keepalive.ts";

// Guards the Brevo FAILOVER keepalive (see src/lib/email/brevo-keepalive.ts).
//
// Brevo expires an API key after 90 consecutive days of inactivity even when it was created with
// "No expiration". The failover key is never exercised while Resend is healthy, so without this
// ping the backup dies unnoticed and only reveals itself during a Resend outage.
//
// The assertion that matters most is #2: this must stay a GET to /v3/account and must NEVER
// become a real send. A "keepalive" that quietly posts to /v3/smtp/email would email a live
// recipient every month and burn the free tier's 300/day credits. That is an easy and tempting
// "improvement" for someone who does not know why the account endpoint was chosen.
export async function runBrevoKeepaliveTests() {
  const savedKey = process.env.BREVO_API_KEY;
  const savedFetch = globalThis.fetch;

  try {
    // ---- 1. No backup configured → skip, and do NOT call Brevo at all ----
    delete process.env.BREVO_API_KEY;
    let called: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      called.push(String(input));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    let result = await pingBrevoApiKey();
    assert.equal(result.status, "skipped", "no BREVO_API_KEY must skip, not fail — failover is optional");
    assert.equal(called.length, 0, "an unconfigured backup must not make any network call");

    // ---- 2. Configured + 200 → ok, via GET /v3/account and NEVER a send endpoint ----
    process.env.BREVO_API_KEY = "xkeysib-test";
    called = [];
    let sawApiKeyHeader = false;
    let usedMethod = "";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      called.push(String(input));
      usedMethod = String(init?.method ?? "GET");
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sawApiKeyHeader = Boolean(headers["api-key"]);
      return new Response(JSON.stringify({ email: "phoenixx.oag@gmail.com" }), { status: 200 });
    }) as typeof fetch;

    result = await pingBrevoApiKey();
    assert.equal(result.status, "ok", "a 200 from Brevo means the key authenticated and the inactivity clock reset");
    assert.equal(
      result.status === "ok" ? result.account : null,
      "phoenixx.oag@gmail.com",
      "the account email is reported so a wrong-account key is visible in the cron output",
    );
    assert.equal(called.length, 1, "exactly one request");
    assert.ok(
      !called.some((url) => url.includes("/v3/smtp/email")),
      "the keepalive must NEVER hit the send endpoint — that would email a real recipient and burn a send credit every run",
    );
    assert.ok(called[0].includes("/v3/account"), "must authenticate via the account endpoint");
    assert.equal(usedMethod, "GET", "must be a GET — a POST to Brevo risks being a send");
    assert.ok(sawApiKeyHeader, "Brevo authenticates with the api-key header, not a bearer token");

    // ---- 3. Rejected key → failed (this is the revoked/expired case worth alerting on) ----
    called = [];
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    result = await pingBrevoApiKey();
    assert.equal(result.status, "failed", "a 401 means the failover key is revoked or already expired");
    assert.ok(
      result.status === "failed" && result.reason.includes("401"),
      "the failure reason must carry the status code so the cron output says what happened",
    );

    // ---- 4. Network error → failed, and MUST NOT throw ----
    globalThis.fetch = (async () => {
      throw new Error("socket hang up");
    }) as typeof fetch;
    result = await pingBrevoApiKey();
    assert.equal(result.status, "failed", "a network error is a failure, not an exception the caller must catch");
    assert.ok(
      result.status === "failed" && result.reason.includes("socket hang up"),
      "the underlying network error must be preserved for diagnosis",
    );
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.BREVO_API_KEY;
    else process.env.BREVO_API_KEY = savedKey;
  }
}
