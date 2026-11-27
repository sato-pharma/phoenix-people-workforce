#!/bin/bash
# Runs ON THE SPARE as user phoenix (installed at ~/phoenix/e2e-run.sh), started by ~/.claude/scripts/spare-e2e.ps1 on the
# main laptop. Owner, 2026-11-23: "Do 18, 19 and 20" (#19) - the FULL browser test suite (tests/e2e, the suite pull
# requests skip in CI), ON HIS WORD ONLY ("browser tests 694"), never on a schedule (his choice the same night).
#
# 🔴 THE SUITE WRITES: it files expenses, leave requests, orders. It runs ONLY against STAGING, in a SEALED NETWORK:
#   - 21 of its 25 files have http://localhost:3000 written in; on the spare that is the LIVE server on PRODUCTION's
#     database. So the test server and the browser run inside their own network (pasta) where localhost:3000 is the
#     staging test server, and the live server (3000), the preview (3001) and the spare's own address cannot be reached.
#   - pasta's defaults DO reach the host (tested 23 Nov: 127.0.0.1:3000 answered 200, and the gateway address led back
#     to it). Only `--no-map-gw -T none -t none -u none` seals it - and the run checks the seal before it starts.
#   - the settings are ~/phoenix/e2e-staging.env (mode 600, staging's database only, a fresh session secret, NO mail
#     or Telegram key), refused unless they name the staging project and never the production one.
# Args: $1 run id, $2 a patch file (the pull request's difference from the live commit) or nothing for the live commit.
# Out: ~/phoenix/e2e-out/<id>/ (output.txt, server.log, the html report) and one line in ~/phoenix/e2e.log.
set -u
P=$HOME/phoenix; REPO=$P/phoenix-workforce; ID=$1; PATCH=${2:-}; RUN=$P/runs/e2e-$ID; OUT=$P/e2e-out/$ID
ENVF=$P/e2e-staging.env; LOG=$P/e2e.log
mkdir -p "$OUT"
L() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG" >> "$OUT/output.txt"; }
fin() { echo "$1" > "$OUT/DONE"; exit "$1"; }

grep -q '^NEXT_PUBLIC_SUPABASE_URL=.*cifwmndunmlxjhyjugxa' "$ENVF" 2>/dev/null || { L "e2e $ID REFUSED: the settings file does not name the staging project"; fin 2; }
grep -q 'ozucdzovmcqvepbozvqf' "$ENVF" && { L "e2e $ID REFUSED: the settings file names the PRODUCTION project"; fin 2; }
systemctl is-active -q phoenix-preview && { L "e2e $ID REFUSED: a pull request preview is running (no memory for a third server)"; fin 3; }
exec 9>"$P/test.lock"
flock -w 1800 9 || { L "e2e $ID REFUSED: a unit test run held the spare for 30 minutes"; fin 3; }
for _ in $(seq 1 120); do [ "$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)" -ge 3500 ] && break; sleep 10; done
avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
[ "$avail" -ge 3500 ] || { L "e2e $ID REFUSED: only $avail MB free after 20 minutes (needs 3,500)"; fin 3; }

base=$(git -C "$REPO" rev-parse HEAD)
remove_run() { rm -f "$RUN/node_modules"; git -C "$REPO" worktree remove --force "$RUN" >/dev/null 2>&1; rm -rf "$RUN"; git -C "$REPO" worktree prune; }
trap remove_run EXIT
git -C "$REPO" worktree add -q --detach "$RUN" "$base" || { L "e2e $ID FAILED: could not make the run folder"; fin 1; }
if [ -n "$PATCH" ]; then
  if grep -qE '^diff --git a/(package\.json|pnpm-lock\.yaml) ' "$PATCH"; then L "e2e $ID REFUSED: the pull request changes the packages (the run reuses the live checkout's)"; fin 2; fi
  git -C "$RUN" apply --whitespace=nowarn "$PATCH" 2>>"$OUT/output.txt" || { L "e2e $ID FAILED: the pull request did not apply on the live commit"; fin 1; }
fi
ln -s "$REPO/node_modules" "$RUN/node_modules"
find "$RUN" -maxdepth 1 -name '.env*' ! -name '*.example' -exec rm -f {} +   # nothing but the staging file may configure it

L "e2e $ID started: ${PATCH:+pull request on }commit ${base:0:9}, $avail MB free, staging database, sealed network"
pasta --config-net --no-map-gw -T none -t none -u none -- bash -c '
  set -u; cd "$1"; OUT=$2; ENVF=$3
  for a in 127.0.0.1:3000 127.0.0.1:3001 localhost:3000 192.168.1.48:3000 192.168.1.1:3000; do
    if curl -s -m 3 -o /dev/null "http://$a/"; then echo "SEAL BROKEN: $a answers from inside - nothing was run" >> "$OUT/output.txt"; exit 90; fi
  done
  echo "seal checked: the live server, the preview and the spare are unreachable" >> "$OUT/output.txt"
  set -a; . "$ENVF"; set +a
  NODE_ENV=development NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--max-old-space-size=3072 \
    node node_modules/next/dist/bin/next dev -p 3000 -H 127.0.0.1 > "$OUT/server.log" 2>&1 &
  srv=$!
  for _ in $(seq 1 90); do curl -fsS -m 10 -o /dev/null http://127.0.0.1:3000/login && break; sleep 10; done
  curl -fsS -m 10 -o /dev/null http://127.0.0.1:3000/login || { echo "the staging test server never answered" >> "$OUT/output.txt"; kill $srv; exit 91; }
  NODE_ENV=test PLAYWRIGHT_BASE_URL=http://localhost:3000 timeout 7200 node node_modules/@playwright/test/cli.js test -j 1 >> "$OUT/output.txt" 2>&1
  rc=$?; kill $srv 2>/dev/null; wait 2>/dev/null; exit $rc
' _ "$RUN" "$OUT" "$ENVF" 2>>"$OUT/output.txt"
rc=$?
[ -d "$RUN/output/playwright-report" ] && cp -r "$RUN/output/playwright-report" "$OUT/report"
sum=$(grep -E '^\s+[0-9]+ (passed|failed|flaky|skipped|did not run)' "$OUT/output.txt" | tr -s ' ' | tr '\n' ',' | sed 's/,$//')
case $rc in 90) L "e2e $ID STOPPED: the network seal failed - nothing ran";; 91) L "e2e $ID FAILED: the staging test server did not start";;
  0) L "e2e $ID PASSED:${sum}";; *) L "e2e $ID FAILED (exit $rc):${sum}";; esac
fin "$rc"
