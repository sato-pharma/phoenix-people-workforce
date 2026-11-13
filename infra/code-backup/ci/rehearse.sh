#!/usr/bin/env bash
# The backup image, rehearsed end to end on a throwaway PostgreSQL 17 that this script starts and removes.
# .github/workflows/backup-image.yml runs it on every pull request that touches infra/code-backup/, because
# nothing else runs these scripts before Railway does, on the live service, at night.
#
# It needs Docker and nothing else, and it touches no real database, no Drive and no real key: the "Drive" is
# a folder, the age key is made here and thrown away, and the reader's password exists only in the container.
#
# What it proves, in the real image:
#   the migration creates a login that reads every table (row security included) and can write nothing;
#   a night's backup is counted, dumped, encrypted, uploaded, read back, and only then prunes;
#   the restore drill passes on that file, and fails on a changed count, a missing table and a wrong key;
#   the drill refuses production by name;
#   a database with too few tables is refused, and that failed night prunes nothing;
#   the backup STEPS ASIDE within seconds when a migration waits for a table, and uploads nothing;
#   the night runs the database backup although the code backup failed, and retries only a step-aside.
set -euo pipefail
cd "$(dirname "$0")/../../.."

IMAGE=phoenix-backup-check
PG=phoenix-backup-rehearsal-pg
YIELD=phoenix-backup-rehearsal-yield
PORT=55432
ADMIN_PASS=rehearsal-admin
READER_PASS=rehearsal-reader
MIGRATION="$(ls supabase/migrations/*_phoenix_backup_reader_role.sql)"
WORK="$(mktemp -d)"
chmod 755 "$WORK"

inside() { docker run --rm --network host -v "$WORK:/work" "$IMAGE" bash -c "$1"; }
cleanup() {
  docker rm -f "$PG" "$YIELD" > /dev/null 2>&1 || true
  docker run --rm -v "$WORK:/work" "$IMAGE" bash -c 'rm -rf /work/* /work/.[!.]*' > /dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "FAILED: $1" >&2
  if [ -s "$WORK/last.log" ]; then sed 's/^/  | /' "$WORK/last.log" >&2; fi
  exit 1
}
# expect <exit code, or "nonzero"> <what it proves> <command...>; the output is kept in last.log.
expect() {
  local wanted="$1" label="$2" code=0
  shift 2
  "$@" > "$WORK/last.log" 2>&1 || code=$?
  if [ "$wanted" = "nonzero" ]; then
    [ "$code" -ne 0 ] || fail "$label: it succeeded"
  elif [ "$code" -ne "$wanted" ]; then
    fail "$label: exit $code, wanted $wanted"
  fi
  echo "ok: $label (exit $code)"
}
said() { grep -q -- "$1" "$WORK/last.log" || fail "the output does not say: $1"; }

sql() { docker exec -i -e PGPASSWORD="$ADMIN_PASS" "$PG" psql -h 127.0.0.1 -U postgres -X -q -At -v ON_ERROR_STOP=1 "$@"; }
reader() { docker exec -i -e PGPASSWORD="$READER_PASS" "$PG" psql -h 127.0.0.1 -U phoenix_backup_reader -d app -X -q -At -v ON_ERROR_STOP=1 "$@"; }
READER_URL="postgresql://phoenix_backup_reader:$READER_PASS@127.0.0.1:$PORT/app?sslmode=disable"
ADMIN_URL="postgresql://postgres:$ADMIN_PASS@127.0.0.1:$PORT/postgres?sslmode=disable"
backup() {
  docker run --rm --network host -v "$WORK:/work" -e DB_BACKUP_DATABASE_URL="$READER_URL" -e DB_BACKUP_MIN_TABLES="${MIN_TABLES:-5}" \
    -e CODE_BACKUP_AGE_RECIPIENT="$RECIPIENT" -e DB_BACKUP_REMOTE=/work/remote "$IMAGE" /usr/local/bin/db-backup
}
# The drill script is NOT in the image, so it is handed in for the rehearsal alone.
drill() {
  docker run --rm --network host -v "$WORK:/work" -v "$PWD/infra/code-backup/restore-drill.sh:/restore-drill.sh:ro" \
    -e RESTORE_DRILL_TARGET_URL="${DRILL_TARGET:-$ADMIN_URL}" "$IMAGE" bash /restore-drill.sh "$@"
}
daily() { find "$WORK/remote/daily" -type f | wc -l | tr -d ' '; }

