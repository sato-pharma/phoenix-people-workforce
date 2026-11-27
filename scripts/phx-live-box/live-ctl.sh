#!/usr/bin/env bash
# /home/phx/live-ctl.sh — the box side of the laptop's `phx-live` (~/.claude/scripts/phx-live.ps1).
#
#   prepare <sha>          put /home/phxlive/live at <sha> and install it (as phxlive)
#   follow <sha>           move the RUNNING server's tree to <sha> WITHOUT stopping it — how phx-live
#                          keeps up with main (owner, 2026-10-17: "I want the PHX live to always run
#                          on main"). `fast` rebuilds while the old build serves; `dev` recompiles.
#                          Prints FOLLOWED <sha>, ALREADY <sha>, or NEEDS_INSTALL (exit 6: the
#                          dependencies changed, so the laptop runs prepare + serve instead).
#   serve [devauth] [mode] start the server on 127.0.0.1:3100 as phxlive in phx-preview-3100.scope.
#                          mode `fast` (production build, /opt/phx-live/live-fast.sh: rebuilds when
#                          the tree changes) is the laptop's DEFAULT again since phx-live became
#                          main-only on 2026-10-17 — nothing is edited on the box, so `next dev`'s one
#                          advantage (a save in seconds) is gone and its cost (a first compile per
#                          page, the 6.8 GB cap) is not. mode `dev` is `phx-live -Dev` / `-DevAuth`.
#                          The "2.5-3 min a page" that once made `fast` the default was phx-live
#                          inside phx-previews.slice's 4.5 GB cap, fixed 2026-10-16 below.
#   stop                   stop it
#   status                 one line: scope state, base sha, memory, dev-auth, mode, build state
#   install-env            read an env file on STDIN and install it as phxlive's .env.local
#   install-env-staging    build phxlive's env from the box's own STAGING preview env (for testing)
#
# 🔴 WHAT THIS SERVES IS PRODUCTION DATA once the owner has run `phx-live -InstallEnv`. The rules that
# make that tolerable are enforced here and in /opt/phx-live/firewall.sh, not by convention:
#   - port 3100 answers only uid phxtunnel (the laptop's tunnel) and phxlive (the server itself) —
#     /api/dev-auth hands out Super Admin to ANY loopback request, so phxci/phxpreview branch code and
#     the runner (phx) must not reach it;
#   - the env is an ALLOWLIST (install-env drops every other key), PHOENIX_AUTH_SECRET is the box's own,
#     and email/Telegram/OneSignal/DB-URL keys never arrive;
#   - PHX_LIVE=1 puts the red PRODUCTION DATA banner on every page.
# Account: docs/agents-worktree-and-machine-limits.md, "phx-live".
set -euo pipefail
source /home/phx/preview-scope.sh

LIVE_USER=phxlive
LIVE_HOME=/home/phxlive
LIVE_DIR=$LIVE_HOME/live
LIVE_PORT=3100
LIVE_UNIT=phx-preview-$LIVE_PORT   # the preview tooling (stop_preview_scope, the idle reaper) finds scopes by this name
LIVE_LOG=/home/phx/live.log
STATE=/home/phx/live-state
mkdir -p "$STATE" /home/phx/preview-state

# preview-scope.sh's stoppers are written for a script with NO `set -e`: stop_preview_port assigns
# `$(pgrep …)`, and pgrep exits 1 when nothing matches, which under errexit kills us before the
# server is even started. Every call goes through here instead.
stop_live() { # $1: 1 to print what was stopped
  set +e
  if [ "${1:-0}" = 1 ]; then stop_preview_scope $LIVE_PORT; stop_preview_port $LIVE_PORT
  else stop_preview_scope $LIVE_PORT >/dev/null; stop_preview_port $LIVE_PORT >/dev/null; fi
  set -e
}

ALLOW='^(NEXT_PUBLIC_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_ANON_KEY|NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_PROJECT_ID|SUPABASE_PROJECT_REF|NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY|NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID|GOOGLE_MAPS_SERVER_KEY|GOOGLE_CALENDAR_API_KEY|GOOGLE_HOLIDAY_CALENDAR_ID_EG)='

