import { JOB_SCHEDULE_TIMEZONE, findJobSchedule } from "@/lib/observability/job-schedule";

// What Sentry's cron monitoring needs to know about a job, derived from the one register of scheduled jobs
// (job-schedule.ts: slug, Africa/Cairo expression, grace). Sent with a check-in, Sentry creates the monitor
// the first time that job reports, so nobody builds 40 monitors by hand and a new job in the register is
// watched without a second edit. A job the register does not declare gets no config, so its check-ins are
// ignored by Sentry and create nothing.

export type SentryMonitorConfig = {
  schedule: { type: "crontab"; value: string } | { type: "interval"; value: number; unit: "minute" };
  checkinMargin: number;
  maxRuntime: number;
  timezone: string;
  failureIssueThreshold: number;
  recoveryThreshold: number;
};

// The longest a job may run before Sentry calls it hung. Check-ins here are a single "ok" or "error" at the end of
// a run, so this only bounds a start that never finishes, which none of these jobs sends.
const MAX_RUNTIME_MINUTES = 60;

// One bad run in a row is noise on a flaky network; two is a pattern. A single good run closes the issue.
const FAILURE_ISSUE_THRESHOLD = 2;
const RECOVERY_THRESHOLD = 1;

export function sentryMonitorConfigFor(jobSlug: string): SentryMonitorConfig | undefined {
  const declared = findJobSchedule(jobSlug);
  if (!declared) return undefined;
  const checkinMargin = Math.max(1, Math.ceil(declared.graceSeconds / 60));
  const common = {
    checkinMargin,
    maxRuntime: MAX_RUNTIME_MINUTES,
    timezone: JOB_SCHEDULE_TIMEZONE,
    failureIssueThreshold: FAILURE_ISSUE_THRESHOLD,
    recoveryThreshold: RECOVERY_THRESHOLD,
  };
  if (declared.kind === "cron" && declared.schedule) {
    return { schedule: { type: "crontab", value: declared.schedule }, ...common };
  }
  if (declared.kind === "simple" && declared.periodSeconds) {
    return { schedule: { type: "interval", value: Math.max(1, Math.round(declared.periodSeconds / 60)), unit: "minute" }, ...common };
  }
  return undefined;
}
