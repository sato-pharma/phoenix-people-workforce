#!/bin/bash

# Bootstrap script for the production Cloud Scheduler jobs. Kept in sync with the
# LIVE jobs (names, schedules, timezone) — last aligned 2026-07-17 after the
# region cutover to europe-west3:
#  - URIs use the public domain (follows DNS through any future region move;
#    the app authenticates crons via the Bearer CRON_SECRET header, not OIDC,
#    so the URL host carries no auth meaning).
#  - Scheduler job LOCATION stays us-central1: jobs only fire HTTP requests, the
#    location is where the job definition lives, and moving it would mean
#    delete+recreate for zero benefit.
#  - Schedules are deliberately de-collided (no two jobs share a firing minute;
#    the notifications drain at */5 owns :00,:05,...) — see the 2026-07-17 perf
#    audit: stacked crons at :00 saturated the single serving instance.
#
# The in-app Cron Control dashboard (/admin/cron-control) can view/pause/resume/run/reschedule
# these same jobs live, but does NOT update this script — if you edit a schedule there, update
# the --schedule=/--time-zone= flags below by hand, or a future re-run of this script will
# silently revert the change.
PROJECT_ID="phoenix-workforce-498619"
SCHEDULER_LOCATION="us-central1"
SERVICE_URL="https://phoenix-hr.satopharma.com"
CRON_SECRET="${CRON_SECRET:-}" # You must provide the CRON_SECRET value via environment variable before running

if [ -z "$CRON_SECRET" ]; then
    echo "ERROR: Please set CRON_SECRET in the environment before running."
    exit 1
fi

echo "Setting up Google Cloud Scheduler for Phoenix Workforce..."

# ATTEMPT-DEADLINE NOTE (added 2026-07-25; +inbound-intake 2026-07-27): the 300s-route jobs below
# (including phoenix-inbound-intake) hit routes declaring
# `export const maxDuration = 300` (their real ceiling is Cloud Run's own service
# request-timeoutSeconds, also 300s — confirmed live). Left unset, gcloud/the Scheduler API
# default attemptDeadline to 180s for an HTTP target — nobody chose that value, it was simply
# never overridden, and it undercuts the 300s a run is allowed to take. Once Scheduler's 180s
# deadline passes it CANCELS ITS OWN WAIT and marks the attempt FAILED, even though the Cloud
# Run request keeps executing to real completion — so a perfectly healthy 200-280s run shows as
# a Scheduler-side failure for no reason. This project's jobs have retryCount unset (=0, the
# documented gcloud default — verified via `gcloud scheduler jobs update http --help`), so a
# "failed" attempt is NOT retried; the false-failure is pure noise, not a duplicate-run risk —
# but it is exactly the kind of noise that would drown out a real failure once truthful
# reporting (see the same PR's fix to app/api/notifications/daily/route.ts) starts alerting on
# job status. --attempt-deadline=330s gives Cloud Run's own 300s timeout room to resolve first
# and report its real outcome, well under the Scheduler HTTP-target ceiling of 30 minutes.
# The 2 jobs further down (live-sync, recruitment-email-intake) hit 120s-max routes, so the
# 180s default already covers them — left alone deliberately, not overlooked.

# 1. Daily Notifications (6:36 Cairo — off :30 to avoid the */5 drain's minute)
gcloud scheduler jobs create http phoenix-notify-daily \
    --schedule="36 6 * * *" \
    --uri="${SERVICE_URL}/api/notifications/daily" \
    --http-method=GET \
    --headers="Authorization=Bearer ${CRON_SECRET}" \
    --time-zone="Africa/Cairo" \
    --attempt-deadline="330s" \
    --location="${SCHEDULER_LOCATION}" \
    --project="${PROJECT_ID}"

# 2. Process Notifications (*/5) — drains the email/notification outbox + retries.
# Every 5 min so a failed/deferred email is retried quickly; also doubles as the
# keep-warm heartbeat for the serving instance.
gcloud scheduler jobs create http phoenix-process-notifications \
    --schedule="*/5 * * * *" \
    --uri="${SERVICE_URL}/api/notifications/process?limit=50" \
    --http-method=GET \
    --headers="Authorization=Bearer ${CRON_SECRET}" \
    --time-zone="Africa/Cairo" \
    --attempt-deadline="330s" \
    --location="${SCHEDULER_LOCATION}" \
    --project="${PROJECT_ID}"

# 3. Background jobs (weekly, Friday 03:00 Cairo — quiet slot; drains up to 10 queued
# admin-requested exports per run and sends a Super-Admin Telegram recap of the run)
gcloud scheduler jobs create http phoenix-background-jobs \
    --schedule="0 3 * * 5" \
    --uri="${SERVICE_URL}/api/cron/background-jobs?limit=10" \
    --http-method=GET \
    --headers="Authorization=Bearer ${CRON_SECRET}" \
    --time-zone="Africa/Cairo" \
    --attempt-deadline="330s" \
    --location="${SCHEDULER_LOCATION}" \
    --project="${PROJECT_ID}"

# 4-6. The three iReports360 jobs (rolling sync, weekly reconcile, live morning sync) were retired
# with the vendor on 6 November 2026; their routes are deleted.

# 7. Recruitment Inbound-CV Poll (every 10 min, :04/:14/.../:54 Cairo — minute offset 4 avoids
# every other job). Polls the configured careers@/hr@ mailboxes (RECRUITMENT_EMAIL_INBOXES_JSON),
# INBOX and the junk/spam folder, for candidate CVs via IMAP; a clean no-op if that env var is
# unset. Added 2026-07-24.
# Since 2026-07-27 it also health-checks the sibling WhatsApp channel on the same tick. WhatsApp
# has no cron of its own — its webhook only runs when Meta calls it — so when Meta blocked API
# access on 2026-07-26 the channel went dead with zero signal for ~19 hours. Piggybacking here
# buys 10-minute detection without an eighth scheduler job. The job NAME stays
# ...-email-intake because renaming a Cloud Scheduler job means delete + recreate.
gcloud scheduler jobs create http phoenix-recruitment-email-intake \
    --schedule="4-59/10 * * * *" \
    --uri="${SERVICE_URL}/api/cron/recruitment-email-intake" \
    --http-method=GET \
    --headers="Authorization=Bearer ${CRON_SECRET}" \
    --time-zone="Africa/Cairo" \
    --location="${SCHEDULER_LOCATION}" \
    --project="${PROJECT_ID}"

# 8. Inbound CV Intake Worker (every 2 min). Drains ats_inbound_intake_queue — the WhatsApp webhook
# and the email poll only enqueue; this does the media download + AI + candidate creation with
# retries/dead-letter. Frequent so a queued CV becomes a candidate within ~2 minutes. Clean no-op
# when the queue is empty. Added 2026-07-27.
gcloud scheduler jobs create http phoenix-inbound-intake \
    --schedule="*/2 * * * *" \
    --uri="${SERVICE_URL}/api/cron/inbound-intake" \
    --http-method=GET \
    --headers="Authorization=Bearer ${CRON_SECRET}" \
    --attempt-deadline="330s" \
    --time-zone="Africa/Cairo" \
    --location="${SCHEDULER_LOCATION}" \
    --project="${PROJECT_ID}"

echo "All cron jobs successfully created!"
