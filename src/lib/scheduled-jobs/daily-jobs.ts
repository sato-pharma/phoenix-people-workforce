/**
 * The morning jobs, one schedule each (owner, 13 Nov 2026 — enterprise audit F-HR-012 / REC-049).
 *
 * WHY THIS EXISTS. Until 13 Nov 2026 `/api/notifications/daily` ran the Needs You daily digest and
 * then about thirty unrelated jobs at once, in one request, at 06:36 Cairo. One heartbeat covered
 * all of them, so one red said "something in the morning failed" and nothing more; a deploy that
 * killed the request mid-way left every job half-done at once; and the jobs queued behind each
 * other for the database. The owner chose that each job gets its own schedule: its own scheduler
 * entry, its own heartbeat, staggered over the morning. WHAT each job does, who it tells and by
 * which channel did not change — only when, and on which request, it runs.
 *
 * 🔴 IT SHIPS SWITCHED OFF (owner, 13 Nov 2026: a safe switch-over). Thirty new cron-job.org entries
 * cost about 120 API requests to arm and the account allows 100 a day, so arming takes two days.
 * Until `PHOENIX_DAILY_JOBS_SPLIT` is exactly `on` (`dailyJobsSplitIsOn` below, the ONE place
 * it is read), `/api/notifications/daily` runs all thirty jobs exactly as it did before, under
 * `phoenix-notify-daily`, and `/api/cron/daily/<job>` answers without running anything. Once it is
 * on, the reverse. A job runs from one place or the other, never both and never neither
 * (`dailyJobsRunOn`). The runbook is docs/deployment.md, "Switching the morning jobs over".
 *
 * THIS FILE IS PURE: no imports, nothing that touches a database. It is the one list of the jobs,
 * their order and their Cairo times, read by:
 *   - `app/api/cron/daily/[job]/route.ts`, which runs ONE job per request once the switch is on (the
 *     runners, which do import the job functions, are in `app/api/cron/daily/_lib/daily-job-runners.ts`);
 *   - `app/api/notifications/daily/route.ts`, the fan-out, which runs them all in this order while the
 *     switch is off, and only names them once it is on;
 *   - `src/lib/observability/job-schedule.ts`, which declares one heartbeat per job from it (switch on);
 *   - `src/lib/observability/job-refire.ts`, which re-fires a job a deploy killed.
 *
 * 🔴 THE TIMES ARE COPIED IN TWO OTHER PLACES BY HAND, AND A TEST HOLDS ALL THREE TOGETHER.
 * `scripts/cronjob-sync.mjs` (the cron-job.org entries; it is plain JavaScript and the arming
 * workflow reads its text, so it cannot import this) and the job table in `docs/observability.md`.
 * `tests/daily-jobs-split.test.ts` fails the PR if any of the three disagree, if two jobs share a
 * minute, or if a job the fan-out used to run is missing here.
 *
 * ORDER. The Needs You digest first, at 06:36 — its old time, and the owner reads it first thing.
 * Then the rest in the order the fan-out listed them, one to four minutes apart, on minutes no
 * other job in `scripts/cronjob-sync.mjs` holds at that hour (the every-2, every-5 and every-10
 * minute drains hold most minutes of every hour and are the only overlap), finishing at 07:32.
 */

export type DailyJobDeclaration = {
  /** Stable, kebab-case. The URL segment (`/api/cron/daily/<key>`) and the heartbeat's suffix. */
  key: string;
  /** What it is, in words, for the fan-out's answer once the switch is on, and the 404. */
  name: string;
  /** Africa/Cairo, 24-hour. */
  hour: number;
  minute: number;
};

