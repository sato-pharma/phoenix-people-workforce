#!/bin/bash
# Runs ON THE SPARE as root, every Sunday at 04:45 Cairo, from the timer phoenix-disk-health (installed at
# /usr/local/lib/phoenix-disk-health.sh). Source: ~/.claude/scripts/spare-disk-health.sh on the main laptop.
# Owner, 2026-11-23: "Do 24, 31, 32" (#32, a weekly disk health report).
#  Reads the disk's own health record (smartctl, the spare's one disk: an Intel 512 GB NVMe) and writes one line to
#  ~phoenix/phoenix/disk-health.log: overall verdict, critical warning, wear used, spare blocks left, media errors,
#  temperature, power-on hours and free space.
#  Telegram ONLY on a problem, to the owner, found the way page-check.sh finds him:
#    the disk's own verdict is not PASSED · a critical warning is set · wear used 80% or more · spare blocks at or under
#    the disk's own threshold · media errors higher than last week's line · less than 15 GB free.
#  A healthy week sends nothing. DRY=1 prints the message instead of sending it (TEST_FAIL=1 fakes a problem to test
#  that path); neither changes anything.
set -u
P=/home/phoenix/phoenix
REPO=$P/phoenix-workforce
LOG=$P/disk-health.log
DEV=/dev/nvme0
L() { if [ "${DRY:-}" = 1 ]; then echo "$*"; return; fi; printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; chown phoenix:phoenix "$LOG" 2>/dev/null; }
command -v smartctl >/dev/null || { L 'disk health NOT read: smartctl is not installed (apt-get install smartmontools)'; exit 1; }
out=$(smartctl -H -A "$DEV" 2>&1)
val() { printf '%s\n' "$out" | sed -n "s/^$1:[[:space:]]*//p" | head -1; }
num() { val "$1" | tr -d ',%' | grep -o '^[0-9x]*' ; }
verdict=$(printf '%s\n' "$out" | sed -n 's/.*self-assessment test result:[[:space:]]*//p' | head -1)
crit=$(num 'Critical Warning'); used=$(num 'Percentage Used'); spare=$(num 'Available Spare')
thr=$(num 'Available Spare Threshold'); media=$(num 'Media and Data Integrity Errors')
temp=$(val 'Temperature' | grep -o '^[0-9]*'); hours=$(num 'Power On Hours')
freeg=$(( $(df -m --output=avail / | tail -1 | tr -d ' ') / 1024 ))
lastmedia=$(grep -o 'media_errors=[0-9]*' "$LOG" 2>/dev/null | tail -1 | cut -d= -f2)
LINE="verdict=${verdict:-unknown} critical=${crit:-?} wear_used=${used:-?}% spare=${spare:-?}% (threshold ${thr:-?}%) media_errors=${media:-?} temp=${temp:-?}C hours=${hours:-?} free=${freeg}GB"
L "$LINE"

PROB=""
[ "$verdict" = PASSED ] || PROB="$PROB"$'\n'"- the disk's own health verdict is ${verdict:-unreadable}, not PASSED"
[ -n "$crit" ] && [ "$((crit))" -ne 0 ] && PROB="$PROB"$'\n'"- a critical warning is set ($crit)"
[ -n "$used" ] && [ "$used" -ge 80 ] && PROB="$PROB"$'\n'"- $used% of the disk's rated wear is used"
[ -n "$spare" ] && [ -n "$thr" ] && [ "$spare" -le "$thr" ] && PROB="$PROB"$'\n'"- spare blocks down to $spare% (its threshold is $thr%)"
[ -n "$media" ] && [ -n "$lastmedia" ] && [ "$media" -gt "$lastmedia" ] && PROB="$PROB"$'\n'"- media errors rose from $lastmedia to $media"
[ "$freeg" -lt 15 ] && PROB="$PROB"$'\n'"- only $freeg GB free"
[ "${TEST_FAIL:-}" = 1 ] && PROB="$PROB"$'\n'"- TEST_FAIL (a faked problem, dry run)"
[ -z "$PROB" ] && exit 0
L "disk health: PROBLEM$(printf '%s' "$PROB" | tr '\n' ' ')"

MSG="Spare laptop disk check ($(date '+%d %b %H:%M')): something needs a look.$PROB
$LINE
Log on the spare: ~/phoenix/disk-health.log"
# Telegram, the way admin-telegram-mirror.ts finds the owner: standing admin email -> hr_id -> connected chat.
urlenc() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }
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
