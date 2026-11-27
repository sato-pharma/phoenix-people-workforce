#!/bin/bash
# Runs ON THE SPARE as user phoenix, nightly at 04:20 Cairo (after the 04:00 restart and its warm-up), from the timer
# phoenix-role-check (installed at ~/phoenix/role-check.sh). Source: ~/.claude/scripts/spare-role-check.sh on the main laptop.
# Owner, 2026-11-23: "Do 18, 19 and 20" (#20, a nightly role check after 04:00: Super Admin, CEO, HR, District Manager
# and Medical Rep).
#  Signs in through dev-auth as one REAL person of each role (production's own sign-in table, 23 Nov):
#    Super Admin B-10 · CEO AA · HR Resourcing HR-011 (the only active HR seat) · District Manager AI-0001 · Medical Rep AI-0005
#  and opens the same 13 pages as each, WITHOUT following redirects. Each answer is classed:
#    OPEN    200                        the role sees the page
#    AWAY    3xx (to another address), 401, 403, 404   the role is kept out
#    BROKEN  5xx, a timeout or no answer
#  The first run is saved as the baseline (~/phoenix/role-check.baseline). Every night after: ONE Telegram to the owner
#  when any page is BROKEN, or when a role's answer CHANGED against the baseline (a page it gains is as loud as one it
#  loses - a rep seeing an admin page is the leak this exists to catch). No change, nothing broken -> no message.
#  Accept an intended change: bash ~/phoenix/role-check.sh --accept (re-saves the baseline from tonight's answers).
#  DRY=1 prints instead of logging and sending; TEST_FAIL=1 fakes one change. Log: ~/phoenix/role-check.log
#  Skipped while a pull request preview runs (two dev servers leave no memory), like the page check; FORCE=1 runs anyway.
set -u
BASE=http://127.0.0.1:3000
P=$HOME/phoenix
REPO=$P/phoenix-workforce
LOG=$P/role-check.log
BL=$P/role-check.baseline
L() { if [ "${DRY:-}" = 1 ]; then echo "$*"; return; fi; printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }
free_mb() { awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo; }
up() { curl -fsS -m 15 -o /dev/null "$BASE/api/healthz" 2>/dev/null; }
wait_up() { for _ in $(seq 1 60); do up && return 0; sleep 10; done; return 1; }

if [ "${FORCE:-}" != 1 ] && systemctl is-active -q phoenix-preview; then L 'role check skipped: a pull request preview is running on 3001'; exit 0; fi
if ! systemctl is-active -q phoenix-dev; then L 'role check skipped: the live dev server is not running'; exit 0; fi

ROLES='Super Admin|B-10
CEO|AA
HR Resourcing|HR-011
District Manager|AI-0001
Medical Rep|AI-0005'
PAGES='/admin
/admin/ceo-command-center
/hr/admin/hr-command-center
/admin/payroll-management
/admin/access
/admin/field-crm
/admin/direct-orders
/admin/outstation/expense-approvals
/organogram
/employee-portals
/employee-portals/field-crm
/employee-portals/payslips
/employee-portals/submit-expense'

urlenc() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }
jars=$(mktemp -d); trap 'rm -rf "$jars"' EXIT
NOW=$(mktemp); FAILS=""; start=$SECONDS
wait_up || { L 'role check: the dev server did not answer for 10 minutes'; FAILS="the dev server did not answer at all"; }
if [ -z "$FAILS" ]; then
  while IFS='|' read -r role hr; do
    jar="$jars/$hr"
    code=$(curl -sS -m 300 -c "$jar" -b "$jar" -o /dev/null -w '%{http_code}' "$BASE/api/dev-auth?role=$(urlenc "$role")&hrId=$(urlenc "$hr")&next=/api/healthz" 2>/dev/null)
    case "$code" in 2??|3??) ;; *) FAILS="$FAILS"$'\n'"sign-in as $role ($hr) failed: $code"; L "sign-in as $role ($hr) -> $code"; continue;; esac
    while IFS= read -r page; do
      for _ in $(seq 1 12); do [ "$(free_mb)" -ge 1024 ] && break; sleep 10; done   # the live server comes first
      t0=$SECONDS
      out=$(curl -sS -m 180 -b "$jar" -o /dev/null -w '%{http_code} %{redirect_url}' "$BASE$page" 2>/dev/null); e=$?
      [ $e = 0 ] || out="timeout"
      c=${out%% *}; to=${out#* }; to=${to#$BASE}
      case "$c" in
        200) cls=OPEN;;
        30?) if [ "${to%%\?*}" = "$page" ]; then cls=OPEN; else cls=AWAY; fi;;
        401|403|404) cls=AWAY;;
        *) cls=BROKEN;;
      esac
      L "  $role | $page -> $c${to:+ $to} = $cls in $((SECONDS - t0)) s"
      [ "$cls" = BROKEN ] && FAILS="$FAILS"$'\n'"$role: $page -> $out"
      echo "$role|$page|$cls" >> "$NOW"
    done <<< "$PAGES"
  done <<< "$ROLES"
fi
[ "${TEST_FAIL:-}" = 1 ] && echo "Medical Rep|/admin/payroll-management|OPEN" >> "$NOW"   # a faked leak, dry run only

if [ "${1:-}" = --accept ] || [ ! -s "$BL" ]; then
  if [ -z "$FAILS" ] && [ "${DRY:-}" != 1 ]; then cp "$NOW" "$BL"; L "role check: baseline saved ($(wc -l < "$BL") answers)"; fi
fi
CHANGES=""
if [ -s "$BL" ]; then
  while IFS='|' read -r role page cls; do
    was=$(grep -F "$role|$page|" "$BL" | tail -1 | cut -d'|' -f3)
    [ -n "$was" ] && [ "$was" != "$cls" ] && [ "$cls" != BROKEN ] && CHANGES="$CHANGES"$'\n'"$role: $page was $was, now $cls"
  done < <(tac "$NOW" | awk -F'|' '!seen[$1"|"$2]++' | tac)
fi
rm -f "$NOW"
nb=$(printf '%s\n' "$FAILS" | grep -c .); nc=$(printf '%s\n' "$CHANGES" | grep -c .)
L "role check: $nb broken, $nc changed against the baseline, in $((SECONDS - start)) s"
[ "$nb" = 0 ] && [ "$nc" = 0 ] && exit 0

MSG="Spare laptop nightly role check ($(date '+%d %b %H:%M')): $nb broken, $nc changed (production version, production database).
$(printf '%s\n' "$FAILS" "$CHANGES" | grep . | head -14)
A change you made on purpose: bash ~/phoenix/role-check.sh --accept on the spare. Log: ~/phoenix/role-check.log"
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
