import assert from "node:assert/strict";

import { RetryableEmailError } from "../src/lib/email/email-errors.ts";
import {
  brevoProvider,
  resendProvider,
  resolveEmailProviders,
  sendPreparedEmailWithFailover,
  type EmailProvider,
  type PreparedEmail,
  type ProviderSendResult,
} from "../src/lib/email/email-providers.ts";

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
}
