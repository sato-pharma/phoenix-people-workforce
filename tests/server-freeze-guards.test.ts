import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveInProcessHostRefusal } from "../src/lib/crm/live-poller.ts";
import { EVENT_LOOP_STALL_ALERT_MS, stallAlertFor } from "../src/lib/observability/process-health.ts";
import { beginJob, drainJobWindow, trackJob } from "../src/lib/observability/running-jobs.ts";
import { SENTRY_PAGE_SURVEY_ENDS_AT_MS, sentryProfileSessionSampleRate } from "../src/lib/observability/sentry-policy.ts";
import {
  isUnrecognisedProcessRole,
  processRoleRefusal,
  resolveProcessRole,
  runsBackgroundJobs,
} from "../src/lib/platform/process-role.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE PAGE SERVER MUST NOT FREEZE FOR WORK NOBODY IS WAITING ON (2026-10-16).
//
// Phoenix ran as ONE Railway process that answered every page AND ran the background jobs. Node runs
// JavaScript on one thread, so a job's heavy stretch froze every page in flight. Measured that day from
// the per-minute process-health line:
//   - three 4.3-second freezes in three and a half hours, each straight after the biggest slice of the
//     hourly doctor-list scrape;
//   - and, once the page survey traced every page with the CPU profiler on, the worst stall of a typical
//     minute rose from 31-88 ms to 372 ms at the same traffic.
//
// Four guards, each pinned here:
//   (1) the profiler is OFF while the survey traces every page;
//   (2) a process told it is the `web` role starts none of the background schedulers;
//   (3) the jobs register themselves, so a stall line names the job that ran;
//   (4) a page server's minute past the alert line raises a named, fingerprinted alert.
// ─────────────────────────────────────────────────────────────────────────────

function code(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n"));
}

const ENV_KEYS = ["PHOENIX_PROCESS_ROLE", "PHOENIX_LIVE_CRM_POLL", "NODE_ENV", "RAILWAY_ENVIRONMENT_NAME"] as const;

