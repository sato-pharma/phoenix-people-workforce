/**
 * Every scheduled job this system expects to hear from, and how late it may be before that
 * silence means something.
 *
 * WHY THIS IS DUPLICATED FROM THE DOC TABLE, AND WHY THAT IS SAFE.
 * `docs/observability.md` holds the same 53 rows and is the source of truth for
 * `scripts/healthchecks-sync.mjs`, which pushes schedules to Healthchecks.io. That table cannot be
 * the runtime source as well: this module runs inside the deployed Next.js server, and a Next
 * standalone build traces imported FILES — it does not copy `docs/`. Reading the markdown at
 * runtime would work locally, pass every test, and then throw on Railway.
 *
 * So the declarations live here in TypeScript, and `tests/job-heartbeat-register.test.ts` asserts
 * — in the required CI `validate` job — that this list and the doc table agree slug for slug,
 * schedule for schedule, grace for grace. There is one truth; it is simply checked rather than
 * shared. A row added to one and not the other turns the PR red.
 *
 * GRACE IS "HOW LATE IS STILL NORMAL", NOT "HOW LONG THE JOB TAKES". It absorbs a scheduler that
 * fires a few minutes late, a queue that backs up, a container that restarts. Set it too tight and
 * the register cries wolf; set it too loose and a dead job stays quiet for hours. The values here
 * are the ones already proven on Healthchecks, unchanged.
 */

export type JobScheduleDeclaration = {
  /** The dead-man's-switch slug — identical to the Healthchecks slug for the same job. */
  slug: string;
  /**
   * `cron` jobs fire on a 5-field Africa/Cairo expression. `simple` jobs are pinged by the
   * in-process poller on a plain interval and have no expression to give.
   */
  kind: "cron" | "simple";
  /** Present on `cron` declarations only. Africa/Cairo, always — see the timezone note below. */
  schedule?: string;
  /** Present on `simple` declarations only. Seconds between expected pings. */
  periodSeconds?: number;
  /** How late a ping may be, in seconds, before the job counts as stranded. */
  graceSeconds: number;
  /**
   * When this system started watching this job, as an ISO instant — set ONLY on a declaration that
   * was RESTORED after being stood down, never on a new one.
   *
   * 🔴 WHY IT EXISTS, AND THE ALARM IT ENDS. The heartbeat row outlives the declaration: taking a
   * slug out of this list stops it being judged but leaves its `job_heartbeats` row, whose
   * `first_seen_at` still points at the ORIGINAL declaration. Put the slug back and the sweep judges
   * the restored job against the fires in between — fires that had no cron job behind them and that
   * it can never have reported — so `hadAChanceToRun` is true, there is no success, and it reads as
   * STRANDED on the first sweep after the restore: an alarm to every Super Admin every 15 minutes
   * about a job that is scheduled correctly and has simply not come round yet.
   *
   * Not hypothetical. `phoenix-crm-daily-digest` was built on 2026-09-26, stood down the next evening
   * before a single message had been sent, and restored at 00:42 Cairo on 2026-09-28. Its row still
   * read 2026-09-26, so the 06:55 of the 27th — a morning on which no cron job existed — counted
   * against it, and the strand alarm ran from 08:55 that morning until the row was re-armed by hand.
   *
   * The floor is a FIXED instant, deliberately: it moves the baseline once, to a date a human wrote
   * down, so it can never widen into a rolling window that hides a job which has genuinely never
   * worked. A value that cannot be parsed, or one in the future, is reported as MISDECLARED rather
   * than quietly ignored — either would otherwise blind the sweep for this job for good.
   */
  watchingSince?: string;
};

/**
 * TIMEZONE. Every expression here is Africa/Cairo local, because cron-job.org — which fires almost
 * all of them — is configured in Africa/Cairo. Evaluating one as UTC puts its expected-fire window
 * two to three hours off the real one and shifts it again at every Egyptian DST change, so a
 * perfectly healthy job reads as stranded.
 */
export const JOB_SCHEDULE_TIMEZONE = "Africa/Cairo" as const;

const MINUTE = 60;
const HOUR = 60 * MINUTE;

