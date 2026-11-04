#!/usr/bin/env bash
# /opt/phx-live/live-fast.sh — phx-live's PRODUCTION-BUILD mode, the default since 2026-10-16.
#
# WHY. In dev mode (`next dev`) phx-live measured 15 s for a first page and then 2.5-3 MINUTES per page
# and API call, with requests failing 500 — `next dev` on this app wants about 7 GB and this box has
# 7.7 GB in all, so the server sat at its 5 GB cap with its 2 GB of swap full and was stalled waiting
# for memory 75-83% of the time (/proc/pressure/memory, 2026-10-16 03:45 Cairo). The owner chose this
# mode over resizing the box: pages run a built app, as fast as the real site; a saved edit appears
# after a rebuild (minutes), not in seconds. `phx-live -Dev` still gives the old dev server, which is
# what /admin/dev-preview and -DevAuth role sweeps need.
#
# Runs AS phxlive inside phx-preview-3100.scope (live-ctl.sh serve <devauth> fast). Its stdout is
# /home/phx/live.log. It:
#   1. builds /home/phxlive/live — the tree phx-live-sync.mjs keeps identical to the laptop folder;
#   2. copies the result into /home/phxlive/serve and runs `next start` there, so the NEXT build never
#      pulls the floor out from under the server that is answering the browser;
#   3. watches the tree: a change -> 3 quiet seconds -> build again while the old build keeps serving
#      -> swap (a few seconds without a server) -> serve the new one. A FAILED build keeps the old one
#      serving, prints why, and the next save tries again.
# State for `live-ctl.sh status`: /home/phxlive/live-state/fast-state (building|serving|failed|...).
set -u
SRC=/home/phxlive/live
SERVE=/home/phxlive/serve
STATE=/home/phxlive/live-state
PORT=3100
STAMP="$STATE/fast-last-build-start"
QUIET="$STATE/fast-quiet"
BUILD_LOG="$STATE/fast-build.log"
mkdir -p "$STATE" "$SERVE"
export NEXT_TELEMETRY_DISABLED=1 PHX_LIVE=1

say() { echo "[$(TZ=Africa/Cairo date '+%H:%M:%S') Cairo] phx-live: $*"; }
state() { echo "$*" > "$STATE/fast-state"; }

# Anything under the tree newer than $1, other than what a build writes itself. `next build` rewrites
# next-env.d.ts, so watching it would rebuild forever.
changed_since() {
  [ -n "$(find "$SRC" -mindepth 1 \( -name node_modules -o -name .next -o -name .git \) -prune \
      -o ! -name next-env.d.ts ! -name '*.tsbuildinfo' -newer "$1" -print -quit 2>/dev/null)" ]
}

SERVER_PID=""
start_server() {
  ( cd "$SERVE" && exec node node_modules/next/dist/bin/next start --port "$PORT" --hostname 127.0.0.1 ) &
  SERVER_PID=$!
  local i
  # A built server loads all ~1,150 route entries before it answers (preloadEntriesOnStart is on in
  # production), so give it up to three minutes.
  for i in $(seq 1 180); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/api/healthz")" = 200 ]; then
      return 0
    fi
    kill -0 "$SERVER_PID" 2>/dev/null || { SERVER_PID=""; return 1; }
    sleep 1
  done
  stop_server
  return 1
}
stop_server() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
    SERVER_PID=""
  fi
}

# serve/ = the source tree WITHOUT node_modules, .next and .git, a link to the built tree's
# node_modules, and a copy of the fresh .next. `next start` reads only .next, public, next.config.ts
# and package.json from it; the rest is copied so next.config.ts can import what it imports.
swap_in() {
  rsync -a --delete --exclude=/node_modules --exclude=/.next --exclude=/.git --exclude=/xlsx --exclude=/mobile \
    "$SRC/" "$SERVE/"
  ln -sfn "$SRC/node_modules" "$SERVE/node_modules"
  stop_server
  rsync -a --delete --exclude=/cache --exclude=/dev --exclude=/standalone "$SRC/.next/" "$SERVE/.next/"
  start_server
}

build() {
  touch "$STAMP"
  state building
  say "building ($(git -C "$SRC" rev-parse --short HEAD 2>/dev/null) + your unpushed edits) — about 3 minutes; the page you have open keeps working"
  local t0=$SECONDS
  if ( cd "$SRC" && exec node node_modules/next/dist/bin/next build ) > "$BUILD_LOG" 2>&1; then
    say "built in $((SECONDS - t0)) s — swapping it in"
    return 0
  fi
  state failed
  say "BUILD FAILED after $((SECONDS - t0)) s — the previous build keeps serving. Last lines:"
  grep -vE '^\s*$' "$BUILD_LOG" | tail -30
  return 1
}

cycle() {
  if build; then
    if swap_in; then
      state serving
      date +%s > "$STATE/fast-served-at"
      say "SERVING the new build — reload the page"
    else
      state failed
      say "the new build would not start — last server lines above; trying again on the next save"
    fi
  elif [ -z "$SERVER_PID" ] && [ -f "$SERVE/.next/BUILD_ID" ]; then
    # Nothing is serving yet (a fresh start whose first build failed) but an older build exists.
    start_server && state "serving-old" && say "serving the PREVIOUS build until a build succeeds"
  fi
}

trap 'stop_server; exit 0' TERM INT

say "production-build mode on 127.0.0.1:$PORT"
# Serve the last good build at once, if there is one, so a restart is not three minutes of nothing.
if [ -f "$SERVE/.next/BUILD_ID" ]; then
  start_server && state "serving-old" && say "serving the previous build while the first build of this session runs"
fi
cycle

LAST_BEAT=0
while :; do
  if changed_since "$STAMP"; then
    # Wait for the save to finish arriving: 3 seconds with nothing new.
    while :; do
      touch "$QUIET"
      sleep 3
      changed_since "$QUIET" || break
    done
    cycle
  fi
  # A built server logs nothing per request, and the box's idle reaper stops a server whose log has
  # been quiet for 60 minutes. While a browser is connected, say so every 10 minutes.
  if [ $((SECONDS - LAST_BEAT)) -ge 600 ] && [ "$(ss -tnH state established "( sport = :$PORT )" 2>/dev/null | wc -l)" -gt 0 ]; then
    say "in use"
    LAST_BEAT=$SECONDS
  fi
  if [ -n "$SERVER_PID" ] && ! kill -0 "$SERVER_PID" 2>/dev/null; then
    say "the server stopped by itself — starting it again"
    SERVER_PID=""
    start_server || say "it would not start"
  fi
  sleep 2
done
