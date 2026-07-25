// Static metadata for the 7 GCP Cloud Scheduler jobs that drive this system's automation.
// This is the single place job descriptions live — the dashboard never shows a raw GCP job
// name without a human label, and `tests/cron-control-registry.test.ts` cross-checks every
// `route` here against `src/lib/security/access-registry.ts` so this can't silently drift
// from the real cron-secret-gated routes.

export type CronJobKey =
  | "phoenix-background-jobs"
  | "phoenix-process-notifications"
  | "phoenix-notify-daily"
  | "phoenix-ireports360-sync"
  | "phoenix-reconcile-visits"
  | "phoenix-ireports360-live-sync"
  | "phoenix-recruitment-email-intake";

export type CronJobRegistryEntry = {
  gcpJobName: CronJobKey;
  label: string;
  description: string;
  route: string;
};

export const cronJobRegistry: readonly CronJobRegistryEntry[] = [
  {
    gcpJobName: "phoenix-background-jobs",
    label: "Background Jobs Worker",
    description: "Drains the durable background-job outbox (imports, exports, and other async work) and sends a Super Admin Telegram/in-app recap after every run.",
    route: "/api/cron/background-jobs",
  },
  {
    gcpJobName: "phoenix-process-notifications",
    label: "Notification Outbox Drain",
    description: "Drains and retries the email/notification outbox faster than the once-daily digest.",
    route: "/api/notifications/process",
  },
  {
    gcpJobName: "phoenix-notify-daily",
    label: "Daily Notifications",
    description: "Birthdays, contract renewals, holiday reminders, vacation/marketing/outstation SLA digests, and daily notification/activity-log retention cleanup.",
    route: "/api/notifications/daily",
  },
  {
    gcpJobName: "phoenix-ireports360-sync",
    label: "iReports360 Visits Sync",
    description: "Syncs field-visit check-ins from the iReports360 CRM three times a day.",
    route: "/api/cron/ireports360-visits-sync",
  },
  {
    gcpJobName: "phoenix-reconcile-visits",
    label: "iReports360 Wide Reconcile",
    description: "Weekly full-window reconciliation of iReports360 visit data against the local mirror.",
    route: "/api/cron/ireports360-visits-reconcile",
  },
  {
    gcpJobName: "phoenix-ireports360-live-sync",
    label: "iReports360 Live Morning Sync",
    description: "High-frequency same-day-only sync, 8:30 AM-12:01 PM Cairo, so CRM First Visit / Early Birds reflects a visit+check-in within minutes of submission during the compliance window.",
    route: "/api/cron/ireports360-visits-live-sync",
  },
  {
    gcpJobName: "phoenix-recruitment-email-intake",
    label: "Recruitment Email Intake",
    description: "Polls the configured careers@/hr@ mailboxes via IMAP every 10 minutes for inbound candidate CVs; a clean no-op when no mailboxes are configured.",
    route: "/api/cron/recruitment-email-intake",
  },
] as const;

export function findCronJobRegistryEntry(jobName: string): CronJobRegistryEntry | null {
  return cronJobRegistry.find((entry) => entry.gcpJobName === jobName) ?? null;
}

export function isCronJobKey(value: string): value is CronJobKey {
  return cronJobRegistry.some((entry) => entry.gcpJobName === value);
}

// GCP Cloud Scheduler job-ID constraint (docs.cloud.google.com/scheduler/docs/reference/rest/v1/
// projects.locations.jobs): 1-500 chars, letters/numbers/hyphens/underscores only. This is the
// REAL safety gate for mutations — not registry membership. A job created outside this repo
// (via console/gcloud, or added to GCP later) must still be listable and mutable here; the
// static registry above only supplies nicer labels/descriptions when it recognizes the name,
// it never gates whether a real GCP job can be seen or controlled.
const GCP_JOB_ID_PATTERN = /^[a-zA-Z0-9_-]{1,500}$/;

export function isValidGcpJobIdFormat(value: string): boolean {
  return GCP_JOB_ID_PATTERN.test(value);
}
