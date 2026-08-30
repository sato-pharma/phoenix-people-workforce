/**
 * Every scheduled job this system expects to hear from, and how late it may be before that
 * silence means something.
 *
 * WHY THIS IS DUPLICATED FROM THE DOC TABLE, AND WHY THAT IS SAFE.
 * `docs/observability.md` holds the same 24 rows and is the source of truth for
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
  { slug: "phoenix-marketing-field-capture-nudge", kind: "cron", schedule: "50 6 * * *", graceSeconds: 1 * HOUR },
  { slug: "phoenix-marketing-invoice-overdue-nudge", kind: "cron", schedule: "5 7 * * *", graceSeconds: 1 * HOUR },
  { slug: "phoenix-mailbox-offboarding-sweep", kind: "cron", schedule: "15 8 * * *", graceSeconds: 1 * HOUR },
  { slug: "phoenix-process-notifications", kind: "cron", schedule: "*/5 * * * *", graceSeconds: 10 * MINUTE },
  { slug: "phoenix-background-jobs", kind: "cron", schedule: "0 3 * * 5", graceSeconds: 2 * HOUR },
  { slug: "phoenix-inbound-intake", kind: "cron", schedule: "*/2 * * * *", graceSeconds: 10 * MINUTE },
  { slug: "phoenix-recruitment-email-intake", kind: "cron", schedule: "4-59/10 * * * *", graceSeconds: 10 * MINUTE },
  { slug: "phoenix-run-synthetic-journeys", kind: "cron", schedule: "0 * * * *", graceSeconds: 1 * HOUR },
  { slug: "phoenix-direct-orders-rotate-sheet-token", kind: "cron", schedule: "23 3 * * 5", graceSeconds: 2 * HOUR },
  { slug: "phoenix-marketing-requests-rotate-sheet-token", kind: "cron", schedule: "43 3 * * 5", graceSeconds: 2 * HOUR },
  { slug: "phoenix-brevo-keepalive", kind: "cron", schedule: "9 4 1 * *", graceSeconds: 12 * HOUR },
  { slug: "phoenix-direct-orders-expire-held", kind: "cron", schedule: "17 2 * * *", graceSeconds: 2 * HOUR },
  { slug: "phoenix-direct-orders-probation", kind: "cron", schedule: "27 2 * * *", graceSeconds: 2 * HOUR },
  { slug: "phoenix-db-health-snapshot", kind: "cron", schedule: "17 */6 * * *", graceSeconds: 2 * HOUR },
  { slug: "phoenix-territory-restamp", kind: "cron", schedule: "20 3 * * *", graceSeconds: 2 * HOUR },
  { slug: "phoenix-reconciliation-check", kind: "cron", schedule: "40 4 * * *", graceSeconds: 2 * HOUR },
  // Twelve ticks inside a single hour, then 23 hours of deliberate silence. This is exactly the
  // shape a naive "expected period" calculation gets wrong — it would read the 23-hour gap as a
  // strand every single day. The register computes the previous scheduled fire from the expression
  // instead, which is why cron-parser is used rather than an interval.
  { slug: "phoenix-crm-contact-lists", kind: "cron", schedule: "*/5 5 * * *", graceSeconds: 10 * MINUTE },
  { slug: "phoenix-expense-claims-refresh", kind: "cron", schedule: "51 * * * *", graceSeconds: 1 * HOUR },
  { slug: "phoenix-recruitment-cv-digest", kind: "cron", schedule: "47 0,6,12,18 * * *", graceSeconds: 1 * HOUR },
  { slug: "phoenix-ireports360-live-poll", kind: "simple", periodSeconds: 5 * MINUTE, graceSeconds: 15 * MINUTE },
  { slug: "phoenix-ireports360-sync", kind: "cron", schedule: "0 6-21/3 * * *", graceSeconds: 2 * HOUR },
  { slug: "phoenix-reconcile-visits", kind: "cron", schedule: "0 4 * * 0", graceSeconds: 12 * HOUR },
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
