#!/bin/bash
# One-time (idempotent) setup ON THE SPARE for pull request previews (owner, 2026-11-20: "Set up PR preview").
# Run by spare-preview.ps1 whenever the unit or the run script on the spare differs from these sources.
# Expects the run script at ~/phoenix/inbox/preview-run.sh.
set -eu
id phxpreview >/dev/null 2>&1 || sudo useradd -m -s /usr/sbin/nologin phxpreview
sudo chmod 750 /home/phxpreview
sudo install -d -o phxpreview -g phxpreview -m 750 /home/phxpreview/app
# Seed its package store from the live server's once, so its first install copies instead of downloading 1.2 GB.
if ! sudo test -d /home/phxpreview/.local/share/pnpm/store; then
  sudo install -d -o phxpreview -g phxpreview /home/phxpreview/.local /home/phxpreview/.local/share /home/phxpreview/.local/share/pnpm
  sudo cp -a "$HOME/.local/share/pnpm/store" /home/phxpreview/.local/share/pnpm/store
  sudo chown -R phxpreview:phxpreview /home/phxpreview/.local/share/pnpm/store
fi
sudo install -d -m 755 /usr/local/lib/phoenix-preview
sed 's/\r$//' "$HOME/phoenix/inbox/preview-run.sh" | sudo tee /usr/local/lib/phoenix-preview/run.sh >/dev/null
sudo chmod 755 /usr/local/lib/phoenix-preview/run.sh
rm -f "$HOME/phoenix/inbox/preview-run.sh"
sudo tee /etc/systemd/system/phoenix-preview.service >/dev/null <<'EOF'
[Unit]
Description=Phoenix pull request preview on localhost:3001 BESIDE the live dev server on 3000 (owner, 2026-11-20; side by side 2026-11-23)
After=network-online.target

[Service]
User=phxpreview
WorkingDirectory=/home/phxpreview/app
Environment=HOME=/home/phxpreview
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/bin/bash /usr/local/lib/phoenix-preview/run.sh
# The live dev server already runs beside the preview; this only makes sure it is up once a preview ends.
ExecStopPost=+/bin/sh -c '[ -e /run/phoenix-preview-switching ] || systemctl --no-block start phoenix-dev.service'
RuntimeMaxSec=7200
Restart=no
Nice=-5
KillMode=control-group
TimeoutStopSec=20
EOF
sudo systemctl daemon-reload
# The 04:00 restart restarts the LIVE dev server even while a preview runs beside it (side by side since 2026-11-23).
sudo tee "$HOME/phoenix/nightly-restart.sh" >/dev/null <<'EOF'
#!/bin/sh
# 04:00 Cairo, timer phoenix-dev-nightly (owner, 2026-11-20, group 2): restart the dev server so the morning starts with memory free
# and every page warmed again. Results: ~/phoenix/warm.log. A pull request preview on 3001 is not touched (it ends by itself).
systemctl restart phoenix-dev
echo "$(date '+%Y-%m-%d %H:%M:%S') nightly: restarted the dev server; $(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo) MB available" >> /home/phoenix/phoenix/warm.log
EOF
sudo chown phoenix:phoenix "$HOME/phoenix/nightly-restart.sh"; sudo chmod 755 "$HOME/phoenix/nightly-restart.sh"
echo "SETUP OK"
