#!/usr/bin/env node
/**
 * Create or correct ONE cron-job.org job, from the declaration in this file.
 *
 * WHY THIS EXISTS
 * Merging a cron route ships the code and arms nothing. cron-job.org is a third-party scheduler
 * with no representation in this repository at all, so a route can be live, correct, CI-green and
 * called by nobody — and there is no signal anywhere that says so. It has now happened twice.
 * `/api/cron/territory-restamp` merged on 2026-08-29 and had never run when this was written.
 * A Healthchecks check does not catch it either: a check that has never been pinged does not go
 * red, it sits "new" forever.
 *
 *   node scripts/cronjob-sync.mjs                       # dry run - list what differs, change nothing
 *   node scripts/cronjob-sync.mjs --job <key>           # narrow to one declaration
 *   node scripts/cronjob-sync.mjs --job <key> --apply   # create or patch that one job
 *
 * WHY IT IS DELIBERATELY NOT A BULK SYNC, and must not be turned into one.
 * The cron-job.org REST API allows **100 requests per DAY** across the whole account. Past the cap
 * every endpoint returns 429 with no `Retry-After`, so the scheduler that runs the entire company's
 * automation becomes unmanageable for the rest of the day. A single sweep over the ~21 live jobs
 * has been measured at roughly 34 requests, a third of the daily budget in one command, and a bulk
 * edit CANNOT be rolled back — the API returns no prior state to restore from. So this script does
 * one job at a time, on purpose, and prints its request count as it goes. Resist the urge to add
 * `--all`.
 *
 * NEEDS two values, both read from the environment or from .env.local and neither ever printed:
 *   `CRONJOB_API_KEY` — authenticates this script to cron-job.org, sent as `Authorization: Bearer …`.
 *   `CRON_SECRET`     — the bearer the CREATED JOB will carry to Phoenix on every fire.
 *
 * `CRON_SECRET` lives in TWO stores (Railway and GitHub Actions), so a half-rotation leaves a local
 * copy that production no longer accepts — and a job built from it 401s silently every night while
 * cron-job.org shows a tidy red that nobody is watching. Before writing anything, this script
 * therefore compares the LENGTH of the header it is about to set against the length of the same
 * header on a job known to be firing successfully right now. Lengths only: enough to catch a stale
 * or truncated copy, and it reveals nothing. Mismatch aborts before any job is created.
 *
 * TIMEZONE. Every schedule here is Africa/Cairo, matching the rest of the account and the
 * `docs/observability.md` table. A job left on UTC drifts two to three hours from the schedule its
 * Healthchecks check expects, and shifts again at every Egyptian DST change.
 *
 * THE 30-SECOND CUT. cron-job.org kills every request at 30s. That is a PLATFORM cap and
 * `requestTimeout` cannot raise it — the field is accepted and read back at whatever you set, and
 * the request is still cut at 30. The server nevertheless finishes the work, so a long route logs a
 * false `Failed (timeout)` while succeeding. Do not read a red execution here as proof the work did
 * not happen; read the route's own terminal artefact (its audit row, its log line).
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.cron-job.org";
const TZ = "Africa/Cairo";
const PROD = "https://phoenix-hr.satopharma.com";

const APPLY = process.argv.includes("--apply");
const JOB_FILTER = (() => {
  const i = process.argv.indexOf("--job");
  return i === -1 ? null : process.argv[i + 1] ?? null;
})();

/**
 * The jobs this script knows how to manage.
 *
 * Only add a row here for a job you are about to create or correct. This is not an inventory of
 * the account — the account holds ~21 jobs and enumerating them here would invite exactly the bulk
 * sweep the header rules out.
 *
 * `hours` / `minutes` are Africa/Cairo. `-1` means "every", which is cron-job.org's wildcard.
 */
/** A job known to be firing successfully right now, used ONLY to compare header lengths. 8200914
 *  is the notification outbox drain: every 5 minutes, HTTP 200. If its bearer is the length ours
 *  is, ours is the credential production currently accepts. */
const REFERENCE_JOB_ID = 8200914;

