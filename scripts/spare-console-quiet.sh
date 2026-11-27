#!/bin/bash
# Owner, 27 Nov 2026: "blank the spare's screen and quiet its messages" — the spare's own monitor showed kernel
# warnings (a hub QA job's out-of-memory kill) over the login screen. No desktop: it would take 300-600 MB.
# Installs, on the spare, as root (run: ssh phoenix-spare 'sudo bash -s' < spare-console-quiet.sh):
#   1. /etc/sysctl.d/90-phoenix-quiet-console.conf — kernel.printk = 3 4 1 3: only critical kernel messages reach
#      the screen. Everything still goes to the journal (journalctl -k).
#   2. phoenix-console-blank.service — at every boot, tty1 goes dark after 1 minute idle and the panel powers down.
set -euo pipefail

cat > /etc/sysctl.d/90-phoenix-quiet-console.conf <<'EOF'
# Owner 2026-11-27: only critical kernel messages on the spare's screen; the journal keeps all of them.
kernel.printk = 3 4 1 3
EOF
sysctl -q -p /etc/sysctl.d/90-phoenix-quiet-console.conf

cat > /etc/systemd/system/phoenix-console-blank.service <<'EOF'
# Owner 2026-11-27: "blank the spare's screen" - tty1 goes dark after 1 minute idle, panel powered down.
[Unit]
Description=Blank the spare's own screen after 1 minute idle (owner, 2026-11-27)
After=getty@tty1.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'TERM=linux /usr/bin/setterm --blank 1 --powerdown 1 --powersave powerdown </dev/tty1 >/dev/tty1'

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now phoenix-console-blank.service

# Clear the warnings already on the screen.
printf '\033[H\033[2J' > /dev/tty1
echo "printk: $(cat /proc/sys/kernel/printk)"
echo "consoleblank: $(cat /sys/module/kernel/parameters/consoleblank) seconds"
systemctl is-active phoenix-console-blank.service
systemctl is-enabled phoenix-console-blank.service
