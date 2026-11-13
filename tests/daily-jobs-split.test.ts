import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { JOBS } from "../scripts/cronjob-sync.mjs";
import { jobRefirePoliciesFor } from "../src/lib/observability/job-refire.ts";
import { healthchecksCheckedSlugsFor, JOB_SCHEDULES, jobSchedulesFor } from "../src/lib/observability/job-schedule.ts";
import {
  DAILY_FAN_OUT_PATH,
  DAILY_FAN_OUT_SLUG,
  DAILY_JOBS,
  DAILY_JOBS_SPLIT_SWITCH,
  dailyJobCronExpression,
  dailyJobHeartbeatSlug,
  dailyJobPath,
  dailyJobsRunOn,
  dailyJobsSplitIsOn,
} from "../src/lib/scheduled-jobs/daily-jobs.ts";

import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE MORNING JOBS, ONE SCHEDULE EACH (owner, 13 Nov 2026 — enterprise audit F-HR-012 / REC-049).
//
// `/api/notifications/daily` runs the Needs You digest and then about thirty unrelated jobs in one
// `Promise.all`, at 06:36 Cairo, under one heartbeat. The split gives each job its own cron-job.org
// entry, its own minute, its own request (`/api/cron/daily/<job>`) and its own heartbeat
// (`phoenix-daily-<job>`). What each job does, who it tells and by which channel does not change.
//
// It ships behind the switch `PHOENIX_DAILY_JOBS_SPLIT` (owner, 13 Nov 2026: a safe switch-over —
// arming thirty entries takes two days under cron-job.org's 100-requests-a-day cap). OFF: the
// fan-out runs every job and the per-job route runs none. ON: the reverse. This file holds it together:
//
//   (a) with the switch on, every job has exactly one cron-job.org entry, on its own address, and one
//       heartbeat whose cron matches that entry's hour and minute — a job with no entry never runs
//       and its heartbeat alarms; an entry with no heartbeat runs unwatched;
//   (b) no two morning jobs share a minute — sharing one is the contention the split removed;
//   (c) the fan-out runs every job, and only through the shared runners, never by name;
//   (d) the per-job route runs ONE job per request — one registry lookup, no fan-out;
//   (e) the jobs run are exactly the jobs the fan-out ran — none lost, none added unseen;
//   (f) the switch: off → the fan-out runs every job once and the per-job route none; on → the
//       reverse; never both and never neither — in the routes, the heartbeat declarations, the
//       Healthchecks check and the re-fire policies alike.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The functions `/api/notifications/daily` called on `origin/main` before the split, written out by
 * hand so a job cannot leave the morning without this list being edited in the same change.
 */
const FUNCTIONS_THE_OLD_FAN_OUT_RAN = [
  "backfillMissingMarketingAssignmentEmails",
  "cleanupOldNotificationData",
  "expireStaleHeldNotifications",
  "notifyInactiveUsers",
  "processProbationMilestoneEmails",
  "pruneExpiredRateLimitBuckets",
  "pruneOldAppErrorEvents",
  "purgeExpiredTabletRecordings",
  "purgeOldActivityEvents",
  "remindHeldNotifications",
  "runBirthdayNotifications",
  "runContractRenewalNotifications",
  "runDeadTelegramLinkAlert",
  "runExcuseDriftCheck",
  "runExcuseSlaDaily",
  "runHolidayConfirmationReminder",
  "runMarketingSlaDaily",
  "runMilestoneDueNotices",
  "runNeedsYouDailyDigest",
  "runNeedsYouWeeklyEmail",
  "runOutstationDeparturePhotoReminders",
  "runOutstationGeocodeWarmup",
  "runOutstationSlaDaily",
  "runOutstationWorkloadRestamp",
  "runRecruitmentDailyNotifications",
  "runResignationSlaDaily",
  "runSosMonthlyClosingReportCheck",
  "runTelegramDailyHrDigest",
  "runVacationSlaDaily",
  "runWeeklyPlansDriftCheck",
] as const;

const FAN_OUT_ROUTE = "app/api/notifications/daily/route.ts";
const JOB_ROUTE = "app/api/cron/daily/[job]/route.ts";
const RUNNERS = "app/api/cron/daily/_lib/daily-job-runners.ts";
const OBSERVABILITY_DOC = "docs/observability.md";

/** Each route's one gate: "run only when dailyJobsRunOn names me". The captured group is the place. */
const GATE = /if \(dailyJobsRunOn\(dailyJobsSplitIsOn\(\)\) !== "(fan-out|own-route)"\)/g;

