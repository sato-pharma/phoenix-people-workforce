#!/usr/bin/env bash
# The restore drill: prove that a database backup can be restored, and say how long it took.
#
# It decrypts one backup file, restores it into a NEW database it creates on a server you name, counts every
# table, and compares each count with the number the backup recorded when it was made (manifest.tsv, counted
# in the dump's own snapshot). It passes only when every table is there with exactly that many rows. Then it
# drops the database it created. It never touches a database that already exists.
#
#   RESTORE_DRILL_TARGET_URL=postgresql://user[:password]@host:port/postgres \
#     restore-drill.sh --file db-backup-YYYY-MM-DD.tar.age --identity age-key.txt
#   ... restore-drill.sh --dir <a folder already decrypted>      (no key needed)
#   --keep   leave the restored database in place        --jobs N   parallel restore workers (default 2)
#
# 🔴 The target is a THROWAWAY server: a local PostgreSQL, or one started for the drill. Never production,
# which is refused by name, and not staging either: the restored copy is as large as production, and staging's
# disk would have to grow to hold it. The private key is read by `age` from the file you name and is never
# printed. This script is not in the nightly image: the service that makes the backups can read none of them.
#
# A server without Supabase's own extensions (pg_cron, the vault) reports those as restore errors. They are
# counted and shown, and they hold no table the manifest lists, so they do not fail the drill. A table that is
# missing or short does.
set -euo pipefail
export LC_ALL=C

PRODUCTION_REF="ozucdzovmcqvepbozvqf"

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

file=""
identity=""
dir=""
keep=0
jobs=2
while [ $# -gt 0 ]; do
  case "$1" in
    --file) file="${2:-}"; shift 2 ;;
    --identity) identity="${2:-}"; shift 2 ;;
    --dir) dir="${2:-}"; shift 2 ;;
    --jobs) jobs="${2:-}"; shift 2 ;;
    --keep) keep=1; shift ;;
    *) usage ;;
  esac
done
: "${RESTORE_DRILL_TARGET_URL:?}"
if [ -z "$file" ] && [ -z "$dir" ]; then usage; fi
if [ -n "$file" ] && [ -z "$identity" ]; then
  echo "refused: --file needs --identity, the age key file that decrypts it" >&2
  exit 2
fi

if [[ "$RESTORE_DRILL_TARGET_URL" == *"$PRODUCTION_REF"* ]]; then
  echo "refused: the target names the production database. A drill never runs there." >&2
  exit 2
fi
# Taken apart into libpq's own variables, as db-backup.sh does, so the URL is never an argument.
url_pattern='^postgres(ql)?://([^:@/?]+)(:([^@/?%]*))?@([^:/?]+)(:([0-9]+))?/([^?]+)([?](.*))?$'
if ! [[ "$RESTORE_DRILL_TARGET_URL" =~ $url_pattern ]]; then
  echo "refused: RESTORE_DRILL_TARGET_URL is not postgresql://user[:password]@host:port/database" >&2
  exit 2
fi
export PGUSER="${BASH_REMATCH[2]}"
if [ -n "${BASH_REMATCH[4]:-}" ]; then export PGPASSWORD="${BASH_REMATCH[4]}"; fi
export PGHOST="${BASH_REMATCH[5]}"
export PGPORT="${BASH_REMATCH[7]:-5432}"
MAINTENANCE_DB="${BASH_REMATCH[8]}"
url_query="${BASH_REMATCH[10]:-}"
if [[ "$url_query" =~ (^|&)sslmode=([a-z-]+) ]]; then export PGSSLMODE="${BASH_REMATCH[2]}"; fi
export PGCONNECT_TIMEOUT=30
export PGAPPNAME=phoenix-restore-drill