const JOBS = {
  "territory-restamp": {
    title: "Phoenix — nightly territory re-stamp",
    path: "/api/cron/territory-restamp",
    // 03:20 Cairo. Deliberately in the quiet hour and offset from its neighbours: 02:17 and 02:27
    // are the Direct Orders jobs, 03:23 and 03:43 the Friday token rotations. Nothing else runs at
    // :20, so a red execution here is unambiguous about which job produced it.
    schedule: { hours: [3], minutes: [20], mdays: [-1], months: [-1], wdays: [-1] },
    // Every open period's geography is re-derived; published closings are skipped by the domain
    // service itself. Steady state is one indexed scan — the read-only reconciliation over a full
    // 12-month window measured 1.19s — so the 30s platform cut is not expected to bite. 300 matches
    // what the rest of the account sets; the platform still cuts at 30 regardless (see header).
    requestTimeout: 300,
  },
};

// ── credentials ───────────────────────────────────────────────────────────────────────────────

/** Read one key from the environment, falling back to .env.local. Never printed, never returned
 *  to a caller that logs. */
function readKey(name) {
  if (process.env[name]) return process.env[name].trim();
  const envPath = join(REPO_ROOT, ".env.local");
  if (!existsSync(envPath)) return null;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`).exec(line);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

// ── API ───────────────────────────────────────────────────────────────────────────────────────

let requestCount = 0;

async function api(key, path, init = {}) {
  requestCount += 1;
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (response.status === 429) {
    throw new Error(
      "cron-job.org returned 429. The account allows 100 requests per DAY and it is spent — " +
        "every endpoint will refuse until it resets. Do not retry in a loop.",
    );
  }
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status} ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

/** Normalise a schedule for comparison: the API returns every field, including ones we never set. */
function scheduleMatches(live, desired) {
  if (!live) return false;
  if (String(live.timezone) !== TZ) return false;
  for (const field of ["hours", "minutes", "mdays", "months", "wdays"]) {
    const a = JSON.stringify(live[field] ?? []);
    const b = JSON.stringify(desired[field] ?? []);
    if (a !== b) return false;
  }
  return true;
}

function describeSchedule(schedule) {
  const pad = (n) => String(n).padStart(2, "0");
  const hours = schedule.hours?.includes(-1) ? "every hour" : schedule.hours?.map(pad).join(",");
  const minutes = schedule.minutes?.includes(-1) ? "every minute" : schedule.minutes?.map(pad).join(",");
  return `${hours}:${minutes} ${TZ}`;
}

/**
 * Confirm the bearer we are about to bake into a job is the one production accepts.
 *
 * Compared by LENGTH against a job that is firing successfully right now — never by value, and
 * nothing is printed but the two numbers. That is enough to catch the failure this guards against
 * (a stale or truncated local `CRON_SECRET` after a half-rotation across its two stores), and it
 * is the difference between finding out now and finding out from a job that has been quietly
 * 401ing at 03:20 for a fortnight.
 */
async function assertBearerCurrent(key, header) {
  const reference = await api(key, `/jobs/${REFERENCE_JOB_ID}`);
  const details = reference.jobDetails ?? reference.job ?? {};
  const live = details.extendedData?.headers?.Authorization;
  if (!live) {
    throw new Error(`Reference job ${REFERENCE_JOB_ID} carries no Authorization header — cannot verify the bearer.`);
  }
  if (String(live).length !== header.length) {
    throw new Error(
      `CRON_SECRET does not match production. The header would be ${header.length} chars; the job ` +
        `known to be authenticating carries ${String(live).length}. It lives in two stores, so a ` +
        `half-rotation leaves a stale local copy. Nothing was created.`,
    );
  }
  console.log(`bearer: length ${header.length} matches job ${REFERENCE_JOB_ID}, which is firing 200s\n`);
}

async function main() {
  const key = readKey("CRONJOB_API_KEY");
  if (!key) {
    console.error("CRONJOB_API_KEY is not set (environment or .env.local). Nothing done.");
    process.exitCode = 1;
    return;
  }
  const cronSecret = readKey("CRON_SECRET");
  if (!cronSecret) {
    console.error("CRON_SECRET is not set (environment or .env.local). Nothing done.");
    process.exitCode = 1;
    return;
  }
  const authHeader = `Bearer ${cronSecret}`;

  const wanted = Object.entries(JOBS).filter(([name]) => !JOB_FILTER || name === JOB_FILTER);
  if (wanted.length === 0) {
    console.error(`No declaration named "${JOB_FILTER}". Known: ${Object.keys(JOBS).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  console.log(APPLY ? "APPLY — changes will be written\n" : "DRY RUN — nothing will be changed\n");

  // One list call covers every declaration, which is the cheapest way to answer "does it exist".
  const listed = await api(key, "/jobs");
  const live = Array.isArray(listed.jobs) ? listed.jobs : [];

  for (const [name, spec] of wanted) {
    const url = `${PROD}${spec.path}`;
    // Matched on URL, never on title: a title is cosmetic and gets edited in the web UI, while the
    // URL is what actually determines which route runs. Two jobs on one URL is the duplicate this
    // avoids creating.
    const existing = live.find((job) => String(job.url ?? "").trim() === url);

    if (!existing) {
      console.log(`${name}: MISSING — no job on ${url}`);
      console.log(`  would create: ${describeSchedule(spec.schedule)}`);
      if (!APPLY) continue;
      await assertBearerCurrent(key, authHeader);
      const created = await api(key, "/jobs", {
        body: JSON.stringify({
          job: {
            enabled: true,
            // The bearer the route's assertCronAuthorized will check on every fire. Without it the
            // job runs perfectly and Phoenix answers 401 every night.
            extendedData: { headers: { Authorization: authHeader } },
            requestMethod: 0,
            requestTimeout: spec.requestTimeout,
            saveResponses: true,
            schedule: { ...spec.schedule, expiresAt: 0, timezone: TZ },
            title: spec.title,
            url,
          },
        }),
        method: "PUT",
      });
      const jobId = created.jobId ?? created.id;
      console.log(`  CREATED jobId=${jobId}`);
      // Read back rather than trusting the write. A job that reports created but sits disabled, or
      // on the wrong timezone, is indistinguishable from a healthy one until the night it does not
      // run — and by then nobody connects the two.
      const readBack = await api(key, `/jobs/${jobId}`);
      const j = readBack.jobDetails ?? readBack.job ?? {};
      const auth = j.extendedData?.headers?.Authorization;
      console.log(
        `  read back: enabled=${j.enabled} tz=${j.schedule?.timezone} ` +
          `at=${describeSchedule(j.schedule ?? {})} url=${j.url}`,
      );
      // Stated separately because a job missing ONLY its header looks completely healthy here and
      // in the web UI, and fails with a 401 nobody reads.
      console.log(`  auth header: ${auth ? `present, length ${String(auth).length}` : "MISSING — this job will 401"}`);
      continue;
    }

    const drift = [];
    if (!existing.enabled) drift.push("disabled");
    if (!scheduleMatches(existing.schedule, spec.schedule)) {
      drift.push(`schedule is ${describeSchedule(existing.schedule ?? {})}, want ${describeSchedule(spec.schedule)}`);
    }
    if (drift.length === 0) {
      console.log(`${name}: OK — jobId=${existing.jobId} ${describeSchedule(existing.schedule ?? {})}`);
      continue;
    }

    console.log(`${name}: DRIFT — jobId=${existing.jobId}: ${drift.join("; ")}`);
    if (!APPLY) continue;
    await api(key, `/jobs/${existing.jobId}`, {
      body: JSON.stringify({
        job: { enabled: true, schedule: { ...spec.schedule, expiresAt: 0, timezone: TZ } },
      }),
      method: "PATCH",
    });
    console.log(`  PATCHED jobId=${existing.jobId}`);
  }

  console.log(`\n${requestCount} API request(s) used of the 100/day account budget.`);
}

main().catch((error) => {
  console.error(String(error?.message ?? error));
  process.exitCode = 1;
});
