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
 * THIS FILE IS PURE: no imports, nothing that touches a database. It is the one list of the jobs,
 * their order and their Cairo times, read by:
 *   - `app/api/cron/daily/[job]/route.ts`, which runs ONE job per request (the runners, which do
 *     import the job functions, are in `app/api/cron/daily/_lib/daily-job-runners.ts`);
 *   - `src/lib/observability/job-schedule.ts`, which declares one heartbeat per job from it;
 *   - `src/lib/observability/job-refire.ts`, which re-fires a job a deploy killed;
 *   - `app/api/notifications/daily/route.ts`, the retired fan-out, which now only names them.
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
  /** What it is, in words, for the retired route's answer and the 404. */
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

export function isDailyJobKey(value: string): value is DailyJobKey {
  return DAILY_JOBS.some((job) => job.key === value);
}

export function findDailyJob(key: string): (typeof DAILY_JOBS)[number] | undefined {
  return DAILY_JOBS.find((job) => job.key === key);
}
