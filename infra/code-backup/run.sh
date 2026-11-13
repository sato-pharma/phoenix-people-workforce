#!/usr/bin/env bash
# The night's two backups, one after the other: the code, then the database.
#
# Each is its own script with its own Drive folder and its own pruning, so one failing never stops the other
# and never removes the other's files. The code backup runs first because it was here first and must not
# start waiting on a database. The run ends red if either failed, and each has its own alarm on Phoenix.
#
# This script must not stop at the first failure: a failed code backup would then skip the database backup.
set -uo pipefail

failed=0
if ! /usr/local/bin/code-backup; then
  echo "FAILED: the code backup" >&2
  failed=1
fi

# The database backup steps aside (exit 75) when a migration needs a table it is reading, so that nothing
# waits behind a backup. It is then tried again after a wait, three times in all. Any other failure is a
# fault someone must read, and is not retried.
STEPPED_ASIDE=75
tries=3
wait_seconds="${DB_BACKUP_RETRY_WAIT_SECONDS:-600}"
attempt=1
while :; do
  /usr/local/bin/db-backup
  code=$?
  if [ "$code" -eq 0 ]; then break; fi
  if [ "$code" -ne "$STEPPED_ASIDE" ] || [ "$attempt" -ge "$tries" ]; then
    echo "FAILED: the database backup (exit $code, attempt $attempt of $tries)" >&2
    failed=1
    break
  fi
  attempt=$((attempt + 1))
  echo "the database backup stepped aside; attempt $attempt of $tries starts in $wait_seconds seconds" >&2
  sleep "$wait_seconds"
done
exit "$failed"