type CronJobSyncSpec = {
  path: string;
  schedule: { hours: number[]; minutes: number[]; mdays: number[]; months: number[]; wdays: number[] };
};

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

export function runDailyJobsSplitTests() {
  // Read INSIDE the test, never at module load, so a break-test edit is seen.
  const jobs = JOBS as unknown as Record<string, CronJobSyncSpec>;
  const splitSchedules = jobSchedulesFor(true);

  // ── (a) one cron-job.org entry and one heartbeat per job, agreeing on the time ─────────────────
  for (const job of DAILY_JOBS) {
    const path = dailyJobPath(job.key);
    const entries = Object.entries(jobs).filter(([, spec]) => spec.path === path);
    assert.equal(
      entries.length,
      1,
      `the morning job "${job.key}" has ${entries.length} cron-job.org entries on ${path} in scripts/cronjob-sync.mjs — ` +
        "it needs exactly one, or it never runs (none) or runs twice a morning (two)",
    );
    const [entryKey, spec] = entries[0];
    assert.equal(entryKey, `daily-${job.key}`, `the cron-job.org entry for "${job.key}" is keyed daily-${job.key}`);
    assert.deepEqual(
      { hours: spec.schedule.hours, mdays: spec.schedule.mdays, minutes: spec.schedule.minutes, months: spec.schedule.months, wdays: spec.schedule.wdays },
      { hours: [job.hour], mdays: [-1], minutes: [job.minute], months: [-1], wdays: [-1] },
      `the cron-job.org entry for "${job.key}" must fire once a day at ${job.hour}:${String(job.minute).padStart(2, "0")} Cairo, as DAILY_JOBS says`,
    );

    const slug = dailyJobHeartbeatSlug(job.key);
    const declared = splitSchedules.filter((entry) => entry.slug === slug);
    assert.equal(declared.length, 1, `with the switch on, the morning job "${job.key}" needs exactly one heartbeat, ${slug}`);
    const [minute, hour, ...rest] = (declared[0].schedule ?? "").split(" ");
    assert.deepEqual(
      [Number(hour), Number(minute), rest.join(" ")],
      [job.hour, job.minute, "* * *"],
      `the heartbeat ${slug} must expect the run at the minute its cron-job.org entry fires`,
    );
  }
  const dailyEntries = Object.entries(jobs).filter(([key]) => key.startsWith("daily-"));
  assert.equal(
    dailyEntries.length,
    DAILY_JOBS.length,
    "every daily-<job> entry in scripts/cronjob-sync.mjs belongs to a job in DAILY_JOBS — an orphan runs a job nobody watches",
  );

  // The doc's job table is the third copy of the times (job-heartbeat-register pins it to the
  // declarations); here only that each job's row carries the same expression, and that the fan-out's
  // row stays while it is what is watched.
  const doc = read(OBSERVABILITY_DOC);
  for (const job of DAILY_JOBS) {
    const row = `| \`${dailyJobHeartbeatSlug(job.key)}\` | \`${dailyJobCronExpression(job)}\` |`;
    assert.ok(doc.includes(row), `${OBSERVABILITY_DOC} has no schedule row ${row}`);
  }
  assert.ok(
    doc.includes(`| \`${DAILY_FAN_OUT_SLUG}\` | \`36 6 * * *\` |`),
    `${OBSERVABILITY_DOC} keeps the fan-out's row — it is what is watched until the switch is on`,
  );

  // ── (b) no two morning jobs share a minute ─────────────────────────────────────────────────────
  const byMinute = new Map<string, string[]>();
  for (const job of DAILY_JOBS) {
    const at = `${job.hour}:${String(job.minute).padStart(2, "0")}`;
    byMinute.set(at, [...(byMinute.get(at) ?? []), job.key]);
  }
  const shared = [...byMinute.entries()].filter(([, keys]) => keys.length > 1);
  assert.deepEqual(shared, [], "two morning jobs on one minute start together and contend for the database — give each its own minute");
  assert.equal(new Set(DAILY_JOBS.map((job) => job.key)).size, DAILY_JOBS.length, "every morning job key is unique");

  // ── (c) the fan-out runs every job, and only through the shared runners ────────────────────────
  const fanOut = stripComments(read(FAN_OUT_ROUTE));
  const namedByFanOut = FUNCTIONS_THE_OLD_FAN_OUT_RAN.filter((name) => new RegExp(`\\b${name}\\b`).test(fanOut));
  assert.deepEqual(
    namedByFanOut,
    [],
    `${FAN_OUT_ROUTE} names ${namedByFanOut.join(", ")} — the fan-out runs each job through daily-job-runners.ts, the ` +
      "same call the per-job route makes, so the two can never drift apart",
  );
  assert.equal(DAILY_JOBS[0].key, "needs-you-daily-digest", "the Needs You digest is first: the fan-out awaits it alone before the rest");
  assert.match(
    fanOut,
    /const digest = DAILY_JOBS\[0\];[\s\S]*?await DAILY_JOB_RUNNERS\[digest\.key\]\.run\(request, onJobFailure\)/,
    `${FAN_OUT_ROUTE} awaits the digest alone, first`,
  );
  assert.match(
    fanOut,
    /const rest = DAILY_JOBS\.slice\(1\);\s*const settled = await Promise\.all\(rest\.map\(\(job\) => DAILY_JOB_RUNNERS\[job\.key\]\.run\(request, onJobFailure\)\)\)/,
    `${FAN_OUT_ROUTE} starts every other job together, in the list's order, so every job runs exactly once`,
  );
  assert.equal(
    (fanOut.match(/DAILY_JOB_RUNNERS\[[^\]]+\]\.run\(/g) ?? []).length,
    2,
    `${FAN_OUT_ROUTE} runs jobs from exactly those two places — the digest, then the rest`,
  );
  assert.match(fanOut, /const totalJobs = DAILY_JOBS\.length;/, "the fan-out's run summary counts the jobs from the list, so it cannot drift");

  // ── (d) the job route runs exactly one job per request ─────────────────────────────────────────
  const jobRoute = stripComments(read(JOB_ROUTE));
  assert.equal((jobRoute.match(/findDailyJob\(/g) ?? []).length, 1, `${JOB_ROUTE} looks the job up exactly once`);
  assert.equal((jobRoute.match(/DAILY_JOB_RUNNERS\[/g) ?? []).length, 1, `${JOB_ROUTE} takes exactly one runner from the registry`);
  assert.doesNotMatch(jobRoute, /Promise\.(all|allSettled|race|any)\(/, `${JOB_ROUTE} must not run jobs together — that is the fan-out it replaces`);
  assert.doesNotMatch(jobRoute, /\bfor\s*\(|\.forEach\(/, `${JOB_ROUTE} must not loop over jobs`);

  // ── (e) the jobs run are exactly the jobs the fan-out ran ──────────────────────────────────────
  const runners = stripComments(read(RUNNERS));
  const called = [...runners.matchAll(/\b(\w+)\([^()]*\)\.catch\(\s*onJobFailure\(/g)].map((match) => match[1]);
  assert.deepEqual(
    [...called].sort(),
    [...FUNCTIONS_THE_OLD_FAN_OUT_RAN],
    `${RUNNERS} must run exactly the functions the fan-out ran, each once — a job added or lost here ` +
      "is a change to what the morning does, not to when",
  );
  const block = runners.slice(runners.indexOf("DAILY_JOB_RUNNERS"));
  const runnerKeys = [...block.matchAll(/^ {2}"?([a-z0-9-]+)"?: \{$/gm)].map((match) => match[1]);
  assert.deepEqual(runnerKeys, DAILY_JOBS.map((job) => job.key), `${RUNNERS} has one runner per morning job, in DAILY_JOBS order`);

  // ── (f) the switch: one place runs the jobs, never both, never neither ─────────────────────────
  assert.equal(dailyJobsSplitIsOn({}), false, "unset leaves the fan-out running the jobs");
  assert.equal(dailyJobsSplitIsOn({ [DAILY_JOBS_SPLIT_SWITCH]: "on" }), true, "exactly `on` switches the split on");
  for (const almost of ["", "ON", "On", "true", "1", "yes", " on", "on "]) {
    assert.equal(
      dailyJobsSplitIsOn({ [DAILY_JOBS_SPLIT_SWITCH]: almost }),
      false,
      `${JSON.stringify(almost)} is not \`on\` and must leave the fan-out running`,
    );
  }

  // Each route's gate, read from its source, then played against both positions of the switch.
  const gateOf = (file: string, source: string) => {
    const gates = [...source.matchAll(GATE)];
    assert.equal(gates.length, 1, `${file} consults the switch exactly once, through dailyJobsRunOn(dailyJobsSplitIsOn())`);
    return gates[0][1];
  };
  const fanOutRunsWhen = gateOf(FAN_OUT_ROUTE, fanOut);
  const jobRouteRunsWhen = gateOf(JOB_ROUTE, jobRoute);
  for (const splitOn of [false, true]) {
    const place = dailyJobsRunOn(splitOn);
    const fanOutRuns = place === fanOutRunsWhen;
    const jobRouteRuns = place === jobRouteRunsWhen;
    const state = splitOn ? "on" : "off";
    assert.ok(!(fanOutRuns && jobRouteRuns), `switch ${state}: the fan-out AND the per-job route would both run the jobs — every job twice a morning`);
    assert.ok(fanOutRuns || jobRouteRuns, `switch ${state}: neither route would run the jobs — the morning would not happen`);
    assert.equal(fanOutRuns, !splitOn, `switch ${state}: the fan-out ${splitOn ? "must run nothing" : "must run every job"}`);
    assert.equal(jobRouteRuns, splitOn, `switch ${state}: the per-job route ${splitOn ? "must run its job" : "must run nothing"}`);
  }

  // The cron secret first, then the gate, and nothing started before it: a gated answer runs no job
  // and records no heartbeat.
  for (const [file, source] of [
    [FAN_OUT_ROUTE, fanOut],
    [JOB_ROUTE, jobRoute],
  ] as const) {
    const handler = source.slice(source.indexOf("export async function GET("));
    const auth = handler.indexOf("if (denied) return denied;");
    const gate = handler.search(new RegExp(GATE.source));
    const run = handler.indexOf("answerNowThenFinish(");
    assert.ok(auth >= 0 && gate > auth, `${file}: the cron secret is checked before the switch is read`);
    assert.ok(run > gate, `${file}: the switch is read before anything runs or any heartbeat is recorded`);
  }
  assert.match(jobRoute, /ran: false,\s*reason: "split_not_switched_on"/, `${JOB_ROUTE} says why it ran nothing`);
  const gatedAnswer = jobRoute.slice(jobRoute.search(new RegExp(GATE.source)), jobRoute.indexOf("answerNowThenFinish("));
  assert.doesNotMatch(
    gatedAnswer,
    /pingDeadMansSwitch|signalDeadMansSwitchStart|DAILY_JOB_RUNNERS/,
    `${JOB_ROUTE}: with the switch off it records no heartbeat and runs no job`,
  );

  // The heartbeat declarations, the Healthchecks check and the re-fire policies follow the same switch.
  const perJobSlugs = DAILY_JOBS.map((job) => dailyJobHeartbeatSlug(job.key));
  const digestSlug = dailyJobHeartbeatSlug("needs-you-daily-digest");
  for (const splitOn of [false, true]) {
    const state = splitOn ? "on" : "off";
    const declared = new Set(jobSchedulesFor(splitOn).map((entry) => entry.slug));
    const refire = jobRefirePoliciesFor(splitOn);
    const checked = healthchecksCheckedSlugsFor(splitOn);
    assert.equal(declared.has(DAILY_FAN_OUT_SLUG), !splitOn, `switch ${state}: ${DAILY_FAN_OUT_SLUG} is ${splitOn ? "not " : ""}declared`);
    assert.equal(Boolean(refire[DAILY_FAN_OUT_SLUG]), !splitOn, `switch ${state}: ${DAILY_FAN_OUT_SLUG} is ${splitOn ? "not " : ""}re-fired`);
    if (!splitOn) assert.equal(refire[DAILY_FAN_OUT_SLUG].path, DAILY_FAN_OUT_PATH, "switch off: a stranded fan-out is re-fired at the fan-out");
    for (const slug of perJobSlugs) {
      assert.equal(
        declared.has(slug),
        splitOn,
        `switch ${state}: ${slug} is ${splitOn ? "" : "NOT "}declared — while off it must stay undeclared, or a job due at 07:32 reads stranded behind a 06:37 report`,
      );
      assert.equal(Boolean(refire[slug]), splitOn, `switch ${state}: ${slug} is ${splitOn ? "" : "not "}re-fired`);
    }
    assert.ok(checked.size <= 20, `switch ${state}: the Healthchecks project holds 20 checks`);
    assert.equal(checked.has(DAILY_FAN_OUT_SLUG), !splitOn, `switch ${state}: the fan-out ${splitOn ? "has handed its check over" : "holds the check"}`);
    assert.equal(checked.has(digestSlug), splitOn, `switch ${state}: the digest ${splitOn ? "holds" : "does not yet hold"} the check`);
  }
  assert.equal(
    healthchecksCheckedSlugsFor(true).size,
    healthchecksCheckedSlugsFor(false).size,
    "the switch hands one Healthchecks check over; it never asks for another",
  );
  if (process.env[DAILY_JOBS_SPLIT_SWITCH] === undefined) {
    assert.deepEqual(JOB_SCHEDULES, jobSchedulesFor(false), "with the switch unset — what ships — the live declarations are the fan-out's");
  }
}
