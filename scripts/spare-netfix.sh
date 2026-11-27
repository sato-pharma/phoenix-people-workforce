#!/bin/bash
# phoenix-netfix — puts the spare back on the home Wi-Fi and records why it fell off (owner, 2026-11-23: "deep audit and
# fix", then "the boot USB is connected to you. Put the fix and do all the enhancements").
# Source: ~/.claude/scripts/spare-netfix.sh on the main laptop. Lives in TWO places:
#   - the Ubuntu USB stick (label ESD-USB) as phoenix/fix.sh, run on the spare with ONE line:
#         sudo mount -L ESD-USB /mnt; sudo bash /mnt/phoenix/fix.sh
#   - installed by that run as /usr/local/sbin/phoenix-netfix, so next time it is one word:  sudo phoenix-netfix
#
# WHAT WENT WRONG (23 Nov): the Wi-Fi password was right (wpa_supplicant: "Key negotiation completed", CONNECTED) but
# networkctl showed wlo1 "unmanaged": systemd-networkd had NO settings for the card, so it never asked the router for an
# address. Restarting networkd did not help, so the netplan-made file /run/systemd/network/10-netplan-wlo1.network was
# missing. Every `sudo wifi-join` (it ran `netplan apply`) re-broke a working connection (10:00 and 10:08).
#
# WHAT THIS DOES
#  1. BEFORE: writes everything needed to find the cause (netplan files with the password hidden, networkd's files and
#     log, the Wi-Fi log, the self-repair log, battery) to /var/log/phoenix-netfix.log AND, when run from the USB, to
#     phoenix/fix-log-<time>.txt on the stick — so if the spare is still offline the stick carries the evidence back.
#  2. INSTALLS (from the stick, when present): wifi-join v3, the self-repair with its unmanaged rung, and itself.
#  3. A FALLBACK networkd file /etc/systemd/network/20-phoenix-wifi.network (any wl* card, DHCP). networkd uses the first
#     matching file by name, so netplan's 10-netplan-wlo1.network still wins whenever it exists; when it goes missing
#     the card is still managed and still asks for an address. This is the permanent cure for "unmanaged".
#  4. REPAIR: netplan generate, restart the Wi-Fi service, reload networkd, set the card up again; if there is still no
#     address after 45 s, restart networkd; then checks the router, the internet and names.
#  5. AFTER: the result on screen in one big line, the log copied to the stick, the stick synced so it can be pulled out.
# Never prints the Wi-Fi password. Never reboots. Safe to run again at any time.
set -u
[ "$(id -u)" = 0 ] || { echo "Run it with sudo:  sudo bash $0"; exit 1; }
SELF=$(readlink -f "$0"); SRC=$(dirname "$SELF")
STAMP=$(date '+%Y%m%d-%H%M%S')
TMP=$(mktemp)
say() { printf '\n===== %s =====\n' "$*"; }
W=$(ls /sys/class/net 2>/dev/null | grep '^wl' | head -n1); [ -n "$W" ] || W=wlo1
FALLBACK=/etc/systemd/network/20-phoenix-wifi.network
hide() { sed -E 's/((password|psk|key)[[:space:]]*[:=][[:space:]]*).*/\1<hidden>/I'; }
has_ip() { ip -4 addr show "$W" 2>/dev/null | grep -q 'inet '; }
setup_state() { networkctl list --no-legend "$W" 2>/dev/null | awk '{print $5}'; }

