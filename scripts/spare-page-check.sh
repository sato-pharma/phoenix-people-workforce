#!/bin/bash
# Runs ON THE SPARE as ~/phoenix/page-check.sh, from the timer phoenix-page-check (03:30 Cairo, before the 04:00 restart).
# Source: ~/.claude/scripts/spare-page-check.sh on the main laptop. Owner, 2026-11-22: "Do the top 6" (#21, a nightly
# page check with a Telegram alert).
#  - Opens the 31 most-used pages (production activity_events, 30 days to 22 Nov 2026) on localhost:3000, signed in
#    through dev-auth: employee-portal pages as Magdy El Senosey (AI-0008, the same person the warm-up uses), the rest
#    as Super Admin. Only GET requests; nothing is clicked or saved.
#  - A page that answers 5xx, times out or cannot connect is tried once more after the server answers again (the dev
#    server can restart itself in place when its 4 GB heap fills). Only a page that fails twice counts.
#  - Any failure -> ONE Telegram message to the owner (chat resolved like admin-telegram-mirror.ts). All pages fine ->
#    no message, one log line. Log: ~/phoenix/page-check.log
#  - Skipped while a pull request preview runs (memory), or when the live dev server is not running.
#  - DRY=1 prints the message instead of sending it and checks the bot token with getMe (no message).
set -u
REPO="$HOME/phoenix/phoenix-workforce"
LOG="$HOME/phoenix/page-check.log"
BASE=http://127.0.0.1:3000
L() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; [ "${DRY:-}" = 1 ] && echo "$*"; }
free_mb() { awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo; }
up() { curl -fsS -m 15 -o /dev/null "$BASE/api/healthz" 2>/dev/null; }
wait_up() { for _ in $(seq 1 60); do up && return 0; sleep 10; done; return 1; }   # up to 10 minutes

if systemctl is-active -q phoenix-preview; then L 'page check skipped: a pull request preview is running on 3001 (two dev servers leave no memory for a page check)'; exit 0; fi
if ! systemctl is-active -q phoenix-dev; then L 'page check skipped: the live dev server is not running'; exit 0; fi
wait_up || { L 'page check: the dev server did not answer for 10 minutes'; FAILS="the dev server did not answer at all"; }

PAGES=$(cat <<'EOF'
/employee-portals | National Sales Manager | AI-0008
/employee-portals/field-crm | National Sales Manager | AI-0008
/employee-portals/field-crm/visits | National Sales Manager | AI-0008
/employee-portals/field-crm/list | National Sales Manager | AI-0008
/employee-portals/field-crm/plan | National Sales Manager | AI-0008
/employee-portals/field-crm/team | National Sales Manager | AI-0008
/employee-portals/field-crm/calendar | National Sales Manager | AI-0008
/employee-portals/monthly-closing | National Sales Manager | AI-0008
/employee-portals/weekly-sales | National Sales Manager | AI-0008
/employee-portals/profile | National Sales Manager | AI-0008
/employee-portals/direct-orders | National Sales Manager | AI-0008
/employee-portals/visits | National Sales Manager | AI-0008
/employee-portals/private-calendar | National Sales Manager | AI-0008
/employee-portals/submit-expense | National Sales Manager | AI-0008
/employee-portals/approvals/vacation | National Sales Manager | AI-0008
/employee-portals/approvals/plan | National Sales Manager | AI-0008
/employee-portals/incentive | National Sales Manager | AI-0008
/employee-portals/vacation-report | National Sales Manager | AI-0008
/employee-portals/vacation-request | National Sales Manager | AI-0008
/employee-portals/deductions | National Sales Manager | AI-0008
/employee-portals/payslips | National Sales Manager | AI-0008
/employee-portals/marketing-requests | National Sales Manager | AI-0008
/employee-portals/marketing-requests/validation | National Sales Manager | AI-0008
/employee-portals/plans | National Sales Manager | AI-0008
/admin
/admin/field-crm
/admin/field-crm/validation-reviews
/admin/direct-orders
/admin/reps-list
/admin/company-activity-report
/organogram
EOF
)

urlenc() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }
jars=$(mktemp -d); trap 'rm -rf "$jars"' EXIT
get() {   # $1 path, $2 jar -> prints the status code, or "timeout"/"no-connection"
  local c; c=$(curl -sS -m 180 -b "$2" -o /dev/null -w '%{http_code}' "$BASE$1" 2>/dev/null); local e=$?
  if [ $e = 28 ]; then echo timeout; elif [ $e != 0 ] || [ "$c" = 000 ]; then echo no-connection; else echo "$c"; fi
}
bad() { case "$1" in 5??|timeout|no-connection) return 0;; *) return 1;; esac; }