export const JOB_SCHEDULES: readonly JobScheduleDeclaration[] = [
  { slug: "phoenix-notify-daily", kind: "cron", schedule: "36 6 * * *", graceSeconds: 1 * HOUR },
  // The production planner's two sweeps, on minutes nothing else in the account uses (06:07 and
  // 06:11), so a missed heartbeat names one job. Both are gated by their own pair of settings
  // switches and do nothing until the owner arms them — but the SWEEP still has to run, which is
  // what these watch: silence here means the job stopped, not that it was switched off.
  { slug: "phoenix-production-planning-fx", kind: "cron", schedule: "7 6 * * *", graceSeconds: 2 * HOUR },
  { slug: "phoenix-production-planning-reorder", kind: "cron", schedule: "11 6 * * *", graceSeconds: 2 * HOUR },
  { slug: "phoenix-marketing-field-capture-nudge", kind: "cron", schedule: "50 6 * * *", graceSeconds: 1 * HOUR },
  { slug: "phoenix-marketing-list-check", kind: "cron", schedule: "37 * * * *", graceSeconds: 1 * HOUR },
  { slug: "phoenix-marketing-invoice-overdue-nudge", kind: "cron", schedule: "5 7 * * *", graceSeconds: 1 * HOUR },
  { slug: "phoenix-distributor-upload-overdue-nudge", kind: "cron", schedule: "20 7 * * *", graceSeconds: 1 * HOUR },
  // Every quarter hour, not daily, and that is the point. A held mapping change means the map is
  // refusing that write until somebody decides, so the gap between the hold and the message is a
  // window in which an import quietly under-applies. The sweep is one indexed query that usually
  // returns nothing, so the cost of running it 96 times a day is far below the cost of a held
  // change nobody hears about until tomorrow. Grace is an hour: a couple of missed runs are not
  // worth waking anyone for, a whole hour of silence is.
  // On :05 rather than the :00 quarters, because job-heartbeat-sweep already holds those and a red
  // execution should name one job unambiguously. This expression must match the cron-job.org
  // declaration in scripts/cronjob-sync.mjs exactly, or the heartbeat assessment judges a job that
  // is firing perfectly well to be late.
  { slug: "phoenix-mapping-guard-notify", kind: "cron", schedule: "5,20,35,50 * * * *", graceSeconds: 1 * HOUR },
  // Every ten minutes, on :03 — the one-hour reminder before an interview has a ten-minute window to
  // land in, so a slower clock would skip interviews. Off every other job's minutes so a red execution
  // names one job. Must match scripts/cronjob-sync.mjs exactly.
  { slug: "phoenix-interview-reminders", kind: "cron", schedule: "3,13,23,33,43,53 * * * *", graceSeconds: 1 * HOUR },
  // Hourly on :27 (owner, 2026-10-16: "I don't want manual work in the recruitment"): opens a
  // requisition for every empty seat and closes as Filled the ones whose seat is filled. On :27,
  // a minute no other job holds. Must match scripts/cronjob-sync.mjs exactly, and lands in the SAME
  // sitting as its cron job. NO watchingSince: a new declaration, never a restored one.
  { slug: "phoenix-recruitment-requisition-autopilot", kind: "cron", schedule: "27 * * * *", graceSeconds: 2 * HOUR },
  // Hourly on :41 (owner, 2026-10-16: a manager's CV folder keeps notifying until its CV is opened).
  // The route sends only between 08:00 and 21:59 Cairo and still pings its heartbeat at night, so the
  // check stays a straight hourly one. On :41, a minute no other job holds. Must match
  // scripts/cronjob-sync.mjs exactly, and lands in the SAME sitting as its cron job. NO watchingSince:
  // a new declaration, never a restored one.
  { slug: "phoenix-recruitment-manager-cv-reminders", kind: "cron", schedule: "41 * * * *", graceSeconds: 2 * HOUR },
  // 03:29 Cairo, daily (owner, 2026-10-20: rejections leave the tabs for the archive after 30 days —
  // never deleted, still searchable, one click back). A minute no other job holds. Must match
  // scripts/cronjob-sync.mjs exactly. NO watchingSince: a new declaration.
  { slug: "phoenix-recruitment-archive-rejections", kind: "cron", schedule: "29 3 * * *", graceSeconds: 2 * HOUR },
  // Every 30 minutes on :01 and :31 (owner, 2026-10-20: the in-window WhatsApp re-ask "stays off
  // until you switch it on"). The route returns at once while ats_recruitment_settings says off, and
  // still pings its heartbeat, so the check stays a straight half-hourly one. :01 and :31 are odd
  // minutes no other job holds (*/2 takes every even one). Must match scripts/cronjob-sync.mjs
  // exactly, and lands in the SAME sitting as its cron job. NO watchingSince: a new declaration.
  { slug: "phoenix-recruitment-whatsapp-reask", kind: "cron", schedule: "1,31 * * * *", graceSeconds: 1 * HOUR },
  // Five ticks at 10:xx Cairo, every day (owner, 3 Nov 2026: the WhatsApp reminder to a slow approver). The route sends
  // nothing on a Friday or Saturday and nothing until its three locks open, and still pings, so the check stays a straight
  // daily one. Must match scripts/cronjob-sync.mjs exactly, and lands in the SAME sitting as its cron job.
  { slug: "phoenix-approval-whatsapp-reminders", kind: "cron", schedule: "9,11,17,29,47 10 * * *", graceSeconds: 2 * HOUR },
  // 02:47 Cairo nightly (owner, 2026-11-03): the Sales -> Marketing pharmacy-code sync, until now run only
  // by hand. A minute no other job holds. Must match scripts/cronjob-sync.mjs exactly, in the SAME sitting.
  // NO watchingSince: a new declaration.
  { slug: "phoenix-marketing-pharmacy-code-sync", kind: "cron", schedule: "47 2 * * *", graceSeconds: 2 * HOUR },
  // 10:57 Cairo, every day (owner, 2026-11-03: the nightly code backup, read from Drive). Under the period.
  { slug: "phoenix-code-backup-verify", kind: "cron", schedule: "57 10 * * *", graceSeconds: 2 * HOUR },
  // 10:37 Cairo, every day including Friday (owner, 2026-11-03: the HR handset's 14-day reminder). Under
  // seven days it says nothing and still reports, so a quiet run is correct. A minute no other job holds.
  // Must match scripts/cronjob-sync.mjs exactly, in the SAME sitting. NO watchingSince: a new declaration.
  { slug: "phoenix-whatsapp-handset-reminder", kind: "cron", schedule: "37 10 * * *", graceSeconds: 2 * HOUR },
  // Hourly on :21 (owner, 2026-11-03): when each check on GitHub last succeeded. The grace is under the
  // hour, so one missed fire stays quiet only if the next one lands. Must match scripts/cronjob-sync.mjs
  // exactly, in the SAME sitting. NO watchingSince: a new declaration.
  { slug: "phoenix-github-workflow-watch", kind: "cron", schedule: "21 * * * *", graceSeconds: 30 * MINUTE },
  // Hourly: has a tablet held by a rep gone quiet. Reads the Headwind device list only (owner, 2026-11-03).
  // Armed on merge by cron-autoarm.yml, in-house only. NO watchingSince: a new declaration.
  { slug: "phoenix-tablet-fleet-watch", kind: "cron", schedule: "11 * * * *", graceSeconds: 30 * MINUTE },
  // 06:55 Cairo, every day — before the field day starts, and on :55 so a red execution names one
  // job. Daily rather than field-days-only: the job runs on a Friday too and simply finds the
  // Thursday before, which is what keeps its heartbeat a straight daily one. Must match
  // scripts/cronjob-sync.mjs exactly, or the heartbeat judges a job that fires perfectly to be late.
  // 🔴 RESTORED 2026-09-28 — the owner asked for the digest back, in his own words: "i want it in
  // app or telegram only". He had stood it down the evening before ("donot create this digest i
  // donot want it") and nothing had ever been sent, so there is nothing in the field to undo.
  // The channel condition he attached was already how it was built: `deliver` asks for
  // ["in_app", "telegram"] and the module guard strips email whatever any caller asks for.
  //
  // 🔴 THIS LINE AND THE CRON JOB LAND IN THE SAME SITTING, NEVER ONE WITHOUT THE OTHER. A
  // declaration with no job behind it is read by the heartbeat sweep as a job that has STOPPED:
  // once one 06:55 passes, `hadAChanceToRun` is true, it has never reported a success, and it goes
  // STRANDED — an in-app, Telegram and push alarm to every Super Admin, every sweep, for ever,
  // about a job nobody created. Merging this without running the cron-job.org sync IS that alarm.
  //
  // `watchingSince` is the restore instant, and it is what stops the SAME alarm arriving for the
  // stand-down window: the row survived it still reading 2026-09-26, so the 06:55 of the 27th — a
  // morning with no cron job behind it — counted against this job until the baseline was re-armed.
  // Read the field's own note before changing or removing this date.
  {
    slug: "phoenix-crm-daily-digest",
    kind: "cron",
    schedule: "55 6 * * *",
    graceSeconds: 2 * HOUR,
    watchingSince: "2026-09-27T21:42:07Z",
  },
  { slug: "phoenix-crm-integrity-sweep", kind: "cron", schedule: "35 3 * * *", graceSeconds: 3 * HOUR },
  // 12:57 and 17:57 Cairo, every day (owner, 2026-10-02): the "your coming week is not sent" reminder.
  // Daily rather than due-days-only, so the heartbeat stays a plain daily one — on a day with nothing
  // due it reads nothing and sends nothing. On :57 so a red execution names one job. Must match
  // scripts/cronjob-sync.mjs exactly, and lands in the SAME sitting as its cron job (see the digest's note above).
  { slug: "phoenix-crm-plan-reminder", kind: "cron", schedule: "57 12,17 * * *", graceSeconds: 2 * HOUR },
  // 09:57 Cairo, every day (owner, 2026-10-02): the nudge to a district manager or the SFE Manager with
  // a list request, an off-plan visit or a request to edit a week waiting on him for more than a day.
  // A morning with nothing overdue sends nothing and still reports. On :57 at 9, a minute no other job
  // holds. Must match scripts/cronjob-sync.mjs exactly, and lands in the SAME sitting as its cron job.
  { slug: "phoenix-crm-approval-nudge", kind: "cron", schedule: "57 9 * * *", graceSeconds: 2 * HOUR },
  // Hourly on :49 (owner, 2026-10-05): the batched routine-visit rollup to the NSM and the SFE
  // Managers. On :49, an odd minute no other hourly job holds. Must match scripts/cronjob-sync.mjs
  // exactly, and lands in the SAME sitting as its cron job (see the digest's note above).
  // 04:17 Cairo nightly (owner, 2026-10-05): Phoenix Ranks rebuilds every window holding yesterday.
  // Must match scripts/cronjob-sync.mjs exactly, and lands in the SAME sitting as its cron job.
  { slug: "phoenix-rep-ranks", kind: "cron", schedule: "17 4 * * *", graceSeconds: 3 * HOUR },
  { slug: "phoenix-crm-visit-rollup", kind: "cron", schedule: "49 * * * *", graceSeconds: 1 * HOUR },
  // 07:00 Cairo on Thursday (owner, 2026-10-07): the weekly visit-fraud scan, reporting the completed
  // Sat–Wed working week to the Super Admin and the SFE Managers. Weekly, so the heartbeat judges one
  // fire a week — on :00 of an hour no other job holds, and on wday 4 (Thursday) so a red execution
  // names one job. Must match scripts/cronjob-sync.mjs exactly, and lands in the SAME sitting as its
  // cron job (see the digest's note above). NO watchingSince: this is a NEW declaration, never a
  // restored one, so there is no stand-down window to exempt — only a restored job carries that date.
  { slug: "phoenix-crm-fraud-scan", kind: "cron", schedule: "0 7 * * 4", graceSeconds: 2 * HOUR },
  // 08:09 Cairo on Saturday (owner, 2026-10-08): the employee's own unexplained-day notice for the
  // completed Sat-Thu week. Weekly, so the heartbeat judges one fire a week. A week with no gap sends
  // nothing, which is why the switch matters here more than usual: silence is the EXPECTED outcome of a
  // healthy week, so without a heartbeat a stopped job and a clean week read identically. Must match
  // scripts/cronjob-sync.mjs exactly. NO watchingSince: this is a NEW declaration, never a restored
  // one, so there is no stand-down window to exempt.
  { slug: "private-calendar-gap-notice", kind: "cron", schedule: "9 8 * * 6", graceSeconds: 2 * HOUR },
  { slug: "phoenix-retention-risk-sweep", kind: "cron", schedule: "40 7 * * *", graceSeconds: 1 * HOUR },
  // Day 25 only. The pre-payroll half of the same feature: Part 1 pays at the start of the month,
  // so the 25th leaves several working days to check on someone before any money moves. The other
  // half fires from the payroll wizard itself when Part 1 is confirmed (see confirmPart1).
  { slug: "phoenix-retention-risk-pre-payroll", kind: "cron", schedule: "45 7 25 * *", graceSeconds: 2 * HOUR },
  { slug: "phoenix-mailbox-offboarding-sweep", kind: "cron", schedule: "15 8 * * *", graceSeconds: 1 * HOUR },
  { slug: "phoenix-process-notifications", kind: "cron", schedule: "*/5 * * * *", graceSeconds: 10 * MINUTE },
  { slug: "phoenix-background-jobs", kind: "cron", schedule: "0 3 * * 5", graceSeconds: 2 * HOUR },
  { slug: "phoenix-inbound-intake", kind: "cron", schedule: "*/2 * * * *", graceSeconds: 10 * MINUTE },
  // 🔴 20 MINUTES, NOT 10 — TWO MISSED FIRES, BECAUSE AT 10 ONE WAS ENOUGH TO ALARM. Measured
  // 2026-10-15 over this check's whole history: 24 outages, and 12 of them lasted 9.8-10.0 minutes,
  // which is the signature of recovering on the very NEXT scheduled fire. A grace equal to the
  // interval makes a single skipped run a page, and this job skipping one run costs nothing — the
  // next one reads the same mailbox. Widening to 20 would have silenced 11 of the 11 alerts in the
  // last 30 days and still caught both real outages (40 minutes and 8 hours). Never put it back to
  // one interval; see the grace note in this file's header.
  { slug: "phoenix-recruitment-email-intake", kind: "cron", schedule: "4-59/10 * * * *", graceSeconds: 20 * MINUTE },
  { slug: "phoenix-run-synthetic-journeys", kind: "cron", schedule: "17 5,8,11,14,17,20 * * *", graceSeconds: 2 * HOUR },
  { slug: "phoenix-direct-orders-rotate-sheet-token", kind: "cron", schedule: "23 3 * * 5", graceSeconds: 2 * HOUR },
  { slug: "phoenix-marketing-requests-rotate-sheet-token", kind: "cron", schedule: "43 3 * * 5", graceSeconds: 2 * HOUR },
  { slug: "phoenix-cv-lifecycle-rotate-sheet-token", kind: "cron", schedule: "3 4 * * 5", graceSeconds: 2 * HOUR },
  { slug: "phoenix-brevo-keepalive", kind: "cron", schedule: "9 4 1 * *", graceSeconds: 12 * HOUR },
  { slug: "phoenix-direct-orders-expire-held", kind: "cron", schedule: "17 2 * * *", graceSeconds: 2 * HOUR },
  { slug: "phoenix-direct-orders-probation", kind: "cron", schedule: "27 2 * * *", graceSeconds: 2 * HOUR },
  { slug: "phoenix-db-health-snapshot", kind: "cron", schedule: "17 */6 * * *", graceSeconds: 2 * HOUR },
  { slug: "phoenix-territory-restamp", kind: "cron", schedule: "20 3 * * *", graceSeconds: 2 * HOUR },
  // Every twenty minutes, on :19/:39/:59 — three minutes no other job in the account holds, so a red
  // execution names one job. Frequent BECAUSE a brick move applies to the mapping immediately and to
  // the TOTALS only once its queued sales files are rebuilt: the gap between the two is a window in
  // which every screen shows pre-move figures with nothing saying so. The قوص and أبنود moves of
  // 2026-10-12 sat in that window for a full day. At rest it is one indexed count, so the cost of
  // firing 72 times a day is far below the cost of a move nobody notices has half-landed.
  // Grace is an hour: a couple of missed fires are not worth waking anyone for, an hour of silence is.
  // Must match scripts/cronjob-sync.mjs exactly, or the heartbeat judges a job that fires perfectly
  // well to be late. NO watchingSince: this is a NEW declaration, never a restored one, so there is
  // no stand-down window to exempt — only a restored job carries that date.
  { slug: "phoenix-brick-move-drain", kind: "cron", schedule: "19,39,59 * * * *", graceSeconds: 1 * HOUR },
  { slug: "phoenix-reconciliation-check", kind: "cron", schedule: "40 4 * * *", graceSeconds: 2 * HOUR },
  // The nightly System Audit sweep (src/lib/system-audit/sweep.ts): every detector one at a time, the
  // verifier, then the one daily message. 04:57 Cairo, seventeen minutes after the integrity checks
  // above have written their findings, on a minute nothing else in the account holds. Must match
  // scripts/cronjob-sync.mjs exactly. In-house only — the Healthchecks project has no slot left.
  { slug: "phoenix-system-audit-sweep", kind: "cron", schedule: "57 4 * * *", graceSeconds: 2 * HOUR },
  { slug: "phoenix-expense-claims-refresh", kind: "cron", schedule: "51 * * * *", graceSeconds: 1 * HOUR },
  { slug: "phoenix-recruitment-cv-digest", kind: "cron", schedule: "47 0,6,12,18 * * *", graceSeconds: 1 * HOUR },
  // 🔴 PINGED FROM INSIDE THE DATABASE, NOT BY CRON-JOB.ORG. The pg_cron job
  // `crm-agent-crm-ids-reconcile` is the only thing keeping the departed-agent CRM id cache current,
  // and the door never falls back to the live read, so a stopped job froze the cache silently.
  // `crm_agent_crm_ids_reconcile_run()` records success after each run
  // (20261023220000_crm_agent_crm_ids_reconcile_heartbeat.sql). Hourly at minute 7 since the 2026-10-25
  // load audit (20261026000000): every 15 minutes it was the second-heaviest statement on the database.
  // The grace is two hours so an on-time run never reads late. pg_cron fires in UTC; Cairo's whole-hour
  // offset leaves minute 7 the same instant. NO watchingSince: a new declaration.
  { slug: "phoenix-crm-agent-crm-ids-reconcile", kind: "cron", schedule: "7 * * * *", graceSeconds: 2 * HOUR },
  // The other six pg_cron jobs, wired the same way by 20261023223000_pg_cron_jobs_report_heartbeats.sql
  // (owner's "Watch all six", 2026-10-23). Each `_run()` wrapper records success after the unchanged
  // function; the recovery snapshot's records FAIL when take_snapshots() reports a table it could not
  // capture, because that function catches per table and pg_cron reads `succeeded` regardless.
  // 🔴 `phoenix-data-retention` fires at 01:40 UTC — 03:40 Cairo in winter, 04:40 in summer — so it
  // is declared at the EARLIER time: the summer run then lands an hour inside the 2h grace, where the
  // later time would read every winter run as an hour too early and the job as stranded.
  // The rep entry-days reconcile fires every five minutes; 30 minutes is about six missed fires.
  // NO watchingSince on any: all new declarations.
  { slug: "phoenix-crm-person-by-hr-key-reconcile", kind: "cron", schedule: "*/15 * * * *", graceSeconds: 1 * HOUR },
  { slug: "phoenix-crm-contact-truth-reconcile", kind: "cron", schedule: "*/15 * * * *", graceSeconds: 1 * HOUR },
  { slug: "phoenix-crm-rep-entry-days-reconcile", kind: "cron", schedule: "*/5 * * * *", graceSeconds: 30 * MINUTE },
  { slug: "phoenix-data-retention", kind: "cron", schedule: "40 3 * * *", graceSeconds: 2 * HOUR },
  { slug: "phoenix-marketing-roi-refresh", kind: "cron", schedule: "20 * * * *", graceSeconds: 1 * HOUR },
  { slug: "phoenix-recovery-snapshot", kind: "cron", schedule: "5 * * * *", graceSeconds: 1 * HOUR },
  // The nightly ANALYZE of every table that holds data with no column statistics
  // (20261025230153_analyze_tables_with_no_statistics_nightly.sql). 02:20 UTC, declared at the
  // EARLIER Cairo reading for the same reason as the retention job. NO watchingSince: new.
  { slug: "phoenix-analyze-tables-without-statistics", kind: "cron", schedule: "20 4 * * *", graceSeconds: 2 * HOUR },
  // The sweeper itself. Declared like any other job so it holds a row and verifies itself on every
  // run. It cannot report its OWN silence — see the migration header and docs/observability.md.
  { slug: "phoenix-job-heartbeat-sweep", kind: "cron", schedule: "*/15 * * * *", graceSeconds: 30 * MINUTE },
];

export const JOB_HEARTBEAT_SWEEP_SLUG = "phoenix-job-heartbeat-sweep" as const;

/** Declared slugs, for the sweeper's bootstrap and for the doc-parity test. */
export function declaredJobSlugs(): string[] {
  return JOB_SCHEDULES.map((declaration) => declaration.slug);
}

export function findJobSchedule(slug: string): JobScheduleDeclaration | undefined {
  return JOB_SCHEDULES.find((declaration) => declaration.slug === slug);
}
