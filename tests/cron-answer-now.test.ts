import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { answerNowThenFinish, callerWaitsForTheRun } from "../src/lib/http/answer-now.ts";
import { fireCronRouteOnLoopback } from "../src/lib/observability/job-refire.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A SCHEDULED ROUTE THAT OUTLASTS ITS SCHEDULER ANSWERS AT ONCE (integration audit, 13 Nov 2026).
//
// cron-job.org hangs up after 30 seconds. Read on production that day: the daily notification run was
// cut at 30,141 ms, the reconciliation check at 30,155 ms, the mailbox sweep at 30,172 ms, and the
// weekly Private Calendar notice finished at 28,987 ms. Each run still completed and still reported
// to its heartbeat, but the scheduler recorded a failure every day for work that had succeeded, and
// its terms switch a job off after more than 25 failures in a row.
//
// What this file pins:
//   1. the helper answers 202 before the run has started, and the run then happens exactly once;
//   2. `?wait=1` waits and hands back the run's own response, which is what the stranded-job re-fire
//      reads, and the re-fire really asks for it;
//   3. each of the routes (the morning fan-out and the per-job route among them) checks the cron secret BEFORE answering, and still reports its outcome
//      to the heartbeat, because a 202 with no heartbeat behind it is a failure turned into silence.
// ─────────────────────────────────────────────────────────────────────────────

