#!/usr/bin/env bash
# One restore drill on one night's database backup, start to finish (owner, 13 Nov 2026: "run the restore
# drill on tonight's scheduled backup after 02:17").
#
#   bash tonight.sh 2026-11-14          (the date in the backup file's name)
#
# What it does: checks this laptop has the memory and disk for it, fetches db-backup-<date>.tar.age from
# Drive (with the backup service's own Drive variables, through `railway run`; none is printed), restores it
# into a throwaway PostgreSQL started here on 127.0.0.1:54329, compares every table's row count with the
# number the backup recorded, stops the server and removes its data. Everything it prints is also kept in
# drill-<date>.log beside this file.
#
# It reads Drive and writes nothing there. It never connects to production or staging. The private key is
# read by `age` from its file and is never printed.
#
# Exit: 0 passed · 1 the drill failed · 3 not enough memory or disk, nothing started · 4 the backup file is
# not on Drive · 5 something this script needs is missing.
set -uo pipefail
DAY="${1:?the date in the backup file name, YYYY-MM-DD}"
HERE="$(cd "$(dirname "$0")" && pwd)"
FILE="db-backup-$DAY.tar.age"
KEY="/c/Users/satoh/.secrets/code-backup/code-backup-age-key.txt"
REPO="/f/Phoenix Workforce/phoenix-workforce"   # the folder the railway CLI is linked in
LOG="$HERE/drill-$DAY.log"
# The file made by hand on 13 Nov 2026 was 331,201,672 bytes. A nightly file under half of that is suspect.
FLOOR_BYTES=165600836
# 3000 is for the normal drill (2 restore workers). A lean drill (DRILL_JOBS=1 DRILL_SHARED_MB=128
# DRILL_MAINT_MB=64, read by run-drill.sh) takes about a third of the memory and may pass a lower line here.
NEED_RAM_MB="${NEED_RAM_MB:-3000}"
NEED_DISK_KB=$((4 * 1024 * 1024))

main() {
  echo "restore drill for $FILE, started $(date -u +%Y-%m-%dT%H:%M:%SZ) (UTC; Cairo is two hours later)"

  for tool in initdb pg_ctl postgres pg_restore psql age rclone jq railway; do
    command -v "$tool" > /dev/null 2>&1 || { echo "MISSING: $tool is not on PATH"; return 5; }
  done
  [ -f "$KEY" ] || { echo "MISSING: the key file $KEY"; return 5; }
  [ -f "$HERE/checkout/infra/code-backup/restore-drill.sh" ] || { echo "MISSING: restore-drill.sh"; return 5; }

  free_mb="$(powershell -NoProfile -c "[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024)" | tr -d '\r')"
  free_kb="$(df -k "$HERE" | awk 'NR==2 { print $4 }')"
  echo "free memory: ${free_mb} MB (needs $NEED_RAM_MB) · free disk here: $((free_kb / 1024 / 1024)) GB (needs 4)"
  if [ "${free_mb:-0}" -lt "$NEED_RAM_MB" ]; then echo "NOT STARTED: too little free memory"; return 3; fi
  if [ "${free_kb:-0}" -lt "$NEED_DISK_KB" ]; then echo "NOT STARTED: too little free disk"; return 3; fi
  if [ -d "$HERE/pgdata" ]; then echo "NOT STARTED: $HERE/pgdata is left from an earlier run; look at it first"; return 5; fi

  if [ -f "$HERE/$FILE" ]; then
    echo "already fetched: $FILE"
  else
    ( cd "$REPO" && timeout 1500 railway run -s phoenix-code-backup -e production bash "$HERE/fetch.sh" "$FILE" ) || true
  fi
  if [ ! -f "$HERE/$FILE" ]; then
    echo "NOT ON DRIVE: $FILE was not fetched. The list above (if any) is what Drive holds."
    return 4
  fi
  bytes="$(stat -c %s "$HERE/$FILE")"
  echo "file: $FILE, $bytes bytes ($((bytes / 1000000)) MB). The 13 Nov file was 331 MB."
  if [ "$bytes" -lt "$FLOOR_BYTES" ]; then
    echo "WARNING: under half of the 13 Nov file. The drill still runs; its count is the answer."
  fi

  bash "$HERE/run-drill.sh" "$HERE/checkout" "$HERE/$FILE" "$KEY"
  code=$?
  echo "leftovers: pgdata $([ -d "$HERE/pgdata" ] && echo STILL THERE || echo removed) · server on 54329 $(pg_ctl -D "$HERE/pgdata" status > /dev/null 2>&1 && echo STILL RUNNING || echo stopped)"
  if [ "$code" -eq 0 ]; then echo "RESULT: PASSED"; return 0; fi
  echo "RESULT: FAILED (exit $code)"
  return 1
}

main 2>&1 | tee "$LOG"
code="${PIPESTATUS[0]}"
echo "finished $(date -u +%Y-%m-%dT%H:%M:%SZ) with exit $code; the log is $LOG"
exit "$code"
