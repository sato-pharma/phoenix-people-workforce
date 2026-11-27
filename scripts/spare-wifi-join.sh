#!/bin/sh
# Joins the Phoenix spare to the home Wi-Fi (owner, 2026-11-20). Usage: sudo wifi-join   (installed at /usr/local/sbin/wifi-join)
# Source: ~/.claude/scripts/spare-wifi-join.sh on the main laptop; also on the Ubuntu USB stick as phoenix/wifi-join.
# v2 (20 Nov evening): the password is SHOWN while typed, the old settings are kept, it waits 60 s and says why.
# v3 (23 Nov): NO `netplan apply` any more. Twice on 23 Nov (10:00, 10:08) `netplan apply` left the card "unmanaged" -
#   networkd had no settings for it, so it never asked the router for an address although the password was RIGHT - and
#   v2 then blamed the password. v3 writes the file, runs `netplan generate`, restarts only the Wi-Fi service and sets the
#   card up again; the fallback /etc/systemd/network/20-phoenix-wifi.network (phoenix-netfix) keeps the card managed even
#   if netplan's own file goes missing. It tells "password refused" apart from "password accepted, no address".
#   A password with " or \ in it is written escaped so the settings file stays valid.
# v4 (27 Nov): it ADDS the network and keeps every one the spare already knew. v3 replaced the file, so joining the
#   work Wi-Fi "605" (owner's first time at work with the spare, 27 Nov) made it forget the home Wi-Fi.
#   Joining a network away from home also needs SSH let in from that network:
#   sudo ufw allow from <network>/24 to any port 22 proto tcp   (the firewall allows only the home network by default).
set -u
W=$(ls /sys/class/net | grep '^wl' | head -n1)
if [ -z "$W" ]; then echo "No Wi-Fi card found."; exit 1; fi
F=/etc/netplan/60-phoenix-wifi.yaml
printf 'Wi-Fi name [WE05FB65_EXT]: '; read S; [ -n "$S" ] || S=WE05FB65_EXT
printf 'Wi-Fi password (it shows as you type): '; read P
printf 'You typed: %s\nIs that right? [y/n]: ' "$P"; read OK
case "$OK" in y|Y|yes|YES) ;; *) echo "Nothing changed. Run: sudo wifi-join"; exit 1 ;; esac
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
umask 077
[ -f "$F" ] && cp "$F" "$F.last-good"
cat > "$F" <<EOF
network:
  version: 2
  wifis:
    $W:
      dhcp4: true
      access-points:
        "$(esc "$S")":
          password: "$(esc "$P")"
EOF
chmod 600 "$F"
# v4: keep every network the spare already knew, so joining a new one never forgets the old.
if [ -f "$F.last-good" ] && command -v python3 >/dev/null 2>&1; then
  python3 - "$F" "$F.last-good" "$W" <<'PY' || echo "(Could not keep the other Wi-Fi networks; only this one is saved.)"
import sys, os, yaml
cur, old, w = sys.argv[1], sys.argv[2], sys.argv[3]
a = yaml.safe_load(open(cur)); b = yaml.safe_load(open(old)) or {}
ap = a["network"]["wifis"][w]["access-points"]
for wifi in ((b.get("network") or {}).get("wifis") or {}).values():
    for name, conf in ((wifi or {}).get("access-points") or {}).items():
        ap.setdefault(name, conf)
os.umask(0o077)
open(cur, "w").write(yaml.safe_dump(a, default_flow_style=False, sort_keys=False))
print("Wi-Fi networks the spare knows: " + ", ".join(ap.keys()))
PY
  chmod 600 "$F"
fi
if ! netplan generate 2>/tmp/wifi-join.err; then
  echo "Those settings could not be saved:"; sed -E 's/(password).*/\1 <hidden>/I' /tmp/wifi-join.err | tail -3
  [ -f "$F.last-good" ] && cp "$F.last-good" "$F" && netplan generate 2>/dev/null
  echo "The previous settings are back. Run: sudo wifi-join"; exit 1
fi
FB=/etc/systemd/network/20-phoenix-wifi.network
if [ ! -f "$FB" ]; then
  mkdir -p /etc/systemd/network
  printf '# Phoenix fallback (wifi-join v3): keeps the Wi-Fi managed if netplan'"'"'s own file is missing.\n[Match]\nName=wl*\n\n[Network]\nDHCP=ipv4\nIPv6AcceptRA=no\n\n[DHCPv4]\nRouteMetric=600\n' > "$FB"
  chmod 644 "$FB"
fi
SINCE=$(date '+%Y-%m-%d %H:%M:%S')
systemctl daemon-reload
systemctl restart "netplan-wpa-$W.service"
networkctl reload; networkctl reconfigure "$W"
printf 'Connecting'
i=0
while [ $i -lt 60 ]; do
  if ip -4 addr show "$W" | grep -q inet; then echo; ip -4 -br addr show "$W"; echo "Connected. The spare is on the network."; exit 0; fi
  printf '.'; sleep 2; i=$((i + 2))
done
echo
LOGW=$(journalctl -u "netplan-wpa-$W" --since "$SINCE" --no-pager 2>/dev/null)
if echo "$LOGW" | grep -qE 'WRONG_KEY|4-Way Handshake failed|pre-shared key may be incorrect'; then
  echo "The Wi-Fi refused that password. Run: sudo wifi-join  and type it again."
elif echo "$LOGW" | grep -q 'CTRL-EVENT-CONNECTED'; then
  echo "The Wi-Fi ACCEPTED the password, but the spare got no address yet. Do NOT type the password again."
  echo "Run: sudo phoenix-netfix"
else
  echo "Not connected yet (the Wi-Fi did not answer). Wait one minute; then run: sudo phoenix-netfix"
fi
exit 1
