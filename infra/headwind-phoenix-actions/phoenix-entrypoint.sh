#!/bin/sh
# Seed Headwind's WAR cache with the WAR that carries the Phoenix actions add-on, then hand over to
# Headwind's own entrypoint untouched.
#
# 🔴 WHY THIS RUNS AT START AND NOT AT BUILD. Headwind's entrypoint downloads the application WAR
# into $BASE_DIR/cache on first start, and $BASE_DIR is inside /usr/local/tomcat/work — which
# docker-compose.headwind.yml mounts a named volume over (`headwind-work`). Anything baked into that
# directory at image build time is therefore INVISIBLE the moment a volume exists: the entrypoint
# would find an empty cache, download a clean WAR, and the add-on would be silently absent while the
# server looked perfectly healthy. Copying here, after mounts, is the only placement that holds on
# both paths — Railway (no volume) and compose (volume).
#
# The add-on's own WAR lives in /opt/phoenix-war, which nothing mounts over.
#
# FORCE_RECONFIGURE=true still re-downloads a clean WAR over this, by Headwind's own design. That is
# the deliberate way out of the pin, and it removes the add-on until the next start.
set -eu

TOMCAT_DIR=/usr/local/tomcat

# Read BASE_DIR out of Headwind's own entrypoint rather than repeating it here, so a future image
# that moves the cache does not leave us writing confidently into the wrong folder.
RAW="$(grep -m1 '^BASE_DIR=' /docker-entrypoint.sh | cut -d= -f2-)"
BASE_DIR="$(eval printf '%s' "\"$RAW\"")"

if [ -z "$BASE_DIR" ]; then
  echo "phoenix-entrypoint: cannot resolve BASE_DIR from /docker-entrypoint.sh — refusing to guess" >&2
  exit 1
fi

WAR="$(cat /opt/phoenix-war/NAME)"

mkdir -p "$BASE_DIR/cache"
if cmp -s "/opt/phoenix-war/$WAR" "$BASE_DIR/cache/$WAR"; then
  echo "phoenix-entrypoint: $BASE_DIR/cache/$WAR already carries the add-on"
else
  cp "/opt/phoenix-war/$WAR" "$BASE_DIR/cache/$WAR"
  echo "phoenix-entrypoint: seeded $BASE_DIR/cache/$WAR with the add-on"
fi

# 🔴 FORCE THE STORED BASE URL TO HTTPS, so tablets never hit Railway's http->https redirect.
#
# Headwind stores its base URL in the DATABASE, seeded ONCE at first install from PROTOCOL://BASE_DOMAIN
# (confirmed against h-mdm/hmdm's docker-entrypoint: it seds `https://h-mdm.com` -> `$PROTOCOL://$BASE_DOMAIN`
# into the init SQL). PROTOCOL is `http` here on purpose — Railway terminates TLS at its edge and forwards
# plain http to this container, so the Tomcat connector MUST stay http; PROTOCOL=https would make Tomcat
# try to own a certificate it does not have. Every QR payload, every app-download URL (the launcher
# plugins, RustDesk) and every configuration URL is built from that one stored value, so with it left at
# http the tablet talks http, Railway answers 301, and the standard Android HTTP client turns a redirected
# POST into a bodyless GET: enrollment itself survives (Android's provisioning downloader follows the
# redirect for a GET) but the device's status report and its own app downloads silently fail. The per-row
# value cannot be rewritten through the REST API (it is recomputed from the stored base URL on read), the
# database has no public proxy, and `railway ssh`/`connect` are closed — so the one place this can be
# corrected is here, inside the container, which reaches the DB on the private network.
#
# It rewrites only the exact string `http://$BASE_DOMAIN` -> `https://$BASE_DOMAIN` across every text
# column, so it is safe (nothing else is touched) and idempotent (a no-op once none remain). It never
# aborts startup: if the database is briefly unreachable it logs and the server still boots, and the
# rewrite applies on the next start.
if [ -n "${BASE_DOMAIN:-}" ] && [ -n "${SQL_HOST:-}" ] && command -v psql >/dev/null 2>&1; then
  BASE_HTTP="http://${BASE_DOMAIN}"
  BASE_HTTPS="https://${BASE_DOMAIN}"
  PSQL="psql -h ${SQL_HOST} -p ${SQL_PORT:-5432} -U ${SQL_USER:-postgres} -d ${SQL_BASE:-hmdm} -w"
  cat > /tmp/phoenix-https.sql <<SQL
DO \$body\$
DECLARE r record; n bigint; total bigint := 0;
BEGIN
  FOR r IN SELECT table_name, column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND data_type IN ('character varying','text','character') LOOP
    EXECUTE format('UPDATE public.%I SET %I = replace(%I, %L, %L) WHERE %I LIKE %L',
      r.table_name, r.column_name, r.column_name, '${BASE_HTTP}', '${BASE_HTTPS}',
      r.column_name, '%${BASE_HTTP}%');
    GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END LOOP;
  RAISE NOTICE 'phoenix-entrypoint(https): rewrote % value(s) http->https for ${BASE_DOMAIN}', total;
END
\$body\$;
SQL
  applied=""
  i=0
  while [ "$i" -lt 12 ]; do
    if PGPASSWORD="${SQL_PASS:-}" $PSQL -tAc "SELECT 1" >/dev/null 2>&1; then
      if PGPASSWORD="${SQL_PASS:-}" $PSQL -v ON_ERROR_STOP=1 -f /tmp/phoenix-https.sql 2>&1 | sed 's/^/phoenix-entrypoint(https): /'; then
        applied="yes"
      fi
      break
    fi
    i=$((i + 1))
    sleep 5
  done
  [ -n "$applied" ] || echo "phoenix-entrypoint(https): base-url https rewrite skipped (database not reachable yet) — it applies on the next start"
  rm -f /tmp/phoenix-https.sql
fi

exec /docker-entrypoint.sh "$@"
