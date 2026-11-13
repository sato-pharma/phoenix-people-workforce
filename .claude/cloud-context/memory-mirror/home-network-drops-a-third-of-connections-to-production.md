---
name: home-network-drops-a-third-of-connections-to-production
description: "From the home network (router 192.168.1.1) about 1 in 3 TCP connections to production's Railway address 153.52.255.32 never complete, on BOTH laptops; staging 153.52.255.122, GitHub, Google fail 0/20. A single-try production read fails often - retry, never conclude production is down."
metadata:
  node_type: memory
  type: project
  originSessionId: 064562b1-9f20-4a2a-907e-cfb2495337fd
  modified: 2026-11-13T13:21:56.391Z
---

Measured 2026-11-13 ~15:00 Cairo, 20 raw TCP connects to port 443 each: production `153.52.255.32` failed 7/20 from the main laptop and 8/20 from the spare; staging `153.52.255.122` (same Railway range) 0/20; github.com 0/20; 8.8.8.8 0/20 (1.1.1.1 failed 8/20 from the main laptop only). curl, .NET and Test-NetConnection all see it — it is the route, not PowerShell, DNS, a proxy or the hosts file.

It is why `~/.claude/logs/spare-follow-production.log` read "production did not answer" through the night of 12–13 Nov. Fixed on our side the same day: `spare-follow-production.ps1` now asks production 3 times, 15 s each (6/6 runs reached it afterwards). The route itself is the router or the internet provider — only a router restart or the provider can repair it; whether employees on other networks see it is unmeasured.

**After the owner restarted the router (2026-11-13 ~15:30 Cairo), 30 connects each:** production still failed 3/30 from the main laptop and 7/30 from the spare; staging, 1.1.1.1 and 8.8.8.8 failed 0/30 from both (the main laptop's 1.1.1.1 fault was cured). The restart did NOT fix production: it is still the only address that fails, on both laptops, so it is the provider's route to Railway's 153.52.255.32, not the router. The 3-try retry stays.

**Proven provider fault (2026-11-13 ~15:15 Cairo):** over the owner's iPhone hotspot (mobile network, gateway 172.20.10.1) production failed **0/30** connects, against 3-7/30 on the home line (WE, SSID WE05FB65_EXT) the same hour. The hotspot dropped during the same run (Google 30/30 and the health reads 0/10 failed after production's 30 had passed; the laptop was back on home Wi-Fi minutes later), so only the first targets count. The fault is the home internet provider's (WE) route to Railway's 153.52.255.32.

**Why:** a one-shot read of `/api/healthz` from this house fails about a third of the time, which reads exactly like "production is down".
**How to apply:** any script here that reads production must retry before concluding anything; before calling production down from this house, try 3 times or read it from another network. Related: [[npm-cache-junction-breaks-deep-mkdir]].
