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

# 🔴 EVERY APP DOWNLOAD BELOW IS BOUNDED. Railway's phoenix-headwind has NO health check (read live
# 2026-10-22: healthcheckPath null), so traffic switches to a new container the moment it starts, and
# the MDM answers nothing until this script reaches the exec at the bottom. wget's defaults are 20 tries
# and a 900 s read timeout, so a stalled CDN used to be able to hold the whole server down for hours.
# Two tries at 30 s each bounds a stalled source to minutes (the image's wget is GNU, from Ubuntu jammy);
# curl, if it is ever the one present, gets a hard 15-minute ceiling.
fetch_url() {
  # $1 the destination file, $2 the URL. Returns non-zero on any failure; every caller treats that as "retry next start".
  if command -v wget >/dev/null 2>&1; then
    wget -q -T 30 -t 2 -O "$1" "$2"
  elif command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 15 --max-time 900 -o "$1" "$2"
  else
    return 1
  fi
}
apk_size_ok() {
  # $1 the size read, $2 the exact size (empty for a floating official source), $3 the minimum size
  if [ -n "$2" ]; then [ "$1" = "$2" ]; else [ "$1" -ge "$3" ] 2>/dev/null; fi
}
provision_official_apk() {
  # $1 the file name configuration 3 serves at /files/, $2 the publisher's URL, $3 exact size or "", $4 minimum size
  pa_name="$1"; pa_url="$2"; pa_exact="$3"; pa_min="$4"
  pa_dest="$FILES_DIR/$pa_name"
  pa_have="$([ -f "$pa_dest" ] && wc -c < "$pa_dest" | tr -d ' ' || echo 0)"
  if apk_size_ok "$pa_have" "$pa_exact" "$pa_min"; then
    echo "phoenix-entrypoint(files): $pa_name already present ($pa_have bytes)"
    return 0
  fi
  echo "phoenix-entrypoint(files): $pa_name missing or wrong size ($pa_have) — fetching it from its publisher"
  pa_tmp="$FILES_DIR/.$pa_name.part"
  rm -f "$pa_tmp"
  pa_fetched=""
  fetch_url "$pa_tmp" "$pa_url" && pa_fetched="yes" || true
  pa_got="$([ -f "$pa_tmp" ] && wc -c < "$pa_tmp" | tr -d ' ' || echo 0)"
  pa_magic="$([ -f "$pa_tmp" ] && dd if="$pa_tmp" bs=2 count=1 2>/dev/null || true)"
  if [ -n "$pa_fetched" ] && apk_size_ok "$pa_got" "$pa_exact" "$pa_min" && [ "$pa_magic" = "PK" ]; then
    mv -f "$pa_tmp" "$pa_dest"
    echo "phoenix-entrypoint(files): installed $pa_name ($pa_got bytes)"
  else
    rm -f "$pa_tmp"
    echo "phoenix-entrypoint(files): could not fetch a valid $pa_name (got $pa_got bytes) — it will retry next start" >&2
  fi
  return 0
}

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
  fetch_url "$TMP" "$RUSTDESK_URL" && fetched="yes" || true
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
PHX_LAUNCHER_URL="https://github.com/it-gawish-hr/hmdm-android/releases/download/launcher-6.40-r1/${PHX_LAUNCHER_APK}"
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
  fetch_url "$PHX_TMP" "$PHX_LAUNCHER_URL" && phx_fetched="yes" || true
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

# 🔴 AND KEEP SERVING 6.39 UNTIL THE LAUNCHER'S URL HAS MOVED TO 6.40. Configuration 3 still points the
# launcher (app 46 / version 10045) at /files/hmdm-phoenix-6.39.apk, and that url is moved by hand only
# AFTER this server is up — so a redeploy that served 6.40 alone would 404 every enrolment in between.
# Drop this line in a later change, once version 10045 names 6.40. Same Phoenix key, same pinned size.
PHX_LAUNCHER_PREVIOUS_SIZE=6286121   # bytes — the signed 6.39 release asset (the same size as 6.40 by coincidence)
provision_official_apk "hmdm-phoenix-6.39.apk" \
  "https://github.com/it-gawish-hr/hmdm-android/releases/download/launcher-6.39-r1/hmdm-phoenix-6.39.apk" "$PHX_LAUNCHER_PREVIOUS_SIZE" 0

# 🔴 THE EVERYDAY APPS ARE FETCHED IN THE BACKGROUND, SO TOMCAT STARTS AT ONCE. WhatsApp, Telegram and WPS
# are about 390 MB together and no enrolment needs them (RustDesk and the launcher above stay in the
# foreground because enrolment does). The subshell keeps running after the exec below hands this process
# to Headwind; a tablet that asks before a file has landed gets a 404 and simply retries on its next sync.
(
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
  fetch_url "$WA_TMP" "$WHATSAPP_URL" && wa_fetched="yes" || true
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

# 🔴 RE-PROVISION TELEGRAM AND WPS OFFICE — the last two of configuration 3's everyday apps that a bare
# work/ leaves a 404. Measured 2026-10-22: /files/Telegram.apk and /files/wps_18.25.2_abi32_en00000.apk
# both answered 404, so neither ever reached a rep tablet. Both come straight from their publisher:
#   - Telegram from telegram.org's own direct-download link (package org.telegram.messenger.web, the
#     build Telegram publishes outside Play). It floats like WhatsApp's, so it gets a size FLOOR and the
#     zip magic, never an exact size; the version only climbs, so the agent's benign "Ignoring downgrade
#     request" is the worst a newer file can cause. 🔴 That means NO integrity pin on a FIRST install —
#     accepted on purpose, exactly as for WhatsApp: the trust is HTTPS to telegram.org itself, and every
#     later update must carry the same signing key as the installed app or Android refuses it. A sha256
#     pin would break on every Telegram release, which is the 404 this block exists to end.
#   - WPS Office from WPS's own CDN, a per-version file, so it is pinned to its exact size like RustDesk.
# Same defensive shape as every block above: temp download, checks before the move, and a failed fetch
# logs and falls through — it NEVER aborts startup, and retries on the next start.
TELEGRAM_MIN_SIZE=41943040   # 40 MiB floor — the official build measured 70,867,407 bytes on 2026-10-22
WPS_SIZE=171366058           # bytes — the exact size of WPS's own wps_18.25.2_abi32_en00000.apk
provision_official_apk "Telegram.apk" "https://telegram.org/dl/android/apk" "" "$TELEGRAM_MIN_SIZE"
provision_official_apk "wps_18.25.2_abi32_en00000.apk" \
  "https://wdl1.pcfg.cache.wpscdn.com/wpsdl/wpsoffice/download/32bit/wps_18.25.2_abi32_en00000.apk" "$WPS_SIZE" 0
) &

exec /docker-entrypoint.sh "$@"
