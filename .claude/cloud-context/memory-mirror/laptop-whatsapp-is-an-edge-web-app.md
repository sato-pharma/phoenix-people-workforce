---
name: laptop-whatsapp-is-an-edge-web-app
description: The laptop WhatsApp is the Edge "WhatsApp Web" app; receives only while open; starts with Windows since 27 Nov; watchdog rule 14 (close under 2.6 GB) turned OFF on his pick 27 Nov 23:05.
metadata:
  node_type: memory
  type: project
  originSessionId: b2bd61c5-f2d2-4398-8c4b-463818f0e6c9
  modified: 2026-11-27T21:06:48.210Z
---

The laptop's WhatsApp is NOT the desktop app — it is the Edge web app "WhatsApp Web" (Default profile, app-id `hnpfjngllnobngcgfapefoaidbinmjnm`). It receives only while its window is open.

27 Nov 2026 ~22:50 Cairo: "phone sends, laptop doesn't receive" was not SIM or Wi-Fi (all WhatsApp servers reachable on 443/5222) — the laptop restarted at 20:03 and nothing reopened the window.
- Fix, his pick "Open at every restart": HKCU `Run` value `WhatsApp Web` = `msedge_proxy.exe --profile-directory=Default --app-id=…`.
- ~23:05 the same night, after "messages are not showing", his pick "Stop the watchdog closing it": `mem-watchdog.ps1` rule 14 is now OFF BY DEFAULT (`$WaEnabled = ($env:PHX_WHATSAPP_LOWRAM -eq '1')`; backup `mem-watchdog.ps1.bak-20261127-pre-whatsapp-keep`); watchdog restarted, START line shows `whatsAppWeb=…on=False`. Never turn it back on unasked. (Earlier that night he had picked "Keep closing it" — superseded.)
- 23:06 a normal Edge window read "(38) WhatsApp …" — WhatsApp open as a tab and receiving.
- Launching the window from Claude's shell (explorer shell:AppsFolder, Start-Process msedge --app-id) showed NO window — he opens it himself; don't retry.
- `PHX_WHATSAPP_LIVETEST=1 powershell -File ~/.claude/scripts/mem-watchdog.ps1` lists every Edge window (Get-Process MainWindowTitle shows only one per process).

**Why:** next time he says the laptop misses WhatsApp, check the window and the watchdog log first.
**How to apply:** see [[heavy-ram-fix-2026-11-27]] for the RAM context.
