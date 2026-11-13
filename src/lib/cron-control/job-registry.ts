// The manifest of this system's cron-triggered routes.
//
// It was written as metadata for the GCP Cloud Scheduler dashboard at /admin/cron-control. That
// dashboard was retired on 2026-08-30 (GCP billing closed 2026-08-01; cron-job.org runs
// production), and this file DELIBERATELY OUTLIVED IT — do not delete it as GCP residue.
//
// What it does now is guard cron auth. `tests/cron-control-registry.test.ts` cross-checks every
// `route` here against `src/lib/security/access-registry.ts` and fails the PR unless each one is
// registered authMode:"cron-secret", so a cron route cannot silently lose its gate. That invariant
// is about this app's own auth and has nothing to do with which scheduler calls the routes.
// `tests/cv-intake-digest-6h.test.ts` also reads this file as a source fixture.
//
// The gcpJobName fields are historical identities, kept because the dead man's switch slugs at
// Healthchecks are named after them — renaming one orphans its check and its history.

export type CronJobKey =
  | "phoenix-background-jobs"
  | "phoenix-process-notifications"
  | "phoenix-notify-daily"
  | "phoenix-recruitment-email-intake"
  | "phoenix-inbound-intake"
  | "phoenix-recruitment-cv-digest";

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
    description: "The 06:36 morning fan-out: the Needs You digest, birthdays, contract renewals, SLA reminders, retention clean-ups and the rest. Once PHOENIX_DAILY_JOBS_SPLIT is on it runs nothing and each job runs on its own /api/cron/daily/<job>.",
    route: "/api/notifications/daily",
  },
  {
    gcpJobName: "phoenix-recruitment-email-intake",
    label: "Recruitment Email Intake",
    description:
      "Polls the configured careers@/hr@ mailboxes (INBOX and the junk/spam folder) via IMAP every 10 minutes, enqueuing each new message for the inbound-intake worker, and health-checks the sibling WhatsApp intake channel on the same tick; a clean no-op when no mailboxes are configured.",
    route: "/api/cron/recruitment-email-intake",
  },
  {
    gcpJobName: "phoenix-inbound-intake",
    label: "Inbound CV Intake Worker",
    description:
      "Drains the inbound-CV intake queue every 2 minutes: downloads WhatsApp media / re-fetches emails, runs AI extraction + candidate creation, and retries or dead-letters failures. A clean no-op when the queue is empty.",
    route: "/api/cron/inbound-intake",
  },
  {
    gcpJobName: "phoenix-recruitment-cv-digest",
    label: "CV Intake 6-Hour Digest",
    description:
      "Emails each hiring manager who had candidates pushed to them in the past 6 hours a summary of how many CVs they received and from whom, with the recipient's own manager in CC (except NSM) and omar.anwar always in CC. Silent when no manager received any.",
    route: "/api/cron/recruitment-cv-digest",
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
