# ~/preview-scope.sh — sourced by preview-start.sh, preview-b.sh and preview-stop.sh.
#
# 🔴 SINCE 2026-10-08 THE PREVIEWS RUN AS `phxpreview`, A USER WITH NO SUDO (owner: "run the box
# previews as their own user without sudo"). A preview runs unmerged branch code — the dev server AND
# every `pnpm install` lifecycle script — and `phx` has passwordless sudo, so a preview run as `phx`
# could do anything on the box. The split:
#   - phx keeps the GitHub deploy key and fetches into a bare mirror, /srv/phx-preview-mirror.git, that
#     group phxpreview may READ and never write. A writable mirror would let branch code plant a hook
#     (reference-transaction runs on fetch) that phx's next fetch would run with sudo.
#   - phxpreview owns its checkouts (/home/phxpreview/preview on 3000, /home/phxpreview/preview-b on
#     3001), fetches from that mirror, installs and runs the dev server. phx never runs git in them.
#   - Each preview is a SYSTEM scope phx-preview-<port>.scope in /etc/systemd/system/phx-previews.slice,
#     started with `sudo systemd-run --scope --uid=phxpreview`, so the caps and the idle reaper still
#     find it by name.
#   - phxpreview reads only its own copy of the env file (staging keys), refreshed from
#     /home/phx/secure/.env.local at every start. It cannot read anything under /home/phx.
# The old checkouts /home/phx/preview and /home/phx/preview-b were REMOVED 2026-10-08 on the owner's word; their
# document files and old draft edits sit in /home/phx/_old-preview-docs-20261008. Script backups: *.pre-phxpreview-20261008.
PHX_PREVIEW_USER=phxpreview
PHX_PREVIEW_HOME=/home/phxpreview
PHX_PREVIEW_MIRROR=/srv/phx-preview-mirror.git
PHX_PREVIEW_MEM_HIGH="${PHX_PREVIEW_MEM_HIGH:-3584M}"   # above this the kernel reclaims/swaps the preview first
PHX_PREVIEW_MEM_MAX="${PHX_PREVIEW_MEM_MAX:-4G}"        # hard ceiling for this one preview
PHX_PREVIEW_SWAP_MAX="${PHX_PREVIEW_SWAP_MAX:-1G}"
PHX_PREVIEW_IDLE_MIN="${PHX_PREVIEW_IDLE_MIN:-60}"

# Bring the mirror up to date from GitHub, as phx (the deploy key never reaches phxpreview).
refresh_preview_mirror() {
  git -C "$PHX_PREVIEW_MIRROR" fetch --quiet --prune origin || { echo "FETCH_FAILED — the box could not fetch from GitHub"; return 1; }
  # 🔴 EVERY MIRROR OBJECT MUST BE GROUP phxpreview, OR A CLONE DIES WITH "unable to open loose
  # object … Permission denied". The mirror is drwxr-s--- phx:phxpreview, so the GROUP is what grants the
  # read — but git creates each new objects/<xx> directory WITHOUT the setgid bit, so objects a fetch
  # writes under a fresh prefix are born group phx and are unreadable to phxpreview and phxlive alike.
  # Measured 2026-10-12: 15 of that day's objects were group phx, which would have failed the next
  # phx-preview of a fresh commit exactly as it failed phx-live. It sits here, right after the fetch
  # that creates them, so EVERY caller is covered — preview-start.sh, preview-b.sh, live-ctl.sh.
  # Idempotent, and never fatal: the callers run under `set -e`, and a preview that cannot be
  # re-grouped must still start.
  # 🔴 NEVER make the mirror group-WRITABLE. phxpreview could then plant a reference-transaction
  # hook in it, and the next fetch would run that hook as phx — who has passwordless sudo.
  sudo -n find "$PHX_PREVIEW_MIRROR" ! -group phxpreview -exec chgrp phxpreview {} + 2>/dev/null || true
  sudo -n find "$PHX_PREVIEW_MIRROR" -type d ! -perm -2000 -exec chmod g+s {} + 2>/dev/null || true
}

