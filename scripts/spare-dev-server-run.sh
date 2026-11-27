#!/bin/bash
# Runs ON THE SPARE (Ubuntu since 20 Nov 2026) as ~/phoenix/dev-server-run.sh, started by the systemd service phoenix-dev
# (source: ~/.claude/scripts/spare-dev-server-run.sh on the main laptop; spare-follow-production.ps1 keeps the copy current).
# Port of the Windows spare-dev-server-run.ps1 (owner, 2026-11-20: "I want the dev server to be super fast"):
#  - starts the dev server, and once it answers WARMS it: signs in through dev-auth and opens each page in
#    ~/phoenix/warm-routes.txt so webpack compiles them before anyone visits. Results: ~/phoenix/warm.log
#  - the warm-up is skipped under 1 GB available (a warm-up then is what runs the spare out of memory);
#  - it re-warms whenever /api/healthz startedAt changes (Next restarted its server in place after a memory restart);
#  - when the dev server dies this script exits with its code and systemd starts it again (Restart=always, backing off
#    to 10 minutes after repeated deaths). A deliberate stop is `sudo systemctl stop phoenix-dev`.
#  - priority (Nice=-5), 8 libuv threads and 4 GB heap come from here and the unit.
set -u
REPO="$HOME/phoenix/phoenix-workforce"
WARM_LOG="$HOME/phoenix/warm.log"
ROUTES="$HOME/phoenix/warm-routes.txt"
cd "$REPO" || exit 1
export PHOENIX_DEV_HEAP_MB=4096 UV_THREADPOOL_SIZE=8 PHOENIX_DEV_PAGES_KEPT=10 PHOENIX_DEV_PAGE_IDLE_MINUTES=60
# 10 kept pages (owner, 2026-11-23: "Do 12, 13 and 14"): the warm list grew from 6 to 10 with his own 4 most-opened admin pages.
W() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$WARM_LOG"; }
free_mb() { awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo; }
started_at() { curl -fsS -m 15 http://127.0.0.1:3000/api/healthz 2>/dev/null | sed -n 's/.*"startedAt":"\([^"]*\)".*/\1/p'; }
[ -f "$ROUTES" ] || printf '%s\n' /admin /employee-360 /organogram /admin/people-management /admin/approvals-hub > "$ROUTES"

urlenc() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }

warm() {
  local why="$1" free; free=$(free_mb)
  if [ "$free" -lt 1024 ]; then W "warm ($why): skipped, only $free MB available (a warm-up now would run the spare out of memory)"; return; fi
  local all_start=$SECONDS jars; jars=$(mktemp -d)
  # A line is "/path" (warmed as Super Admin) or "/path | <role> | <hrId>" (warmed signed in as that person,
  # owner 2026-11-20: "Warm his pages"). One dev-auth sign-in per person, reused for all his lines.
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"; [ -z "${line// }" ] && continue; [ "${line:0:1}" = "#" ] && continue
    kill -0 "$NODE" 2>/dev/null || break
    if [ "$(free_mb)" -lt 1024 ]; then W "warm ($why): stopped part-way, under 1 GB available"; break; fi
    IFS='|' read -r path role hr <<< "$line"
    path="$(echo "$path" | xargs)"; role="$(echo "${role:-}" | xargs)"; hr="$(echo "${hr:-}" | xargs)"
    [ -z "$role" ] && role='Super Admin'
    local jar="$jars/$(printf '%s|%s' "$role" "$hr" | md5sum | cut -c1-12)"
    if [ ! -f "$jar" ]; then
      local q="role=$(urlenc "$role")"; [ -n "$hr" ] && q="$q&hrId=$(urlenc "$hr")"
      curl -fsS -m 300 -c "$jar" -b "$jar" -o /dev/null "http://127.0.0.1:3000/api/dev-auth?$q&next=/api/healthz" || W "warm: dev-auth sign-in as $role|$hr failed"
      touch "$jar"
    fi
    local t0=$SECONDS code
    code=$(curl -sS -m 300 -b "$jar" -o /dev/null -w '%{http_code}' "http://127.0.0.1:3000$path" 2>&1) || code="failed ($code)"
    W "warm $path${hr:+ as $hr} -> $code in $((SECONDS - t0)) s"
  done < "$ROUTES"
  rm -rf "$jars"
  W "warm ($why): all pages compiled in $((SECONDS - all_start)) s, $(free_mb) MB available"
}

node scripts/dev-server.mjs --port 3000 --lean >> "$HOME/phoenix/dev-server.log" 2>&1 &
NODE=$!
trap 'kill -TERM "$NODE" 2>/dev/null; wait "$NODE"; exit 0' TERM INT
up=0
for _ in $(seq 1 120); do   # up to 10 minutes for the first answer
  kill -0 "$NODE" 2>/dev/null || break
  if curl -fsS -m 10 -o /dev/null http://127.0.0.1:3000/api/healthz 2>/dev/null; then up=1; break; fi
  sleep 5
done
last=""; last_rewarm=-10000   # a second in-place restart within 30 minutes of a re-warm is NOT re-warmed: a warm list too big for the heap must never loop
if [ "$up" = 1 ]; then last=$(started_at); warm start
elif kill -0 "$NODE" 2>/dev/null; then W 'warm: the dev server never answered, nothing warmed'; fi
# Watch it: re-warm after an in-place memory restart, notice a death.
while kill -0 "$NODE" 2>/dev/null; do
  sleep 60 & wait $!
  kill -0 "$NODE" 2>/dev/null || break
  now=$(started_at)
  if [ -n "$now" ] && [ -n "$last" ] && [ "$now" != "$last" ] && [ $((SECONDS - last_rewarm)) -lt 1800 ]; then W "the server restarted in place AGAIN within 30 minutes (startedAt $last -> $now); NOT warming, so a warm-up can never loop"; last=$now
  elif [ -n "$now" ] && [ -n "$last" ] && [ "$now" != "$last" ]; then W "the server restarted in place (startedAt $last -> $now); warming again"; last=$now; last_rewarm=$SECONDS; warm 'after a memory restart'
  elif [ -n "$now" ] && [ -z "$last" ]; then last=$now; fi
done
wait "$NODE"; code=$?
W "the dev server exited (code $code, $(free_mb) MB available); systemd starts it again"
exit "$code"