echo "--- the image"
docker build --quiet -t "$IMAGE" infra/code-backup > /dev/null
if docker run --rm "$IMAGE" bash -c 'ls /usr/local/bin | grep -q restore-drill'; then fail "the script that decrypts is in the image that makes the backups"; fi
docker run --rm "$IMAGE" pg_dump --version

echo "--- a throwaway PostgreSQL 17"
docker run -d --name "$PG" -e POSTGRES_PASSWORD="$ADMIN_PASS" -p "127.0.0.1:$PORT:5432" postgres:17 -c fsync=off -c full_page_writes=off > /dev/null
for _ in $(seq 1 60); do
  if docker exec "$PG" pg_isready -h 127.0.0.1 -U postgres > /dev/null 2>&1; then break; fi
  sleep 1
done
sql -c "create database app"
# Twice: the migration must be safe to apply again.
sql -d app < "$MIGRATION"
sql -d app < "$MIGRATION"
[ "$(sql -c "select rolcanlogin::int || '/' || rolbypassrls::int || '/' || rolsuper::int || '/' || rolcreaterole::int || '/' || rolconnlimit from pg_roles where rolname = 'phoenix_backup_reader'")" = "0/1/0/0/4" ] \
  || fail "the migration's role is not: no login, bypasses row security, no administrative right, four connections"
echo "ok: the migration makes the role with no login and no administrative right, and applies twice"
# The login is set by hand on production; here it is this rehearsal's own.
sql -c "alter role phoenix_backup_reader login password '$READER_PASS'"
sql -d app <<'SQL'
create schema ledger;
create table public.people (id int primary key, name text not null);
insert into public.people select g, 'person ' || g from generate_series(1, 1200) g;
create table public."Sheet One" (id int primary key, note text);
insert into public."Sheet One" select g, 'row ' || g from generate_series(1, 7) g;
create table ledger.entries (id bigint primary key, amount numeric(12, 2) not null);
insert into ledger.entries select g, g * 1.5 from generate_series(1, 5000) g;
create table public.guarded (id int primary key, secret text);
insert into public.guarded select g, 'hidden ' || g from generate_series(1, 40) g;
alter table public.guarded enable row level security;
alter table public.guarded force row level security;
create table public.empty_one (id int primary key);
create view public.people_names as select name from public.people;
SQL

echo "--- the login reads everything and writes nothing"
[ "$(reader -c "select count(*) from public.guarded")" = "40" ] || fail "row security hid rows from the backup login"
expect nonzero "an insert is refused" reader -c "insert into public.people values (99999, 'x')"
expect nonzero "an insert is refused in a transaction it declared read-write" reader -c "begin read write" -c "insert into public.people values (99999, 'x')" -c "commit"
said "permission denied"
expect nonzero "a delete is refused" reader -c "set default_transaction_read_only = off" -c "delete from ledger.entries"
said "permission denied"
expect nonzero "a new table is refused" reader -c "set default_transaction_read_only = off" -c "create table public.mine (id int)"
[ "$(sql -d app -c "select count(*) from public.people")" = "1200" ] || fail "a row changed"

echo "--- a night's backup"
docker run --rm -v "$WORK:/work" "$IMAGE" bash -c 'age-keygen -o /work/key.txt 2> /dev/null && age-keygen -o /work/other-key.txt 2> /dev/null && chmod 644 /work/key.txt /work/other-key.txt'
RECIPIENT="$(grep -o 'age1[a-z0-9]*' "$WORK/key.txt" | head -1)"
mkdir -p "$WORK/remote/daily"
# Eight older nights, so pruning has something to do: seven are kept, counting tonight's.
for day in 01 02 03 04 05 06 07 08; do echo "an older night" > "$WORK/remote/daily/db-backup-2020-01-$day.tar.age"; done
expect 0 "the backup runs" backup
said "counted: 5 tables, 6247 rows"
said "pruned: daily/db-backup-2020-01-01.tar.age"
said "pruned: daily/db-backup-2020-01-02.tar.age"
[ "$(daily)" = "7" ] || fail "seven daily files should remain, found $(daily)"
FILE="$(find "$WORK/remote/daily" -name "db-backup-$(date -u +%F).tar.age")"
[ -s "$FILE" ] || fail "tonight's file is not there"
if grep -q -a "person 1199" "$FILE"; then fail "the uploaded file is readable without the key"; fi
IN_FILE="/work/remote/daily/$(basename "$FILE")"