WORK="$(mktemp -d "${RESTORE_DRILL_WORK:-${TMPDIR:-/tmp}}/restore-drill.XXXXXX")"
SCRATCH=""
cleanup() {
  if [ -n "$SCRATCH" ] && [ "$keep" -eq 0 ]; then
    PGDATABASE="$MAINTENANCE_DB" psql -X -q -c "drop database if exists \"$SCRATCH\" with (force)" > /dev/null 2>&1 || echo "warning: could not drop $SCRATCH; drop it by hand" >&2
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

seconds_since() { echo $(( $(date +%s) - $1 )); }
clock() { printf '%d min %02d s' $(( $1 / 60 )) $(( $1 % 60 )); }

decrypt_seconds=0
if [ -n "$file" ]; then
  started="$(date +%s)"
  dir="$WORK/backup"
  mkdir -p "$dir"
  age -d -i "$identity" "$file" | tar -xf - -C "$dir"
  decrypt_seconds="$(seconds_since "$started")"
fi
for needed in database.dump manifest.tsv roles.sql; do
  if [ ! -s "$dir/$needed" ]; then
    echo "refused: $needed is missing or empty in the backup" >&2
    exit 1
  fi
done
expected_tables="$(wc -l < "$dir/manifest.tsv" | tr -d ' ')"
expected_rows="$(awk -F'\t' '{ n += $3 } END { printf "%d", n }' "$dir/manifest.tsv")"
taken_at="$(awk -F'\t' '$1 == "taken_at" { print $2 }' "$dir/meta.tsv" 2>/dev/null || true)"
echo "backup: taken ${taken_at:-unknown}, $expected_tables tables, $expected_rows rows, dump $(stat -c %s "$dir/database.dump") bytes"

me="$(PGDATABASE="$MAINTENANCE_DB" psql -X -q -At -c "select current_user")"
me="${me%$'\r'}"
SCRATCH="restore_drill_$(date -u +%Y%m%d_%H%M%S)"
PGDATABASE="$MAINTENANCE_DB" psql -X -q -v ON_ERROR_STOP=1 -c "create database \"$SCRATCH\""
export PGDATABASE="$SCRATCH"

# The roles first, so a policy or a grant that names one can be made. The drill's own login is left out: the
# file would otherwise rewrite the attributes of the user doing the restore. A role that already exists is
# reported by the server and is not a failure.
grep -v -E "^(CREATE|ALTER) ROLE \"?${me}\"?( |;)" "$dir/roles.sql" > "$WORK/roles.sql" || true
psql -X -q -f "$WORK/roles.sql" > /dev/null 2> "$WORK/roles.err" || true

started="$(date +%s)"
# pg_restore ends non-zero when it skipped anything, which a server without Supabase's extensions always
# makes it do. The verdict below is the row counts, so its exit code is recorded, not obeyed.
pg_restore --no-owner --jobs "$jobs" --dbname "$SCRATCH" "$dir/database.dump" > /dev/null 2> "$WORK/restore.err" || true
restore_seconds="$(seconds_since "$started")"
restore_errors="$(grep -c -E '^pg_restore: error:' "$WORK/restore.err" || true)"

started="$(date +%s)"
{
  echo "set row_security = off;"
  echo "create temp table drill_expected (nspname text, relname text, expected bigint);"
  echo "\\copy drill_expected from stdin"
  cat "$dir/manifest.tsv"
  echo "\\."
  echo "select 'MISMATCH' || chr(9) || nspname || '.' || relname || chr(9) || expected || chr(9) || coalesce(actual::text, 'missing') from (select e.*, case when to_regclass(format('%I.%I', nspname, relname)) is null then null else (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', nspname, relname), false, true, '')))[1]::text::bigint end as actual from drill_expected e) t where actual is distinct from expected order by 1;"
  echo "select 'SIZE' || chr(9) || pg_database_size(current_database());"
} | psql -X -q -At -v ON_ERROR_STOP=1 > "$WORK/compare.txt"
count_seconds="$(seconds_since "$started")"
sed -i 's/\r$//' "$WORK/compare.txt"
mismatches="$(grep -c '^MISMATCH' "$WORK/compare.txt" || true)"
restored_bytes="$(awk -F'\t' '$1 == "SIZE" { print $2 }' "$WORK/compare.txt")"

echo "restore: $(clock "$restore_seconds") with $jobs workers, restored size ${restored_bytes:-unknown} bytes, $restore_errors object(s) the server refused"
if [ "$restore_errors" -gt 0 ]; then
  grep -E '^pg_restore: error:' "$WORK/restore.err" | sed -E 's/^pg_restore: error: //' | cut -c1-160 | sort | uniq -c | sort -rn | head -8 | sed 's/^/  refused: /'
fi
echo "timings: decrypt $(clock "$decrypt_seconds"), restore $(clock "$restore_seconds"), count $(clock "$count_seconds")"
if [ "$mismatches" -ne 0 ]; then
  echo "DRILL FAILED: $mismatches of $expected_tables tables are missing or hold a different number of rows (table, counted at backup, restored):"
  grep '^MISMATCH' "$WORK/compare.txt" | cut -f2- | head -20 | sed 's/^/  /'
  exit 1
fi
echo "DRILL PASSED: $expected_tables of $expected_tables tables restored with exactly the rows counted at backup ($expected_rows rows), in $(clock $(( decrypt_seconds + restore_seconds + count_seconds )))"