write_env() { # stdin: raw env text, $1: label
  local tmp; tmp="$(mktemp)"; chmod 600 "$tmp"
  {
    echo "# phx-live env — $1 — written $(date -u +%FT%TZ). ALLOWLIST ONLY; see /home/phx/live-ctl.sh."
    tr -d '\r' | grep -E "$ALLOW" || true
    echo "APP_ENV=development"
    echo "PHOENIX_APP_URL=http://localhost:3000"
    echo "PHOENIX_EMAIL_FORCE_TESTING=true"
    echo "PHOENIX_ENABLE_DEV_AUTH_HEADERS=false"
    echo "PHOENIX_AUTH_SECRET=$(openssl rand -hex 32)"
    echo "PHX_LIVE=1"
  } > "$tmp"
  sudo -n install -d -o $LIVE_USER -g $LIVE_USER -m 700 "$LIVE_HOME/secure"
  sudo -n install -o $LIVE_USER -g $LIVE_USER -m 600 "$tmp" "$LIVE_HOME/secure/.env.local"
  rm -f "$tmp"
  echo "ENV_INSTALLED ($1) keys:"
  sudo -n sed -E 's/=.*//' "$LIVE_HOME/secure/.env.local" | grep -v '^#' | sed 's/^/    /'
  local ref; ref="$(sudo -n grep -E '^SUPABASE_PROJECT_REF=' "$LIVE_HOME/secure/.env.local" | cut -d= -f2 | tr -d '"' || true)"
  echo "  project ref: ${ref:-<none>}"
}

case "${1:-}" in
  prepare)
    SHA="${2:?sha}"
    [ "$(sudo -n test -s $LIVE_HOME/secure/.env.local && echo y)" = y ] || { echo "NO_ENV — run phx-live -InstallEnv on the laptop first"; exit 3; }
    refresh_preview_mirror
    # The mirror group/setgid guard lives in refresh_preview_mirror (preview-scope.sh) since
    # 2026-10-12, so phx-preview gets it too. Do not re-add a copy here.
    stop_live
    sudo -n -u $LIVE_USER -H bash -s -- "$SHA" "$PHX_PREVIEW_MIRROR" < /opt/phx-live/live-prepare.sh
    ;;
  follow)
    SHA="${2:?sha}"
    refresh_preview_mirror
    # As phxlive, from its own home (it cannot stat the caller's cwd). A change to what pnpm installs
    # is NEVER applied under a running server — node_modules is shared with it — so that one answers
    # NEEDS_INSTALL and the laptop does a full prepare + serve.
    rc=0
    sudo -n -u $LIVE_USER -H bash -s -- "$SHA" <<'FOLLOW' || rc=$?
set -e
cd "$HOME"; cd /home/phxlive/live
git fetch --quiet --prune origin
git cat-file -e "$1^{commit}" 2>/dev/null || { echo "NO_COMMIT — $1 is not on GitHub"; exit 4; }
OLD="$(git rev-parse HEAD)"; NEW="$(git rev-parse "$1^{commit}")"
[ "$OLD" = "$NEW" ] && { echo "ALREADY $NEW"; exit 0; }
if ! git diff --quiet "$OLD" "$NEW" -- package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc patches; then
  echo "NEEDS_INSTALL $NEW (the dependencies changed since ${OLD:0:9})"; exit 6
