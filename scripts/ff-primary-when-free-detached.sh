#!/usr/bin/env bash
# Fast-forward the primary checkout to origin/main once the session holding it is free.
# Free = no .claude/session.lock, or a lock not refreshed for 15+ minutes (the lock hook's own
# "provably live" window: a live session rewrites it at least every 5 minutes while it works).
# Moves nothing unless the tree is clean, on main, and no git operation is in progress.
P="F:/Phoenix Workforce/phoenix-workforce"
LOCK="$P/.claude/session.lock"
sleep 30; END=$(( $(date +%s) + 6*3600 ))
cairo() { node -e "console.log(new Date().toLocaleString('en-GB',{timeZone:'Africa/Cairo'}))"; }
lock_age_min() {
  [ -f "$LOCK" ] || { echo none; return; }
  node -e '
    const l = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const t = Date.parse(l.refreshedAt || l.startedAt || "");
    console.log(Number.isFinite(t) ? Math.floor((Date.now() - t) / 60000) : 9999);
  ' "$LOCK" 2>/dev/null || echo 9999
}
while [ "$(date +%s)" -lt "$END" ]; do
  age=$(lock_age_min)
  if [ "$age" = none ] || [ "$age" -ge 15 ]; then
    br=$(git -C "$P" branch --show-current)
    dirty=$(git -C "$P" status --porcelain --untracked-files=no | head -5)
    busy=""
    for f in index.lock MERGE_HEAD REBASE_HEAD CHERRY_PICK_HEAD rebase-merge rebase-apply; do
      [ -e "$P/.git/$f" ] && busy="$busy $f"
    done
    if [ "$br" != main ] || [ -n "$dirty" ] || [ -n "$busy" ]; then
      echo "$(cairo) Cairo: the session is idle, but the primary is not safe to move (branch=$br busy=[$busy] changed files: $dirty). Waiting."
      sleep 300; continue
    fi
    git -C "$P" fetch -q origin main; [ "$(git -C "$P" rev-parse HEAD)" = "$(git -C "$P" rev-parse origin/main)" ] && { echo "$(cairo) Cairo: primary already current"; exit 0; }
    before=$(git -C "$P" rev-parse --short=9 HEAD)
    git -C "$P" fetch -q origin main || { sleep 120; continue; }
    if git -C "$P" merge --ff-only -q origin/main; then
      after=$(git -C "$P" rev-parse --short=9 HEAD)
      echo "DONE $(cairo) Cairo: primary fast-forwarded $before -> $after ($(git -C "$P" log -1 --format=%s))"
      echo "lock at that moment: age ${age} min"
      echo "repo SessionStart compact matcher now in the primary: $(git -C "$P" grep -c 'startup|resume|clear' HEAD -- .claude/settings.json)"
      exit 0
    fi
    echo "$(cairo) Cairo: merge --ff-only refused; leaving the primary as it is."
    git -C "$P" status --short | head -10
    exit 4
  fi
  sleep 60
done
echo "TIMEOUT $(cairo) Cairo: the session holding the primary stayed active for 4 hours (lock age ${age} min)."
exit 3