main() {
say "PHOENIX NETFIX $(date '+%Y-%m-%d %H:%M:%S') on $(hostname), card $W, run from $SRC"
say "BEFORE"
uptime
networkctl list --no-pager 2>&1
ip -br addr 2>&1
ip route 2>&1
echo "--- /etc/netplan"; ls -la /etc/netplan 2>&1
for f in /etc/netplan/*.yaml; do [ -f "$f" ] && { echo "--- $f"; hide < "$f"; }; done
echo "--- netplan get"; netplan get 2>&1 | hide
echo "--- /run/systemd/network (netplan writes here)"; ls -la /run/systemd/network 2>&1
for f in /run/systemd/network/*; do [ -f "$f" ] && { echo "--- $f"; hide < "$f"; }; done
echo "--- /etc/systemd/network"; ls -la /etc/systemd/network 2>&1
echo "--- netplan generate --debug (last 25 lines)"; netplan generate --debug 2>&1 | hide | tail -25
echo "--- services"; for s in systemd-networkd systemd-networkd.socket "netplan-wpa-$W" NetworkManager systemd-resolved phoenix-wifi-rejoin.timer; do printf '%-28s %s\n' "$s" "$(systemctl is-active "$s" 2>&1)"; done
echo "--- networkd log, this boot"; journalctl -b -u systemd-networkd --no-pager -o short-iso 2>&1 | tail -30
echo "--- Wi-Fi log, this boot"; journalctl -b -u "netplan-wpa-$W" --no-pager -o short-iso 2>&1 | hide | tail -25
echo "--- previous boot's networkd log"; journalctl -b -1 -u systemd-networkd --no-pager -o short-iso 2>&1 | tail -12
echo "--- self-repair log"; tail -25 /var/log/phoenix-wifi-rejoin.log 2>&1
echo "--- boots"; journalctl --list-boots --no-pager 2>&1 | tail -5
echo "--- battery"; for f in /sys/class/power_supply/*/online /sys/class/power_supply/BAT*/status /sys/class/power_supply/BAT*/capacity; do [ -r "$f" ] && echo "$f=$(cat "$f")"; done

say "INSTALL"
if [ -f "$SRC/wifi-join" ] && [ "$SRC/wifi-join" != /usr/local/sbin/wifi-join ]; then
  tr -d '\r' < "$SRC/wifi-join" > /usr/local/sbin/wifi-join && chmod 755 /usr/local/sbin/wifi-join && echo "wifi-join v3 installed"
fi
if [ -f "$SRC/rejoin.sh" ]; then
  tr -d '\r' < "$SRC/rejoin.sh" > /usr/local/lib/phoenix-wifi-rejoin.sh && chmod 755 /usr/local/lib/phoenix-wifi-rejoin.sh && echo "self-repair (with the unmanaged rung) installed"
fi
if [ "$SELF" != /usr/local/sbin/phoenix-netfix ]; then
  tr -d '\r' < "$SELF" > /usr/local/sbin/phoenix-netfix && chmod 755 /usr/local/sbin/phoenix-netfix && echo "phoenix-netfix installed: next time type  sudo phoenix-netfix"
fi
mkdir -p /etc/systemd/network
WANT='# Phoenix fallback (2026-11-23): if netplan'"'"'s own file for the Wi-Fi is ever missing, networkd still manages the
# card and asks the router for an address instead of leaving it "unmanaged". netplan'"'"'s 10-netplan-*.network sorts
# first and wins whenever it exists. Source: phoenix-netfix.
[Match]
Name=wl*

[Network]
DHCP=ipv4
IPv6AcceptRA=no

[DHCPv4]
RouteMetric=600'
if [ "$(cat "$FALLBACK" 2>/dev/null)" != "$WANT" ]; then printf '%s\n' "$WANT" > "$FALLBACK"; chmod 644 "$FALLBACK"; echo "fallback written: $FALLBACK"; else echo "fallback already in place"; fi
systemctl enable --now phoenix-wifi-rejoin.timer >/dev/null 2>&1 && echo "self-repair timer on"

say "REPAIR"
netplan generate 2>&1 | hide | tail -5
systemctl daemon-reload
systemctl restart "netplan-wpa-$W.service" 2>&1
systemctl is-active -q systemd-networkd || systemctl start systemd-networkd
networkctl reload; networkctl reconfigure "$W" 2>&1
iw dev "$W" set power_save off 2>/dev/null
printf 'waiting for an address'
for i in $(seq 1 45); do has_ip && break; printf '.'; sleep 1; done; echo
if ! has_ip; then
  echo "no address after 45 s (setup: $(setup_state)) - restarting networkd"
  systemctl restart systemd-networkd; sleep 2; networkctl reconfigure "$W" 2>&1
  for i in $(seq 1 40); do has_ip && break; printf '.'; sleep 1; done; echo
fi

say "AFTER"
networkctl list --no-pager 2>&1
networkctl status "$W" --no-pager 2>&1 | hide | head -25
ls -la /run/systemd/network 2>&1
GW=$(ip -4 route show default dev "$W" 2>/dev/null | awk '{print $3; exit}')
IP=$(ip -4 -br addr show "$W" 2>/dev/null | awk '{print $3}')
R=no; [ -n "$GW" ] && ping -c 3 -W 2 "$GW" >/dev/null 2>&1 && R=yes
N=no; ping -c 3 -W 3 1.1.1.1 >/dev/null 2>&1 && N=yes
D=no; getent hosts github.com >/dev/null 2>&1 && D=yes
echo "address: ${IP:-none}   router ${GW:-none}: $R   internet: $N   names: $D   setup: $(setup_state)"
echo
if [ "$R" = yes ]; then
  echo "############################################################"
  echo "  THE SPARE IS ON THE NETWORK  ($IP)"
  echo "  You can pull the USB stick out now."
  echo "############################################################"
  return 0
else
  echo "############################################################"
  echo "  STILL NOT ON THE NETWORK."
  echo "  Pull the USB stick out and plug it into the main laptop:"
  echo "  the full record is on it in phoenix/fix-log-$STAMP.txt"
  echo "############################################################"
  return 1
fi
}

main 2>&1 | tee "$TMP"; RC=${PIPESTATUS[0]}
cat "$TMP" >> /var/log/phoenix-netfix.log 2>/dev/null
if [ "$SRC" != /usr/local/sbin ] && [ -w "$SRC" ]; then cp "$TMP" "$SRC/fix-log-$STAMP.txt" 2>/dev/null && sync && echo "(record saved on the USB stick: phoenix/fix-log-$STAMP.txt)"; fi
rm -f "$TMP"
exit $RC
