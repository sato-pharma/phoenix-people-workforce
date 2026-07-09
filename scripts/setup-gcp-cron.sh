#!/bin/bash

# Cloud Run Service Details
PROJECT_ID="phoenix-workforce-498619"
REGION="us-central1"
SERVICE_URL="https://phoenix-hr-897559113412.us-central1.run.app"
CRON_SECRET="${CRON_SECRET:-}" # You must provide the CRON_SECRET value via environment variable before running

if [ -z "$CRON_SECRET" ]; then
    echo "ERROR: Please edit this script and set your CRON_SECRET before running."
    exit 1
fi

echo "Setting up Google Cloud Scheduler for Phoenix Workforce..."

# 1. Daily Notifications (30 6 * * *)
gcloud scheduler jobs create http phoenix-daily-notifications \
    --schedule="30 6 * * *" \
    --uri="${SERVICE_URL}/api/notifications/daily" \
    --http-method=GET \
    --headers="Authorization=Bearer ${CRON_SECRET}" \
    --time-zone="UTC" \
    --location="${REGION}" \
    --project="${PROJECT_ID}"

# 2. Process Notifications (*/30 * * * *)
gcloud scheduler jobs create http phoenix-process-notifications \
    --schedule="*/30 * * * *" \
    --uri="${SERVICE_URL}/api/notifications/process?limit=50" \
    --http-method=GET \
    --headers="Authorization=Bearer ${CRON_SECRET}" \
    --time-zone="UTC" \
    --location="${REGION}" \
    --project="${PROJECT_ID}"

# 3. iReports360 Visits Sync (0 9,12,19 * * *)
gcloud scheduler jobs create http phoenix-ireports360-sync \
    --schedule="0 9,12,19 * * *" \
    --uri="${SERVICE_URL}/api/cron/ireports360-visits-sync" \
    --http-method=GET \
    --headers="Authorization=Bearer ${CRON_SECRET}" \
    --time-zone="UTC" \
    --location="${REGION}" \
    --project="${PROJECT_ID}"

# 4. iReports360 Visits Reconcile (0 4 * * 0)
gcloud scheduler jobs create http phoenix-ireports360-reconcile \
    --schedule="0 4 * * 0" \
    --uri="${SERVICE_URL}/api/cron/ireports360-visits-reconcile" \
    --http-method=GET \
    --headers="Authorization=Bearer ${CRON_SECRET}" \
    --time-zone="UTC" \
    --location="${REGION}" \
    --project="${PROJECT_ID}"

echo "All cron jobs successfully created!"
