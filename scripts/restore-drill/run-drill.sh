#!/usr/bin/env bash
# Runs the restore drill on one backup file against a throwaway PostgreSQL server started here and removed
# afterwards. The server listens on 127.0.0.1 only, on its own port, with its data in this folder (C:).
#   run-drill.sh <checkout with infra/code-backup/restore-drill.sh> <backup file> <age key file>
set -uo pipefail
CHECKOUT="${1:?}"; FILE="${2:?}"; KEY="${3:?}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="$HERE/pgdata"
PORT=54329
stamp() { TZ=UTC date -u +%H:%M:%S; }

if [ -d "$DATA" ]; then echo "refused: $DATA already exists"; exit 2; fi
echo "server: $(postgres --version)"
initdb -D "$DATA" -U drill --auth=trust -E UTF8 --locale=C > "$HERE/initdb.log" 2>&1 || { echo "initdb failed"; tail -5 "$HERE/initdb.log"; exit 1; }
# Throwaway settings: this database is dropped in minutes, so durability is traded for speed and the memory
# it may take is kept small.
cat >> "$DATA/postgresql.conf" <<CONF
listen_addresses = '127.0.0.1'
port = $PORT
shared_buffers = ${DRILL_SHARED_MB:-256}MB
maintenance_work_mem = ${DRILL_MAINT_MB:-256}MB
max_wal_size = 4GB
fsync = off
synchronous_commit = off
full_page_writes = off
autovacuum = off
CONF
pg_ctl -D "$DATA" -l "$HERE/server.log" -w start > /dev/null 2>&1 || { echo "the server did not start"; tail -8 "$HERE/server.log"; exit 1; }
echo "server started on 127.0.0.1:$PORT at $(stamp) UTC (shared ${DRILL_SHARED_MB:-256} MB, maintenance ${DRILL_MAINT_MB:-256} MB, ${DRILL_JOBS:-2} restore worker(s))"

mkdir -p "$HERE/work"
RESTORE_DRILL_WORK="$HERE/work" RESTORE_DRILL_TARGET_URL="postgresql://drill@127.0.0.1:$PORT/postgres?sslmode=disable" \
  bash "$CHECKOUT/infra/code-backup/restore-drill.sh" --file "$FILE" --identity "$KEY" --jobs "${DRILL_JOBS:-2}"
code=$?
echo "drill exit $code at $(stamp) UTC"

pg_ctl -D "$DATA" -m fast -w stop > /dev/null 2>&1 && echo "server stopped"
rm -rf "$DATA" "$HERE/work"
echo "throwaway data removed: $([ -d "$DATA" ] && echo NO || echo yes)"
exit $code