echo "--- the restore drill"
expect 0 "the drill passes on tonight's file" drill --file "$IN_FILE" --identity /work/key.txt
said "DRILL PASSED: 5 of 5 tables restored with exactly the rows counted at backup (6247 rows)"
[ "$(sql -c "select count(*) from pg_database where datname like 'restore_drill_%'")" = "0" ] || fail "the drill left its database behind"
expect nonzero "the wrong key opens nothing" drill --file "$IN_FILE" --identity /work/other-key.txt
if grep -q "DRILL PASSED" "$WORK/last.log"; then fail "the drill passed with the wrong key"; fi
inside "mkdir -p /work/plain && age -d -i /work/key.txt '$IN_FILE' | tar -xf - -C /work/plain && cp /work/plain/manifest.tsv /work/manifest.good"
expect 0 "the drill passes on a folder already decrypted" drill --dir /work/plain
inside "awk -F'\t' -v OFS='\t' '\$2 == \"people\" { \$3 = \$3 + 1 } { print }' /work/manifest.good > /work/plain/manifest.tsv"
expect 1 "a table one row short of its count fails the drill" drill --dir /work/plain
said "DRILL FAILED: 1 of 5 tables"
inside "cp /work/manifest.good /work/plain/manifest.tsv && printf 'public\tghost\t3\n' >> /work/plain/manifest.tsv"
expect 1 "a table the dump does not hold fails the drill" drill --dir /work/plain
said "missing"
PRODUCTION_REF="$(sed -n 's/^PRODUCTION_REF="\(.*\)"$/\1/p' infra/code-backup/restore-drill.sh)"
[ -n "$PRODUCTION_REF" ] || fail "the drill no longer names production"
DRILL_TARGET="postgresql://postgres.$PRODUCTION_REF:x@127.0.0.1:$PORT/postgres" expect 2 "production is refused as a drill target" drill --dir /work/plain
said "refused: the target names the production database"
[ "$(sql -c "select count(*) from pg_database where datname like 'restore_drill_%'")" = "0" ] || fail "a failed drill left its database behind"

echo "--- a night that must be refused prunes nothing"
echo "an older night" > "$WORK/remote/daily/db-backup-2020-01-09.tar.age"
BEFORE="$(sha256sum "$FILE" | cut -d' ' -f1)"
MIN_TABLES=500 expect 1 "a database with too few tables is refused" backup
said "refused: the login sees 5 tables, fewer than the 500 expected"
[ "$(daily)" = "8" ] || fail "a refused night pruned: $(daily) daily files, wanted 8"
[ "$(sha256sum "$FILE" | cut -d' ' -f1)" = "$BEFORE" ] || fail "a refused night replaced the good file"

echo "--- the backup steps aside for a waiting migration"
sql -d app -c "create table public.big as select g as id, md5(g::text) as a, md5((g * 7)::text) as b from generate_series(1, 6000000) g"
docker run -d --name "$YIELD" --network host -v "$WORK:/work" -e DB_BACKUP_DATABASE_URL="$READER_URL" -e DB_BACKUP_MIN_TABLES=5 \
  -e CODE_BACKUP_AGE_RECIPIENT="$RECIPIENT" -e DB_BACKUP_REMOTE=/work/remote -e DB_BACKUP_WATCH_SECONDS=1 "$IMAGE" /usr/local/bin/db-backup > /dev/null
