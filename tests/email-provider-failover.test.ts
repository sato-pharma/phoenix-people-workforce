import assert from "node:assert/strict";

import { RetryableEmailError } from "../src/lib/email/email-errors.ts";
import {
  applySenderOverride,
  brevoProvider,
  checkResendAccepted,
  resendAcceptedCheckDelaysMs,
  resendProvider,
  resolveEmailProviders,
  sendPreparedEmailWithFailover,
  type AcceptedSendCheck,
  type EmailProvider,
  type PreparedEmail,
  type ProviderSendResult,
} from "../src/lib/email/email-providers.ts";
import { parseResendWebhookEvent, suppressionReasonForEvent } from "../src/lib/email/resend-webhook-events.ts";

const sampleEmail: PreparedEmail = {
  from: "Phoenix <no-reply@phoenix.example>",
  html: "<p>hello</p>",
  idempotencyKey: "idem-1",
  replyTo: "reply@phoenix.example",
  subject: "Subject",
  text: "hello",
  to: ["someone@example.com"],
};

function fakeProvider(name: string, result: ProviderSendResult, calls: string[]): EmailProvider {
  return {
    name,
    isConfigured: () => true,
    async send() {
      calls.push(name);
      return result;
    },
  };
}

export async function runEmailProviderFailoverTests() {
  // 1) Primary sends → returns it, backup is NEVER called (no duplicate).
  {
    const calls: string[] = [];
    const primary = fakeProvider("primary", { outcome: "sent", id: "P1" }, calls);
    const backup = fakeProvider("backup", { outcome: "sent", id: "B1" }, calls);
    const result = await sendPreparedEmailWithFailover(sampleEmail, [primary, backup]);
    assert.deepEqual(result, { id: "P1", provider: "primary" });
    assert.deepEqual(calls, ["primary"], "backup must not be called once primary sent");
  }

  // 2) Primary quota-exhausted (failover) → backup sends. Each provider called exactly once.
  {
    const calls: string[] = [];
    const primary = fakeProvider("primary", { outcome: "failover", reason: "rate limited (429)" }, calls);
    const backup = fakeProvider("backup", { outcome: "sent", id: "B2" }, calls);
    const result = await sendPreparedEmailWithFailover(sampleEmail, [primary, backup]);
    assert.deepEqual(result, { id: "B2", provider: "backup" });
    assert.deepEqual(calls, ["primary", "backup"]);
  }

  // 3) AMBIGUOUS primary failure (may have sent) → throws Retryable, backup is NEVER tried.
  //    This is the core no-duplication guarantee.
  {
    const calls: string[] = [];
    const primary = fakeProvider("primary", { outcome: "retry", reason: "timeout" }, calls);
    const backup = fakeProvider("backup", { outcome: "sent", id: "B3" }, calls);
    await assert.rejects(
      () => sendPreparedEmailWithFailover(sampleEmail, [primary, backup]),
      (error: unknown) => error instanceof RetryableEmailError,
    );
    assert.deepEqual(calls, ["primary"], "backup must NOT be tried after an ambiguous failure");
  }

  // 4) Hard deterministic rejection (bad payload) → throws Error, backup NEVER tried.
  {
    const calls: string[] = [];
    const primary = fakeProvider("primary", { outcome: "error", reason: "invalid payload" }, calls);
    const backup = fakeProvider("backup", { outcome: "sent", id: "B4" }, calls);
    await assert.rejects(() => sendPreparedEmailWithFailover(sampleEmail, [primary, backup]));
    assert.deepEqual(calls, ["primary"], "a hard rejection must not fail over");
  }

  // 5) All providers exhausted → RetryableEmailError, propagating the Retry-After hint so the
  //    outbox backs off until a quota window resets (mail delayed, never dropped).
  {
    const calls: string[] = [];
    const primary = fakeProvider("primary", { outcome: "failover", reason: "429", retryAfterMs: 1000 }, calls);
    const backup = fakeProvider("backup", { outcome: "failover", reason: "429", retryAfterMs: 5000 }, calls);
    await assert.rejects(
      () => sendPreparedEmailWithFailover(sampleEmail, [primary, backup]),
      (error: unknown) => error instanceof RetryableEmailError && error.retryAfterMs === 5000,
    );
    assert.deepEqual(calls, ["primary", "backup"]);
  }

  // 6) Resend-only chain (no backup): a 429 still surfaces as Retryable — unchanged legacy behaviour.
  {
    const calls: string[] = [];
    const primary = fakeProvider("primary", { outcome: "failover", reason: "429" }, calls);
    await assert.rejects(
      () => sendPreparedEmailWithFailover(sampleEmail, [primary]),
      (error: unknown) => error instanceof RetryableEmailError,
    );
    assert.deepEqual(calls, ["primary"]);
  }

  // 7) resolveEmailProviders is inert until the backup is configured, and honours the kill switch.
  {
    const saved = {
      resend: process.env.RESEND_API_KEY,
      brevo: process.env.BREVO_API_KEY,
      toggle: process.env.EMAIL_FAILOVER_ENABLED,
    };
    try {
      process.env.RESEND_API_KEY = "re_test";

      delete process.env.BREVO_API_KEY;
      delete process.env.EMAIL_FAILOVER_ENABLED;
      let providers = resolveEmailProviders();
      assert.deepEqual(providers.map((p) => p.name), ["resend"], "no backup env → resend only");

      process.env.BREVO_API_KEY = "brevo_test";
      providers = resolveEmailProviders();
      assert.deepEqual(providers.map((p) => p.name), ["resend", "brevo"], "backup configured → failover chain");

      process.env.EMAIL_FAILOVER_ENABLED = "false";
      providers = resolveEmailProviders();
      assert.deepEqual(providers.map((p) => p.name), ["resend"], "kill switch disables the backup");
    } finally {
      if (saved.resend === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = saved.resend;
      if (saved.brevo === undefined) delete process.env.BREVO_API_KEY;
      else process.env.BREVO_API_KEY = saved.brevo;
      if (saved.toggle === undefined) delete process.env.EMAIL_FAILOVER_ENABLED;
      else process.env.EMAIL_FAILOVER_ENABLED = saved.toggle;
    }
  }

  // 8) The wire format each provider actually receives. Reply-To is the one field whose NAME differs
  //    between them — Resend's REST API takes `reply_to`, Brevo a `replyTo` object — and a wrong name
  //    is not an error on either: the provider drops it, answers 200 and sends the mail with no
  //    Reply-To at all, so every reply goes to the From address and bounces. Production shipped
  //    exactly that (Resend recorded `reply_to: null` on every job offer), so assert on the request
  //    body itself, not on the PreparedEmail that produced it.
  {
    const realFetch = globalThis.fetch;
    const saved = {
      brevo: process.env.BREVO_API_KEY,
      brevoFrom: process.env.BREVO_EMAIL_FROM,
      resend: process.env.RESEND_API_KEY,
    };
    const bodies: Record<string, Record<string, unknown>> = {};
    let resendResult: ProviderSendResult | undefined;
    let brevoResult: ProviderSendResult | undefined;
    try {
      process.env.RESEND_API_KEY = "re_test";
      process.env.BREVO_API_KEY = "brevo_test";
      delete process.env.BREVO_EMAIL_FROM;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const provider = String(input).includes("resend") ? "resend" : "brevo";
        bodies[provider] = JSON.parse(String(init?.body));
        return new Response(JSON.stringify(provider === "resend" ? { id: "R1" } : { messageId: "<B1>" }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;

      resendResult = await resendProvider.send(sampleEmail);
      brevoResult = await brevoProvider.send(sampleEmail);
    } finally {
      globalThis.fetch = realFetch;
      if (saved.brevo === undefined) delete process.env.BREVO_API_KEY;
      else process.env.BREVO_API_KEY = saved.brevo;
      if (saved.brevoFrom === undefined) delete process.env.BREVO_EMAIL_FROM;
      else process.env.BREVO_EMAIL_FROM = saved.brevoFrom;
      if (saved.resend === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = saved.resend;
    }

    assert.deepEqual(resendResult, { outcome: "sent", id: "R1" }, "the stubbed Resend call must have been reached");
    assert.deepEqual(brevoResult, { outcome: "sent", id: "<B1>" }, "the stubbed Brevo call must have been reached");
    assert.equal(
      bodies.resend?.reply_to,
      "reply@phoenix.example",
      "Resend's REST field is reply_to — the camelCase name is silently dropped and the mail loses its Reply-To",
    );
    assert.equal("replyTo" in (bodies.resend ?? {}), false, "never send replyTo to Resend's REST API");
    assert.deepEqual(bodies.brevo?.replyTo, { email: "reply@phoenix.example" }, "Brevo takes a replyTo object");
  }

  // 9) A TWO-mailbox Reply-To (a job offer routes replies to HR and to the owner). Resend must
  //    receive an ARRAY — a single comma-joined string it would treat as one malformed address and
  //    drop, sending the offer with no Reply-To, which is the whole bounce. Brevo has no array shape,
  //    so the backup honours the first mailbox (the HR inbox); Resend, which sends every offer in
  //    practice, carries both.
  {
    const realFetch = globalThis.fetch;
    const saved = {
      brevo: process.env.BREVO_API_KEY,
      brevoFrom: process.env.BREVO_EMAIL_FROM,
      resend: process.env.RESEND_API_KEY,
    };
    const bodies: Record<string, Record<string, unknown>> = {};
    const twoMailboxes: PreparedEmail = {
      ...sampleEmail,
      replyTo: "hr@satopharma.com, omar.anwar@satopharma.com",
    };
    try {
      process.env.RESEND_API_KEY = "re_test";
      process.env.BREVO_API_KEY = "brevo_test";
      delete process.env.BREVO_EMAIL_FROM;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const provider = String(input).includes("resend") ? "resend" : "brevo";
        bodies[provider] = JSON.parse(String(init?.body));
        return new Response(JSON.stringify(provider === "resend" ? { id: "R2" } : { messageId: "<B2>" }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;

      await resendProvider.send(twoMailboxes);
      await brevoProvider.send(twoMailboxes);
    } finally {
      globalThis.fetch = realFetch;
      if (saved.brevo === undefined) delete process.env.BREVO_API_KEY;
      else process.env.BREVO_API_KEY = saved.brevo;
      if (saved.brevoFrom === undefined) delete process.env.BREVO_EMAIL_FROM;
      else process.env.BREVO_EMAIL_FROM = saved.brevoFrom;
      if (saved.resend === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = saved.resend;
    }

    assert.deepEqual(
      bodies.resend?.reply_to,
      ["hr@satopharma.com", "omar.anwar@satopharma.com"],
      "Resend must receive both reply-to mailboxes as an array",
    );
    assert.deepEqual(
      bodies.brevo?.replyTo,
      { email: "hr@satopharma.com" },
      "Brevo (backup only) honours the first reply-to mailbox",
    );
  }

  // 10) ACCEPTED, THEN FAILED. On 2026-09-28 Resend answered 200 with an id for every send from
  //     13:00 Cairo and marked 52 of the next 56 `failed` — Norhan Gamal's job offer among them —
  //     while Phoenix recorded each as sent and never reached Brevo. A `failed` verdict after the
  //     200 must hand the SAME message to the backup, and the backup's id is what gets recorded.
  function checkingProvider(name: string, id: string, check: AcceptedSendCheck, calls: string[]): EmailProvider {
    return {
      ...fakeProvider(name, { outcome: "sent", id }, calls),
      async checkAccepted(checkedId) {
        calls.push(`${name}:check:${checkedId}`);
        return check;
      },
    };
  }
  {
    const calls: string[] = [];
    const primary = checkingProvider("resend", "R-accepted", { reason: "failed after accept", state: "failed" }, calls);
    const backup = fakeProvider("brevo", { outcome: "sent", id: "<B10>" }, calls);
    const result = await sendPreparedEmailWithFailover(sampleEmail, [primary, backup]);
    assert.deepEqual(result, { id: "<B10>", provider: "brevo" }, "an accepted-then-failed send must reach the backup");
    assert.deepEqual(calls, ["resend", "resend:check:R-accepted", "brevo"]);
  }

  // 11) Accepted and settled (delivered, or anything that is not `failed`) → the primary's id
  //     stands and the backup is NEVER called: Resend stays the primary and the source of truth.
  for (const state of ["settled", "pending"] as const) {
    const calls: string[] = [];
    const primary = checkingProvider("resend", "R-ok", { state }, calls);
    const backup = fakeProvider("brevo", { outcome: "sent", id: "<B11>" }, calls);
    const result = await sendPreparedEmailWithFailover(sampleEmail, [primary, backup]);
    assert.deepEqual(result, { id: "R-ok", provider: "resend" }, `a ${state} check keeps the Resend send`);
    assert.deepEqual(calls, ["resend", "resend:check:R-ok"], `a ${state} check must not wake the backup`);
  }

  // 12) No backup configured → nothing to hand to, so the check is not even asked (no added wait).
  {
    const calls: string[] = [];
    const primary = checkingProvider("resend", "R-only", { reason: "x", state: "failed" }, calls);
    const result = await sendPreparedEmailWithFailover(sampleEmail, [primary]);
    assert.deepEqual(result, { id: "R-only", provider: "resend" });
    assert.deepEqual(calls, ["resend"], "with no backup the accepted check is skipped");
  }

  // 13) checkResendAccepted reads Resend's own verdict. It waits between reads (stubbed here), stops
  //     at the first verdict, and never throws — any trouble asking answers `pending`, which keeps the
  //     accepted send exactly as it was before this check existed.
  {
    const realKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "re_test";
    try {
      const sleeps: number[] = [];
      const sleep = async (ms: number) => {
        sleeps.push(ms);
      };
      const reading = (events: Array<string | number>) => {
        const urls: string[] = [];
        const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
          urls.push(`${init?.method ?? "GET"} ${String(input)}`);
          const next = events.shift();
          if (typeof next === "number") return new Response("{}", { status: next });
          return new Response(JSON.stringify({ id: "R", last_event: next }), { status: 200 });
        }) as typeof fetch;
        return { fetchImpl, urls };
      };

      const failed = reading(["sent", "failed"]);
      assert.equal((await checkResendAccepted("R 1", { fetchImpl: failed.fetchImpl, sleep })).state, "failed");
      assert.deepEqual(failed.urls, ["GET https://api.resend.com/emails/R%201", "GET https://api.resend.com/emails/R%201"]);

      assert.equal((await checkResendAccepted("R", { fetchImpl: reading(["delivered"]).fetchImpl, sleep })).state, "settled");
      assert.equal((await checkResendAccepted("R", { fetchImpl: reading(["suppressed"]).fetchImpl, sleep })).state, "settled", "a Resend suppression is not ours to route around");
      assert.equal((await checkResendAccepted("R", { fetchImpl: reading([429]).fetchImpl, sleep })).state, "pending", "a refused read keeps the send");
      const queued = reading(["queued", "queued", "queued", "queued", "queued"]);
      assert.equal((await checkResendAccepted("R", { fetchImpl: queued.fetchImpl, sleep })).state, "pending");
      assert.equal(queued.urls.length, resendAcceptedCheckDelaysMs.length, "one read per wait, then stop");
      const throwing = (async () => {
        throw new Error("network down");
      }) as typeof fetch;
      assert.equal((await checkResendAccepted("R", { fetchImpl: throwing, sleep })).state, "pending", "a network error never throws");

      assert.ok(sleeps.length > 0 && sleeps.every((ms) => ms > 0), "every read waits first");
      // The outbox drains up to 10 rows inside one 30 s step; a longer wait per row would time the
      // whole drain out and read as a stranded queue.
      assert.ok(resendAcceptedCheckDelaysMs.reduce((sum, ms) => sum + ms, 0) <= 3000, "the check must stay within 3 s per email");

      delete process.env.RESEND_API_KEY;
      assert.equal((await checkResendAccepted("R", { fetchImpl: reading(["failed"]).fetchImpl, sleep })).state, "pending", "no key, no read");
    } finally {
      if (realKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = realKey;
    }
    assert.equal(typeof resendProvider.checkAccepted, "function", "the live Resend provider must carry the check");
    assert.equal(brevoProvider.checkAccepted, undefined, "the backup is the end of the chain — it has nothing to hand to");
  }

  // 14) Resend's `email.failed` webhook states its cause under data.failed.reason — record it, and
  //     never let a failed send suppress the address: the recipient did nothing wrong.
  {
    const row = parseResendWebhookEvent(
      { created_at: "2026-09-28T18:45:50Z", data: { email_id: "R-f", failed: { reason: "reached_daily_quota" }, to: ["someone@example.com"] }, type: "email.failed" },
      "evt-failed-1",
    );
    assert.equal(row.status, "failed");
    assert.equal(row.failure_reason, "reached_daily_quota", "the failed reason must be recorded");
    assert.equal(row.provider_message_id, "R-f");
    assert.equal(suppressionReasonForEvent(row), null, "a provider-side failure must never suppress the recipient");
  }

  // 15) EXTRA ACCOUNTS (owner, 2026-10-08 — Resend's daily quota runs out every day). A second Resend
  //     account and a second Brevo account join the chain only when their key is set, in the order
  //     resend → resend-2 → brevo → brevo-2. Each sends with ITS OWN key and its own verified From,
  //     and the second Resend account reads its accepted-then-failed verdict with its own key — a
  //     Resend id is readable only by the account that accepted it.
  {
    const names = [
      "RESEND_API_KEY",
      "RESEND_API_KEY_2",
      "RESEND_EMAIL_FROM_2",
      "RESEND_API_KEY_3",
      "RESEND_API_KEY_4",
      "BREVO_API_KEY",
      "BREVO_API_KEY_2",
      "BREVO_EMAIL_FROM",
      "BREVO_EMAIL_FROM_2",
      "EMAIL_FAILOVER_ENABLED",
    ];
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    const realFetch = globalThis.fetch;
    try {
      for (const name of names) delete process.env[name];
      process.env.RESEND_API_KEY = "re_one";
      process.env.BREVO_API_KEY = "brevo_one";
      assert.deepEqual(resolveEmailProviders().map((p) => p.name), ["resend", "brevo"], "no extra keys → the chain is unchanged");

      process.env.RESEND_API_KEY_2 = "re_two";
      process.env.BREVO_API_KEY_2 = "brevo_two";
      const chain = resolveEmailProviders();
      assert.deepEqual(chain.map((p) => p.name), ["resend", "resend-2", "brevo", "brevo-2"], "both Resend accounts before both Brevo accounts");

      process.env.RESEND_API_KEY_3 = "re_three";
      assert.deepEqual(
        resolveEmailProviders().map((p) => p.name),
        ["resend", "resend-2", "resend-3", "brevo", "brevo-2"],
        "the third Resend account comes after the second and before any Brevo account",
      );
      process.env.RESEND_API_KEY_4 = "re_four";
      assert.deepEqual(
        resolveEmailProviders().map((p) => p.name),
        ["resend", "resend-2", "resend-3", "resend-4", "brevo", "brevo-2"],
        "the fourth Resend account comes after the third and before any Brevo account",
      );
      delete process.env.RESEND_API_KEY_3;
      assert.deepEqual(
        resolveEmailProviders().map((p) => p.name),
        ["resend", "resend-2", "resend-4", "brevo", "brevo-2"],
        "an unset account is skipped, the rest keep their order",
      );
      delete process.env.RESEND_API_KEY_4;

      process.env.EMAIL_FAILOVER_ENABLED = "false";
      assert.deepEqual(resolveEmailProviders().map((p) => p.name), ["resend"], "the kill switch drops every backup account");
      delete process.env.EMAIL_FAILOVER_ENABLED;

      const requests: Array<{ auth: string; body: Record<string, unknown> | null; url: string }> = [];
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const url = String(input);
        requests.push({ auth: headers.Authorization ?? headers["api-key"] ?? "", body: init?.body ? JSON.parse(String(init.body)) : null, url });
        if (url.includes("brevo")) return new Response(JSON.stringify({ messageId: "<B>" }), { status: 200 });
        if (init?.method === "GET") return new Response(JSON.stringify({ last_event: "failed" }), { status: 200 });
        return new Response(JSON.stringify({ id: "R" }), { status: 200 });
      }) as typeof fetch;

      const [, resendTwo, , brevoTwo] = chain;

      // A bare address keeps the message's display name; only the verified address changes.
      process.env.RESEND_EMAIL_FROM_2 = "phoenix@send2.satopharma.com";
      await resendTwo.send(sampleEmail);
      assert.equal(requests.at(-1)?.auth, "Bearer re_two", "the second Resend account sends with its own key");
      assert.equal(requests.at(-1)?.body?.from, "Phoenix <phoenix@send2.satopharma.com>", "its From is its own verified address");
      assert.equal(requests.at(-1)?.body?.reply_to, "reply@phoenix.example", "Reply-To is untouched");

      const check = await checkResendAccepted("R2", { apiKey: "re_two", delaysMs: [1], sleep: async () => undefined });
      assert.equal(check.state, "failed");
      assert.equal(requests.at(-1)?.auth, "Bearer re_two", "the accepted-then-failed read uses the account that accepted the message");
      assert.equal(typeof resendTwo.checkAccepted, "function", "the second Resend account carries the accepted check too");

      // Unset, the second account sends from the message's own From.
      delete process.env.RESEND_EMAIL_FROM_2;
      await resendTwo.send(sampleEmail);
      assert.equal(requests.at(-1)?.body?.from, sampleEmail.from);

      // Brevo 2: its own key, then its own sender, falling back to the first account's sender.
      process.env.BREVO_EMAIL_FROM = "Sato HR <hr@satopharma.com>";
      await brevoTwo.send(sampleEmail);
      assert.equal(requests.at(-1)?.auth, "brevo_two", "the second Brevo account sends with its own key");
      assert.deepEqual(requests.at(-1)?.body?.sender, { email: "hr@satopharma.com", name: "Sato HR" });
      process.env.BREVO_EMAIL_FROM_2 = "Sato People <people@satopharma.com>";
      await brevoTwo.send(sampleEmail);
      assert.deepEqual(requests.at(-1)?.body?.sender, { email: "people@satopharma.com", name: "Sato People" });
    } finally {
      globalThis.fetch = realFetch;
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }

    // The whole chain walks in order when every account before the last is out of quota.
    const calls: string[] = [];
    const result = await sendPreparedEmailWithFailover(sampleEmail, [
      fakeProvider("resend", { outcome: "failover", reason: "daily quota" }, calls),
      fakeProvider("resend-2", { outcome: "failover", reason: "daily quota" }, calls),
      fakeProvider("brevo", { outcome: "failover", reason: "daily quota" }, calls),
      fakeProvider("brevo-2", { outcome: "sent", id: "<B4>" }, calls),
    ]);
    assert.deepEqual(result, { id: "<B4>", provider: "brevo-2" });
    assert.deepEqual(calls, ["resend", "resend-2", "brevo", "brevo-2"]);

    assert.equal(applySenderOverride("Phoenix HR <hr@send.satopharma.com>", ""), "Phoenix HR <hr@send.satopharma.com>");
    assert.equal(applySenderOverride("hr@send.satopharma.com", "hr@send2.satopharma.com"), "hr@send2.satopharma.com");
    assert.equal(applySenderOverride("Phoenix HR <hr@send.satopharma.com>", "Other <x@y.com>"), "Other <x@y.com>");
  }

  // 9) THE DEDICATED ACCOUNT (owner, 2026-10-13: "make it and hrbp dedicated only for job offers
  //    + sato email composer"). Resend's FIRST account is the only one that can send as hr@, hrbp@
  //    or ceo@ — and automated notification traffic was spending its ~100/day quota (404 Resend
  //    messages on 11 Oct 2026), which is why 30 of the last 63 offers were sent by a backup and 18
  //    of them went out branded Phoenix Workforce. So ordinary Phoenix mail is handed the chain
  //    WITHOUT it; only a Sato human identity starts there.
  {
    const names = ["RESEND_API_KEY_2", "RESEND_API_KEY_3", "RESEND_API_KEY_4", "BREVO_API_KEY", "BREVO_API_KEY_2", "EMAIL_FAILOVER_ENABLED"];
    const saved: Record<string, string | undefined> = {};
    for (const name of names) saved[name] = process.env[name];
    try {
      for (const name of names) delete process.env[name];
      process.env.RESEND_API_KEY_2 = "test-key-2";
      process.env.BREVO_API_KEY = "test-brevo-key";

      const chainFor = (from: string) => resolveEmailProviders({ from }).map((provider) => provider.name);

      // A Sato human identity keeps the dedicated account, and keeps it FIRST.
      for (const identity of [
        "Sato Pharma HR <hr@satopharma.com>",
        "Sato Pharma HR <hr@send.satopharma.com>",
        "Sato Pharma <hrbp@send.satopharma.com>",
        "Anwar Gaweesh <ceo@send.satopharma.com>",
      ]) {
        assert.equal(chainFor(identity)[0], "resend", `the dedicated account is first for ${identity}`);
      }

      // Ordinary automated Phoenix mail does not touch it at all — whichever host it names.
      for (const ordinary of [
        "Phoenix Workforce <phoenix@send.satopharma.com>",
        "Phoenix Workforce <phoenix@satopharma.com>",
        "Phoenix <no-reply@phoenix.example>",
      ]) {
        const chain = chainFor(ordinary);
        assert.ok(!chain.includes("resend"), `ordinary mail must not spend the dedicated quota (${ordinary}): ${chain.join(", ")}`);
        assert.ok(chain.length > 0, `ordinary mail still has somewhere to go (${ordinary})`);
      }

      // `hr@send2…` is NOT an identity sender: the mailbox is right, the host is a backup account's.
      assert.ok(!chainFor("Sato Pharma HR <hr@send2.satopharma.com>").includes("resend"));

      // Asked with no email at all — "is anything configured?" — the whole chain comes back.
      assert.equal(resolveEmailProviders()[0].name, "resend");

      // With NO backup configured, ordinary mail keeps the only account there is: an email that
      // cannot be sent at all is worse than one that spends the reserved quota.
      delete process.env.RESEND_API_KEY_2;
      delete process.env.BREVO_API_KEY;
      assert.deepEqual(chainFor("Phoenix Workforce <phoenix@send.satopharma.com>"), ["resend"]);
    } finally {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  }

  // 10) PER-MODULE ACCOUNTS (owner, 2026-10-13: one Resend account per module, sales first, on
  //     sales.satopharma.com). A module's mail tries ITS account first and then the ordinary chain;
  //     the account is never in the failover pool, so no other module can spend its quota; and it
  //     stays inert until BOTH its key and its sender are set.
  {
    const names = [
      "RESEND_API_KEY_2",
      "RESEND_API_KEY_3",
      "RESEND_API_KEY_4",
      "BREVO_API_KEY",
      "BREVO_API_KEY_2",
      "EMAIL_FAILOVER_ENABLED",
      "RESEND_API_KEY_SALES",
      "RESEND_EMAIL_FROM_SALES",
    ];
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    const realFetch = globalThis.fetch;
    try {
      for (const name of names) delete process.env[name];
      process.env.RESEND_API_KEY_2 = "re_two";
      process.env.BREVO_API_KEY = "brevo_one";

      const ordinaryFrom = "Phoenix Workforce <phoenix@send.satopharma.com>";
      const chainFor = (module: string | null | undefined) =>
        resolveEmailProviders({ from: ordinaryFrom, module }).map((provider) => provider.name);
      const ordinaryChain = ["resend-2", "brevo"];

      // Nothing set: sales mail rides the ordinary chain exactly as before.
      assert.deepEqual(chainFor("sales"), ordinaryChain, "no sales key → unchanged");
      // A key without its verified sender is still inert: it would send from an address its domain does not hold.
      process.env.RESEND_API_KEY_SALES = "re_sales";
      assert.deepEqual(chainFor("sales"), ordinaryChain, "a key with no sender stays out of the chain");
      process.env.RESEND_EMAIL_FROM_SALES = "sales@sales.satopharma.com";

      // Both set: the sales account goes FIRST, behind it the ordinary chain — the mail never stops.
      assert.deepEqual(chainFor("sales"), ["resend-sales", ...ordinaryChain]);
      assert.deepEqual(chainFor("Sales"), ["resend-sales", ...ordinaryChain], "the template category spelling reaches it too");
      assert.deepEqual(chainFor(" SALES "), ["resend-sales", ...ordinaryChain]);

      // No other module reaches it — and a send with no module at all does not either.
      for (const other of ["payroll", "Direct Orders", "system", "Leave Management", "", null, undefined]) {
        assert.deepEqual(chainFor(other), ordinaryChain, `module ${JSON.stringify(other)} must not spend the sales quota`);
      }

      // It is never in the pool: the whole chain (asked with no email) does not list it.
      assert.deepEqual(resolveEmailProviders().map((provider) => provider.name), ["resend", "resend-2", "brevo"]);

      // A Sato human identity keeps the dedicated first account whatever the module says.
      assert.deepEqual(
        resolveEmailProviders({ from: "Sato Pharma HR <hr@satopharma.com>", module: "sales" }).map((provider) => provider.name),
        ["resend", "resend-2", "brevo"],
      );

      // The kill switch drops it with every other backup.
      process.env.EMAIL_FAILOVER_ENABLED = "false";
      assert.deepEqual(chainFor("sales"), ["resend"]);
      delete process.env.EMAIL_FAILOVER_ENABLED;

      // Sending: its own key, its own From, the message's display name kept; a refusal falls through.
      const requests: Array<{ auth: string; body: Record<string, unknown> | null }> = [];
      let salesAnswer = 200;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        requests.push({ auth: headers.Authorization ?? "", body: init?.body ? JSON.parse(String(init.body)) : null });
        if (headers.Authorization === "Bearer re_sales" && salesAnswer !== 200) {
          return new Response(JSON.stringify({ message: "daily limit" }), { status: salesAnswer });
        }
        if (init?.method === "GET") return new Response(JSON.stringify({ last_event: "delivered" }), { status: 200 });
        return new Response(JSON.stringify({ id: headers.Authorization === "Bearer re_sales" ? "S1" : "R2" }), { status: 200 });
      }) as typeof fetch;

      const salesEmail: PreparedEmail = { ...sampleEmail, from: ordinaryFrom, module: "sales" };
      const sent = await sendPreparedEmailWithFailover(salesEmail);
      assert.deepEqual(sent, { id: "S1", provider: "resend-sales" });
      // The accepted-then-failed read follows the send as a GET with no body; the send is the POST.
      const lastPost = requests.filter((request) => request.body).at(-1);
      assert.equal(lastPost?.auth, "Bearer re_sales", "it sends with its own key");
      assert.equal(lastPost?.body?.from, "Phoenix Workforce <sales@sales.satopharma.com>", "a bare sender keeps the display name");

      salesAnswer = 429;
      const overflow = await sendPreparedEmailWithFailover(salesEmail);
      assert.deepEqual(overflow, { id: "R2", provider: "resend-2" }, "a capped sales account hands the mail to the ordinary chain");

      // And another module's mail never touches the sales key.
      salesAnswer = 200;
      requests.length = 0;
      await sendPreparedEmailWithFailover({ ...sampleEmail, from: ordinaryFrom, module: "payroll" });
      assert.ok(requests.every((request) => request.auth !== "Bearer re_sales"), "payroll mail must not use the sales key");
    } finally {
      globalThis.fetch = realFetch;
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  }
}
