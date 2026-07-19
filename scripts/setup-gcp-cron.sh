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

# 1. Daily Notifications (6:36 Cairo — off :30 to avoid the */5 drain's minute)
gcloud scheduler jobs create http phoenix-notify-daily \
    --schedule="36 6 * * *" \
    --uri="${SERVICE_URL}/api/notifications/daily" \
    --http-method=GET \
    --headers="Authorization=Bearer ${CRON_SECRET}" \
    --time-zone="Africa/Cairo" \
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
    --location="${SCHEDULER_LOCATION}" \
    --project="${PROJECT_ID}"

# 3. Background jobs (every 10 min at :03,:13,... — never on a */5 minute)
gcloud scheduler jobs create http phoenix-background-jobs \
    --schedule="3-59/10 * * * *" \
    --uri="${SERVICE_URL}/api/cron/background-jobs?limit=3" \
    --http-method=GET \
    --headers="Authorization=Bearer ${CRON_SECRET}" \
    --time-zone="Africa/Cairo" \
    --location="${SCHEDULER_LOCATION}" \
    --project="${PROJECT_ID}"

# 4. iReports360 Visits Sync (9:07/12:07/19:07 Cairo — minute 7 avoids every other job)
gcloud scheduler jobs create http phoenix-ireports360-sync \
    --schedule="7 9,12,19 * * *" \
    --uri="${SERVICE_URL}/api/cron/ireports360-visits-sync" \
    --http-method=GET \
    --headers="Authorization=Bearer ${CRON_SECRET}" \
    --time-zone="Africa/Cairo" \
    --location="${SCHEDULER_LOCATION}" \
    --project="${PROJECT_ID}"

# 5. iReports360 Visits Reconcile (Sunday 4:24 Cairo)
gcloud scheduler jobs create http phoenix-reconcile-visits \
    --schedule="24 4 * * 0" \
    --uri="${SERVICE_URL}/api/cron/ireports360-visits-reconcile" \
    --http-method=GET \
    --headers="Authorization=Bearer ${CRON_SECRET}" \
    --time-zone="Africa/Cairo" \
    --location="${SCHEDULER_LOCATION}" \
    --project="${PROJECT_ID}"

echo "All cron jobs successfully created!"