FAILS="${FAILS:-}"; total=$(printf '%s\n' "$PAGES" | grep -c .); ok=0; start=$SECONDS
if [ -z "$FAILS" ]; then
  while IFS= read -r line; do
    [ -z "${line// }" ] && continue
    IFS='|' read -r path role hr <<< "$line"
    path=$(echo "$path" | xargs); role=$(echo "${role:-}" | xargs); hr=$(echo "${hr:-}" | xargs); [ -z "$role" ] && role='Super Admin'
    for _ in $(seq 1 12); do [ "$(free_mb)" -ge 1024 ] && break; sleep 10; done   # let memory recover before the next page
    jar="$jars/$(printf '%s|%s' "$role" "$hr" | md5sum | cut -c1-12)"
    if [ ! -f "$jar" ]; then
      q="role=$(urlenc "$role")"; [ -n "$hr" ] && q="$q&hrId=$(urlenc "$hr")"
      curl -fsS -m 300 -c "$jar" -b "$jar" -o /dev/null "$BASE/api/dev-auth?$q&next=/api/healthz" 2>/dev/null || L "dev-auth sign-in as $role${hr:+ ($hr)} failed"
      touch "$jar"
    fi
    t0=$SECONDS; code=$(get "$path" "$jar")
    if bad "$code"; then wait_up; code2=$(get "$path" "$jar"); [ "$code2" != "$code" ] && code="$code then $code2"; code_last=$code2; else code_last=$code; fi
    L "  $path${hr:+ as $hr} -> $code in $((SECONDS - t0)) s"
    if bad "$code_last"; then FAILS="$FAILS"$'\n'"$path -> $code_last"; else ok=$((ok + 1)); fi
  done <<< "$PAGES"
fi

[ "${TEST_FAIL:-}" = 1 ] && FAILS="$FAILS"$'\n'"/test-page -> 500 (TEST_FAIL)"   # exercises the alert path in a DRY run
if [ -z "$FAILS" ]; then L "page check: all $total pages answered ($((SECONDS - start)) s, $(free_mb) MB available)"; exit 0; fi
nfail=$(printf '%s\n' "$FAILS" | grep -c .)
L "page check: $nfail of $total pages FAILED"
MSG="Spare laptop nightly page check ($(date '+%d %b %H:%M')): $nfail of $total pages failed on localhost:3000 (the production version, production database).
$(printf '%s\n' "$FAILS" | grep . | head -12)
Full log on the spare: ~/phoenix/page-check.log"

# Telegram, the way admin-telegram-mirror.ts finds the owner: standing admin email -> hr_id -> connected chat.
envv() { grep -E "^$1=" "$REPO/.env.local" | head -1 | cut -d= -f2- | sed -e 's/\r$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"; }
TOKEN=$(envv TELEGRAM_BOT_TOKEN); URL=$(envv NEXT_PUBLIC_SUPABASE_URL); KEY=$(envv SUPABASE_SERVICE_ROLE_KEY)
[ -n "$TOKEN" ] && [ -n "$URL" ] && [ -n "$KEY" ] || { L 'ALERT NOT SENT: Telegram or Supabase settings missing in .env.local'; exit 1; }
sb() { curl -fsS -m 30 -A phoenix-watch/1.0 -H "apikey: $KEY" -H "Authorization: Bearer $KEY" "${URL%/}/rest/v1/$1"; }
HR=$(sb 'employees?select=hr_id&work_email=ilike.omar.anwar@satopharma.com&limit=1' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s)[0]?.hr_id||"")}catch{}})')
[ -n "$HR" ] || { L 'ALERT NOT SENT: the standing admin email matched no employee'; exit 1; }
CHATS=$(sb "telegram_connections?select=telegram_chat_id&status=eq.connected&hr_id=ilike.$(urlenc "$HR")" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).map(r=>r.telegram_chat_id).filter(Boolean).join(" "))}catch{}})')
[ -n "$CHATS" ] || { L 'ALERT NOT SENT: the owner has no connected Telegram chat'; exit 1; }
if [ "${DRY:-}" = 1 ]; then
  echo "DRY RUN - would send to $(echo $CHATS | wc -w) chat(s):"; echo "$MSG"
  curl -fsS -m 20 "https://api.telegram.org/bot$TOKEN/getMe" -o /dev/null && echo 'bot token valid (getMe)' || echo 'bot token REJECTED'
  exit 0
fi
sent=0
for c in $CHATS; do curl -fsS -m 30 -o /dev/null "https://api.telegram.org/bot$TOKEN/sendMessage" --data-urlencode "chat_id=$c" --data-urlencode "text=$MSG" --data-urlencode disable_web_page_preview=true && sent=1; done
L "alert sent to Telegram: $([ $sent = 1 ] && echo yes || echo FAILED)"
