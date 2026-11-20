#!/bin/bash
# Runs ON THE SPARE as /usr/local/lib/phoenix-preview/run.sh, started by the systemd service phoenix-preview as the user
# phxpreview (no sudo). Source: ~/.claude/scripts/spare-preview-run.sh on the main laptop; spare-preview.ps1 installs it.
# Owner, 2026-11-20: "Set up PR preview" - he clicks through a pull request on localhost:3000 BEFORE he merges it.
#  - The unit Conflicts= phoenix-dev, so starting a preview stops the live dev server, and the unit's ExecStopPost starts
#    the live one again when the preview ends (its time limit, `spare-preview.ps1 stop`, a crash or the 04:00 timer).
#  - Unmerged code runs as phxpreview, a user with no sudo, so neither the code nor a package install script can take the
#    machine (the same rule as the old box's previews, owner 2026-10-08).
#  - It reinstalls packages only when the pull request's lockfile differs from what is installed.
set -u
APP=/home/phxpreview/app
LOG=/home/phxpreview/preview.log
cd "$APP" || exit 1
L() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }
pkg_ok() { [ -e node_modules/.bin/next ] && cmp -s pnpm-lock.yaml node_modules/.pnpm/lock.yaml; }
L "preview starting: $(head -n 1 /home/phxpreview/preview-info 2>/dev/null)"
if ! pkg_ok; then
  export CI=true
  for try in 1 2; do
    [ "$try" = 2 ] && rm -f node_modules/.pnpm-workspace-state*.json node_modules/.modules.yaml node_modules/.pnpm/lock.yaml
    L "installing packages (try $try)"
    pnpm install --frozen-lockfile --reporter=append-only >> "$LOG" 2>&1 && pkg_ok && break
    [ "$try" = 2 ] && { L 'PACKAGE INSTALL FAILED - the preview cannot start'; exit 1; }
  done
  L 'packages installed'
fi
export PHOENIX_DEV_HEAP_MB=4096 UV_THREADPOOL_SIZE=8 PHOENIX_DEV_PAGES_KEPT=6 PHOENIX_DEV_PAGE_IDLE_MINUTES=60
node scripts/dev-server.mjs --port 3000 --lean >> "$LOG" 2>&1 &
NODE=$!
trap 'kill -TERM "$NODE" 2>/dev/null; wait "$NODE"; exit 0' TERM INT
# Once it answers, compile the Command Center so the first click is not the slow one.
for _ in $(seq 1 120); do
  kill -0 "$NODE" 2>/dev/null || break
  if curl -fsS -m 10 -o /dev/null http://127.0.0.1:3000/api/healthz 2>/dev/null; then
    L 'preview answers on localhost:3000'
    jar=$(mktemp)
    curl -fsS -m 300 -c "$jar" -b "$jar" -o /dev/null 'http://127.0.0.1:3000/api/dev-auth?role=Super%20Admin&next=/api/healthz' \
      && L "warm /admin -> $(curl -sS -m 300 -b "$jar" -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/admin)"
    rm -f "$jar"
    break
  fi
  sleep 5
done
wait "$NODE"; code=$?
L "preview dev server exited (code $code)"
exit "$code"