held=0
for _ in $(seq 1 600); do
  held="$(sql -d app -c "select count(*) from pg_locks l join pg_stat_activity a on a.pid = l.pid where l.relation = 'public.big'::regclass and l.granted and a.usename = 'phoenix_backup_reader' and a.query like 'COPY public.big %'")"
  if [ "$held" != "0" ]; then break; fi
  sleep 0.1
done
[ "$held" != "0" ] || { docker logs "$YIELD" > "$WORK/last.log" 2>&1; fail "the dump never reached the big table"; }
asked="$(date +%s)"
# What a migration does: it asks for the table outright. Without the watch it would wait for the whole dump.
sql -d app -c "begin" -c "set local lock_timeout = '90s'" -c "lock table public.big in access exclusive mode" -c "commit"
waited=$(( $(date +%s) - asked ))
code="$(docker wait "$YIELD")"
docker logs "$YIELD" > "$WORK/last.log" 2>&1
[ "$code" = "75" ] || fail "the backup did not step aside: exit $code, wanted 75"
said "stepped aside: "
said "Nothing was uploaded and nothing was pruned."
[ "$waited" -le 15 ] || fail "the migration waited $waited seconds behind the backup"
[ "$(daily)" = "8" ] || fail "a backup that stepped aside pruned: $(daily) daily files, wanted 8"
[ "$(sha256sum "$FILE" | cut -d' ' -f1)" = "$BEFORE" ] || fail "a backup that stepped aside replaced the good file"
[ "$(sql -c "select count(*) from pg_stat_activity where usename = 'phoenix_backup_reader'")" = "0" ] || fail "the backup left a session holding its locks"
echo "ok: the backup stepped aside (exit 75); the migration waited $waited s; nothing uploaded, nothing pruned, no session left"
docker rm -f "$YIELD" > /dev/null

echo "--- the night: both backups, and a retry only after a step-aside"
mkdir -p "$WORK/stub"
printf '#!/usr/bin/env bash\necho "stub: the code backup fails"\nexit 1\n' > "$WORK/stub/code-fails"
printf '#!/usr/bin/env bash\necho "stub: the code backup is fine"\n' > "$WORK/stub/code-ok"
printf '#!/usr/bin/env bash\nn="$(cat /work/stub/tries 2> /dev/null || echo 0)"\nn=$((n + 1))\necho "$n" > /work/stub/tries\nif [ "$n" -ge 3 ]; then exit 0; fi\nexit 75\n' > "$WORK/stub/db-third-time"
printf '#!/usr/bin/env bash\nn="$(cat /work/stub/tries 2> /dev/null || echo 0)"\necho "$((n + 1))" > /work/stub/tries\nexit 75\n' > "$WORK/stub/db-always-aside"
printf '#!/usr/bin/env bash\nn="$(cat /work/stub/tries 2> /dev/null || echo 0)"\necho "$((n + 1))" > /work/stub/tries\nexit 1\n' > "$WORK/stub/db-fault"
chmod 755 "$WORK"/stub/*
# The image's own start command, with the two backups replaced by stand-ins.
night() {
  inside "rm -f /work/stub/tries"
  docker run --rm -v "$WORK:/work" -v "$WORK/stub/$1:/usr/local/bin/code-backup:ro" -v "$WORK/stub/$2:/usr/local/bin/db-backup:ro" \
    -e DB_BACKUP_RETRY_WAIT_SECONDS=1 "$IMAGE"
}
tries() { cat "$WORK/stub/tries"; }
expect 1 "a failed code backup turns the night red" night code-fails db-third-time
[ "$(tries)" = "3" ] || fail "after a failed code backup the database backup ran $(tries) time(s), wanted 3"
echo "ok: the database backup still ran, and was tried again after each step-aside"
expect 0 "a step-aside twice, then a good run, is a good night" night code-ok db-third-time
expect 1 "three step-asides end the night red" night code-ok db-always-aside
[ "$(tries)" = "3" ] || fail "a backup that always steps aside was tried $(tries) time(s), wanted 3"
expect 1 "a fault ends the night red" night code-ok db-fault
[ "$(tries)" = "1" ] || fail "a fault was retried: $(tries) tries, wanted 1"
echo "ok: a fault is not retried"

echo "REHEARSAL PASSED"