export async function runServerFreezeGuardsTests() {
  // ── (1) The profiler is off for the survey ────────────────────────────────
  assert.equal(
    sentryProfileSessionSampleRate(SENTRY_PAGE_SURVEY_ENDS_AT_MS - 1),
    0,
    "RED the profiler must be off while the survey traces every page — on, it ran on every page and the typical stall went from ~30 ms to 372 ms",
  );
  assert.equal(sentryProfileSessionSampleRate(SENTRY_PAGE_SURVEY_ENDS_AT_MS), 1, "it comes back by itself when the survey ends");
  for (const path of ["src/lib/observability/sentry-server.ts", "src/lib/observability/sentry-client.ts"]) {
    const source = code(path);
    assert.match(
      source,
      /profileSessionSampleRate: sentryProfileSessionSampleRate\(\)/,
      `RED ${path} must take the profiler rate from the policy function, never a literal or the old constant`,
    );
    assert.doesNotMatch(source, /SENTRY_PROFILE_SESSION_SAMPLE_RATE/, `${path} must not bring back the fixed rate`);
  }

  // ── (2) The role: unset means today's behaviour, `web` refuses the schedulers ──
  assert.equal(resolveProcessRole(undefined), "all", "unset is exactly the behaviour before the split");
  assert.equal(resolveProcessRole(""), "all");
  assert.equal(resolveProcessRole(" Web "), "web", "case and spaces are forgiven");
  assert.equal(resolveProcessRole("worker"), "worker");
  assert.equal(resolveProcessRole("wrker"), "all", "a typo must never be the reason the background jobs stop");
  assert.equal(isUnrecognisedProcessRole("wrker"), true, "and it is said at boot");
  assert.equal(isUnrecognisedProcessRole(undefined), false);
  assert.equal(isUnrecognisedProcessRole("all"), false);
  assert.equal(runsBackgroundJobs("web"), false);
  assert.equal(runsBackgroundJobs("worker"), true);
  assert.equal(runsBackgroundJobs("all"), true);
  assert.match(processRoleRefusal("web") ?? "", /worker service runs the background jobs/);
  assert.equal(processRoleRefusal("worker"), null);
  assert.equal(processRoleRefusal(undefined), null);

  // Behaviour through the shared host guard every scheduler uses (the poller, the Early Birds close, CRM
  // housekeeping): with every other guard passing, only the role decides.
  const env = process.env as Record<string, string | undefined>;
  const saved = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, env[key]]));
  try {
    env.PHOENIX_LIVE_CRM_POLL = "true";
    env.NODE_ENV = "production";
    env.RAILWAY_ENVIRONMENT_NAME = "production";
    delete env.PHOENIX_PROCESS_ROLE;
    assert.equal(resolveInProcessHostRefusal(), null, "precondition: a production host with no role runs the jobs, as before");
    env.PHOENIX_PROCESS_ROLE = "worker";
    assert.equal(resolveInProcessHostRefusal(), null, "the worker runs them");
    env.PHOENIX_PROCESS_ROLE = "web";
    assert.match(
      resolveInProcessHostRefusal() ?? "",
      /PHOENIX_PROCESS_ROLE is 'web'/,
      "RED the page server must refuse every background scheduler — a job there freezes every page while it runs",
    );
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
  for (const path of ["src/lib/crm/housekeeping-scheduler.ts", "src/lib/early-birds/close-scheduler.ts"]) {
    assert.match(code(path), /const hostRefusal = resolveInProcessHostRefusal\(\);/, `${path} must keep the shared host guard, which now carries the role`);
  }

  // ── (3) The job register ──────────────────────────────────────────────────
  // The register is one per process, and the suite shares the process: the step-runner test's two
  // never-settling steps stay registered for good, so a shard that runs it first carries their names
  // into every window. Read only this test's own names.
  const drainOwn = () => drainJobWindow().filter((name) => /^job-[abc]$/.test(name));
  drainOwn();
  const endA = beginJob("job-a");
  await trackJob("job-b", async () => undefined);
  assert.deepEqual(drainOwn(), ["job-a", "job-b"], "a job that FINISHED inside the minute is still named — the culprit has usually ended by the report");
  assert.deepEqual(drainOwn(), ["job-a"], "a job still running is carried into the next window");
  endA();
  endA();
  assert.deepEqual(drainOwn(), ["job-a"], "it ended during this window, so this window still names it");
  assert.deepEqual(drainOwn(), [], "and the window after that is empty");
  await assert.rejects(trackJob("job-c", async () => { throw new Error("boom"); }), /boom/, "a failing job's error is passed through untouched");
  assert.deepEqual(drainOwn(), ["job-c"]);
  assert.deepEqual(drainOwn(), [], "a failed job is unregistered too");

  const poller = code("src/lib/crm/live-poller.ts");
  assert.match(poller, /trackJob\("crm:live-poll", tick\)/, "RED every poller tick must register itself");
  assert.match(poller, /trackJob\(`crm:\$\{dueWork\}`, \(\) => runScheduledWork\(dueWork\)\)/, "RED each deep run must register under its own name (crm:contact-lists, crm:rolling-sync, ...)");
  assert.match(code("src/lib/notifications/step-runner.ts"), /trackJob\(`cron:process:\$\{name\}`, thunk\)/, "RED every step of the 5-minute notification job must register itself");
  assert.match(code("src/lib/early-birds/close-scheduler.ts"), /trackJob\("early-birds:close", runDueEarlyBirdsClose\)/);
  assert.match(code("src/lib/crm/housekeeping-scheduler.ts"), /trackJob\("crm:housekeeping", /);

  // ── (4) The stall alert ───────────────────────────────────────────────────
  assert.equal(EVENT_LOOP_STALL_ALERT_MS, 1_000, "one second: below it a stall is felt, above it a page visibly hangs");
  assert.equal(stallAlertFor({ jobs: ["crm:contact-lists"], maxMs: EVENT_LOOP_STALL_ALERT_MS - 1, role: "web" }), null, "under the line nothing is raised");
  assert.equal(stallAlertFor({ jobs: [], maxMs: Number.NaN, role: "all" }), null, "an unusable reading raises nothing");
  assert.equal(
    stallAlertFor({ jobs: ["crm:contact-lists"], maxMs: 4_349.5, role: "worker" }),
    null,
    "RED the worker's stalls make no page wait — alerting on them would page him for the design working",
  );
  const alert = stallAlertFor({ jobs: ["crm:contact-lists", "crm:live-poll"], maxMs: 4_349.5, role: "all" });
  assert.ok(alert, "RED a page server frozen past the line must raise an alert");
  assert.equal(alert.message, "Server froze for 4.3 s (all process) while crm:contact-lists + crm:live-poll ran");
  assert.deepEqual(alert.fingerprint, ["event-loop-stall", "all", "crm:contact-lists + crm:live-poll"], "one issue per culprit, so a new culprit is a new Telegram");
  assert.equal(
    stallAlertFor({ jobs: [], maxMs: 1_500, role: "web" })?.message,
    "Server froze for 1.5 s (web process) while no background job ran",
    "a freeze with no job to blame says so — that is a page's own work, and worth knowing",
  );

  const health = code("src/lib/observability/process-health.ts");
  assert.match(health, /const jobs = drainJobWindow\(\);/, "the line names the jobs of its minute");
  assert.match(health, /\n\s+role,\n/, "the line names the role, so the web and worker logs read apart");
  assert.match(health, /labels: \{ event: "event_loop_stall" \}/, "a stall is its own searchable event");
  // The 2026-10-17 freezes recurred every exactly 65:00 with no job running; the gap since the last stall and the process age
  // are what say whether a timer of this process owns that period.
  assert.match(
    health,
    /event: "event_loop_stall" \},\s*context: \{[^}]*sinceLastStallS,[^}]*uptimeS: Math\.round\(process\.uptime\(\)\)/,
    "the stall warning carries the seconds since the previous stall and the process uptime",
  );
  assert.match(
    health,
    /const sinceLastStallS = lastStallAtMs == null \? null : Math\.round\(\(nowMs - lastStallAtMs\) \/ 1000\);/,
    "the gap is measured from the previous stall, null for the first",
  );
  assert.match(
    health,
    /sentryServerStatus\(\{ appEnv: process\.env\.APP_ENV, dsn: process\.env\.SENTRY_DSN \}\)\.enabled\) return;[\s\S]*?await import\("@\/lib\/observability\/sentry-server"\)/,
    "RED the SDK is loaded only after the production policy clears it — staging never loads Sentry",
  );
}
