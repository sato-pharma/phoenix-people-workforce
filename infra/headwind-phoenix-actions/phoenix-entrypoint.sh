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

# 🔴 RE-PROVISION THE ONE CONSOLE-ADDED APP HEADWIND DOES NOT RE-FETCH: RustDesk.
#
# Headwind serves /files/<name> from $BASE_DIR/files, which lives under /usr/local/tomcat/work — the
# same ephemeral tree as the WAR cache above. On Railway there is no volume, so EVERY redeploy starts
# with an empty work/ and the files directory is recreated bare. Headwind's own entrypoint repopulates
# it for the apps that are in the install-time seed — its launcher and plugins: it greps init.sql for
# the h-mdm.com download URLs and re-downloads each into $BASE_DIR/files if missing (confirmed against
# h-mdm/hmdm's docker-entrypoint, `cd $BASE_DIR/files; for FILE in $FILES_TO_DOWNLOAD`). RustDesk was
# added later, through the console, so it is NOT in that seed and is NOT re-fetched. That is exactly
# why the https redeploy left the device record pointing at /files/rustdesk-1.4.9-aarch64-signed.apk
# (urlArm64, still correct in the database) while the file itself was gone — a 404 the tablet cannot
# install from — even though the small plugins survived.
#
# The fix is to do for RustDesk what Headwind already does for its own files: ensure the APK is in
# $BASE_DIR/files on every start, fetching it from RustDesk's official release if missing. The device
# record's urlArm64 already names this exact file, so nothing in the database changes and no console
# step is needed. It downloads to a temp name and only moves the finished file into place once its
# size and zip magic check out, so a partial download never shadows a good file; and it never aborts
# startup — a failed fetch logs and the server still boots, and it retries on the next start.
RUSTDESK_APK="rustdesk-1.4.9-aarch64-signed.apk"
RUSTDESK_URL="https://github.com/rustdesk/rustdesk/releases/download/1.4.9/${RUSTDESK_APK}"
RUSTDESK_SIZE=26871021   # bytes — the exact size of RustDesk's immutable 1.4.9 aarch64-signed asset
FILES_DIR="$BASE_DIR/files"
DEST="$FILES_DIR/$RUSTDESK_APK"
mkdir -p "$FILES_DIR"
have_size="$([ -f "$DEST" ] && wc -c < "$DEST" | tr -d ' ' || echo 0)"
if [ "$have_size" = "$RUSTDESK_SIZE" ]; then
  echo "phoenix-entrypoint(files): $RUSTDESK_APK already present ($have_size bytes)"
else
  echo "phoenix-entrypoint(files): $RUSTDESK_APK missing or wrong size ($have_size) — fetching from RustDesk"
  TMP="$FILES_DIR/.$RUSTDESK_APK.part"
  rm -f "$TMP"
  fetched=""
  if command -v wget >/dev/null 2>&1; then
    wget -q -O "$TMP" "$RUSTDESK_URL" && fetched="yes" || true
  elif command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$TMP" "$RUSTDESK_URL" && fetched="yes" || true
  fi
  got_size="$([ -f "$TMP" ] && wc -c < "$TMP" | tr -d ' ' || echo 0)"
  magic="$([ -f "$TMP" ] && dd if="$TMP" bs=2 count=1 2>/dev/null || true)"
  if [ -n "$fetched" ] && [ "$got_size" = "$RUSTDESK_SIZE" ] && [ "$magic" = "PK" ]; then
    mv -f "$TMP" "$DEST"
    echo "phoenix-entrypoint(files): installed $RUSTDESK_APK ($got_size bytes)"
  else
    rm -f "$TMP"
    echo "phoenix-entrypoint(files): could not fetch a valid $RUSTDESK_APK (got $got_size bytes) — it will retry next start" >&2
  fi
fi

# 🔴 RE-PROVISION THE PHOENIX CUSTOM LAUNCHER — same reason as RustDesk above.
#
# The rep tablets enrol onto a CUSTOM build of the Headwind launcher (a clean status bar that hides
# Android's forced "managed"/"location" notices while keeping the clock, battery and wifi, and a hidden
# app-drawer icon) rather than the stock 6.37. Like RustDesk it is NOT in Headwind's install-time seed,
# so Headwind's own entrypoint never re-fetches it and a bare Railway work/ would leave it a 404 the
# enrolling tablet cannot download its device-owner launcher from. It is served under its OWN filename;
# the launcher application's version url (app 46 / version 10045) is pointed at THIS file in the database
# once, out of band — nothing here touches the database. Same defensive shape as RustDesk: temp download,
# size + zip-magic check before it is moved into place, and it NEVER aborts startup — a failed fetch logs
# and the server still boots, so a bad release can never take the whole MDM down. The release asset is
# immutable, so its byte size is pinned and a wrong size is refused.
PHX_LAUNCHER_APK="hmdm-phoenix-6.40.apk"
PHX_LAUNCHER_URL="https://github.com/Gawish-1997/hmdm-android/releases/download/launcher-6.40-r1/${PHX_LAUNCHER_APK}"
PHX_LAUNCHER_SIZE=6286121   # bytes — the exact size of the signed Phoenix launcher release asset
PHX_DEST="$FILES_DIR/$PHX_LAUNCHER_APK"
have_launcher="$([ -f "$PHX_DEST" ] && wc -c < "$PHX_DEST" | tr -d ' ' || echo 0)"
if [ "$have_launcher" = "$PHX_LAUNCHER_SIZE" ]; then
  echo "phoenix-entrypoint(files): $PHX_LAUNCHER_APK already present ($have_launcher bytes)"
