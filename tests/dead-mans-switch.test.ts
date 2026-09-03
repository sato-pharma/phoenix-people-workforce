import assert from "node:assert/strict";

import { failureDetail, pingDeadMansSwitch, withDeadMansSwitch } from "../src/lib/observability/dead-mans-switch.ts";

type FetchCall = { url: string; init: RequestInit | undefined };

function stubFetch(behavior: "resolve" | "reject") {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ init, url: String(url) });
    if (behavior === "reject") throw new Error("simulated network failure");
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

export async function runDeadMansSwitchTests() {
  // --- failureDetail: the diagnostic a failed cron actually leaves behind ---
  //
  // Supabase/PostgREST rejects with a PLAIN OBJECT, not an Error, so the `String(error)` this
  // repo used at 13 call sites produced the literal "[object Object]". On 2026-09-03
  // phoenix-expense-claims-refresh failed hourly recording exactly that: the heartbeat said
  // "[object Object]", app_error_events held nothing, and the real cause — a check-constraint
  // violation naming the constraint and both amounts — was in the rejected object the whole time.
  {
    const postgrestError = {
      code: "23514",
      details: "Failing row contains (OUTSTATION-52, approved, 364.00, 800.00).",
      hint: null,
      message: 'new row for relation "expense_claims" violates check constraint "expense_claims_approved_total_range"',
    };
    const detail = failureDetail(postgrestError);

    assert.notEqual(
      detail,
      "[object Object]",
      "a PostgREST rejection must never render as [object Object] — that is the whole diagnostic gone",
    );
    assert.ok(
      detail.includes("expense_claims_approved_total_range"),
      `the failing constraint must survive into the heartbeat detail, got: ${detail}`,
    );
    assert.ok(
      detail.includes("23514"),
      `the SQLSTATE must survive into the heartbeat detail, got: ${detail}`,
    );
    assert.ok(
      detail.includes("OUTSTATION-52"),
      `PostgREST's own details field names the offending row and must not be dropped, got: ${detail}`,
    );

    assert.equal(
      failureDetail(new Error("real failure")),
      "Error: real failure",
      "a genuine Error keeps its existing name: message shape, so nothing already readable in the job history changes",
    );
    assert.ok(
      typeof failureDetail("plain string") === "string" && typeof failureDetail(null) === "string",
      "failureDetail must return a string for any thrown value — it runs on the failure path and must never throw itself",
    );
  }

  const saved = {
    APP_ENV: process.env.APP_ENV,
    NODE_ENV: process.env.NODE_ENV,
    VERCEL_ENV: process.env.VERCEL_ENV,
    HEALTHCHECKS_PING_KEY: process.env.HEALTHCHECKS_PING_KEY,
    HEALTHCHECKS_PING_HOST: process.env.HEALTHCHECKS_PING_HOST,
  };
  try {
    process.env.APP_ENV = "production";
    delete process.env.VERCEL_ENV;

    // Not configured yet (no key) — must be a complete no-op, even in production. This is what
    // keeps the code inert on every environment until the owner sets the key.
    {
      delete process.env.HEALTHCHECKS_PING_KEY;
      const { calls, restore } = stubFetch("resolve");
      try {
        await pingDeadMansSwitch("phoenix-notify-daily", "success");
        assert.equal(calls.length, 0, "no HEALTHCHECKS_PING_KEY ⇒ must never attempt a network call");
      } finally {
        restore();
      }
    }

    // Non-production, even with a key configured — must never ping. Prevents dev/staging runs
    // from flapping a shared production Healthchecks dashboard.
    {
      process.env.HEALTHCHECKS_PING_KEY = "test-ping-key";
      process.env.APP_ENV = "staging";
      const { calls, restore } = stubFetch("resolve");
      try {
        await pingDeadMansSwitch("phoenix-notify-daily", "success");
        assert.equal(calls.length, 0, "non-production ⇒ must never attempt a network call, even when configured");
      } finally {
        restore();
        process.env.APP_ENV = "production";
      }
    }

    // Production + configured + success ⇒ pings the plain (non-/fail) slug URL, with
    // auto-provisioning enabled so the check is created on first real ping.
    {
      const { calls, restore } = stubFetch("resolve");
      try {
        await pingDeadMansSwitch("phoenix-notify-daily", "success");
        assert.equal(calls.length, 1, "configured + production + success ⇒ exactly one ping");
        assert.equal(calls[0].url, "https://hc-ping.com/test-ping-key/phoenix-notify-daily?create=1");
        assert.equal(calls[0].init?.method, "POST");
        assert.equal(calls[0].init?.body, undefined, "a success ping with no detail must send no body");
      } finally {
        restore();
      }
    }

    // Failure ⇒ the /fail suffix, placed before the query string, and the detail as the body.
    {
      const { calls, restore } = stubFetch("resolve");
      try {
        await pingDeadMansSwitch("phoenix-process-notifications", "fail", "3 of 22 sub-jobs failed");
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, "https://hc-ping.com/test-ping-key/phoenix-process-notifications/fail?create=1");
        assert.equal(calls[0].init?.body, "3 of 22 sub-jobs failed");
      } finally {
        restore();
      }
    }

    // Oversized detail is truncated, not rejected/dropped — Healthchecks accepts up to 100KB but
    // there is no reason to send more than a short diagnostic summary.
    {
      const { calls, restore } = stubFetch("resolve");
      try {
        const huge = "x".repeat(10_000);
        await pingDeadMansSwitch("phoenix-notify-daily", "fail", huge);
        assert.ok((calls[0].init?.body as string).length <= 4_000, "detail body must be capped, not sent unbounded");
      } finally {
        restore();
      }
    }

    // HEALTHCHECKS_PING_HOST override (e.g. a self-hosted instance) — and a trailing slash on the
    // configured host must not produce a double slash in the constructed URL.
    {
      process.env.HEALTHCHECKS_PING_HOST = "https://healthchecks.example.internal/";
      const { calls, restore } = stubFetch("resolve");
      try {
        await pingDeadMansSwitch("phoenix-notify-daily", "success");
        assert.equal(calls[0].url, "https://healthchecks.example.internal/test-ping-key/phoenix-notify-daily?create=1");
      } finally {
        restore();
        delete process.env.HEALTHCHECKS_PING_HOST;
      }
    }

    // The ping itself failing (network error, timeout, non-2xx — all surface as a fetch throw or
    // are simply ignored, since the response is never inspected) must never throw out of
    // pingDeadMansSwitch. This is the core best-effort contract: a Healthchecks outage must never
    // become a second, self-inflicted incident.
    {
      const { restore } = stubFetch("reject");
      try {
        await assert.doesNotReject(
          () => pingDeadMansSwitch("phoenix-notify-daily", "success"),
          "a failed ping attempt must never throw",
        );
      } finally {
        restore();
      }
    }

    // withDeadMansSwitch: happy path — returns run()'s value unchanged and pings success.
    {
      const { calls, restore } = stubFetch("resolve");
      try {
        const result = await withDeadMansSwitch("phoenix-background-jobs", async () => ({ processed: 4 }));
        assert.deepEqual(result, { processed: 4 }, "withDeadMansSwitch must return run()'s value unchanged");
        assert.equal(calls.length, 1);
        assert.ok(calls[0].url.endsWith("/phoenix-background-jobs?create=1"), "happy path must ping the plain (success) URL");
      } finally {
        restore();
      }
    }

    // withDeadMansSwitch: run() throws — the SAME error propagates to the caller (this must never
    // be swallowed), and a /fail ping is sent carrying the error's own message as detail.
    {
      const { calls, restore } = stubFetch("resolve");
      try {
        const boom = new Error("upstream provider unreachable");
        await assert.rejects(
          () => withDeadMansSwitch("phoenix-ireports360-sync", async () => { throw boom; }),
          (err: unknown) => err === boom,
          "withDeadMansSwitch must re-throw the exact original error, not swallow or wrap it",
        );
        assert.equal(calls.length, 1);
        assert.ok(calls[0].url.includes("/fail"), "a thrown run() must ping the /fail URL");
        assert.ok((calls[0].init?.body as string).includes("upstream provider unreachable"));
      } finally {
        restore();
      }
    }

    // withDeadMansSwitch: even if the ping call itself fails, run()'s own success/failure outcome
    // must still be the only thing that determines what the caller sees.
    {
      const { restore } = stubFetch("reject");
      try {
        const result = await withDeadMansSwitch("phoenix-notify-daily", async () => "ok");
        assert.equal(result, "ok", "a failed ping must never mask a successful run() result");

        const boom = new Error("real failure");
        await assert.rejects(
          () => withDeadMansSwitch("phoenix-notify-daily", async () => { throw boom; }),
          (err: unknown) => err === boom,
          "a failed ping must never mask run()'s real error, or replace it with a ping error",
        );
      } finally {
        restore();
      }
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
