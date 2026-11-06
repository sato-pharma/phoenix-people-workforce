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

  // 15) ONE RESEND ACCOUNT, ONE BREVO ACCOUNT — NOTHING ELSE (owner, 2026-11-06: "keep a free Resend
  //     account as the primary, and one Brevo account in case needed as a fallback"). The retired
  //     accounts — Resend 2, 3 and 4, the Sales and People module accounts, Brevo 2 — may still have
  //     keys on Railway, so every one of them is SET here and must not reach the chain, for any
  //     module or sender. Mail from hr@ no longer gets a chain of its own either.
  {
    const names = [
      "RESEND_API_KEY",
      "RESEND_API_KEY_2",
      "RESEND_EMAIL_FROM_2",
      "RESEND_API_KEY_3",
      "RESEND_EMAIL_FROM_3",
      "RESEND_API_KEY_4",
      "RESEND_EMAIL_FROM_4",
      "RESEND_API_KEY_SALES",
      "RESEND_EMAIL_FROM_SALES",
      "RESEND_API_KEY_PEOPLE",
      "RESEND_EMAIL_FROM_PEOPLE",
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
      process.env.RESEND_API_KEY_2 = "re_two";
      process.env.RESEND_EMAIL_FROM_2 = "phoenix@send2.satopharma.com";
      process.env.RESEND_API_KEY_3 = "re_three";
      process.env.RESEND_EMAIL_FROM_3 = "phoenix@send3.satopharma.com";
      process.env.RESEND_API_KEY_4 = "re_four";
      process.env.RESEND_EMAIL_FROM_4 = "phoenix@send4.satopharma.com";
      process.env.RESEND_API_KEY_SALES = "re_sales";
      process.env.RESEND_EMAIL_FROM_SALES = "sales@sales.satopharma.com";
      process.env.RESEND_API_KEY_PEOPLE = "re_people";
      process.env.RESEND_EMAIL_FROM_PEOPLE = "people@people.satopharma.com";
      process.env.BREVO_API_KEY_2 = "brevo_two";

      assert.deepEqual(resolveEmailProviders().map((p) => p.name), ["resend", "brevo"], "only one Resend and one Brevo account, whatever else is set");

      process.env.EMAIL_FAILOVER_ENABLED = "false";
      assert.deepEqual(resolveEmailProviders().map((p) => p.name), ["resend"], "the kill switch drops Brevo");
      delete process.env.EMAIL_FAILOVER_ENABLED;

      // Every kind of mail is sent through the same two accounts: a module that used to own an
      // account, mail from hr@, and plain Phoenix mail. The send is the POST; the accepted check is a GET.
      const requests: Array<{ auth: string; body: Record<string, unknown> | null; method: string; url: string }> = [];
      let resendAnswer = 200;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const url = String(input);
        const method = init?.method ?? "GET";
        requests.push({ auth: headers.Authorization ?? headers["api-key"] ?? "", body: init?.body ? JSON.parse(String(init.body)) : null, method, url });
        if (url.includes("brevo")) return new Response(JSON.stringify({ messageId: "<B>" }), { status: 200 });
        if (method === "GET") return new Response(JSON.stringify({ last_event: "delivered" }), { status: 200 });
        if (resendAnswer !== 200) return new Response(JSON.stringify({ message: "daily quota" }), { status: resendAnswer });
        return new Response(JSON.stringify({ id: "R" }), { status: 200 });
      }) as typeof fetch;

      const retiredKeys = ["Bearer re_two", "Bearer re_three", "Bearer re_four", "Bearer re_sales", "Bearer re_people", "brevo_two"];
      const kinds: Array<{ from: string; module: string | null }> = [
        { from: "Phoenix Workforce <phoenix@send.satopharma.com>", module: "sales" },
        { from: "Phoenix Workforce <phoenix@send.satopharma.com>", module: "Leave Management" },
        { from: "Phoenix Workforce <phoenix@send.satopharma.com>", module: "recruitment" },
        { from: "Phoenix Workforce <phoenix@send.satopharma.com>", module: "payroll" },
        { from: "Phoenix Workforce <phoenix@send.satopharma.com>", module: null },
        { from: "Sato Pharma HR <hr@satopharma.com>", module: "recruitment" },
      ];
      for (const kind of kinds) {
        requests.length = 0;
        const sent = await sendPreparedEmailWithFailover({ ...sampleEmail, ...kind });
        assert.deepEqual(sent, { id: "R", provider: "resend" }, `${kind.module ?? "no module"} mail goes to the one Resend account`);
        const post = requests.find((request) => request.method === "POST");
        assert.equal(post?.auth, "Bearer re_one", "it sends with the one Resend key");
        assert.equal(post?.body?.from, kind.from, "Resend keeps the message's own From — no account rewrites it");
        assert.ok(requests.every((request) => !retiredKeys.includes(request.auth)), "no retired account is ever called");
      }

      // Resend out of quota → Brevo, with Brevo's own sender, and still never a retired account.
      resendAnswer = 429;
      process.env.BREVO_EMAIL_FROM = "Phoenix Workforce <phoenix@send.satopharma.com>";
      requests.length = 0;
      const overflow = await sendPreparedEmailWithFailover({ ...sampleEmail, from: "Phoenix Workforce <phoenix@send.satopharma.com>", module: "sales" });
      assert.deepEqual(overflow, { id: "<B>", provider: "brevo" }, "a capped Resend account hands the mail to Brevo");
      assert.deepEqual(
        requests.map((request) => request.auth),
        ["Bearer re_one", "brevo_one"],
        "exactly two calls: the one Resend account, then the one Brevo account",
      );
      assert.deepEqual(requests.at(-1)?.body?.sender, { email: "phoenix@send.satopharma.com", name: "Phoenix Workforce" });
    } finally {
      globalThis.fetch = realFetch;
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }

    assert.equal(applySenderOverride("Phoenix HR <hr@send.satopharma.com>", ""), "Phoenix HR <hr@send.satopharma.com>");
    assert.equal(applySenderOverride("Phoenix HR <hr@send.satopharma.com>", "hr@send2.satopharma.com"), "Phoenix HR <hr@send2.satopharma.com>");
    assert.equal(applySenderOverride("Phoenix HR <hr@send.satopharma.com>", "Other <x@y.com>"), "Other <x@y.com>");
  }
}
