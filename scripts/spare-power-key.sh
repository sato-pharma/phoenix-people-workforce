#!/bin/bash
# Owner, 27 Nov 2026: "Ignore power taps" — at 15:20 one short press of the spare's power button powered it off.
# Run: ssh phoenix-spare 'sudo bash -s' < spare-power-key.sh
# A short press now does nothing; holding the button 5+ seconds still powers off cleanly (and the laptop's own
# hardware hold still forces it off). The lid was already ignored (/etc/systemd/logind.conf.d/phoenix-lid.conf).
set -euo pipefail
cat > /etc/systemd/logind.conf.d/phoenix-power-key.conf <<'CONF'
# Owner 2026-11-27: "Ignore power taps" - a short press of the power button does nothing; a 5-second hold powers off.
[Login]
HandlePowerKey=ignore
HandlePowerKeyLongPress=poweroff
CONF
systemctl kill -s HUP systemd-logind   # re-reads its settings without ending any session
sleep 1
busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager HandlePowerKey HandlePowerKeyLongPress
