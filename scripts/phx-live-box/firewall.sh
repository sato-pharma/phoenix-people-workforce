#!/usr/bin/env bash
# /opt/phx-live/firewall.sh — run at boot by phx-live-firewall.service (after ufw), and idempotent.
#
# 🔴 PORT 3100 IS phx-live's DEV SERVER ON PRODUCTION DATA, AND `/api/dev-auth` GIVES SUPER ADMIN TO
# ANY LOOPBACK REQUEST (src/lib/auth/dev-preview.ts isLocalDevelopmentRequest). So only two uids may
# open a connection to it: phxtunnel (sshd's forwarding child for the laptop's tunnel) and phxlive (the
# server itself, and the receiver's health check). Everyone else — phxci running branch code for
# remote-check, phxpreview running branch code for phx-preview, phx (which runs the GitHub runner), and
# root — is REJECTED. Loopback traffic leaves through OUTPUT, so that is where the owner match lives.
set -euo pipefail
CHAIN=PHX_LIVE_3100
iptables -N "$CHAIN" 2>/dev/null || iptables -F "$CHAIN"
iptables -A "$CHAIN" -m owner --uid-owner phxtunnel -j RETURN
iptables -A "$CHAIN" -m owner --uid-owner phxlive -j RETURN
iptables -A "$CHAIN" -p tcp -j REJECT --reject-with tcp-reset
while iptables -C OUTPUT -o lo -p tcp --dport 3100 -j "$CHAIN" 2>/dev/null; do
  iptables -D OUTPUT -o lo -p tcp --dport 3100 -j "$CHAIN"
done
iptables -I OUTPUT 1 -o lo -p tcp --dport 3100 -j "$CHAIN"
# ::1 is not bound (the server listens on 127.0.0.1 only), but close it the same way in case it ever is.
ip6tables -N "$CHAIN" 2>/dev/null || ip6tables -F "$CHAIN"
ip6tables -A "$CHAIN" -m owner --uid-owner phxtunnel -j RETURN
ip6tables -A "$CHAIN" -m owner --uid-owner phxlive -j RETURN
ip6tables -A "$CHAIN" -p tcp -j REJECT --reject-with tcp-reset
while ip6tables -C OUTPUT -o lo -p tcp --dport 3100 -j "$CHAIN" 2>/dev/null; do
  ip6tables -D OUTPUT -o lo -p tcp --dport 3100 -j "$CHAIN"
done
ip6tables -I OUTPUT 1 -o lo -p tcp --dport 3100 -j "$CHAIN"
echo "phx-live firewall: 3100 open to phxtunnel + phxlive only"
