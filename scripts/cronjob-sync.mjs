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
 *   node scripts/cronjob-sync.mjs --job <key> --apply --hold   # ...create it switched OFF
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

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "cronjob-sync",
  entry: import.meta.url,
  known: ["--apply", "--hold", "--job"],
});

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.cron-job.org";
const TZ = "Africa/Cairo";
const PROD = "https://phoenix-hr.satopharma.com";

const APPLY = process.argv.includes("--apply");
/**
 * Create the job switched OFF.
 *
 * For the case where a job must EXIST before it may FIRE: its id has to be written into
 * `docs/observability.md` in the same pull request that makes the route safe to run on a cadence,
 * and that id cannot be known until the job is created. Creating it live would mean the first fire
 * lands before the fix that made it worth scheduling. So `--hold` creates it disabled, and the
 * plain `--apply` afterwards is the arming step: a held job reads as DRIFT "disabled", which the
 * existing patch path corrects. There is no `--unhold` for that reason — arming is the default.
 */
const HOLD = process.argv.includes("--hold");
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
  "brick-move-drain": {
    title: "Phoenix — brick move rollup drain",
    path: "/api/cron/brick-move-drain",
    // Every twenty minutes on :19/:39/:59, around the clock, matching docs/observability.md and
    // JOB_SCHEDULES. Those three minutes are unused across the account, so a red execution here is
    // unambiguous about which job produced it.
    //
    // Frequent BECAUSE a brick move lands on the mapping at once and on the TOTALS only when its
    // queued sales files are rebuilt. Until this clock existed the only thing that rebuilt them was a
    // poller on the Database Mapping screen, so closing the tab left the move half-applied with no
    // signal anywhere — measured 2026-10-12, 71 files stranded for a day.
    schedule: { hours: [-1], minutes: [19, 39, 59], mdays: [-1], months: [-1], wdays: [-1] },
    // A fire with nothing waiting is one indexed count and answers in milliseconds. A fire that finds
    // a real backlog runs its four-minute budget and WILL pass the 30s platform cut, which logs
    // `Failed (timeout)` here while the drain carries on server-side and the heartbeat reads success
    // (see the header). Read liveness from the heartbeat, never from this execution list. 300 matches
    // the rest of the account; the platform still cuts at 30 regardless.
    requestTimeout: 300,
  },
  "mapping-guard-notify": {
    title: "Phoenix — mapping guard notify",
    path: "/api/cron/mapping-guard-notify",
    // Every 15 minutes, around the clock, matching docs/observability.md and JOB_SCHEDULES.
    //
    // On the :05 offsets rather than the :00 quarters the heartbeat sweep already occupies, so a red
    // execution is unambiguous about which job produced it — the same reasoning the morning block
    // uses, applied to a job that fires 96 times a day.
    //
    // Frequent BECAUSE a held change means the map is refusing that write until somebody decides.
    // The gap between the hold and the message is a window in which an import quietly under-applies,
    // so a daily cadence would mean learning tomorrow that today's import was incomplete.
    schedule: { hours: [-1], minutes: [5, 20, 35, 50], mdays: [-1], months: [-1], wdays: [-1] },
    // One indexed read of pending, un-notified holds — empty on almost every fire — then at most one
    // notification write per batch, to a single recipient. Nowhere near the 30s platform cut. 300
    // matches the rest of the account; the platform still cuts at 30 regardless (see header).
    requestTimeout: 300,
  },
  "interview-reminders": {
    title: "Phoenix — interview reminders",
    path: "/api/cron/interview-reminders",
    // Every ten minutes on :03, around the clock — matching docs/observability.md and JOB_SCHEDULES.
    // Ten because the one-hour-before reminder lands in the ten-minute window before the hour
    // (50 to 60 minutes ahead); the evening list needs only the first tick after 5:00 PM Cairo. Off the
    // :00/:15/:30/:45 quarters the heartbeat sweep holds and the :05/:20/:35/:50 ones of the mapping
    // guard, so a red execution names one job. Silent on almost every fire: an idempotency key means a
    // repeat tells nobody twice.
    schedule: { hours: [-1], minutes: [3, 13, 23, 33, 43, 53], mdays: [-1], months: [-1], wdays: [-1] },
    // One indexed read of the next few days' interviews, then at most a handful of notifications.
    // Nowhere near the 30s platform cut. 300 matches the rest of the account.
    requestTimeout: 300,
  },
  "recruitment-requisition-autopilot": {
    title: "Phoenix — requisition autopilot",
    path: "/api/cron/recruitment-requisition-autopilot",
    // Hourly on :27 (owner, 2026-10-16): every empty seat gets an open requisition and every
    // requisition whose seat is filled is closed as Filled, with nobody pressing anything. On :27,
    // a minute no other job holds, so a red execution names one job. Matches JOB_SCHEDULES exactly.
    schedule: { hours: [-1], minutes: [27], mdays: [-1], months: [-1], wdays: [-1] },
    // The directory, two indexed reads, then at most MAX_OPENINGS_PER_RUN openings plus the fills —
    // none on most fires.
    requestTimeout: 300,
  },
  "recruitment-manager-cv-reminders": {
    title: "Phoenix — manager CV folder reminders",
    path: "/api/cron/recruitment-manager-cv-reminders",
    // Hourly on :41 (owner, 2026-10-16: the folder keeps notifying until its CV is opened). The route
    // itself stays quiet outside 08:00-21:59 Cairo, so the schedule is a plain hourly one and the
    // heartbeat stays a straight hourly one. On :41, a minute no other job holds. Matches
    // JOB_SCHEDULES exactly.
    schedule: { hours: [-1], minutes: [41], mdays: [-1], months: [-1], wdays: [-1] },
    // The org tree, the live sends and the managers' views are indexed reads; at most one message per
    // manager follows. None on most fires.
    requestTimeout: 300,
  },
  "phoenix-crm-daily-digest": {
    title: "Phoenix — CRM daily digest",
    path: "/api/cron/phoenix-crm-daily-digest",
    // 06:55 Cairo, every day, before the field day starts. On :55 so it shares a minute with nothing
    // else in this account and a red execution names one job. It runs on Fridays too and simply finds
    // the Thursday before — a daily fire keeps the heartbeat a straight daily one.
    schedule: { hours: [6], minutes: [55], mdays: [-1], months: [-1], wdays: [-1] },
    // Four reads over the whole company's territories, then at most a dozen notifications. Most
    // mornings it sends nothing at all, which is the feature rather than a fault.
    requestTimeout: 300,
  },
  "phoenix-crm-integrity-sweep": {
    title: "Phoenix — CRM integrity sweep",
    path: "/api/cron/phoenix-crm-integrity-sweep",
    // 03:35 Cairo, every night. On :35 so it shares a minute with nothing else in this account and a
    // red execution names one job. It is the only Phoenix CRM job that downloads anything, so it runs
    // while the field is asleep and three hours before the digest.
    schedule: { hours: [3], minutes: [35], mdays: [-1], months: [-1], wdays: [-1] },
    // Reads at most a few hundred photos it has never seen, then one comparison pass in memory. The
    // platform still cuts at 30s regardless; a night cut short simply finds the rest tomorrow,
    // oldest first, which is why the backlog drains from the old end rather than the new one.
    requestTimeout: 300,
  },
  "phoenix-crm-plan-reminder": {
    title: "Phoenix — CRM plan reminder",
    path: "/api/cron/phoenix-crm-plan-reminder",
    // 12:57 and 17:57 Cairo, every day (owner, 2026-10-02). It speaks only from the day a week is due
    // until the day before it starts, to the rep and his district manager in the teams that have
    // started; every other day it sends nothing. The 17:57 tick tells whoever is STILL not sent
    // (owner, 2026-10-02: "Yes, remind again"); the keys are per person per day per tick, so a retry of
    // one tick tells nobody twice. On :57, a minute no other job holds.
    schedule: { hours: [12, 17], minutes: [57], mdays: [-1], months: [-1], wdays: [-1] },
    // One read of the week's plans, then at most a few dozen notifications.
    requestTimeout: 300,
  },
  "phoenix-crm-approval-nudge": {
    title: "Phoenix — CRM approval nudge",
    path: "/api/cron/phoenix-crm-approval-nudge",
    // 09:57 Cairo, every day (owner, 2026-10-02). Whoever has a list request, an off-plan visit or a
    // request to edit a week waiting on him for more than a day at his step — the district manager or
    // the SFE Manager — gets one message naming the counts. A morning with nothing overdue sends
    // nothing. The key is per approver per day, so a second fire tells nobody twice. On :57 at 9, a
    // minute no other job holds.
    schedule: { hours: [9], minutes: [57], mdays: [-1], months: [-1], wdays: [-1] },
    // Three small reads of what is waiting, then one notification per approver.
    requestTimeout: 300,
  },
  "phoenix-crm-visit-rollup": {
    title: "Phoenix — CRM routine-visit rollup",
    path: "/api/cron/phoenix-crm-visit-rollup",
    // Hourly on :49 (owner, 2026-10-05). The batched half of the activity mirror: routine planned
    // visits — about 600 a working day — gathered into one message an hour per in-scope manager (the
    // national sales manager and the SFE Managers), rather than one notice each. On :49, an odd minute
    // no other hourly job holds — inbound-intake takes every even minute. Each fire reports the
    // previous completed clock hour, so a quiet hour (overnight) sends nothing at all.
    schedule: { hours: [-1], minutes: [49], mdays: [-1], months: [-1], wdays: [-1] },
    // One keyset-paged read of an hour of visits, then at most a handful of notifications.
    requestTimeout: 300,
  },
  "phoenix-crm-fraud-scan": {
    title: "Phoenix — CRM weekly fraud scan",
    path: "/api/cron/phoenix-crm-fraud-scan",
    // 07:00 Cairo on Thursday (owner, 2026-10-07). Weekly, the morning after the Sat–Wed working week
    // it reports. On :00 of an hour no other job holds and on wday 4 (Thursday — cron-job.org counts
    // 0=Sunday, matching the `0 7 * * 4` in JOB_SCHEDULES and docs/observability.md), so a red
    // execution names one job. It reads the integrity board for the week and sends at most one notice
    // per Super Admin and SFE Manager, so it is nowhere near the 30s platform cut.
    schedule: { hours: [7], minutes: [0], mdays: [-1], months: [-1], wdays: [4] },
    requestTimeout: 300,
  },
  "private-calendar-gap-notice": {
    title: "Phoenix — Private Calendar gap notice",
    path: "/api/cron/private-calendar-gap-notice",
    // 08:09 Cairo on Saturday (owner, 2026-10-08). Weekly, the first working morning after the Sat-Thu
    // week it reports, so the week is closed and the employee has the new week to answer. On wday 6
    // (Saturday — cron-job.org counts 0=Sunday, matching the `9 8 * * 6` in JOB_SCHEDULES and
    // docs/observability.md) at minute 9, which nothing else in the account fires on, so a red
    // execution names one job. One engine read over the week plus at most one notice per employee with
    // a gap, so it stays well inside the platform cut.
    schedule: { hours: [8], minutes: [9], mdays: [-1], months: [-1], wdays: [6] },
    requestTimeout: 300,
  },
  "job-heartbeat-sweep": {
    title: "Phoenix — job heartbeat sweep",
    path: "/api/cron/job-heartbeat-sweep",
    // Every 15 minutes, around the clock. This is the sweep that reads public.job_heartbeats and
    // pages when a scheduled job has stopped reporting, so it is the one job whose own silence is
    // not covered by anything else in this account -- the Healthchecks free tier is full at 20 and
    // there is no slot left for it. 15 minutes is the granularity the declared graces assume: the
    // tightest is 30m, so a sweep interval above that could let a stranded job go a full cycle
    // unnoticed.
    schedule: { hours: [-1], minutes: [0, 15, 30, 45], mdays: [-1], months: [-1], wdays: [-1] },
    // Reads 24 rows, judges each against its cron expression, and writes only when something is
    // wrong. Nowhere near the 30s platform cut. 300 matches the rest of the account; the platform
    // still cuts at 30 regardless (see header).
    requestTimeout: 300,
  },
  "distributor-upload-overdue-nudge": {
    title: "Phoenix — distributor upload overdue nudge",
    path: "/api/cron/distributor-upload-overdue-nudge",
    // 07:20 Cairo, matching docs/observability.md and JOB_SCHEDULES. Offset from its neighbours in
    // the morning block: 06:36 is the daily notification bundle, 06:50 the marketing field-capture
    // nudge, 07:05 the marketing invoice-overdue nudge, 08:15 the mailbox offboarding sweep.
    // Nothing else runs at :20 in this hour, so a red execution here is unambiguous about which job
    // produced it.
    schedule: { hours: [7], minutes: [20], mdays: [-1], months: [-1], wdays: [-1] },
    // Two indexed reads — the active distributor list, and two periods of validated import batches
    // — then at most one notification write per recipient, where the default audience is two roles.
    // Nowhere near the 30s platform cut. 300 matches the rest of the account; the platform still
    // cuts at 30 regardless (see header).
    requestTimeout: 300,
  },
  "cv-lifecycle-rotate-sheet-token": {
    title: "Phoenix — CV lifecycle sheet token rotation",
    path: "/api/cron/cv-lifecycle-rotate-sheet-token",
    // 04:03 Cairo, Fridays. The third of the three weekly token rotations, twenty minutes behind
    // marketing at 03:43 and forty behind direct orders at 03:23. Each one waits on a Google Apps
    // Script round-trip that the route allows 60s, well past the 30s at which cron-job.org gives up
    // on the request, so the spacing is what stops the three overlapping on the same Apps Script
    // account. Weekly, because a feed token that reads candidates' names and phone numbers is worth
    // replacing often and the sheet only reads it once an hour.
    schedule: { hours: [4], minutes: [3], mdays: [-1], months: [-1], wdays: [5] },
    // Mints a link, POSTs it to the sheet, then waits up to 40s watching for the sheet to USE it
    // before revoking the old one — so this route is expected to run past the 30s platform cut and
    // log a false red while succeeding. Read the outcome from the link table, not from the
    // execution colour. 300 matches the rest of the account; the platform still cuts at 30 (header).
    requestTimeout: 300,
  },
  "rep-ranks": {
    title: "Phoenix — Phoenix Ranks nightly",
    path: "/api/cron/rep-ranks",
    // 04:17 Cairo (owner, 2026-10-05). Rebuilds every Phoenix Ranks window that holds yesterday —
    // day, week, month, quarter, semester — from the KPIs board and the Early Birds clock, so the
    // board every rep opens in the morning is complete. On :17, a minute nothing else holds.
    schedule: { hours: [4], minutes: [17], mdays: [-1], months: [-1], wdays: [-1] },
    // A handful of KPIs boards plus every district's day facts: past the 30 s platform cut, so
    // cron-job.org logs a timeout while the server finishes and the dead-man's switch is the witness.
    requestTimeout: 300,
  },
  "reconciliation-check": {
    title: "Phoenix — nightly reconciliation harness",
    path: "/api/cron/reconciliation-check",
    // 04:40 Cairo. After the 03:20 re-stamp has settled the geography the CRM checks read, and well
    // before the 06:36 daily notification run — so a breach is found and paged while there is still
    // a morning left to act on it. Nothing else in the account runs at :40.
    schedule: { hours: [4], minutes: [40], mdays: [-1], months: [-1], wdays: [-1] },
    // 16 checks, entirely read-only, measured end to end at 15.6s against production — inside the
    // 30s platform cut with room to spare. 300 matches the rest of the account; the platform still
    // cuts at 30 regardless (see header).
    requestTimeout: 300,
  },
  "retention-risk-sweep": {
    title: "Phoenix — retention risk sweep",
    path: "/api/cron/retention-risk-sweep",
    // 07:40 Cairo, matching docs/observability.md and JOB_SCHEDULES. It has to sit AFTER the
    // morning CRM sync, because it reads the absence of visit rows and a stale mirror reads as a
    // rep who has vanished. Offset from its neighbours in the morning block: 06:36 is the daily
    // notification bundle, 06:50 the marketing field-capture nudge, 07:05 marketing
    // invoice-overdue, 07:20 the distributor upload nudge, 08:15 the mailbox offboarding sweep.
    // Nothing else runs at :40 in this hour, so a red execution here is unambiguous.
    schedule: { hours: [7], minutes: [40], mdays: [-1], months: [-1], wdays: [-1] },
    // Scans ~66 days of the visits mirror for the medical reps only, plus one leave read and the
    // holiday lookup, then at most one notification per flagged rep per recipient. The page that
    // renders the same computation measured 8.6s warm and ~40s on a cold compile, so this one CAN
    // cross the 30s platform cut on a cold container and log a false red while succeeding — read
    // the response body's `announced`/`notified`, not the execution colour. 300 matches the rest
    // of the account; the platform still cuts at 30 regardless (see header).
    requestTimeout: 300,
  },
  "retention-risk-pre-payroll": {
    title: "Phoenix — retention risk pre-payroll notice",
    path: "/api/cron/retention-risk-pre-payroll",
    // 07:45 Cairo on the 25th ONLY — `mdays: [25]`. Part 1 pays at the start of the month, so the
    // 25th leaves several working days to check on somebody before any money moves. The other half
    // of this warning fires from the payroll wizard itself when Part 1 is confirmed; the two carry
    // different `reason` values in their idempotency keys and neither suppresses the other.
    // Five minutes behind the daily sweep so the two never share a minute.
    schedule: { hours: [7], minutes: [45], mdays: [25], months: [-1], wdays: [-1] },
    // Same computation as the sweep, then ONE digest per recipient rather than one per rep. It
    // sends even when nobody is flagged — a notice that only appears with bad news cannot be told
    // apart from one that has silently stopped working. Same cold-start caveat as the sweep above.
    requestTimeout: 300,
  },
  "production-planning-fx": {
    title: "Phoenix — production planner daily dollar rate",
    path: "/api/cron/production-planning-fx",
    // 06:07 Cairo, and the minute matters: 06:07 is used by NOTHING else in this account, not even
    // the every-two-minute and every-five-minute sweeps (both land on even or 5-divisible minutes),
    // so a red execution here names this job and no other. Four minutes ahead of the reorder sweep,
    // so a cost that email might carry is read off today's rate rather than yesterday's.
    schedule: { hours: [6], minutes: [7], mdays: [-1], months: [-1], wdays: [-1] },
    // One outbound GET with a 10s timeout and one upsert. It is gated by its own pair of settings
    // switches and does nothing at all until the owner arms it. 300 matches the rest of the account;
    // the platform still cuts at 30 regardless (see header).
    requestTimeout: 300,
  },
  "production-planning-reorder": {
    title: "Phoenix — production planner reorder alarm",
    path: "/api/cron/production-planning-reorder",
    // 06:11 Cairo — another minute nothing else in the account uses, for the same reason as the FX
    // job above, and early enough that the answer is waiting before the office opens. The imported
    // material needs about six months of lead time, so a day's delay is not neutral.
    schedule: { hours: [6], minutes: [11], mdays: [-1], months: [-1], wdays: [-1] },
    // The planner's own engine over one product's materials, then at most one email. SILENT until
    // the owner arms it: `alarm_enabled`, `alarm_dry_run`, the template's `is_active` and
    // EMAIL_NOTIFICATIONS_ENABLED are four independent switches and none of them is a default.
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
            enabled: !HOLD,
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
      if (HOLD) {
        console.log(`  HELD — created disabled, so it fires nothing yet. Re-run without --hold to arm it.`);
      }
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
