import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { JOBS } from "../scripts/cronjob-sync.mjs";
import { HEALTHCHECKS_CHECKED_SLUGS, JOB_SCHEDULES } from "../src/lib/observability/job-schedule.ts";
import {
  DAILY_JOBS,
  dailyJobCronExpression,
  dailyJobHeartbeatSlug,
  dailyJobPath,
} from "../src/lib/scheduled-jobs/daily-jobs.ts";

import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE MORNING JOBS, ONE SCHEDULE EACH (owner, 13 Nov 2026 — enterprise audit F-HR-012 / REC-049).
//
// Until 13 Nov 2026 `/api/notifications/daily` ran the Needs You digest and then about thirty
// unrelated jobs in one `Promise.all`, at 06:36 Cairo, under one heartbeat. Each job now has its own
// cron-job.org entry, its own minute, its own request (`/api/cron/daily/<job>`) and its own
// heartbeat (`phoenix-daily-<job>`). What each job does, who it tells and by which channel did not
// change. This file holds the split together:
//
//   (a) every job has exactly one cron-job.org entry, on its own address, and one heartbeat whose
//       cron matches that entry's hour and minute — a job with no entry never runs and its heartbeat
//       alarms; an entry with no heartbeat runs unwatched;
//   (b) no two morning jobs share a minute — sharing one is the contention the split removed;
//   (c) the retired route imports none of the job functions — every job already has its own
//       schedule, so anything it ran would run twice a morning;
//   (d) the new route runs ONE job per request — one registry lookup, no fan-out;
//   (e) the jobs run are exactly the jobs the retired route ran — none lost, none added unseen.
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

const RETIRED_ROUTE = "app/api/notifications/daily/route.ts";
const JOB_ROUTE = "app/api/cron/daily/[job]/route.ts";
const RUNNERS = "app/api/cron/daily/_lib/daily-job-runners.ts";
const OBSERVABILITY_DOC = "docs/observability.md";

type CronJobSyncSpec = {
  path: string;
  schedule: { hours: number[]; minutes: number[]; mdays: number[]; months: number[]; wdays: number[] };
};

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

export function runDailyJobsSplitTests() {
  // Read INSIDE the test, never at module load, so a break-test edit is seen.
  const jobs = JOBS as unknown as Record<string, CronJobSyncSpec>;
  const schedules = new Map(JOB_SCHEDULES.map((entry) => [entry.slug, entry]));

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
    const declared = JOB_SCHEDULES.filter((entry) => entry.slug === slug);
    assert.equal(declared.length, 1, `the morning job "${job.key}" needs exactly one JOB_SCHEDULES heartbeat, ${slug}`);
    const [minute, hour, ...rest] = declared[0].schedule.split(" ");
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
  assert.equal(schedules.has("phoenix-notify-daily"), false, "the retired fan-out's heartbeat is gone: its route runs nothing, so it would never report");
  assert.ok(HEALTHCHECKS_CHECKED_SLUGS.size <= 20, "the Healthchecks project holds 20 checks; the split must not ask for more");

  // The doc's job table is the third copy of the times (job-heartbeat-register pins it to JOB_SCHEDULES);
  // here only that each job's row carries the same expression.
  const doc = read(OBSERVABILITY_DOC);
  for (const job of DAILY_JOBS) {
    const row = `| \`${dailyJobHeartbeatSlug(job.key)}\` | \`${dailyJobCronExpression(job)}\` |`;
    assert.ok(doc.includes(row), `${OBSERVABILITY_DOC} has no schedule row ${row}`);
  }

  // ── (b) no two morning jobs share a minute ─────────────────────────────────────────────────────
  const byMinute = new Map<string, string[]>();
  for (const job of DAILY_JOBS) {
    const at = `${job.hour}:${String(job.minute).padStart(2, "0")}`;
    byMinute.set(at, [...(byMinute.get(at) ?? []), job.key]);
  }
  const shared = [...byMinute.entries()].filter(([, keys]) => keys.length > 1);
  assert.deepEqual(shared, [], "two morning jobs on one minute start together and contend for the database — give each its own minute");
  assert.equal(new Set(DAILY_JOBS.map((job) => job.key)).size, DAILY_JOBS.length, "every morning job key is unique");

  // ── (c) the retired route runs nothing ─────────────────────────────────────────────────────────
  const retired = stripComments(read(RETIRED_ROUTE));
  const importedByRetired = FUNCTIONS_THE_OLD_FAN_OUT_RAN.filter((name) => new RegExp(`\\b${name}\\b`).test(retired));
  assert.deepEqual(
    importedByRetired,
    [],
    `${RETIRED_ROUTE} names ${importedByRetired.join(", ")} — every job already runs on its own schedule, so anything ` +
      "this route ran would run TWICE a morning",
  );
  assert.doesNotMatch(retired, /daily-job-runners/, `${RETIRED_ROUTE} must not reach the runners either`);

  // ── (d) the job route runs exactly one job per request ─────────────────────────────────────────
  const route = stripComments(read(JOB_ROUTE));
  assert.equal((route.match(/findDailyJob\(/g) ?? []).length, 1, `${JOB_ROUTE} looks the job up exactly once`);
  assert.equal((route.match(/DAILY_JOB_RUNNERS\[/g) ?? []).length, 1, `${JOB_ROUTE} takes exactly one runner from the registry`);
  assert.doesNotMatch(route, /Promise\.(all|allSettled|race|any)\(/, `${JOB_ROUTE} must not run jobs together — that is the fan-out it replaced`);
  assert.doesNotMatch(route, /\bfor\s*\(|\.forEach\(/, `${JOB_ROUTE} must not loop over jobs`);

  // ── (e) the jobs run are exactly the jobs the fan-out ran ──────────────────────────────────────
  const runners = stripComments(read(RUNNERS));
  const called = [...runners.matchAll(/\b(\w+)\([^()]*\)\.catch\(\s*onJobFailure\(/g)].map((match) => match[1]);
  assert.deepEqual(
    [...called].sort(),
    [...FUNCTIONS_THE_OLD_FAN_OUT_RAN],
    `${RUNNERS} must run exactly the functions the retired fan-out ran, each once — a job added or lost here ` +
      "is a change to what the morning does, not to when",
  );
  const block = runners.slice(runners.indexOf("DAILY_JOB_RUNNERS"));
  const runnerKeys = [...block.matchAll(/^ {2}"?([a-z0-9-]+)"?: \{$/gm)].map((match) => match[1]);
  assert.deepEqual(runnerKeys, DAILY_JOBS.map((job) => job.key), `${RUNNERS} has one runner per morning job, in DAILY_JOBS order`);
}
