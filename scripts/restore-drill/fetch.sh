#!/usr/bin/env bash
# Fetches one night's database backup file from Drive into this folder. Run through `railway run`, which
# supplies the backup service's own Drive variables; nothing here prints one.
#   railway run -s phoenix-code-backup -e production bash fetch.sh db-backup-YYYY-MM-DD.tar.age
set -euo pipefail
FILE="${1:?the file name}"
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${GOOGLE_DRIVE_OAUTH_CLIENT_ID:?}" "${GOOGLE_DRIVE_OAUTH_CLIENT_SECRET:?}" "${GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN:?}"
export RCLONE_CONFIG_BACKUP_TYPE=drive
export RCLONE_CONFIG_BACKUP_SCOPE=drive.file
export RCLONE_CONFIG_BACKUP_CLIENT_ID="$GOOGLE_DRIVE_OAUTH_CLIENT_ID"
export RCLONE_CONFIG_BACKUP_CLIENT_SECRET="$GOOGLE_DRIVE_OAUTH_CLIENT_SECRET"
RCLONE_CONFIG_BACKUP_TOKEN="$(jq -cn --arg r "$GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN" '{access_token:"",token_type:"Bearer",refresh_token:$r,expiry:"2000-01-01T00:00:00Z"}')"
export RCLONE_CONFIG_BACKUP_TOKEN
# The token rclone refreshes is kept in memory only. rclone keeps its config in memory when the config file is
# named `notfound`; any other missing path is CREATED, holding the refreshed Drive token (found 13 Nov 2026).
export RCLONE_CONFIG=notfound
REMOTE="backup:${DB_BACKUP_DRIVE_FOLDER:-phoenix-db-backup}/daily"
echo "on Drive:"
rclone lsl "$REMOTE" 2>/dev/null | sed 's/^/  /'
started="$(date +%s)"
rclone copy "$REMOTE/$FILE" "$HERE" 2>/dev/null
echo "fetched: $FILE bytes=$(stat -c %s "$HERE/$FILE") in $(( $(date +%s) - started )) s"
