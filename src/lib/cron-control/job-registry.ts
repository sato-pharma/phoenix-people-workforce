// Static metadata for the 5 GCP Cloud Scheduler jobs that drive this system's automation.
// This is the single place job descriptions live — the dashboard never shows a raw GCP job
// name without a human label, and `tests/cron-control-registry.test.ts` cross-checks every
// `route` here against `src/lib/security/access-registry.ts` so this can't silently drift
// from the real cron-secret-gated routes.

export type CronJobKey =
  | "phoenix-background-jobs"
  | "phoenix-process-notifications"
  | "phoenix-notify-daily"
  | "phoenix-ireports360-sync"
  | "phoenix-reconcile-visits";

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
    description: "Drains the durable background-job outbox (imports, exports, and other async work).",
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
    description: "Birthdays, contract renewals, holiday reminders, and vacation/marketing/outstation SLA digests.",
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
] as const;

export function findCronJobRegistryEntry(jobName: string): CronJobRegistryEntry | null {
  return cronJobRegistry.find((entry) => entry.gcpJobName === jobName) ?? null;
}

export function isCronJobKey(value: string): value is CronJobKey {
  return cronJobRegistry.some((entry) => entry.gcpJobName === value);
}