fi
git checkout --quiet --force --detach "$NEW"
git clean -fdq -e node_modules -e .next -e .env.local
echo "FOLLOWED $NEW (from ${OLD:0:9})"
FOLLOW
    exit $rc
    ;;
  serve)
    DEVAUTH="${2:-0}"
    MODE="${3:-dev}"
    case "$MODE" in fast|dev) ;; *) echo "usage: live-ctl.sh serve [0|1] [fast|dev]"; exit 2 ;; esac
    # Dev-auth headers only work under `next dev` (the gate also demands NODE_ENV=development).
    [ "$MODE" = fast ] && [ "$DEVAUTH" = 1 ] && { echo "dev-auth needs dev mode: serve 1 dev"; exit 2; }
    echo "$DEVAUTH" > "$STATE/devauth"
    echo "$MODE" > "$STATE/mode"
    stop_live
    rm -f "/home/phx/preview-state/$LIVE_PORT.stopped"
    : > "$LIVE_LOG"
    DA=false; [ "$DEVAUTH" = 1 ] && DA=true
    # 🔴 phx-live runs in ITS OWN slice, phx-live.slice — NOT phx-previews.slice (changed 2026-10-16).
    # phx-previews.slice caps everything inside it at MemoryHigh=4608M / MemoryMax=5G / swap 2G, for
    # the two phx-preview servers together, and a parent's cap wins over the scope's: so the 5.5 GB this
    # file promised `next dev` was really 4.5 GB, and it lived in swap (2.5-3 min a page). The first
    # production build sat stalled at 4.9 GB under the same parent until the slice was lifted.
    # remote-check never builds beside phx-live (its busy probe counts phx-preview-3100.scope).
    # phx-preview was RETIRED 2026-10-17 and phx-previews.slice removed with it (archive:
    # /home/phx/retired/phx-preview-20261017.tar.gz), so the line that reset that slice's caps here is
    # gone too — `set-property --runtime` on the removed slice would quietly bring it back.
    if [ "$MODE" = fast ]; then
      # `next build` here peaks at ~6.9 GB RAM + ~2.5 GB swap (measured 2026-10-16), and a rebuild runs
      # WHILE the previous build serves, so this mode gets most of the box.
      nohup sudo -n systemd-run --scope --quiet \
        --unit="$LIVE_UNIT" --slice=phx-live.slice \
        --uid=$LIVE_USER --gid=$LIVE_USER \
        --description="Phoenix phx-live on $LIVE_PORT (as $LIVE_USER, production build)" \
        -p MemoryHigh=6800M -p MemoryMax=7G -p MemorySwapMax=5G \
        /bin/bash /opt/phx-live/live-fast.sh > "$LIVE_LOG" 2>&1 &
    else
      # 🔴 HEAP 4096 — the repo default — NOT 5120 (owner, 2026-10-17: "put phx-live's heap back to 4 GB").
      # 5120 was set 2026-10-16 while chasing slowness that was really phx-previews.slice's cap. At 5120
      # Next restarts the server only past ~4.25 GB of heap, and with 1.5-2 GB outside the heap (compile
      # buffers no cap reaches) it sat at 5.7 GB RAM + 1.1 GB swap after compiling only /login, hitting
      # this scope's MemoryHigh 541 times. At 4096 Next restarts near 3.4 GB, about 5-5.5 GB in all.
      nohup sudo -n systemd-run --scope --quiet \
        --unit="$LIVE_UNIT" --slice=phx-live.slice \
        --uid=$LIVE_USER --gid=$LIVE_USER \
        --description="Phoenix phx-live on $LIVE_PORT (as $LIVE_USER, dev-auth $DA)" \
        -p MemoryHigh=6800M -p MemoryMax=7G -p MemorySwapMax=5G \
        /bin/bash -c 'cd "$1" && exec env PHX_LIVE=1 PHOENIX_ENABLE_DEV_AUTH_HEADERS="$3" PHOENIX_DEV_HEAP_MB=4096 PHOENIX_ALLOW_MULTIPLE_DEV_SERVERS=1 node scripts/dev-server.mjs --port "$2" --hostname 127.0.0.1' \
        phx-live "$LIVE_DIR" "$LIVE_PORT" "$DA" > "$LIVE_LOG" 2>&1 &
    fi
    sleep 2
    if systemctl is-active --quiet "$LIVE_UNIT.scope"; then
      if [ "$MODE" = fast ]; then
        echo "BUILDING on 127.0.0.1:$LIVE_PORT · production build, rebuilt on every save · cap 7 GB RAM + 5 GB swap · as $LIVE_USER"
      else
        echo "SERVING on 127.0.0.1:$LIVE_PORT · next dev · cap 7 GB RAM + 5 GB swap · as $LIVE_USER · dev-auth $DA"
      fi
    else
      echo "START_FAILED"; tail -15 "$LIVE_LOG"; exit 1
    fi
    ;;
  stop)
    stop_live 1
    echo "STOPPED"
    ;;
  status)
    act="$(systemctl is-active "$LIVE_UNIT.scope" 2>/dev/null || true)"
    cur="$(systemctl show -p MemoryCurrent --value "$LIVE_UNIT.scope" 2>/dev/null || echo 0)"
    peak="$(systemctl show -p MemoryPeak --value "$LIVE_UNIT.scope" 2>/dev/null || echo 0)"
    b="$(sudo -n -u $LIVE_USER git -C $LIVE_DIR rev-parse --short HEAD 2>/dev/null || echo none)"
    stopped="$(cat /home/phx/preview-state/$LIVE_PORT.stopped 2>/dev/null || true)"
    mode="$(cat $STATE/mode 2>/dev/null || echo dev)"
    build="-"
    [ "$mode" = fast ] && build="$(sudo -n cat $LIVE_HOME/live-state/fast-state 2>/dev/null || echo starting)"
    echo "STATUS scope=${act:-inactive} base=$b mem=$(( ${cur/\[not set\]/0} / 1048576 ))MB peak=$(( ${peak/\[not set\]/0} / 1048576 ))MB devauth=$(cat $STATE/devauth 2>/dev/null || echo 0) idle_stopped=${stopped:-no} mode=$mode build=$build"
    ;;
  install-env)
    write_env "from the laptop's .env.local"
    ;;
  install-env-staging)
    write_env "STAGING (box preview env)" < /home/phx/secure/.env.local
    ;;
  *)
    echo "usage: live-ctl.sh prepare <sha> | follow <sha> | serve [0|1] [fast|dev] | stop | status | install-env | install-env-staging"; exit 2 ;;
esac