# Give phxpreview a fresh private copy of the env file.
install_preview_env() {
  if [ ! -s /home/phx/secure/.env.local ]; then echo "NO_ENV — /home/phx/secure/.env.local is missing or empty"; return 1; fi
  sed -i "s/\r$//" /home/phx/secure/.env.local
  sudo -n install -d -o "$PHX_PREVIEW_USER" -g "$PHX_PREVIEW_USER" -m 700 "$PHX_PREVIEW_HOME/secure"
  sudo -n install -o "$PHX_PREVIEW_USER" -g "$PHX_PREVIEW_USER" -m 600 /home/phx/secure/.env.local "$PHX_PREVIEW_HOME/secure/.env.local"
}

# sync_preview_tree <dir> <branch> — clone/checkout/install AS phxpreview. The script is fed on stdin
# because phxpreview cannot read /home/phx. Prints DIRTY_TREE, NO_BRANCH or INSTALL_FAILED on refusal.
sync_preview_tree() {
  sudo -n -u "$PHX_PREVIEW_USER" -H env PHX_PREVIEW_FORCE="${PHX_PREVIEW_FORCE:-0}" \
    bash -s -- "$1" "$2" "$PHX_PREVIEW_MIRROR" < /home/phx/preview-sync.sh
}

# Stop the named scope for this port, if one is running.
stop_preview_scope() {
  sudo -n systemctl stop "phx-preview-$1.scope" 2>/dev/null && echo "  stopped phx-preview-$1.scope" || true
  # A preview started before 2026-10-08 runs as phx, in phx's own user manager.
  XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" systemctl --user stop "phx-preview-$1.scope" 2>/dev/null \
    && echo "  stopped an older phx-preview-$1.scope (run as phx)" || true
}

# Fallback: stop whatever still LISTENS on this port — by the port, never by a name match, any user.
stop_preview_port() {
  _pids="$(sudo -n ss -ltnpH "sport = :$1" 2>/dev/null | grep -E "127\.0\.0\.1:$1[[:space:]]" | grep -oP 'pid=\K[0-9]+' | sort -u)"
  _wrap="$(pgrep -f "dev-server\.mjs --port $1( |\$)" | head -1)"
  for _pid in $_wrap $_pids; do sudo -n kill "$_pid" 2>/dev/null || true; done
  [ -n "$_wrap$_pids" ] && echo "  stopped the server on port $1 (pids: $(echo $_wrap $_pids))" || true
}

# start_preview_scope <port> <dir> <logfile> <label>
start_preview_scope() {
  _port="$1"; _dir="$2"; _log="$3"; _label="$4"
  mkdir -p /home/phx/preview-state
  rm -f "/home/phx/preview-state/$_port.stopped"
  : > "$_log"
  # The log is opened here, by phx, and handed to the scope: phxpreview writes it through that fd.
  nohup sudo -n systemd-run --scope --quiet \
    --unit="phx-preview-$_port" --slice=phx-previews.slice \
    --uid="$PHX_PREVIEW_USER" --gid="$PHX_PREVIEW_USER" \
    --description="Phoenix preview $_label on $_port (as $PHX_PREVIEW_USER)" \
    -p MemoryHigh="$PHX_PREVIEW_MEM_HIGH" -p MemoryMax="$PHX_PREVIEW_MEM_MAX" \
    -p MemorySwapMax="$PHX_PREVIEW_SWAP_MAX" \
    /bin/bash -c 'cd "$1" && exec env PHOENIX_DEV_HEAP_MB=2048 PHOENIX_ALLOW_MULTIPLE_DEV_SERVERS=1 node scripts/dev-server.mjs --port "$2" --hostname 127.0.0.1' \
    phx-preview "$_dir" "$_port" > "$_log" 2>&1 &
  sleep 2
  if systemctl is-active --quiet "phx-preview-$_port.scope"; then
    echo "  capped: ${PHX_PREVIEW_MEM_MAX} RAM + ${PHX_PREVIEW_SWAP_MAX} swap · runs as $PHX_PREVIEW_USER (no sudo) · stops itself after ${PHX_PREVIEW_IDLE_MIN} min with no request and no open tab"
  else
    echo "START_FAILED — the preview scope did not start. Log:"; tail -15 "$_log"
    return 1
  fi
}
