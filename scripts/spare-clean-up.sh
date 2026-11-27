#!/bin/bash
# Runs ON THE SPARE as root, every Sunday at 04:30 Cairo, from the timer phoenix-clean-up (installed at
# /usr/local/lib/phoenix-clean-up.sh). Source: ~/.claude/scripts/spare-clean-up.sh on the main laptop.
# Owner, 2026-11-23: "Do 24, 31, 32" (#31, a weekly clean-up of old preview and test folders).
#  1. Test run folders left in ~/phoenix/runs (a run removes its own; one killed half-way leaves it) - removed the
#     way spare-test.ps1 does it, and ONLY while holding the test lock, so a run can never lose its folder.
#  2. ~/phoenix/inbox: test patches and git bundles (*.patch, *.bundle) older than 7 days. Nothing else there is touched.
#  3. The two package stores (pnpm store prune, users phoenix and phxpreview) - only when no install is running and
#     at least 1,500 MB of memory is free (the spare also runs the live server and sometimes a preview).
#  4. The system's downloaded-package cache (apt-get clean) and the system journal (kept to 500 MB).
#  5. dev-server.log and preview.log over 20 MB keep their last 5 MB (in place, so the running server keeps writing).
#  NEVER TOUCHED: /home/phxpreview/app (the preview reuses it), /mnt/chaos, ~/archive-copy, any document type.
#  Log: ~phoenix/phoenix/clean-up.log, one line per step and one summary line. DRY=1 says what it would do, changes nothing.
set -u
P=/home/phoenix/phoenix
LOG=$P/clean-up.log
L() { if [ "${DRY:-}" = 1 ]; then echo "$*"; return; fi; printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; chown phoenix:phoenix "$LOG" 2>/dev/null; }
free_mb() { df -m --output=avail / | tail -1 | tr -d ' '; }
before=$(free_mb)
D=""; [ "${DRY:-}" = 1 ] && D="DRY: would "

# 1 - leftover test run folders, under the test lock
n=$(find "$P/runs" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
if [ "$n" -eq 0 ]; then L "test folders: none left over"
else
  exec 9>"$P/test.lock"
  if ! flock -n 9; then L "test folders: $n present but a test run holds the lock - left for next week"
  elif [ "${DRY:-}" = 1 ]; then L "${D}remove $n leftover test folder(s): $(ls "$P/runs" | tr '\n' ' ')"
  else
    for d in "$P"/runs/*/; do d=${d%/}; rm -f "$d/node_modules"; runuser -u phoenix -- git -C "$P/phoenix-workforce" worktree remove --force "$d" >/dev/null 2>&1; rm -rf "$d"; done
    runuser -u phoenix -- git -C "$P/phoenix-workforce" worktree prune
    L "test folders: removed $n leftover folder(s)"
  fi
  exec 9>&-
fi

# 2 - old patches and bundles in the inbox
old=$(find "$P/inbox" -maxdepth 1 -type f \( -name '*.patch' -o -name '*.bundle' \) -mtime +7 2>/dev/null)
if [ -z "$old" ]; then L "inbox: nothing older than 7 days"
else
  k=$(printf '%s\n' "$old" | wc -l)
  if [ "${DRY:-}" = 1 ]; then L "${D}remove $k old patch/bundle file(s) from the inbox"
  else printf '%s\n' "$old" | xargs -d '\n' rm -f; L "inbox: removed $k patch/bundle file(s) older than 7 days"; fi
fi

# 3 - package stores, never while an install runs
avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
if pgrep -f 'pnpm.*(install|add|fetch)' >/dev/null 2>&1; then L "package stores: an install is running - left for next week"
elif [ "$avail" -lt 1500 ]; then L "package stores: only $avail MB of memory free (the live server and a preview come first) - left for next week"
else
  for u in phoenix phxpreview; do
    s=$(du -sm "/home/$u/.local/share/pnpm/store" 2>/dev/null | cut -f1)
    if [ "${DRY:-}" = 1 ]; then L "${D}prune the $u package store (${s:-0} MB now)"; continue; fi
    (cd / && runuser -u "$u" -- bash -lc 'cd ~ && pnpm store prune' >/dev/null 2>&1) && r=ok || r=FAILED
    a=$(du -sm "/home/$u/.local/share/pnpm/store" 2>/dev/null | cut -f1)
    L "package store $u: ${s:-0} MB -> ${a:-0} MB ($r)"
  done
fi

# 4 - apt cache and journal
if [ "${DRY:-}" = 1 ]; then L "${D}clean the apt cache ($(du -sm /var/cache/apt | cut -f1) MB) and keep the journal under 500 MB ($(journalctl --disk-usage | grep -o '[0-9.]*[KMG]'))"
else
  apt-get -qq clean >/dev/null 2>&1; journalctl -q --vacuum-size=500M >/dev/null 2>&1
  L "system: apt cache $(du -sm /var/cache/apt | cut -f1) MB, journal $(journalctl --disk-usage | grep -o '[0-9.]*[KMG]')"
fi

# 5 - the two server logs
for f in "$P/dev-server.log" /home/phxpreview/preview.log; do
  [ -f "$f" ] || continue
  m=$(( $(stat -c %s "$f") / 1048576 ))
  if [ "$m" -le 20 ]; then continue; fi
  if [ "${DRY:-}" = 1 ]; then L "${D}cut $f from $m MB to its last 5 MB"; continue; fi
  tail -c 5M "$f" > "$f.cut" && cat "$f.cut" > "$f"; rm -f "$f.cut"
  L "log: cut $(basename "$f") from $m MB to 5 MB"
done

after=$(free_mb)
L "clean-up finished${DRY:+ (dry run)}: $(( (after - before) )) MB freed, $(( after / 1024 )) GB free"
exit 0