else
  echo "phoenix-entrypoint(files): $PHX_LAUNCHER_APK missing or wrong size ($have_launcher) — fetching from the fork release"
  PHX_TMP="$FILES_DIR/.$PHX_LAUNCHER_APK.part"
  rm -f "$PHX_TMP"
  phx_fetched=""
  if command -v wget >/dev/null 2>&1; then
    wget -q -O "$PHX_TMP" "$PHX_LAUNCHER_URL" && phx_fetched="yes" || true
  elif command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$PHX_TMP" "$PHX_LAUNCHER_URL" && phx_fetched="yes" || true
  fi
  phx_got="$([ -f "$PHX_TMP" ] && wc -c < "$PHX_TMP" | tr -d ' ' || echo 0)"
  phx_magic="$([ -f "$PHX_TMP" ] && dd if="$PHX_TMP" bs=2 count=1 2>/dev/null || true)"
  if [ -n "$phx_fetched" ] && [ "$phx_got" = "$PHX_LAUNCHER_SIZE" ] && [ "$phx_magic" = "PK" ]; then
    mv -f "$PHX_TMP" "$PHX_DEST"
    echo "phoenix-entrypoint(files): installed $PHX_LAUNCHER_APK ($phx_got bytes)"
  else
    rm -f "$PHX_TMP"
    echo "phoenix-entrypoint(files): could not fetch a valid $PHX_LAUNCHER_APK (got $phx_got bytes) — it will retry next start" >&2
  fi
fi

# 🔴 RE-PROVISION WHATSAPP — same wiped-on-restart problem as RustDesk and the launcher above, but
# sourced DIFFERENTLY and on purpose.
#
# WhatsApp is one of the rep tablets' everyday apps (configuration 3, served at /files/WhatsApp.apk,
# and the device record's url already names that path). It was added through the console, so Headwind's
# own entrypoint never re-fetches it, and a bare Railway work/ leaves it a 404 — which is exactly what
# the enrolled rep tablet hit for a week: "Failed to download app com.whatsapp: Bad server response",
# retried every hour, WhatsApp never installed.
#
# 🔴 UNLIKE RustDesk and the launcher, this is NOT an immutable pinned asset. WhatsApp ships no stable
# per-version download — its only official direct APK is the ever-current build at whatsapp.com, which
# changes (and its byte size with it) every few weeks. So this block deliberately fetches the OFFICIAL
# current WhatsApp over TLS and verifies a sane MINIMUM size + the zip magic, rather than an exact size.
# Each redeploy therefore lands the then-current official build; because WhatsApp's version only ever
# climbs, the agent reads an installed version at or above configuration 3's and leaves it in place
# (the same benign "Ignoring downgrade request" the launcher already logs) — so nothing loops and the
# Headwind record needs no change. We never re-host WhatsApp's binary ourselves; it comes straight from
# WhatsApp. Same defensive shape otherwise: temp download, checks before the move, and it NEVER aborts
# startup — a failed or blocked fetch logs and the server still boots, and it retries on the next start.
WHATSAPP_APK="WhatsApp.apk"
WHATSAPP_URL="https://www.whatsapp.com/android/current/WhatsApp.apk"
WHATSAPP_MIN_SIZE=83886080   # 80 MiB floor — the universal APK is ~150 MB; a floating official source gets a minimum + zip-magic check, not an exact size
WA_DEST="$FILES_DIR/$WHATSAPP_APK"
have_wa="$([ -f "$WA_DEST" ] && wc -c < "$WA_DEST" | tr -d ' ' || echo 0)"
if [ "$have_wa" -ge "$WHATSAPP_MIN_SIZE" ] 2>/dev/null; then
  echo "phoenix-entrypoint(files): $WHATSAPP_APK already present ($have_wa bytes)"
else
  echo "phoenix-entrypoint(files): $WHATSAPP_APK missing or too small ($have_wa) — fetching the official current WhatsApp"
  WA_TMP="$FILES_DIR/.$WHATSAPP_APK.part"
  rm -f "$WA_TMP"
  wa_fetched=""
  if command -v wget >/dev/null 2>&1; then
    wget -q -O "$WA_TMP" "$WHATSAPP_URL" && wa_fetched="yes" || true
  elif command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$WA_TMP" "$WHATSAPP_URL" && wa_fetched="yes" || true
  fi
  wa_got="$([ -f "$WA_TMP" ] && wc -c < "$WA_TMP" | tr -d ' ' || echo 0)"
  wa_magic="$([ -f "$WA_TMP" ] && dd if="$WA_TMP" bs=2 count=1 2>/dev/null || true)"
  if [ -n "$wa_fetched" ] && [ "$wa_got" -ge "$WHATSAPP_MIN_SIZE" ] 2>/dev/null && [ "$wa_magic" = "PK" ]; then
    mv -f "$WA_TMP" "$WA_DEST"
    echo "phoenix-entrypoint(files): installed $WHATSAPP_APK ($wa_got bytes)"
  else
    rm -f "$WA_TMP"
    echo "phoenix-entrypoint(files): could not fetch a valid $WHATSAPP_APK (got $wa_got bytes) — it will retry next start" >&2
  fi
fi

exec /docker-entrypoint.sh "$@"
