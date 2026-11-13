import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  pingDeadMansSwitch,
  signalDeadMansSwitchStart,
  withDeadMansSwitch,
} from "../src/lib/observability/dead-mans-switch.ts";
import { HEALTHCHECKS_CHECKED_SLUGS } from "../src/lib/observability/job-schedule.ts";
import { stripComments } from "./support/comment-strip.ts";

type FetchCall = { url: string; init: RequestInit | undefined };

function stubFetch(behavior: "resolve" | "reject" | "refuse") {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ init, url: String(url) });
    if (behavior === "reject") throw new Error("simulated network failure");
    // "refuse" is what Healthchecks answers when the project is at its check ceiling and will not
    // auto-provision another: a RESOLVED response carrying 403. It is not a network failure, so it
    // never reaches the catch block — which is why it went unlogged for months.
    return new Response(null, { status: behavior === "refuse" ? 403 : 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** Capture the logger's own stdout — a WARNING is one JSON line on console.log. */
function captureLogLines() {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => { console.log = original; } };
}

export async function runDeadMansSwitchTests() {
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

    // 🔴 A REFUSED PING MUST BE SAYABLE. `fetch` resolves on a 403, so the response went unread and
    // nothing was logged — which is how `phoenix-brick-move-drain` pinged every 20 minutes from
    // 2026-10-13 with no check behind it and no trace anywhere (found 2026-10-15). It must still
    // never throw: a monitoring refusal is not an application failure.
    {
      const { calls, restore } = stubFetch("refuse");
      const log = captureLogLines();
      try {
        await assert.doesNotReject(
          () => pingDeadMansSwitch("phoenix-brick-move-drain", "success"),
          "a refused ping must never throw",
        );
      } finally {
        log.restore();
        restore();
      }
      assert.equal(calls.length, 1, "the ping must still be attempted");
      const refusal = log.lines.find((l) => l.includes("deadmans_switch_ping_refused"));
      assert.ok(
        refusal,
        "a non-2xx answer must be LOGGED — an unread response is exactly the silence this closes",
      );
      assert.ok(refusal.includes("phoenix-brick-move-drain"), "the refusal must name the job");
      assert.ok(refusal.includes("403"), "the refusal must carry the status that was refused");
      assert.ok(
        !log.lines.some((l) => l.includes("deadmans_switch_ping_failed")),
        "a refusal is not a network failure and must not be reported as one",
      );
    }

    // A 2xx must stay silent — a warning on every healthy ping would bury the refusal above.
    {
      const { restore } = stubFetch("resolve");
      const log = captureLogLines();
      try {
        await pingDeadMansSwitch("phoenix-notify-daily", "success");
      } finally {
        log.restore();
        restore();
      }
      assert.equal(
        log.lines.filter((l) => l.includes("deadmans_switch_ping")).length,
        0,
        "a successful ping must log nothing about itself",
      );
    }

    // 🔴 ONLY A JOB THAT HOLDS A CHECK PINGS HEALTHCHECKS. Until 12 Nov 2026 every wired job pinged
    // with ?create=1 and the ones with no check were refused on every run - about 1,000 expected 404s
    // a day - so when the whole account stopped answering on 9 Nov 2026 the real refusals looked like
    // the normal ones for three days. An in-house-only job, and a slug nothing declares, must send
    // NOTHING to Healthchecks: not the ending ping, not /fail, not the start signal.
    {
      assert.ok(HEALTHCHECKS_CHECKED_SLUGS.size > 0 && HEALTHCHECKS_CHECKED_SLUGS.size <= 20, "the new account holds 20 checks");
      assert.ok(!HEALTHCHECKS_CHECKED_SLUGS.has("phoenix-crm-integrity-sweep"), "the fixture below must be an in-house-only job");
      const { calls, restore } = stubFetch("resolve");
      try {
        await pingDeadMansSwitch("phoenix-crm-integrity-sweep", "success");
        await pingDeadMansSwitch("phoenix-crm-integrity-sweep", "fail", "boom");
        await signalDeadMansSwitchStart("phoenix-crm-integrity-sweep");
        await withDeadMansSwitch("phoenix-crm-integrity-sweep", async () => "ok", { signalStart: true });
        await pingDeadMansSwitch("phoenix-not-declared-anywhere", "success");
      } finally {
        restore();
      }
      assert.deepEqual(
        calls.map((c) => c.url).filter((u) => u.includes("hc-ping.com")),
        [],
        "a job with no Healthchecks check must never ping it - that ping can only be refused",
      );
    }

    // And every slug in the list really does ping - a list that pinged nothing would pass the block above.
    {
      const { calls, restore } = stubFetch("resolve");
      try {
        for (const slug of HEALTHCHECKS_CHECKED_SLUGS) await pingDeadMansSwitch(slug, "success");
      } finally {
        restore();
      }
      assert.equal(calls.length, HEALTHCHECKS_CHECKED_SLUGS.size, "each checked job sends exactly one ping");
    }

    // withDeadMansSwitch: happy path — returns run()'s value unchanged and pings success.
    {
      const { calls, restore } = stubFetch("resolve");
      try {
        const result = await withDeadMansSwitch("phoenix-process-notifications", async () => ({ processed: 4 }));
        assert.deepEqual(result, { processed: 4 }, "withDeadMansSwitch must return run()'s value unchanged");
        assert.equal(calls.length, 1);
        assert.ok(calls[0].url.endsWith("/phoenix-process-notifications?create=1"), "happy path must ping the plain (success) URL");
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
          () => withDeadMansSwitch("phoenix-reconciliation-check", async () => { throw boom; }),
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

    // THE START SIGNAL. A run a deploy killed halfway and a run that never began are both just a
    // missing ping; `/start` is what lets Healthchecks tell "started, never finished" apart.
    // It is the slug URL with `/start` before the query string, and it carries no body.
    {
      const { calls, restore } = stubFetch("resolve");
      try {
        await signalDeadMansSwitchStart("phoenix-notify-daily");
        assert.equal(calls.length, 1, "one start signal is exactly one request");
        assert.equal(calls[0].url, "https://hc-ping.com/test-ping-key/phoenix-notify-daily/start?create=1");
        assert.equal(calls[0].init?.method, "POST");
        assert.equal(calls[0].init?.body, undefined, "a start signal carries no body");
      } finally {
        restore();
      }
    }

    // Inert exactly like a ping: no key, or a non-production runtime, means no network call at all.
    {
      const { calls, restore } = stubFetch("resolve");
      try {
        process.env.APP_ENV = "staging";
        await signalDeadMansSwitchStart("phoenix-notify-daily");
        assert.equal(calls.length, 0, "non-production ⇒ a start signal must never reach the shared dashboard");
        process.env.APP_ENV = "production";
        delete process.env.HEALTHCHECKS_PING_KEY;
        await signalDeadMansSwitchStart("phoenix-notify-daily");
        assert.equal(calls.length, 0, "no ping key ⇒ a start signal must never attempt a network call");
      } finally {
        process.env.APP_ENV = "production";
        process.env.HEALTHCHECKS_PING_KEY = "test-ping-key";
        restore();
      }
    }

    // A start signal that cannot be delivered must never throw, exactly like a ping.
    {
      const { restore } = stubFetch("reject");
      try {
        await assert.doesNotReject(
          () => signalDeadMansSwitchStart("phoenix-notify-daily"),
          "a failed start signal must never throw out of a cron job",
        );
      } finally {
        restore();
      }
    }

    // withDeadMansSwitch is OPT-IN: a job that does not ask sends exactly the one ending ping it
    // always did, so the other twenty-odd wired jobs are unchanged.
    {
      const { calls, restore } = stubFetch("resolve");
      try {
        await withDeadMansSwitch("phoenix-process-notifications", async () => "ok");
        assert.equal(calls.length, 1, "no signalStart ⇒ no start signal");
        assert.ok(!calls[0].url.includes("/start"));
      } finally {
        restore();
      }
    }

    // With signalStart the start comes FIRST and is AWAITED before the run begins - a start that
    // landed after the success ping would leave the check "started" for good and raise a false
    // alarm - then the ending ping follows. The run observes the start already sent.
    {
      const { calls, restore } = stubFetch("resolve");
      try {
        let seenWhenRunBegan = -1;
        const result = await withDeadMansSwitch(
          "phoenix-db-health-snapshot",
          async () => {
            seenWhenRunBegan = calls.length;
            return { photos: 3 };
          },
          { signalStart: true },
        );
        assert.deepEqual(result, { photos: 3 }, "run()'s value passes through unchanged");
        assert.equal(seenWhenRunBegan, 1, "the start signal must already be sent when the run begins");
        assert.equal(calls.length, 2, "one start, one ending ping");
        assert.equal(calls[0].url, "https://hc-ping.com/test-ping-key/phoenix-db-health-snapshot/start?create=1");
        assert.equal(calls[1].url, "https://hc-ping.com/test-ping-key/phoenix-db-health-snapshot?create=1");
      } finally {
        restore();
      }
    }

    // A run that throws after a start still ends in /fail and still re-throws the original error.
    {
      const { calls, restore } = stubFetch("resolve");
      try {
        const boom = new Error("cut off by upstream");
        await assert.rejects(
          () => withDeadMansSwitch("phoenix-reconciliation-check", async () => { throw boom; }, { signalStart: true }),
          (err: unknown) => err === boom,
        );
        assert.equal(calls.length, 2);
        assert.ok(calls[0].url.includes("/start?"), "start first");
        assert.ok(calls[1].url.includes("/fail?"), "then /fail");
      } finally {
        restore();
      }
    }

    // The long jobs actually ask for it, at the point they run. Source-level because the
    // routes cannot be executed here; comment-stripped so the explanation cannot satisfy the check.
    {
      const read = (path: string) => stripComments(readFileSync(new URL(path, import.meta.url), "utf8"));
      const sweep = read("../app/api/cron/phoenix-crm-integrity-sweep/route.ts");
      // The morning jobs signal start wherever they run: the 06:36 fan-out under `phoenix-notify-daily`
      // while PHOENIX_DAILY_JOBS_SPLIT is off, each job's own route under its own slug once it is on.
      const fanOut = read("../app/api/notifications/daily/route.ts");
      const daily = read("../app/api/cron/daily/[job]/route.ts");
      assert.match(sweep, /withDeadMansSwitch\(\s*"phoenix-crm-integrity-sweep"[\s\S]*?signalStart:\s*true/, "integrity sweep must signal start");
      assert.match(fanOut, /await signalDeadMansSwitchStart\("phoenix-notify-daily"\);/, "the morning fan-out must signal start");
      assert.ok(
        fanOut.indexOf('await signalDeadMansSwitchStart("phoenix-notify-daily");') < fanOut.indexOf("await runDailyNotifications(request"),
        "and before the run, not after it",
      );
      assert.match(daily, /await signalDeadMansSwitchStart\(slug\);/, "each morning job must signal start");
      assert.ok(
        daily.indexOf("await signalDeadMansSwitchStart(slug);") < daily.indexOf("await runOneDailyJob(request"),
        "and before the run, not after it",
      );
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
