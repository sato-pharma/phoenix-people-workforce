#!/bin/bash
# Runs ON THE SPARE as root, once a minute, from the timer phoenix-wifi-rejoin (installed at /usr/local/lib/phoenix-wifi-rejoin.sh).
# Source: ~/.claude/scripts/spare-wifi-rejoin.sh on the main laptop. Owner, 2026-11-23: "Do 7, 28 and 29" (#7, the spare
# rejoins the Wi-Fi by itself).
#  - Asks the router (the default gateway) for 3 pings. A minute with no answer counts as a miss; an answer clears the count.
#  - 2 misses in a row (about 2 minutes) -> restart the Wi-Fi service (netplan-wpa-wlo1) and ask networkd to set wlo1 up
#    again; on 22 Nov 23:30 that reconnected in 3 seconds.
#  - 6 misses in a row (still nothing 4 minutes later) -> reload the Wi-Fi driver (iwlwifi), then the same restart.
#    After that it starts counting again, so it tries again every 6 minutes while the router stays silent.
#  - 20 silent minutes in a row (three driver reloads failed) -> restart the whole spare, at most once an hour. Added
#    23 Nov after a power cut at 03:17: from 09:26 the spare joined the Wi-Fi again and again but never reached the router,
#    ten repairs failed, and only a restart (09:55) brought it back.
#  - FIRST, every minute: if networkctl shows the card "unmanaged" (networkd holds no settings for it, so it never asks
#    for an address - 23 Nov 10:00-10:30, after `netplan apply`, while the password was right), write the fallback
#    /etc/systemd/network/20-phoenix-wifi.network if missing, reload networkd and set the card up; still unmanaged ->
#    restart networkd. The Wi-Fi restarts below cannot cure this, which is why ten of them failed that morning.
#  - Log: /var/log/phoenix-wifi-rejoin.log (only misses and repairs are written, never a normal minute).
#  - Test: FAKE_MISS=1 counts a miss without pinging; DRY=1 writes what it would do and repairs nothing.
set -u
IF=wlo1
LOG=/var/log/phoenix-wifi-rejoin.log
STATE=/run/phoenix-wifi-rejoin.misses
TOTAL=/run/phoenix-wifi-rejoin.total          # silent minutes in a row, NOT reset by the 6-minute repair
STAMP=/var/lib/phoenix-wifi-rejoin.last-reboot   # survives the restart: at most one restart an hour
L() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }
FB=/etc/systemd/network/20-phoenix-wifi.network
setup=$(networkctl list --no-legend "$IF" 2>/dev/null | awk '{print $5}')
if [ "$setup" = unmanaged ] || [ "${FAKE_UNMANAGED:-}" = 1 ]; then
  if [ "${DRY:-}" = 1 ]; then L "DRY: $IF is unmanaged - would write the fallback and reload networkd"
  else
    L "$IF is unmanaged (networkd holds no settings for it): loading the fallback and reloading networkd"
    if [ ! -f "$FB" ]; then mkdir -p /etc/systemd/network
      printf '# Phoenix fallback (self-repair): keeps the Wi-Fi managed if netplan'"'"'s own file is missing.\n[Match]\nName=wl*\n\n[Network]\nDHCP=ipv4\nIPv6AcceptRA=no\n\n[DHCPv4]\nRouteMetric=600\n' > "$FB"; chmod 644 "$FB"; fi
    netplan generate >/dev/null 2>&1; networkctl reload; networkctl reconfigure "$IF"; sleep 8
    if [ "$(networkctl list --no-legend "$IF" 2>/dev/null | awk '{print $5}')" = unmanaged ]; then
      L "still unmanaged: restarting networkd"; systemctl restart systemd-networkd; sleep 3; networkctl reconfigure "$IF"
    fi
    for _ in $(seq 1 15); do ip -4 addr show "$IF" | grep -q 'inet ' && { L "$IF has an address again: $(ip -4 -br addr show "$IF" | awk '{print $3}')"; break; }; sleep 2; done
  fi
fi
gw=$(ip -4 route show default dev "$IF" 2>/dev/null | awk '{print $3; exit}')
[ -n "$gw" ] || gw=192.168.1.1   # no default route at all is itself a sign the link is gone
misses=$(cat "$STATE" 2>/dev/null || echo 0)

if [ "${FAKE_MISS:-}" != 1 ] && ping -c 3 -W 2 -I "$IF" "$gw" >/dev/null 2>&1; then
  [ "$misses" -gt 0 ] && L "router $gw answers again after $misses missed minute(s)"
  echo 0 > "$STATE"; echo 0 > "$TOTAL"; exit 0
fi

misses=$((misses + 1)); echo "$misses" > "$STATE"
total=$(( $(cat "$TOTAL" 2>/dev/null || echo 0) + 1 )); echo "$total" > "$TOTAL"
L "router $gw did not answer (miss $misses)"
if [ "$total" -ge 20 ]; then
  last=$(cat "$STAMP" 2>/dev/null || echo 0); now=$(date +%s)
  if [ $((now - last)) -ge 3600 ] && [ "$(cut -d. -f1 /proc/uptime)" -ge 900 ]; then
    if [ "${DRY:-}" = 1 ]; then L "DRY: would restart the spare ($total silent minutes)"; exit 0; fi
    L "$total minutes without the router after every repair: restarting the spare"
    echo "$now" > "$STAMP"; sync; systemctl reboot; exit 0
  fi
fi
restart_wifi() {
  if [ "${DRY:-}" = 1 ]; then L "DRY: would restart netplan-wpa-$IF and reconfigure $IF"; return; fi
  systemctl restart "netplan-wpa-$IF.service"; networkctl reconfigure "$IF"; iw dev "$IF" set power_save off 2>/dev/null   # keep #1 of 22 Nov
  for _ in $(seq 1 20); do ping -c 1 -W 2 -I "$IF" "$gw" >/dev/null 2>&1 && { L "Wi-Fi back after the restart"; return; }; sleep 3; done
  L "Wi-Fi still silent 60 s after the restart"
}
if [ "$misses" -eq 2 ]; then
  L "2 minutes without the router: restarting the Wi-Fi"; restart_wifi
elif [ "$misses" -ge 6 ]; then
  if [ "${DRY:-}" = 1 ]; then L "DRY: would reload the iwlwifi driver"
  else L "6 minutes without the router: reloading the Wi-Fi driver"; modprobe -r iwlmvm iwlwifi 2>/dev/null; sleep 2; modprobe iwlwifi; sleep 5; fi
  restart_wifi; echo 0 > "$STATE"
fi
exit 0
