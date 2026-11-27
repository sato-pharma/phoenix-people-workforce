# /opt/phx-live/live-prepare.sh — runs AS phxlive (no sudo), fed on stdin by live-ctl.sh prepare.
# Args: <base sha> <mirror path>. Puts /home/phxlive/live at exactly <base sha> and installs it.
#
# Unlike preview-sync.sh this DOES discard local state: the laptop is the source of truth for this
# tree, and phx-live-sync.mjs re-sends every file that differs from <base> straight after. Nobody
# edits /home/phxlive/live by hand. node_modules, .next and the .env.local link are kept.
set -e
SHA="$1"; MIRROR="$2"; DIR=/home/phxlive/live
# FIRST, before any git call. `sudo -u phxlive` keeps the CALLER's working directory, which is
# usually somewhere under /home/phx — and phxlive cannot even stat that, so git exits 128 with
# "failed to stat" and never reaches the clone.
cd "$HOME" 2>/dev/null || cd /tmp
# The mirror is owned by phx, so git calls it "dubious ownership" and refuses every command on it
# until this is recorded. Idempotent, and it survives a rebuilt /home/phxlive.
git config --global --get-all safe.directory | grep -qx "$MIRROR" || git config --global --add safe.directory "$MIRROR"
if [ ! -d "$DIR/.git" ]; then
  git clone --quiet --no-checkout "$MIRROR" "$DIR"
fi
cd "$DIR"
git fetch --quiet --prune origin
if ! git cat-file -e "$SHA^{commit}" 2>/dev/null; then
  echo "NO_COMMIT — $SHA is not on GitHub"; exit 4
fi
git checkout --quiet --force --detach "$SHA"
git clean -fdq -e node_modules -e .next -e .env.local
ln -sfn "$HOME/secure/.env.local" .env.local
LOG="$HOME/install.log"
if ! pnpm install --frozen-lockfile > "$LOG" 2>&1; then
  echo "INSTALL_FAILED"; tail -20 "$LOG"; exit 5
fi
echo "PREPARED $(git rev-parse HEAD)"
