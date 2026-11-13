#!/usr/bin/env bash
# The nightly database backup. The whole production database goes into one encrypted file on Drive.
#
# What is in the file (README.md has the restore):
#   database.dump   pg_dump, custom format, every schema: the app's tables, the sign-in tables, the dated
#                   backup schemas. Restoring chooses what to take from it; the dump leaves nothing out.
#   manifest.tsv    schema, table, row count for every table, counted in the SAME snapshot the dump read.
#                   A restore is proven by comparing these numbers, never by "it finished".
#   roles.sql       the roles, with no passwords (the database does not let them be read).
#   cron-jobs.tsv   the database's own scheduled jobs, which a dump does not carry.
#   meta.tsv        when, which server version, how big.
#
# Any failure stops before anything is pruned, so the older backups stay, and the Phoenix route
# /api/cron/code-backup-verify raises the alarm when the newest file passes 36 hours. This job never
# reports its own success: the check reads Drive from production.
#
# It holds only the PUBLIC age key, so nothing on this service can decrypt a backup, and its database login
# (phoenix_backup_reader) can read and cannot write.
#
# 🔴 IT STEPS ASIDE. From its first count to the end of the dump it holds a read lock on every table. A
# migration that alters a table waits for that lock, and everything that reads the table then waits behind the
# migration. So a second connection looks every few seconds for anyone waiting behind this login; the moment
# one is seen twice running, the backup ends its own sessions, uploads nothing, prunes nothing and exits 75.
# run.sh tries again ten minutes later. (13 Nov 2026, 18:13 Cairo: a rehearsal without this held a migration
# for over ten seconds until it was stopped by hand.) It still runs at 02:17 Cairo, when least is waiting.
set -euo pipefail
# A write to a session that has gone must come back as an error this script can read, not end it in silence.
trap '' PIPE
shopt -s nullglob
# One byte order for every sort, so the two table lists below compare line for line.
export LC_ALL=C

: "${DB_BACKUP_DATABASE_URL:?}"
: "${CODE_BACKUP_AGE_RECIPIENT:?}"

# A login that lost its rights, or a URL pointing at the wrong database, would otherwise back up less in silence.
MIN_TABLES="${DB_BACKUP_MIN_TABLES:-500}"
KEEP_DAILY=7
KEEP_WEEKLY=4

# Where the files go. Drive unless DB_BACKUP_REMOTE names another rclone path, which the image's own test
# and a rehearsal use (a local folder). The code backup's folder is never this one.
if [ -n "${DB_BACKUP_REMOTE:-}" ]; then
  REMOTE="$DB_BACKUP_REMOTE"
else
  : "${GOOGLE_DRIVE_OAUTH_CLIENT_ID:?}"
  : "${GOOGLE_DRIVE_OAUTH_CLIENT_SECRET:?}"
  : "${GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN:?}"
  # rclone reads its Drive remote from these. drive.file sees only what this app itself created.
  export RCLONE_CONFIG_BACKUP_TYPE=drive
  export RCLONE_CONFIG_BACKUP_SCOPE=drive.file
  export RCLONE_CONFIG_BACKUP_CLIENT_ID="$GOOGLE_DRIVE_OAUTH_CLIENT_ID"
  export RCLONE_CONFIG_BACKUP_CLIENT_SECRET="$GOOGLE_DRIVE_OAUTH_CLIENT_SECRET"
  RCLONE_CONFIG_BACKUP_TOKEN="$(jq -cn --arg r "$GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN" '{access_token:"",token_type:"Bearer",refresh_token:$r,expiry:"2000-01-01T00:00:00Z"}')"
  export RCLONE_CONFIG_BACKUP_TOKEN
  # A pruned backup is really gone: the trash counts against Drive's storage and would fill it.
  export RCLONE_DRIVE_USE_TRASH=false
  REMOTE="backup:${DB_BACKUP_DRIVE_FOLDER:-phoenix-db-backup}"
fi

# The URL is taken apart into libpq's own variables, so it is never an argument: it is in no process list and
# no error line. A password with a character a URL would have to escape is refused, since nothing here unescapes.
url_pattern='^postgres(ql)?://([^:@/?]+):([^@/?%]+)@([^:/?]+)(:([0-9]+))?/([^?]+)([?](.*))?$'
if ! [[ "$DB_BACKUP_DATABASE_URL" =~ $url_pattern ]]; then
  echo "refused: DB_BACKUP_DATABASE_URL is not postgresql://user:password@host:port/database" >&2
  exit 1