export const DAILY_JOBS = [
  { key: "needs-you-daily-digest", name: "Needs You daily digest", hour: 6, minute: 36 },
  { key: "birthday", name: "Birthday notices", hour: 6, minute: 38 },
  { key: "contract-renewals", name: "Contract renewal notices", hour: 6, minute: 40 },
  { key: "holiday-confirmation", name: "Holiday confirmation reminder", hour: 6, minute: 42 },
  { key: "vacation-sla", name: "Vacation approval reminders", hour: 6, minute: 44 },
  { key: "marketing-sla", name: "Marketing request approval reminders", hour: 6, minute: 46 },
  { key: "marketing-assignment-backfill", name: "Marketing request approver backfill", hour: 6, minute: 48 },
  { key: "recruitment-notifications", name: "Recruitment daily notices", hour: 6, minute: 52 },
  { key: "telegram-digest", name: "Telegram daily HR digest", hour: 6, minute: 54 },
  { key: "outstation-geocode-warmup", name: "Outstation address look-up warm-up", hour: 6, minute: 56 },
  { key: "excuse-sla", name: "Excuse approval reminders", hour: 6, minute: 57 },
  { key: "outstation-sla", name: "Outstation approval reminders", hour: 6, minute: 58 },
  { key: "outstation-departure-photo", name: "Outstation departure photo reminders", hour: 7, minute: 2 },
  { key: "resignation-sla", name: "Resignation approval reminders", hour: 7, minute: 4 },
  { key: "weekly-plans-drift", name: "Weekly plans drift check", hour: 7, minute: 6 },
  { key: "excuse-drift", name: "Excuse drift check", hour: 7, minute: 8 },
  { key: "rate-limit-prune", name: "Rate-limit bucket clean-up", hour: 7, minute: 9 },
  { key: "error-events-prune", name: "Error log clean-up", hour: 7, minute: 10 },
  { key: "notification-retention", name: "Notification retention clean-up", hour: 7, minute: 12 },
  { key: "activity-retention", name: "Activity log retention clean-up", hour: 7, minute: 14 },
  { key: "sos-monthly-report-check", name: "Monthly sales report delivery check", hour: 7, minute: 16 },
  { key: "held-notification-reminder", name: "Held notification reminder", hour: 7, minute: 17 },
  { key: "held-notification-expiry", name: "Held notification expiry", hour: 7, minute: 18 },
  { key: "milestone-due", name: "Service milestone and birthday card notices", hour: 7, minute: 22 },
  { key: "inactive-user-digest", name: "Inactive colleagues digest", hour: 7, minute: 24 },
  { key: "needs-you-weekly-email", name: "Needs You weekly email (Sundays)", hour: 7, minute: 25 },
  { key: "dead-telegram-link-alert", name: "Dead Telegram link alert", hour: 7, minute: 26 },
  { key: "probation-milestone-emails", name: "Probation Day 30, 60 and 75 emails", hour: 7, minute: 28 },
  { key: "outstation-workload-restamp", name: "Outstation workload refresh", hour: 7, minute: 29 },
  { key: "tablet-recording-retention", name: "Tablet recording retention", hour: 7, minute: 32 },
] as const satisfies readonly DailyJobDeclaration[];

export type DailyJobKey = (typeof DAILY_JOBS)[number]["key"];

/** The dynamic route every job is called on. */
export const DAILY_JOB_PATH_PREFIX = "/api/cron/daily/";

/** Prefix of every daily job's heartbeat slug. */
export const DAILY_JOB_SLUG_PREFIX = "phoenix-daily-";

/**
 * How late a job may report before its silence means something. One hour, the grace the single
 * 06:36 heartbeat had, so each job is watched exactly as tightly as the bundle was.
 */
export const DAILY_JOB_GRACE_SECONDS = 60 * 60;

/**
 * The latest Cairo minute at which a job a deploy killed is still re-fired (job-refire.ts): 12:00,
 * the cut-off the bundle had.
 */
export const DAILY_JOB_REFIRE_LATEST_CAIRO_MINUTES = 12 * 60;

export function dailyJobHeartbeatSlug(key: string): string {
  return `${DAILY_JOB_SLUG_PREFIX}${key}`;
}

export function dailyJobPath(key: string): string {
  return `${DAILY_JOB_PATH_PREFIX}${key}`;
}

/** The 5-field Africa/Cairo cron expression, as `JOB_SCHEDULES` and the doc table write it. */
export function dailyJobCronExpression(job: Pick<DailyJobDeclaration, "hour" | "minute">): string {
  return `${job.minute} ${job.hour} * * *`;
}

/** `06:36`, for people. */
export function dailyJobCairoTime(job: Pick<DailyJobDeclaration, "hour" | "minute">): string {
  return `${String(job.hour).padStart(2, "0")}:${String(job.minute).padStart(2, "0")}`;
}

/** The environment variable that switches the morning jobs from the fan-out to their own schedules. */
export const DAILY_JOBS_SPLIT_SWITCH = "PHOENIX_DAILY_JOBS_SPLIT";

/** The heartbeat and the address of the old 06:36 fan-out, which runs the jobs until the switch is on. */
export const DAILY_FAN_OUT_SLUG = "phoenix-notify-daily";
export const DAILY_FAN_OUT_PATH = "/api/notifications/daily";

/**
 * Is the split switched on? The ONE place `PHOENIX_DAILY_JOBS_SPLIT` is read. Only the exact value
 * `on` switches it on — unset, empty, `true`, `ON`, `1` or a typo all leave the fan-out running
 * the jobs, because the fan-out is the arrangement that is known to be armed and watched. It is set
 * by hand on the Railway service after both arming days (docs/deployment.md), never in a file.
 */
export function dailyJobsSplitIsOn(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[DAILY_JOBS_SPLIT_SWITCH] === "on";
}

/**
 * Where the morning jobs run: all of them from the fan-out, or each from its own route. One answer
 * for both routes, so a job can never run from both or from neither.
 */
export function dailyJobsRunOn(splitOn: boolean): "fan-out" | "own-route" {
  return splitOn ? "own-route" : "fan-out";
}

export function isDailyJobKey(value: string): value is DailyJobKey {
  return DAILY_JOBS.some((job) => job.key === value);
}

export function findDailyJob(key: string): (typeof DAILY_JOBS)[number] | undefined {
  return DAILY_JOBS.find((job) => job.key === key);
}