const read = (path: string) => stripComments(readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n"));

const ROUTES: Array<{ file: string; job: string; reportsThrough: RegExp }> = [
  {
    // The morning fan-out, which runs every morning job while PHOENIX_DAILY_JOBS_SPLIT is off.
    file: "../app/api/notifications/daily/route.ts",
    job: '"phoenix-notify-daily"',
    reportsThrough: /pingDeadMansSwitch\(\s*"phoenix-notify-daily"/,
  },
  {
    // The morning jobs one per request, once the switch is on (13 Nov 2026 split). The heartbeat
    // slug is computed from the job's name.
    file: "../app/api/cron/daily/[job]/route.ts",
    job: "slug",
    reportsThrough: /pingDeadMansSwitch\(\s*slug/,
  },
  {
    file: "../app/api/cron/reconciliation-check/route.ts",
    job: '"phoenix-reconciliation-check"',
    reportsThrough: /withDeadMansSwitch\("phoenix-reconciliation-check"/,
  },
  {
    file: "../app/api/cron/mailbox-offboarding-sweep/route.ts",
    job: '"phoenix-mailbox-offboarding-sweep"',
    reportsThrough: /pingDeadMansSwitch\(\s*"phoenix-mailbox-offboarding-sweep"/,
  },
  {
    file: "../app/api/cron/private-calendar-gap-notice/route.ts",
    job: "GAP_NOTICE_JOB_SLUG",
    reportsThrough: /withDeadMansSwitch\(GAP_NOTICE_JOB_SLUG/,
  },
];

/** What is wrong with a route file, or nothing. Exported so the pin can be handed a broken copy. */
export function answerNowRouteProblems(source: string, job: string, reportsThrough: RegExp): string[] {
  const problems: string[] = [];
  const get = source.indexOf("export async function GET(");
  if (get < 0) return ["it has no GET handler"];
  const nextExport = source.indexOf("\nexport ", get + 1);
  const handler = source.slice(get, nextExport < 0 ? undefined : nextExport);
  const auth = handler.indexOf("assertCronAuthorized(");
  const denied = handler.indexOf("if (denied) return denied;");
  const answer = handler.indexOf(`answerNowThenFinish(request, ${job}`);
  if (answer < 0) problems.push(`GET does not answer through answerNowThenFinish(request, ${job}, …)`);
  if (auth < 0 || denied < 0) problems.push("GET does not check the cron secret");
  if (answer >= 0 && (auth < 0 || denied < 0 || denied > answer)) {
    problems.push("the cron secret is checked after the answer, so an unauthorized caller would start the run");
  }
  if (!reportsThrough.test(source)) problems.push("the run no longer reports its outcome to the heartbeat");
  return problems;
}

export async function runCronAnswerNowTests() {
  const request = (query = "") => new Request(`https://phoenix.test/api/cron/example${query}`);

  // ── 1. The default: answered before the run starts, and the run happens once ────────────────
  {
    let runs = 0;
    const queued: Array<() => Promise<void>> = [];
    const response = await answerNowThenFinish(
      request(),
      "phoenix-example",
      async () => {
        runs += 1;
        return Response.json({ done: true });
      },
      (task) => {
        queued.push(task);
      },
    );
    assert.equal(response.status, 202, "the scheduler is answered 202, inside its 30 seconds");
    assert.equal(runs, 0, "and the answer does not wait for the run: nothing has started yet");
    const body = (await response.json()) as { accepted?: boolean; job?: string };
    assert.equal(body.accepted, true);
    assert.equal(body.job, "phoenix-example", "the answer names the job whose heartbeat carries the verdict");
    assert.equal(queued.length, 1, "exactly one run is handed to after-the-response");
    await queued[0]();
    assert.equal(runs, 1, "the run then happens, once");
  }

  // ── 2. `?wait=1` is the old behaviour, whole ────────────────────────────────────────────────
  {
    let scheduled = 0;
    const response = await answerNowThenFinish(
      request("?wait=1"),
      "phoenix-example",
      async () => Response.json({ report: "full" }, { status: 500 }),
      () => {
        scheduled += 1;
      },
    );
    assert.equal(response.status, 500, "a waiting caller reads the run's own status, a failure included");
    assert.deepEqual(await response.json(), { report: "full" }, "and the run's own body");
    assert.equal(scheduled, 0, "nothing is deferred for a caller who waits");
  }
  assert.equal(callerWaitsForTheRun(request("?wait=1")), true);
  assert.equal(callerWaitsForTheRun(request("?other=1&wait=1")), true);
  for (const notWaiting of ["", "?wait=0", "?wait=true", "?wait=", "?waiting=1"]) {
    assert.equal(callerWaitsForTheRun(request(notWaiting)), false, `"${notWaiting}" does not ask to wait: only wait=1 does`);
  }

  // ── 3. Outside a request scope the run is awaited, as every caller did before ───────────────
  {
    let runs = 0;
    const response = await answerNowThenFinish(
      request(),
      "phoenix-example",
      async () => {
        runs += 1;
        return Response.json({ done: true });
      },
      () => {
        throw new Error("`after` was called outside a request scope");
      },
    );
    assert.equal(response.status, 200, "with nowhere to defer to, the run's own response comes back");
    assert.equal(runs, 1, "and it ran exactly once, not once for the attempt and once for the fallback");
  }
  {
    // The real scheduler, with no injected one: the unit suite is not a request, so this is the
    // fallback path through Next's own `after`.
    const response = await answerNowThenFinish(request(), "phoenix-example", async () => Response.json({ real: true }));
    assert.deepEqual(await response.json(), { real: true }, "Next's own after() throws outside a request and the run is awaited");
  }

  // ── 4. A run that throws after the answer is logged, never an unhandled rejection ───────────
  {
    const queued: Array<() => Promise<void>> = [];
    await answerNowThenFinish(
      request(),
      "phoenix-example",
      async () => {
        throw new Error("the run blew up after the scheduler was answered");
      },
      (task) => {
        queued.push(task);
      },
    );
    const original = console.error;
    console.error = () => {};
    try {
      await assert.doesNotReject(queued[0](), "the deferred run swallows its throw: there is no caller left to hand it to");
      // The error log prints its own line a tick later; keep the console quiet until it has.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      console.error = original;
    }
  }

  // ── 5. The routes: secret first, answer second, heartbeat still behind it ──────────────
  for (const route of ROUTES) {
    const source = read(route.file);
    assert.deepEqual(answerNowRouteProblems(source, route.job, route.reportsThrough), [], `${route.file}`);
    assert.match(source, /import \{ answerNowThenFinish \} from "@\/lib\/http\/answer-now";/, `${route.file} imports the helper`);
  }
  // The pin must fire on a broken copy, or it proves nothing.
  {
    const mailbox = ROUTES.find((route) => route.file.includes("mailbox-offboarding-sweep"));
    assert.ok(mailbox, "the mailbox sweep is one of the routes");
    const good = read(mailbox.file);
    const { job, reportsThrough } = mailbox;
    const unwrapped = good.replace(`return answerNowThenFinish(request, ${job}, () => runSweep());`, "return runSweep();");
    assert.notEqual(unwrapped, good, "the broken copy really differs");
    assert.ok(
      answerNowRouteProblems(unwrapped, job, reportsThrough).some((problem) => problem.includes("does not answer through")),
      "a route that waits for its run again is caught",
    );
    const noSecret = good.replace("if (denied) return denied;", "");
    assert.ok(
      answerNowRouteProblems(noSecret, job, reportsThrough).some((problem) => problem.includes("cron secret")),
      "a route that answers without checking the cron secret is caught",
    );
    const silent = good.replace(/pingDeadMansSwitch\(/g, "skipThePing(");
    assert.ok(
      answerNowRouteProblems(silent, job, reportsThrough).some((problem) => problem.includes("heartbeat")),
      "a route that answers 202 and then reports to nobody is caught",
    );
  }

  // ── 6. The stranded-job re-fire asks the route to wait ──────────────────────────────────────
  {
    const saved = { APP_ENV: process.env.APP_ENV, CRON_SECRET: process.env.CRON_SECRET, PORT: process.env.PORT };
    const originalFetch = globalThis.fetch;
    const called: Array<{ authorization: string | null; url: string }> = [];
    let status = 200;
    process.env.APP_ENV = "production";
    process.env.CRON_SECRET = "unit-suite-placeholder";
    process.env.PORT = "8080";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      called.push({ authorization: new Headers(init?.headers).get("authorization"), url: String(input) });
      return new Response("{}", { status });
    }) as typeof fetch;
    try {
      await fireCronRouteOnLoopback("/api/cron/daily/birthday");
      assert.equal(called.length, 1);
      assert.equal(
        called[0].url,
        "http://127.0.0.1:8080/api/cron/daily/birthday?wait=1",
        "the re-fire waits for the run, so the status it reads is the run's and not a 202",
      );
      assert.equal(called[0].authorization, "Bearer unit-suite-placeholder", "and still carries the cron secret");

      status = 500;
      await assert.rejects(
        fireCronRouteOnLoopback("/api/cron/reconciliation-check"),
        /answered 500/,
        "a re-fired run that failed is reported as failed, which only a waiting call can know",
      );
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
}