fi
export PGUSER="${BASH_REMATCH[2]}"
export PGPASSWORD="${BASH_REMATCH[3]}"
export PGHOST="${BASH_REMATCH[4]}"
export PGPORT="${BASH_REMATCH[6]:-5432}"
export PGDATABASE="${BASH_REMATCH[7]}"
url_query="${BASH_REMATCH[9]:-}"
# A URL that does not say otherwise is read as requiring TLS: the database is across the internet.
export PGSSLMODE=require
if [[ "$url_query" =~ (^|&)sslmode=([a-z-]+) ]]; then export PGSSLMODE="${BASH_REMATCH[2]}"; fi
export PGCONNECT_TIMEOUT=30
export PGAPPNAME=phoenix-db-backup

# A rehearsal only: connect with one login and READ as another, to prove what the backup role may read before it
# has a password of its own. The nightly service never sets it; its URL is the backup role's own.
READ_AS="${DB_BACKUP_READ_AS_ROLE:-}"
role_args=()
if [ -n "$READ_AS" ]; then
  if ! [[ "$READ_AS" =~ ^[a-z_][a-z0-9_]*$ ]]; then
    echo "refused: DB_BACKUP_READ_AS_ROLE is not a plain role name" >&2
    exit 1
  fi
  role_args=(--role="$READ_AS")
fi

