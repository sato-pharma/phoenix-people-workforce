---
name: home-wifi-hops-between-router-and-extender
description: "Slow GitHub / 'DNS broken' at home on 20 Nov 2026 was the laptop switching between WE05FB65, WE05FB65_EXT and WE05FB65_5G_EXT every ~2 min; each switch cut the internet 1-3 s"
metadata:
  node_type: memory
  type: project
  originSessionId: 782c0c82-d4a7-45be-b739-4afb60dfd0f9
  modified: 2026-11-20T00:42:38.103Z
---

On 20 Nov 2026 (~02:20 Cairo) the owner said "whats wrong with my dns", then "GitHub is slow", then "Opening PR pages".
DNS servers (1.1.1.1, 8.8.8.8) and every record were fine. The cause was the Wi-Fi: from 02:19 the laptop switched
between the three home networks — `WE05FB65` (router, 2.4 GHz ch 5), `WE05FB65_EXT` (extender, 2.4 GHz ch 5) and
`WE05FB65_5G_EXT` (extender, 5 GHz ch 36) — every ~2 min, because all three read 81–92% and all were set to
connect automatically. WLAN-AutoConfig event 8003 logs each switch as "the user wants to establish a new connection".
Each switch lost even the router for 1–3 s; 21 of 40 curl calls to api.github.com failed ("Could not resolve host").
github.com itself kept working only because the hosts file pins it ([[git-to-github-is-pinned-to-the-france-edge]]).

**Fix chosen:** keep the laptop on `WE05FB65_5G_EXT`; set the other two to `connectionmode=manual`. Changing Wi-Fi
profiles is a system setting, so the owner runs the elevated `netsh wlan set profileparameter` command himself.
After his first run all three read "Connect manually" and the laptop sat on the 2.4 GHz extender, so a second command
(5G back to auto + `netsh wlan connect name=WE05FB65_5G_EXT`) was handed to him. Result 02:26:54: on the 5 GHz
extender, no switch in a 2-minute watch, 0 of 120 lookups failed afterwards. But `WE05FB65_EXT` read "Connect
automatically" again after the second run, so it can still pull the laptop back; a third command (EXT to manual) was run. **Final state 02:31 Cairo:** only
`WE05FB65_5G_EXT` connects automatically, the router and the 2.4 GHz extender are manual, and the laptop has been on
the 5 GHz extender since 02:26:54 with no switch.

**Later, 02:41 Cairo:** all three profiles read "Connect automatically" again and the laptop moved to `WE05FB65_EXT`.
Separately, the home router's own DNS (192.168.1.1, handed out by DHCP) returns "server failure" for names behind
Azure Front Door / long CNAME chains — `support.microsoft.com` (DNS_PROBE_FINISHED_NXDOMAIN in the browser) and
`mcp.supabase.com` (the Supabase MCP servers fail ENOTFOUND) — while 1.1.1.1 and 8.8.8.8 answer both, and github.com /
google.com resolve fine through the router. Fix handed to him: elevated `Set-DnsClientServerAddress -InterfaceAlias
'Wi-Fi' -ServerAddresses 1.1.1.1,8.8.8.8`.

**How to apply:** when he reports slow GitHub, slow pages or "DNS" at home, read the last hour of WLAN-AutoConfig
events 8001/8003 before blaming DNS or GitHub. All home profiles on manual means the laptop will not rejoin
any home network by itself after a drop or reboot.
