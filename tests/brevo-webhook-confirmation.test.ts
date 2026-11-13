import assert from "node:assert/strict";

import { parseBrevoWebhookEvent, recordBrevoWebhookEvent } from "../src/lib/email/brevo-webhook-events.ts";

const { POST: brevoWebhookPost } = await import("../app/api/webhooks/brevo/route.ts");

// ─────────────────────────────────────────────────────────────────────────────
// A BREVO EVENT CHANGES THE BOUNCE LIST ONLY ONCE BREVO CONFIRMS IT (S01, F-COM-017).
//
//   1. A bounce, block, invalid address, spam report or unsubscribe from the webhook puts the
//      address on the bounce list only when Brevo's own event log (read with the account's API key)
//      holds that event for that address and message. Either Brevo account may hold it.
//   2. Not found, Brevo unreachable, or no key: the delivery row is still recorded, the bounce list
//      is unchanged.
//   3. An open, click or delivery never asks Brevo at all.
//
// No network: Supabase's REST API and Brevo's API are a stubbed `fetch`.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = "http://brevo-webhook-confirmation-test.invalid";
const ENV_NAMES = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "BREVO_API_KEY", "BREVO_API_KEY_2", "BREVO_WEBHOOK_SECRET"] as const;
const KEY_ONE = "test-only-brevo-key-one";
const KEY_TWO = "test-only-brevo-key-two";
const WEBHOOK_SECRET = "test-only-brevo-webhook-secret";

type BrevoLog = Record<string, Array<{ email: string; event: string; messageId: string }> | "error" | "throw">;

type Seen = { brevoAsks: Array<{ key: string; event: string | null; messageId: string | null; email: string | null }>; deliveryRows: number; suppressionWrites: number };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

async function withStubs(keys: string[], log: BrevoLog, run: (seen: Seen) => Promise<void>) {
  const seen: Seen = { brevoAsks: [], deliveryRows: 0, suppressionWrites: 0 };
  const env = process.env as Record<string, string | undefined>;
  const saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
  const savedFetch = globalThis.fetch;
  env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  env.SUPABASE_SERVICE_ROLE_KEY = "test-only-not-a-key";
  env.BREVO_WEBHOOK_SECRET = WEBHOOK_SECRET;
  delete env.BREVO_API_KEY;
  delete env.BREVO_API_KEY_2;
  if (keys[0]) env.BREVO_API_KEY = keys[0];
  if (keys[1]) env.BREVO_API_KEY_2 = keys[1];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin === SUPABASE_URL) {
      if (url.pathname.endsWith("/email_delivery_events")) seen.deliveryRows += 1;
      else if (url.pathname.endsWith("/email_suppressions")) seen.suppressionWrites += 1;
      else throw new Error(`unexpected table ${url.pathname}`);
      return new Response(null, { status: 201 });
    }
    if (url.origin === "https://api.brevo.com" && url.pathname === "/v3/smtp/statistics/events") {
      const key = new Headers(init?.headers).get("api-key") ?? "";
      seen.brevoAsks.push({ email: url.searchParams.get("email"), event: url.searchParams.get("event"), key, messageId: url.searchParams.get("messageId") });
      const answer = log[key] ?? [];
      if (answer === "throw") throw new Error("connection reset");
      if (answer === "error") return json({ code: "unauthorized", message: "Key not found" }, 401);
      return json({ events: answer });
    }
    throw new Error(`unexpected fetch ${url.origin}${url.pathname}`);
  }) as typeof fetch;
  try {
    await run(seen);
  } finally {
    globalThis.fetch = savedFetch;
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete env[name];
      else env[name] = saved[name];
    }
  }
}

const ADDRESS = "someone@example.test";
const MESSAGE_ID = "<202611131200.1234567@smtp-relay.mailin.fr>";

function webhookEvent(event: string, extra: Record<string, unknown> = {}) {
  return { email: ADDRESS, event, "message-id": MESSAGE_ID, ts_event: 1_800_000_000, ...extra };
}

const logged = (event: string, messageId = MESSAGE_ID, email = ADDRESS) => [{ email, event, messageId }];

async function record(payload: Record<string, unknown>) {
  return recordBrevoWebhookEvent(parseBrevoWebhookEvent(payload), { confirmRetryDelayMs: 0 });
}