WORK="$(mktemp -d)"
SNAP_PID_KEPT=""
WATCH_PID=""
cleanup() {
  if [ -n "$WATCH_PID" ]; then kill "$WATCH_PID" 2>/dev/null || true; fi
  if [ -s "$WORK/dump.pid" ]; then kill "$(cat "$WORK/dump.pid")" 2>/dev/null || true; fi
  if [ -n "$SNAP_PID_KEPT" ]; then kill "$SNAP_PID_KEPT" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT
OUT="$WORK/backup"
mkdir -p "$OUT"

# Stepping aside. The exit code is sysexits' "temporary failure, try again": run.sh retries on it and on no other.
YIELD_EXIT=75
WATCH_EVERY="${DB_BACKUP_WATCH_SECONDS:-3}"
# Every session that waits for a lock one of this login's sessions holds. pg_blocking_pids and these columns
# need no privilege. A lock this backup itself waits for is not counted: --lock-wait-timeout answers that.
waiters_sql="select count(*) from pg_locks w where not w.granted and exists (select 1 from unnest(pg_blocking_pids(w.pid)) as b(pid) join pg_stat_activity a on a.pid = b.pid where a.usename = session_user)"

# Why the night stopped: stepped aside (try again), or refused (a fault someone must read).
give_up() {
  if [ -s "$WORK/yielded" ]; then
    echo "stepped aside: $(cat "$WORK/yielded"). Nothing was uploaded and nothing was pruned." >&2
    exit "$YIELD_EXIT"
  fi
  echo "refused: $1" >&2
  exit 1
}

step_aside() {
  printf '%s\n' "$1" > "$WORK/yielded"
  # The login's own sessions are ended ON THE SERVER, which frees every lock at once whatever the client was
  # doing. Not in a rehearsal, where the connecting login is a shared one: there only this run's own
  # processes are stopped.
  if [ -z "$READ_AS" ]; then
    PGCONNECT_TIMEOUT=10 psql -X -q -At --no-password -c "select pg_terminate_backend(pid) from pg_stat_activity where usename = session_user and pid <> pg_backend_pid()" > /dev/null 2>&1 || true
  fi
  if [ -s "$WORK/dump.pid" ]; then kill "$(cat "$WORK/dump.pid")" 2>/dev/null || true; fi
  kill "$SNAP_PID_KEPT" 2>/dev/null || true
}

# Runs beside the count and the dump, on a connection of its own each time, so a lost connection is one missed
# look and not the end of the watch. A backup that cannot see who is waiting must not go on holding its locks.
watch_for_waiters() {
  local seen=0 blind=0 waiting
  while sleep "$WATCH_EVERY"; do
    waiting="$(PGCONNECT_TIMEOUT=10 psql -X -q -At --no-password -c "$waiters_sql" 2>/dev/null || true)"
    waiting="${waiting%$'\r'}"
    if [[ "$waiting" =~ ^[0-9]+$ ]]; then blind=0; else blind=$((blind + 1)); waiting=0; fi
    if [ "$waiting" -gt 0 ]; then seen=$((seen + 1)); else seen=0; fi
    if [ "$seen" -ge 2 ]; then
      step_aside "$waiting session(s) were waiting for a table the backup was reading"
      return 0
    fi
    if [ "$blind" -ge 5 ]; then
      step_aside "the backup could not see who was waiting, five looks running"
      return 0
    fi
  done
}

# ONE snapshot for the counts and the dump. A second session holds it open; pg_dump reads through it. Counted
# in any other way, a row written between the count and the dump would make a perfect restore look wrong.
coproc SNAP { psql -X -q -At -v ON_ERROR_STOP=1 --no-password 2>"$WORK/snapshot.err"; }
SNAP_PID_KEPT="$SNAP_PID"
exec {SNAP_IN}>&"${SNAP[1]}" {SNAP_OUT}<&"${SNAP[0]}"

say() {
  if ! printf '%s\n' "$1" >&"$SNAP_IN" 2>/dev/null; then
    give_up "the snapshot session is gone. $(head -c 600 "$WORK/snapshot.err" | tr '\n' ' ')"
  fi
}
# One line back from the snapshot session, or the night stops with what the database said. It is called as
# $(answer ...), where its exit ends only that subshell, so every caller ends the night itself with `|| exit`.
answer() {
  local line
  if ! IFS= read -r -t "$1" -u "$SNAP_OUT" line; then
    give_up "the database did not answer ($2). $(head -c 600 "$WORK/snapshot.err" | tr '\n' ' ')"
  fi
  printf '%s' "${line%$'\r'}"
}

if [ -n "$READ_AS" ]; then say "set role $READ_AS;"; fi
say "set statement_timeout = 0;"
say "set idle_in_transaction_session_timeout = 0;"
say "begin transaction isolation level repeatable read read only;"
say "select pg_export_snapshot();"
snapshot="$(answer 120 "opening the snapshot")" || exit $?
if ! [[ "$snapshot" =~ ^[0-9A-Fa-f-]+$ ]]; then
  echo "refused: the database returned no snapshot" >&2
  exit 1
fi
# From here on tables are locked, so from here on someone is looking for whoever waits behind them.
watch_for_waiters &
WATCH_PID=$!

# Asked first and read into a variable: a failed answer inside a here-string would not stop the night.
say "select to_char(now() at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') || chr(9) || current_setting('server_version') || chr(9) || current_database() || chr(9) || pg_database_size(current_database()) || chr(9) || current_user;"
server_line="$(answer 120 "reading the server")" || exit $?
IFS=$'\t' read -r taken_at server_version database_name database_bytes read_as <<< "$server_line"

# Every ordinary table outside the system schemas. A table that belongs to an extension is left out: the dump
# does not carry it as a table, the extension makes it again.
say "select n.nspname || chr(9) || c.relname || chr(9) || (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'r' and c.relpersistence <> 't' and n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e') order by n.nspname, c.relname;"
say "select '--counted--';"
MANIFEST="$OUT/manifest.tsv"
: > "$MANIFEST"
counted=0
# The first line arrives only when every table has been counted, so this wait is the long one.
while IFS= read -r -t 3600 -u "$SNAP_OUT" line; do
  line="${line%$'\r'}"
  if [ "$line" = "--counted--" ]; then counted=1; break; fi
  printf '%s\n' "$line" >> "$MANIFEST"
done
if [ "$counted" -ne 1 ]; then
  give_up "the row counts did not finish. $(head -c 600 "$WORK/snapshot.err" | tr '\n' ' ')"
fi
tables="$(wc -l < "$MANIFEST" | tr -d ' ')"
rows="$(awk -F'\t' '{ n += $3 } END { printf "%d", n }' "$MANIFEST")"
echo "counted: $tables tables, $rows rows, server $server_version, read as $read_as"
if [ "$tables" -lt "$MIN_TABLES" ]; then
  echo "refused: the login sees $tables tables, fewer than the $MIN_TABLES expected" >&2
  exit 1
fi

# The scheduled jobs live in an extension's table, which no dump carries. A database without pg_cron has none.
say "select coalesce(to_regclass('cron.job')::text, '');"
has_jobs="$(answer 120 "looking for scheduled jobs")" || exit $?
if [ -n "$has_jobs" ]; then
  say "select jobname || chr(9) || schedule || chr(9) || active || chr(9) || replace(replace(command, chr(10), ' '), chr(9), ' ') from cron.job order by 1;"
  say "select '--jobs--';"
  while IFS= read -r -t 300 -u "$SNAP_OUT" line; do
    line="${line%$'\r'}"
    [ "$line" = "--jobs--" ] && break
    printf '%s\n' "$line" >> "$OUT/cron-jobs.tsv"
  done
fi
touch "$OUT/cron-jobs.tsv"

# A lock it cannot get inside a minute means a migration holds a table: stop, and let the next night try.
# It runs beside this script, not in front of it, so the watch can stop it the moment someone waits.
pg_dump --format=custom --snapshot="$snapshot" --lock-wait-timeout=60000 --no-password "${role_args[@]}" --file "$OUT/database.dump" &
echo "$!" > "$WORK/dump.pid"
if ! wait "$!"; then give_up "pg_dump stopped before the end"; fi
rm -f "$WORK/dump.pid"
pg_dumpall --database="$PGDATABASE" --roles-only --no-role-passwords --no-password "${role_args[@]}" --file "$OUT/roles.sql" || give_up "the roles could not be read"

# The dump is whole and nothing more is read, so the watch ends first, then the session that held the
# snapshot and its locks. A watch that stepped aside in the last second still ends the attempt: its sessions are gone.
kill "$WATCH_PID" 2>/dev/null || true
wait "$WATCH_PID" 2>/dev/null || true
WATCH_PID=""
if [ -s "$WORK/yielded" ]; then give_up ""; fi
say "commit;"
say '\q'
wait "$SNAP_PID_KEPT" 2>/dev/null || true
SNAP_PID_KEPT=""

# Every counted table must be in the dump's own table of contents, or the two do not describe one database.
pg_restore --list "$OUT/database.dump" > "$WORK/toc.txt"
# A line reads "id; n oid TABLE DATA schema name owner". The name is everything between the schema and the
# owner, because a table name may hold a space.
awk '$4 == "TABLE" && $5 == "DATA" { name = $7; for (i = 8; i < NF; i++) name = name " " $i; print $6 "\t" name }' "$WORK/toc.txt" | sort > "$WORK/dumped.txt"
cut -f1,2 "$MANIFEST" | sort > "$WORK/counted.txt"
missing="$(comm -23 "$WORK/counted.txt" "$WORK/dumped.txt" | wc -l | tr -d ' ')"
if [ "$missing" -ne 0 ]; then
  echo "refused: $missing counted table(s) are not in the dump, first: $(comm -23 "$WORK/counted.txt" "$WORK/dumped.txt" | head -3 | tr '\t\n' '. ')" >&2
  exit 1
fi
dump_bytes="$(stat -c %s "$OUT/database.dump")"
printf 'taken_at\t%s\nserver_version\t%s\ndatabase\t%s\ndatabase_bytes\t%s\ntables\t%s\nrows\t%s\ndump_bytes\t%s\nread_as\t%s\npg_dump\t%s\n' \
  "$taken_at" "$server_version" "$database_name" "$database_bytes" "$tables" "$rows" "$dump_bytes" "$read_as" "$(pg_dump --version)" > "$OUT/meta.tsv"
echo "dumped: $tables tables, dump bytes=$dump_bytes"

DATE="$(date -u +%F)"
FILE="db-backup-$DATE.tar.age"
TARGET="$REMOTE/daily/$FILE"
rclone mkdir "$REMOTE/daily"
tar -C "$OUT" -cf - . | age -r "$CODE_BACKUP_AGE_RECIPIENT" | rclone rcat --drive-chunk-size 64M "$TARGET"
size="$(rclone lsf --format s "$TARGET")"
# The encrypted file is the dump plus a little: one that reads smaller than the dump did not arrive whole.
if ! [ "${size:-0}" -gt "$dump_bytes" ]; then
  echo "refused: the uploaded file reads as ${size:-0} bytes where the dump alone is $dump_bytes" >&2
  exit 1
fi
echo "uploaded: $FILE bytes=$size"

# Everything above succeeded, so only now is anything old removed.
if [ "$(date -u +%u)" = "7" ]; then
  rclone copyto "$TARGET" "$REMOTE/weekly/$FILE"
fi
prune() {
  rclone lsf --files-only "$REMOTE/$1" | sort -r | tail -n +"$(($2 + 1))" | while IFS= read -r old; do
    rclone deletefile "$REMOTE/$1/$old"
    echo "pruned: $1/$old"
  done
}
# Listing a folder that does not exist fails, and weekly/ has none until the first Sunday.
rclone mkdir "$REMOTE/weekly"
prune daily "$KEEP_DAILY"
prune weekly "$KEEP_WEEKLY"
echo "done"
