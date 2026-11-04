#!/usr/bin/env bash
# /home/phx/phx-live-install.sh — one-time install of phx-live on this box. Idempotent.
set -euo pipefail
NODE=/usr/local/bin/node
PUB="$(cat /home/phx/.ssh/phx-live.pub)"

# 1. the two users. phxlive runs the server and the receiver; phxtunnel only forwards a port.
if ! id -u phxlive >/dev/null 2>&1; then
  sudo -n useradd -m -d /home/phxlive -s /bin/bash -G phxpreview phxlive
  echo "created phxlive"
fi
sudo -n usermod -a -G phxpreview phxlive
sudo -n chmod 700 /home/phxlive
if ! id -u phxtunnel >/dev/null 2>&1; then
  sudo -n useradd -m -d /home/phxtunnel -s /usr/sbin/nologin phxtunnel
  echo "created phxtunnel"
fi

# 2. the keys. phxlive gets ONE command and nothing else; phxtunnel gets ONE port and no command.
sudo -n install -d -o phxlive -g phxlive -m 700 /home/phxlive/.ssh
printf 'command="%s /opt/phx-live/live-receiver.mjs",restrict %s\n' "$NODE" "$PUB" \
  | sudo -n tee /home/phxlive/.ssh/authorized_keys >/dev/null
sudo -n chown phxlive:phxlive /home/phxlive/.ssh/authorized_keys
sudo -n chmod 600 /home/phxlive/.ssh/authorized_keys
sudo -n install -d -o phxtunnel -g phxtunnel -m 700 /home/phxtunnel/.ssh
printf 'restrict,port-forwarding,permitopen="127.0.0.1:3100",command="/bin/false" %s\n' "$PUB" \
  | sudo -n tee /home/phxtunnel/.ssh/authorized_keys >/dev/null
sudo -n chown phxtunnel:phxtunnel /home/phxtunnel/.ssh/authorized_keys
sudo -n chmod 600 /home/phxtunnel/.ssh/authorized_keys

# 3. the box-side scripts.
sudo -n install -d -o root -g root -m 755 /opt/phx-live
for f in live-receiver.mjs live-prepare.sh live-fast.sh firewall.sh; do
  sudo -n install -o root -g root -m 755 "/home/phx/phx-live-stage/$f" "/opt/phx-live/$f"
done
install -m 755 /home/phx/phx-live-stage/live-ctl.sh /home/phx/live-ctl.sh

# 4. the firewall: port 3100 answers phxtunnel and phxlive only.
sudo -n install -o root -g root -m 644 /home/phx/phx-live-stage/phx-live-firewall.service \
  /etc/systemd/system/phx-live-firewall.service
sudo -n systemctl daemon-reload
sudo -n systemctl enable --now phx-live-firewall.service
sudo -n systemctl is-enabled phx-live-firewall.service

# 5. the idle reaper learns port 3100.
if ! grep -q '3100) plog=/home/phx/live.log' /home/phx/preview-idle-reaper.sh; then
  cp /home/phx/preview-idle-reaper.sh /home/phx/preview-idle-reaper.sh.pre-phxlive
  sed -i 's#3001) plog=/home/phx/preview-b.log ;;#3001) plog=/home/phx/preview-b.log ;; 3100) plog=/home/phx/live.log ;;#' \
    /home/phx/preview-idle-reaper.sh
  grep -n 'plog=' /home/phx/preview-idle-reaper.sh
fi
mkdir -p /home/phx/preview-state /home/phx/live-state
echo "INSTALL_OK"
