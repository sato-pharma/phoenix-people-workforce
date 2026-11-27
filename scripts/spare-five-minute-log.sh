#!/bin/bash
# Runs ON THE SPARE as user phoenix every 5 minutes, from the timer phoenix-five-minute-log (installed at
# ~/phoenix/five-minute-log.sh). Source: ~/.claude/scripts/spare-five-minute-log.sh on the main laptop.
# Owner, 2026-11-23: "Do 5, 27, 30".
#  #5  ~/phoenix/link-delay.log  - 20 pings each to the main laptop and the router, on whatever network the spare is on: average, worst, lost.
#  #30 ~/phoenix/dev-memory.log  - the live dev server's memory (phoenix-dev), a preview's (phoenix-preview) if one runs,
#      memory available to the whole spare and swap in use, in MB. A slow leak shows as the live number climbing day
#      over day at the same hour (the 04:00 restart resets it).
#  Each log keeps its last 30 days (about 8,600 lines); older lines are dropped from the log only.
set -u
D="$HOME/phoenix"
ts=$(date '+%Y-%m-%d %H:%M')
ping_line() {   # $1 name, $2 address -> "name avg=.. max=.. lost=..%"
  local out; out=$(ping -c 20 -i 0.2 -W 2 "$2" 2>/dev/null)
  local lost; lost=$(printf '%s\n' "$out" | sed -n 's/.* \([0-9.]*\)% packet loss.*/\1/p')
  local rtt; rtt=$(printf '%s\n' "$out" | sed -n 's#.*= [0-9.]*/\([0-9.]*\)/\([0-9.]*\)/.*#avg=\1ms max=\2ms#p')
  echo "$1 ${rtt:-avg=- max=-} lost=${lost:-100}%"
}
# 27 Nov: the addresses are read live, not fixed to the home network - at the office (Wi-Fi 605) the fixed home
# addresses read 100% lost while the link was fine. Router = the default gateway; laptop = the machine holding an SSH
# session to the spare (the tunnel), else the home laptop's address.
router=$(ip -4 route show default 2>/dev/null | awk '{print $3; exit}'); router=${router:-192.168.1.1}
laptop=$(ss -tnH state established '( sport = :22 )' 2>/dev/null | awk '{print $NF}' | sed 's/:[0-9]*$//' | head -n1)
laptop=${laptop:-192.168.1.46}
echo "$ts $(ping_line laptop "$laptop") | $(ping_line router "$router")" >> "$D/link-delay.log"

unit_mb() {   # memory of a systemd unit's processes, MB (0 when not running)
  local cg; cg=$(systemctl show -p ControlGroup --value "$1" 2>/dev/null)
  [ -n "$cg" ] && [ -r "/sys/fs/cgroup$cg/memory.current" ] && echo $(( $(cat "/sys/fs/cgroup$cg/memory.current") / 1048576 )) || echo 0
}
avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
swap=$(free -m | awk '/Swap:/ {print $3}')
started=$(curl -fsS -m 10 http://127.0.0.1:3000/api/healthz 2>/dev/null | sed -n 's/.*"startedAt":"\([^"]*\)".*/\1/p')
echo "$ts live=$(unit_mb phoenix-dev)MB preview=$(unit_mb phoenix-preview)MB available=${avail}MB swap=${swap}MB live_started=${started:--}" >> "$D/dev-memory.log"

for f in link-delay.log dev-memory.log; do
  n=$(wc -l < "$D/$f"); [ "$n" -gt 8700 ] && { tail -n 8640 "$D/$f" > "$D/$f.tmp" && mv "$D/$f.tmp" "$D/$f"; }
done
exit 0