export async function runBrevoWebhookConfirmationTests(): Promise<void> {
  // ── 1. Confirmed by Brevo → on the bounce list ─────────────────────────────────────────────
  const cases: Array<[string, string]> = [
    ["hard_bounce", "hardBounces"],
    ["soft_bounce", "softBounces"],
    ["invalid_email", "invalid"],
    ["blocked", "blocked"],
    ["spam", "spam"],
    ["unsubscribed", "unsubscribed"],
  ];
  for (const [webhookName, logName] of cases) {
    await withStubs([KEY_ONE], { [KEY_ONE]: logged(logName) }, async (seen) => {
      const result = await record(webhookEvent(webhookName));
      assert.deepEqual(result, { duplicate: false, suppression: "applied" }, `${webhookName} confirmed by Brevo is applied`);
      assert.equal(seen.deliveryRows, 1);
      assert.equal(seen.suppressionWrites, 1, `${webhookName}: the address is put on the bounce list`);
      assert.deepEqual(seen.brevoAsks, [{ email: ADDRESS, event: logName, key: KEY_ONE, messageId: MESSAGE_ID }], `${webhookName}: Brevo is asked for exactly that event`);
    });
  }

  // The webhook may send the message id bare; the log carries the angle brackets.
  await withStubs([KEY_ONE], { [KEY_ONE]: logged("hardBounces") }, async (seen) => {
    const bare = MESSAGE_ID.slice(1, -1);
    assert.equal((await record(webhookEvent("hard_bounce", { "message-id": bare }))).suppression, "applied");
    assert.equal(seen.brevoAsks[0]?.messageId, MESSAGE_ID, "Brevo is asked with the bracketed id");
  });

  // Either account may hold it.
  await withStubs([KEY_ONE, KEY_TWO], { [KEY_ONE]: [], [KEY_TWO]: logged("spam") }, async (seen) => {
    assert.equal((await record(webhookEvent("spam"))).suppression, "applied", "the second Brevo account confirms it");
    assert.equal(seen.suppressionWrites, 1);
  });

  // ── 2. Not confirmed → recorded, bounce list unchanged ─────────────────────────────────────
  const unconfirmed: Array<[string, string[], BrevoLog]> = [
    ["not in Brevo's log", [KEY_ONE], { [KEY_ONE]: [] }],
    ["another message in Brevo's log", [KEY_ONE], { [KEY_ONE]: logged("hardBounces", "<another@smtp-relay.mailin.fr>") }],
    ["another address in Brevo's log", [KEY_ONE], { [KEY_ONE]: logged("hardBounces", MESSAGE_ID, "other@example.test") }],
    ["Brevo refuses the key", [KEY_ONE], { [KEY_ONE]: "error" }],
    ["Brevo unreachable", [KEY_ONE], { [KEY_ONE]: "throw" }],
    ["no Brevo key", [], {}],
  ];
  for (const [label, keys, log] of unconfirmed) {
    await withStubs(keys, log, async (seen) => {
      const result = await record(webhookEvent("hard_bounce"));
      assert.deepEqual(result, { duplicate: false, suppression: "unconfirmed" }, `🔴 ${label}: not applied`);
      assert.equal(seen.deliveryRows, 1, `${label}: the delivery row is still recorded`);
      assert.equal(seen.suppressionWrites, 0, `🔴 ${label}: the bounce list is unchanged`);
    });
  }

  // A miss is asked once more, because the log can trail the webhook.
  await withStubs([KEY_ONE], { [KEY_ONE]: [] }, async (seen) => {
    await record(webhookEvent("hard_bounce"));
    assert.equal(seen.brevoAsks.length, 2, "a miss is asked twice");
  });

  // No message id: nothing to confirm against.
  await withStubs([KEY_ONE], { [KEY_ONE]: logged("hardBounces") }, async (seen) => {
    assert.equal((await record(webhookEvent("hard_bounce", { "message-id": undefined }))).suppression, "unconfirmed");
    assert.equal(seen.suppressionWrites, 0);
  });

  // ── 3. Ordinary events never ask Brevo ─────────────────────────────────────────────────────
  for (const event of ["delivered", "opened", "click", "request", "deferred"]) {
    await withStubs([KEY_ONE], { [KEY_ONE]: logged("hardBounces") }, async (seen) => {
      assert.deepEqual(await record(webhookEvent(event)), { duplicate: false, suppression: "none" });
      assert.equal(seen.brevoAsks.length, 0, `${event} never asks Brevo`);
      assert.equal(seen.suppressionWrites, 0);
    });
  }

  // ── The route, end to end: an authenticated post Brevo does not confirm is recorded, not applied
  await withStubs([KEY_ONE], { [KEY_ONE]: [] }, async (seen) => {
    const response = await brevoWebhookPost(
      new Request("https://phoenix-hr.satopharma.com/api/webhooks/brevo", {
        body: JSON.stringify(webhookEvent("spam")),
        headers: { authorization: `Bearer ${WEBHOOK_SECRET}`, "content-type": "application/json" },
        method: "POST",
      }),
    );
    assert.equal(response.status, 200, "Brevo is answered 200, so it does not retry or give up on the webhook");
    assert.deepEqual(await response.json(), { duplicates: 0, ok: true, recorded: 1 });
    assert.equal(seen.deliveryRows, 1);
    assert.equal(seen.suppressionWrites, 0, "🔴 an unconfirmed report through the route leaves the bounce list alone");
  });
}
